#!/usr/bin/env node
/**
 * session-start.mjs — Claude Code SessionStart hook.
 * INPUT dimension: at session start, audit CLAUDE.md for prefix-cache hazards
 * and inject a concise warning as additionalContext so the model (and you) know
 * the prefix is unstable before burning a whole session at full input price.
 *
 * Hook wiring (settings.json):
 *   "SessionStart": [{ "hooks": [
 *     { "type": "command", "command": "node .claude/hooks/session-start.mjs" }
 *   ]}]
 *
 * Reads hook JSON on stdin: { cwd, hook_event_name, ... }
 * Emits: { hookSpecificOutput: { hookEventName, additionalContext } }
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { report } from '../lib/cache-doctor.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

const input = (() => { try { return JSON.parse(readStdin() || '{}'); } catch { return {}; } })();
const cwd = input.cwd || process.cwd();

const candidates = [join(cwd, 'CLAUDE.md'), join(cwd, '.claude', 'CLAUDE.md'), join(cwd, 'AGENTS.md')];
const file = candidates.find(existsSync);

if (!file) {
  // nothing to audit; stay silent (empty output = no context added)
  process.exit(0);
}

const r = report(readFileSync(file, 'utf8'), file.replace(cwd + '/', ''));

// Only speak up if there's something worth saying.
if (r.critical.length === 0 && r.warnings.length === 0) {
  process.exit(0);
}

const context =
  `[tokenlean] prompt-cache audit of ${file.replace(cwd + '/', '')}:\n${r.text}\n` +
  (r.critical.length
    ? `Because this file is loaded on every turn, the issues above will cause cache MISSES and inflate input cost. Consider fixing before a long session.`
    : ``);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
}) + '\n');
