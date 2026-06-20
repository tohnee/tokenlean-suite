#!/usr/bin/env node
/**
 * test-opencode-plugin.mjs — verifies the OpenCode plugin's lint logic.
 *
 * The plugin (opencode/plugin/tokenlean.ts) is TypeScript and cannot be
 * imported by a .mjs test without a TS runtime. This test therefore takes
 * a two-layer approach:
 *
 *   Layer 1 — functional tests of the source-of-truth libs
 *     (claude-code/lib/bash-lint.mjs + cache-doctor.mjs). These are .mjs
 *     and can be imported directly. They define what "correct" means.
 *
 *   Layer 2 — structural parity tests of tokenlean.ts
 *     Reads the .ts file as text and verifies every rule, regex, and check
 *     from the source libs is present. This catches parity drift without
 *     needing to execute TypeScript.
 *
 * Run:  node test/test-opencode-plugin.mjs
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintCommand } from '../claude-code/lib/bash-lint.mjs';
import { diagnose } from '../claude-code/lib/cache-doctor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(here, '..', 'opencode', 'plugin', 'tokenlean.ts');
const pluginSrc = readFileSync(PLUGIN, 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${d}`)); };

console.log('═══ tokenlean OpenCode plugin test suite ═══\n');

// ═══════════════════════════════════════════════════════════════════════
// Layer 1: functional tests of the source-of-truth libs
// These define the expected behavior that tokenlean.ts must match.
// ═══════════════════════════════════════════════════════════════════════

console.log('[1] bash-lint functional tests (source of truth)');
{
  // all 7 rules should fire
  ok('cat fires', lintCommand('cat server.log').risky === true);
  ok('grep -r fires', lintCommand('grep -r TODO .').risky === true);
  ok('find fires', lintCommand('find . -name "*.ts"').risky === true);
  ok('log fires', lintCommand('cat app.log').risky === true);
  ok('npm test fires', lintCommand('npm test').risky === true);
  ok('git log fires', lintCommand('git log').risky === true);
  ok('ls -R fires', lintCommand('ls -R /').risky === true, `got: ${JSON.stringify(lintCommand('ls -R /'))}`);

  // bounded commands are safe
  ok('cat | head safe', lintCommand('cat server.log | head -n 50').risky === false);
  ok('sed -n safe', lintCommand('sed -n "1,200p" big.txt').risky === false);
  ok('npm test | tail safe', lintCommand('npm test 2>&1 | tail -n 50').risky === false);
  ok('git log -n safe', lintCommand('git log -n 20').risky === false);
  ok('ls -la safe (no R)', lintCommand('ls -la').risky === false);
  ok('echo safe', lintCommand('echo hello').risky === false);
  ok('empty safe', lintCommand('').risky === false);

  // suggestions are bounded
  ok('cat suggests sed -n', /sed -n/.test(lintCommand('cat big.txt').suggestion || ''));
  ok('ls -R suggests head', /head/.test(lintCommand('ls -R /').suggestion || ''));
  ok('git log suggests -n', /-n 30/.test(lintCommand('git log').suggestion || ''));
}

console.log('\n[2] cache-doctor functional tests (source of truth)');
{
  // critical: timestamps
  const ts = diagnose('# Updated 2026-01-15T08:30:00\n# Rules\nUse TS.');
  ok('flags ISO timestamp', ts.critical.some((c) => c.check === 'timestamp'));
  ok('flags new Date()', diagnose('const x = new Date()').critical.some((c) => c.check === 'timestamp'));
  ok('flags Date.now()', diagnose('const x = Date.now()').critical.some((c) => c.check === 'timestamp'));
  ok('flags {{timestamp}}', diagnose('# {{timestamp}}').critical.some((c) => c.check === 'timestamp'));

  // critical: UUIDs
  const uuid = diagnose('# ID: 550e8400-e29b-41d4-a716-446655440000\n# Rules');
  ok('flags UUID', uuid.critical.some((c) => c.check === 'random-id'));
  ok('flags {{uuid}}', diagnose('# {{uuid}}').critical.some((c) => c.check === 'random-id'));
  ok('flags {{session_id}}', diagnose('# {{session_id}}').critical.some((c) => c.check === 'random-id'));

  // warning: unknown placeholders
  const ph = diagnose('# {{user_name}} is dynamic');
  ok('flags unknown placeholder', ph.warnings.some((w) => w.check === 'placeholder'));

  // warning: known dynamic placeholders are NOT flagged
  const knownPh = diagnose('# {{date}} is known');
  ok('known placeholder not flagged', !knownPh.warnings.some((w) => w.check === 'placeholder'));

  // warning: ordering
  const ordered = diagnose('# Current Session\n## Rules\nUse TS.');
  ok('flags dynamic-before-static ordering', ordered.warnings.some((w) => w.check === 'ordering'));

  // size tiers
  ok('oversize >5000 critical', diagnose('x '.repeat(11000)).critical.some((c) => c.check === 'size'));
  ok('large >3000 warning', diagnose('x '.repeat(7000)).warnings.some((w) => w.check === 'size'));

  // clean file
  const clean = diagnose('# Project\n## Architecture\nNode + TS.\n## Conventions\nNamed exports.');
  ok('clean file ok', clean.ok === true && clean.critical.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════
// Layer 2: structural parity tests of tokenlean.ts
// Verify every rule, regex, and check from the source libs exists in the
// plugin source. This catches drift without needing a TS runtime.
// ═══════════════════════════════════════════════════════════════════════

console.log('\n[3] bash-lint parity (tokenlean.ts has all 7 rules)');
{
  const ruleNames = ['cat', 'grep-r', 'find', 'log', 'test', 'gitlog', 'ls-R'];
  for (const name of ruleNames) {
    ok(`plugin has "${name}" rule`, new RegExp(`name:\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(pluginSrc), `not found in tokenlean.ts`);
  }

  // BOUNDED regex must match (same pattern)
  ok('plugin BOUNDED regex present', /BOUNDED\s*=.*head\|tail\|wc\|jq/.test(pluginSrc));

  // ls-R rule specifically (was the parity gap)
  ok('plugin ls-R regex correct', /name:\s*"ls-R"[\s\S]*?\[a-zA-Z\]\*R/.test(pluginSrc));
  ok('plugin ls-R bound is head', /name:\s*"ls-R"[\s\S]*?head -n 200/.test(pluginSrc));
}

console.log('\n[4] cache-doctor parity (tokenlean.ts has all 5 checks)');
{
  // TIMESTAMP_RE must include all variants from cache-doctor.mjs
  ok('plugin TIMESTAMP_RE has timestamp var', /TIMESTAMP_RE.*timestamp/.test(pluginSrc));
  ok('plugin TIMESTAMP_RE has new Date()', /new Date\\\(/.test(pluginSrc));
  ok('plugin TIMESTAMP_RE has Date.now', /Date\\.now/.test(pluginSrc));
  ok('plugin TIMESTAMP_RE has backtick date', /`date/.test(pluginSrc));

  // UUID_RE must include template var detection
  ok('plugin UUID_RE has {{uuid}}', /UUID_RE.*uuid/.test(pluginSrc));
  ok('plugin UUID_RE has {{nanoid}}', /UUID_RE.*nanoid/.test(pluginSrc));
  ok('plugin UUID_RE has {{session_id}}', /UUID_RE.*session_id/.test(pluginSrc));
  ok('plugin UUID_RE has {{sessionId}}', /UUID_RE.*sessionId/.test(pluginSrc));
  ok('plugin UUID_RE has {{random}}', /UUID_RE.*random/.test(pluginSrc));

  // PLACEHOLDER_RE must exist
  ok('plugin has PLACEHOLDER_RE', /PLACEHOLDER_RE\s*=/.test(pluginSrc));
  ok('plugin PLACEHOLDER_RE matches {{var}}', /PLACEHOLDER_RE.*\\\{\\\{/.test(pluginSrc));
  ok('plugin PLACEHOLDER_RE matches ${var}', /PLACEHOLDER_RE.*\\\$\\\{/.test(pluginSrc));

  // KNOWN_DYNAMIC must exist
  ok('plugin has KNOWN_DYNAMIC', /KNOWN_DYNAMIC\s*=/.test(pluginSrc));

  // size: both >5000 (critical) and >3000 (warning) tiers
  ok('plugin has size >5000 check', /toks\s*>\s*5000/.test(pluginSrc));
  ok('plugin has size >3000 check', /toks\s*>\s*3000/.test(pluginSrc));

  // ordering check: dynamic-before-static heading detection
  ok('plugin has ordering check', /current\|today\|session\|live\|now\|recent\|latest/.test(pluginSrc));
  ok('plugin ordering detects dynamic heading', /rule\|convention\|architecture\|guideline\|workflow\|command/.test(pluginSrc));
  ok('plugin ordering compares line numbers', /dynLine\s*<\s*staticLine/.test(pluginSrc));
}

console.log('\n[5] plugin structure integrity');
{
  // the plugin must still export TokenLeanPlugin
  ok('plugin exports TokenLeanPlugin', /export\s+const\s+TokenLeanPlugin/.test(pluginSrc));

  // tool.execute.before hook must still exist
  ok('plugin has tool.execute.before', /tool\.execute\.before/.test(pluginSrc));

  // MODE_BASH and MODE_WRITE env vars must still exist
  ok('plugin has MODE_BASH env', /TOKENLEAN_BASH_MODE/.test(pluginSrc));
  ok('plugin has MODE_WRITE env', /TOKENLEAN_WRITE_MODE/.test(pluginSrc));

  // write guard must still exist
  ok('plugin has write guard', /WRITE_MIN_BYTES/.test(pluginSrc));
}

// ── done ──
console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
