#!/usr/bin/env node
/**
 * test-hooks.mjs — verifies the workflow without needing a live Claude Code.
 * 1. Unit-tests the shared libs (cache-doctor, bash-lint, hit-rate).
 * 2. Feeds each hook the exact JSON shape Claude Code sends on stdin and
 *    asserts the emitted hook output.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnose } from '../claude-code/lib/cache-doctor.mjs';
import { lintCommand } from '../claude-code/lib/bash-lint.mjs';
import { analyze } from '../claude-code/lib/hit-rate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(here, '..', 'claude-code', 'hooks');
const SANDBOX = join('/tmp', 'tl-wf-' + Date.now());
mkdirSync(SANDBOX, { recursive: true });

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${d}`)); };

// run a hook: pipe JSON to stdin, capture stdout JSON (or empty)
function runHook(file, payload, env = {}) {
  const r = spawnSync('node', [join(HOOKS, file)], {
    input: JSON.stringify(payload),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  const out = (r.stdout || '').trim();
  return { raw: out, exit: r.status, json: out ? JSON.parse(out) : null };
}

console.log('═══ tokenlean-workflow test suite ═══\n');

// ── 1. cache-doctor lib ──
console.log('[1] cache-doctor (INPUT)');
{
  const bad = diagnose('# Session as of 2026-01-15T08:30:00\nID: 550e8400-e29b-41d4-a716-446655440000\n# Rules\nUse TS.');
  ok('flags timestamp as critical', bad.critical.some((c) => c.check === 'timestamp'));
  ok('flags uuid as critical', bad.critical.some((c) => c.check === 'random-id'));
  ok('bad file not ok', bad.ok === false);
  const good = diagnose('# Project\n## Architecture\nNode + TS.\n## Conventions\nNamed exports.');
  ok('clean file ok', good.ok === true && good.critical.length === 0);
  const big = diagnose('x '.repeat(11000));
  ok('oversize flagged critical', big.critical.some((c) => c.check === 'size'));

  // placeholder detection
  const pl = diagnose('# Project\n{{task}}\n## Rules\nUse TS.');
  ok('placeholder flagged as warning', pl.warnings.some((c) => c.check === 'placeholder'));

  // ordering: dynamic section before static → warning
  const ord = diagnose('# Current Task\nFoo\n# Architecture\nBar');
  ok('dynamic-before-static ordering flagged', ord.warnings.some((c) => c.check === 'ordering'));

  // near-threshold size (3000-5000 tok = warning, not critical)
  const near = diagnose('x '.repeat(7000));
  ok('near-threshold size is warning not critical', near.warnings.some((c) => c.check === 'size') && !near.critical.some((c) => c.check === 'size'));

  // report() returns text
  const rpt = diagnose('x '.repeat(7000));
  ok('report returns critical+warnings arrays', Array.isArray(rpt.critical) && Array.isArray(rpt.warnings));
}

// ── 2. bash-lint lib ──
console.log('\n[2] bash-lint (FUTURE INPUT)');
{
  ok('cat large file risky', lintCommand('cat server.log').risky === true);
  ok('cat suggests bounded', /sed -n|head|tail/.test(lintCommand('cat server.log').suggestion || ''));
  ok('grep -r risky', lintCommand('grep -r TODO .').risky === true);
  ok('already-bounded cat is safe', lintCommand('cat server.log | head -n 50').risky === false);
  ok('sed -n bounded is safe', lintCommand('sed -n "1,200p" big.txt').risky === false);
  ok('npm test risky (unbounded)', lintCommand('npm test').risky === true);
  ok('npm test bounded safe', lintCommand('npm test 2>&1 | tail -n 50').risky === false);
  ok('git log unbounded risky', lintCommand('git log').risky === true);
  ok('git log -n safe', lintCommand('git log -n 20').risky === false);
  ok('normal echo safe', lintCommand('echo hello').risky === false);
  ok('find unbounded risky', lintCommand('find . -name "*.ts"').risky === true);
  ok('find bounded safe', lintCommand('find . -name "*.ts" | head -n 50').risky === false);
  ok('log tail unbounded risky', lintCommand('tail production.log').risky === true);
  ok('log tail bounded safe', lintCommand('tail -n 200 production.log').risky === false);
  ok('ls -R unbounded risky', lintCommand('ls -R src/').risky === true);
  ok('empty command safe', lintCommand('').risky === false);
  ok('null input safe', lintCommand(null).risky === false);
  ok('piped bounded via jq safe', lintCommand('cat data.json | jq .items').risky === false);
  ok('pipd bounded via wc safe', lintCommand('cat server.log | wc -l').risky === false);
}

// ── 3. hit-rate lib ──
console.log('\n[3] hit-rate (INPUT observability)');
{
  const t = join(SANDBOX, 's.jsonl');
  writeFileSync(t, [
    JSON.stringify({ message: { usage: { input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500, output_tokens: 300 } } }),
    JSON.stringify({ message: { usage: { input_tokens: 500, cache_read_input_tokens: 12000, cache_creation_input_tokens: 0, output_tokens: 200 } } }),
  ].join('\n'));
  const r = analyze(t);
  ok('parses 2 calls', r.calls === 2, `got ${r.calls}`);
  ok('hit rate computed high', r.hitRate > 85, `got ${r.hitRate.toFixed(1)}`);
  ok('savings positive', r.savedPct > 0);
}

// ── 3b. hit-rate F-5: weighted 5m/1h write cost ──
console.log('\n[3b] hit-rate weighted 5m/1h write cost (F-5)');
{
  // Transcript with ephemeral_5m / ephemeral_1h breakdown
  const t = join(SANDBOX, 's_ttl.jsonl');
  writeFileSync(t, [
    JSON.stringify({ message: { usage: {
      input_tokens: 1000, cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 },
      output_tokens: 200,
    } } }),
    JSON.stringify({ message: { usage: {
      input_tokens: 500, cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 500,
      cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 200 },
      output_tokens: 100,
    } } }),
  ].join('\n'));
  const r = analyze(t);
  // eph5=900, eph1h=600, write=1500
  ok('ephemeral tokens parsed', r.eph5 === 900 && r.eph1h === 600, `eph5=${r.eph5} eph1h=${r.eph1h}`);
  // Weighted write cost = 900*3.75 + 600*6.0 per Mtok = 0.006975
  // Flat (old) write cost = 1500*3.75 per Mtok = 0.005625
  // Total weighted cost = 1500*3 + 13000*0.3 + 0.006975 + 300*15  per Mtok
  const expectedWeighted = (1500/1e6)*3.0 + (13000/1e6)*0.3 + (900/1e6)*3.75 + (600/1e6)*6.0 + (300/1e6)*15.0;
  const oldFlat = (1500/1e6)*3.0 + (13000/1e6)*0.3 + (1500/1e6)*3.75 + (300/1e6)*15.0;
  ok('cost uses weighted 5m/1h prices', Math.abs(r.cost - expectedWeighted) < 1e-9, `got ${r.cost} expected ${expectedWeighted}`);
  ok('weighted cost > flat-5m cost (1h is pricier)', r.cost > oldFlat, `weighted=${r.cost} flat=${oldFlat}`);
}

// ── 3c. hit-rate F-5: backward compat (no ephemeral breakdown) ──
console.log('\n[3c] hit-rate backward compat: no ephemeral breakdown (F-5)');
{
  const t = join(SANDBOX, 's_old.jsonl');
  writeFileSync(t, [
    JSON.stringify({ message: { usage: { input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500, output_tokens: 300 } } }),
  ].join('\n'));
  const r = analyze(t);
  ok('no ephemeral tokens', r.eph5 === 0 && r.eph1h === 0);
  // Falls back to flat write5m: 500*3.75 per Mtok
  const expected = (1000/1e6)*3.0 + (9000/1e6)*0.3 + (500/1e6)*3.75 + (300/1e6)*15.0;
  ok('fallback uses flat write5m price', Math.abs(r.cost - expected) < 1e-9, `got ${r.cost} expected ${expected}`);
}

// ── 4. session-start hook ──
console.log('\n[4] session-start hook (INPUT)');
{
  // bad CLAUDE.md → should emit warning context
  writeFileSync(join(SANDBOX, 'CLAUDE.md'), '# Now: 2026-01-15T08:30:00\n# Rules\nUse TS.');
  const r = runHook('session-start.mjs', { hook_event_name: 'SessionStart', cwd: SANDBOX });
  ok('emits additionalContext on bad CLAUDE.md', !!r.json?.hookSpecificOutput?.additionalContext);
  ok('context mentions cache audit', /cache|prefix/i.test(r.json?.hookSpecificOutput?.additionalContext || ''));

  // good CLAUDE.md → silent (no output)
  writeFileSync(join(SANDBOX, 'CLAUDE.md'), '# Project\n## Architecture\nNode.\n## Conventions\nNamed exports.');
  const r2 = runHook('session-start.mjs', { hook_event_name: 'SessionStart', cwd: SANDBOX });
  ok('silent on clean CLAUDE.md', r2.raw === '', `got: ${r2.raw}`);

  // AGENTS.md path (OpenCode style) - need to remove CLAUDE.md first
  rmSync(join(SANDBOX, 'CLAUDE.md'), { force: true });
  writeFileSync(join(SANDBOX, 'AGENTS.md'), '# Now: 2026-01-15T08:30:00\n# Rules\nUse TS.');
  const r3 = runHook('session-start.mjs', { hook_event_name: 'SessionStart', cwd: SANDBOX });
  ok('picks up AGENTS.md when no CLAUDE.md', !!r3.json?.hookSpecificOutput?.additionalContext);

  // no CLAUDE.md or AGENTS.md → silent
  rmSync(join(SANDBOX, 'CLAUDE.md'), { force: true });
  rmSync(join(SANDBOX, 'AGENTS.md'), { force: true });
  const r4 = runHook('session-start.mjs', { hook_event_name: 'SessionStart', cwd: SANDBOX });
  ok('silent when no CLAUDE.md/AGENTS.md', r4.raw === '', `got: ${r4.raw}`);

  // .claude/CLAUDE.md path
  mkdirSync(join(SANDBOX, '.claude'), { recursive: true });
  writeFileSync(join(SANDBOX, '.claude', 'CLAUDE.md'), '# Now: 2026-01-15T08:30:00\n# Rules\nUse TS.');
  const r5 = runHook('session-start.mjs', { hook_event_name: 'SessionStart', cwd: SANDBOX });
  ok('picks up .claude/CLAUDE.md when root CLAUDE.md absent', !!r5.json?.hookSpecificOutput?.additionalContext);
}

// ── 5. bash-guard hook ──
console.log('\n[5] bash-guard hook (FUTURE INPUT)');
{
  const risky = runHook('bash-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'cat huge.log' } });
  ok('asks on risky command', risky.json?.hookSpecificOutput?.permissionDecision === 'ask');
  ok('reason includes bounded suggestion', /head|tail|sed/.test(risky.json?.hookSpecificOutput?.permissionDecisionReason || ''));

  const safe = runHook('bash-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'ls -la | head' } });
  ok('silent on safe command', safe.raw === '');

  const auto = runHook('bash-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'grep -r TODO .' } }, { TOKENLEAN_BASH_MODE: 'auto' });
  ok('auto mode returns updatedInput', !!auto.json?.hookSpecificOutput?.updatedInput?.command);
  ok('auto rewrite is bounded', /head|tail/.test(auto.json?.hookSpecificOutput?.updatedInput?.command || ''));

  const off = runHook('bash-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'cat huge.log' } }, { TOKENLEAN_BASH_MODE: 'off' });
  ok('off mode is silent', off.raw === '');

  const other = runHook('bash-guard.mjs', { tool_name: 'Read', tool_input: { file_path: 'x' } });
  ok('ignores non-Bash tools', other.raw === '');
}

// ── 6. write-guard hook ──
console.log('\n[6] write-guard hook (OUTPUT)');
{
  const big = join(SANDBOX, 'big.ts');
  writeFileSync(big, 'const x = 1;\n'.repeat(200)); // ~2.6KB existing file
  const overwrite = runHook('write-guard.mjs', { tool_name: 'Write', tool_input: { file_path: big, content: 'const x = 2;\n'.repeat(200) } });
  ok('asks when overwriting large existing file', overwrite.json?.hookSpecificOutput?.permissionDecision === 'ask');
  ok('reason recommends Edit', /Edit/.test(overwrite.json?.hookSpecificOutput?.permissionDecisionReason || ''));

  const newFile = runHook('write-guard.mjs', { tool_name: 'Write', tool_input: { file_path: join(SANDBOX, 'brand-new.ts'), content: 'whatever' } });
  ok('allows brand-new file (silent)', newFile.raw === '');

  const tiny = join(SANDBOX, 'tiny.ts');
  writeFileSync(tiny, 'x');
  const tinyOverwrite = runHook('write-guard.mjs', { tool_name: 'Write', tool_input: { file_path: tiny, content: 'y' } });
  ok('allows tiny file overwrite (silent)', tinyOverwrite.raw === '');

  const warn = runHook('write-guard.mjs', { tool_name: 'Write', tool_input: { file_path: big, content: 'const x = 2;\n'.repeat(200) } }, { TOKENLEAN_WRITE_MODE: 'warn' });
  ok('warn mode emits context not ask', !!warn.json?.hookSpecificOutput?.additionalContext && !warn.json?.hookSpecificOutput?.permissionDecision);

  // edge: non-existent path → silent (file not found)
  const missing = runHook('write-guard.mjs', { tool_name: 'Write', tool_input: { file_path: join(SANDBOX, 'not-here.ts'), content: 'x' } });
  ok('non-existent path is silent (falls through to new file path)', missing.raw === '');

  // edge: off mode
  const off = runHook('write-guard.mjs', { tool_name: 'Write', tool_input: { file_path: big, content: 'new' } }, { TOKENLEAN_WRITE_MODE: 'off' });
  ok('off mode is silent', off.raw === '');

  // edge: non-Write tool
  const nonWrite = runHook('write-guard.mjs', { tool_name: 'Read', tool_input: { file_path: big } });
  ok('ignores non-Write tools', nonWrite.raw === '');
}

// ── 7. precompact hook ──
console.log('\n[7] precompact hook (FUTURE INPUT)');
{
  const r = runHook('precompact.mjs', { hook_event_name: 'PreCompact', trigger: 'auto' });
  ok('emits compaction policy', /PRESERVE/.test(r.json?.hookSpecificOutput?.additionalContext || ''));
  ok('policy says discard raw tool output', /DISCARD|raw tool output/.test(r.json?.hookSpecificOutput?.additionalContext || ''));
}

// ── done ──
rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
