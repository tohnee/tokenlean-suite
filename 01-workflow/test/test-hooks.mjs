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
