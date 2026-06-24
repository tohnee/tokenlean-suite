#!/usr/bin/env node
/**
 * tl-audit.mjs — Analyze prompt-cache hit rate + estimated savings from
 * Claude Code session transcripts (~/.claude/projects/*.jsonl).
 *
 * Usage:
 *   tl-audit                    # scan default ~/.claude/projects
 *   tl-audit --path DIR         # scan a custom transcripts dir/file
 *   tl-audit --json             # emit raw JSON instead of the report
 *   tl-audit --savings          # print only the savings summary line
 *   tl-audit --claudecode       # alias for default behaviour (kept for README compat)
 *
 * Exit codes:
 *   0  report printed
 *   1  no transcripts found at the given path
 *   2  bad arguments
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HIT_RATE_LIB = join(here, '..', '01-workflow', 'claude-code', 'lib', 'hit-rate.mjs');

if (!existsSync(HIT_RATE_LIB)) {
  console.error(`[tokenlean] hit-rate library not found: ${HIT_RATE_LIB}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
let target = join(homedir(), '.claude', 'projects');
let jsonMode = false;
let savingsOnly = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--path' && argv[i + 1]) { target = argv[++i]; continue; }
  if (a === '--json' || a === '-j') { jsonMode = true; continue; }
  if (a === '--savings') { savingsOnly = true; continue; }
  if (a === '--claudecode') { continue; } // default; kept for README compat
  if (a === '-h' || a === '--help') {
    console.log(`tl-audit — prompt-cache hit rate audit

Usage:
  tl-audit [--path DIR] [--json] [--savings] [--claudecode]

Defaults to scanning ~/.claude/projects (Claude Code session transcripts).
Run while a coding session is live for richer data.`);
    process.exit(0);
  }
}

const { analyze, report } = await import(HIT_RATE_LIB);

if (!existsSync(target)) {
  console.error(`[tokenlean] transcripts path not found: ${target}`);
  console.error(`  Pass --path <dir> to point at a JSONL transcripts directory.`);
  process.exit(1);
}

if (jsonMode) {
  const r = analyze(target);
  if (!r.files) { console.error(`[tokenlean] no transcripts at ${target}`); process.exit(1); }
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

const text = report(target);
if (savingsOnly) {
  const line = text.split('\n').find((l) => l.startsWith('est. cost:'));
  console.log(line || text);
} else {
  console.log(text);
}
