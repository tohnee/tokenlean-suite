#!/usr/bin/env node
/**
 * write-guard.mjs — Claude Code PreToolUse hook for the Write tool.
 * OUTPUT dimension: rewriting a whole existing file with Write makes the model
 * emit every line again (expensive output tokens) even for a small change.
 * This detects a Write that OVERWRITES an existing non-trivial file and nudges
 * toward Edit (surgical change), which only emits the changed region.
 *
 * Mode (env TOKENLEAN_WRITE_MODE): guard (default, "ask") | warn (additionalContext only) | off
 *
 * Hook wiring (settings.json):
 *   "PreToolUse": [{ "matcher": "Write", "hooks": [
 *     { "type": "command", "command": "node .claude/hooks/write-guard.mjs" }
 *   ]}]
 */
import { readFileSync, existsSync, statSync } from 'node:fs';

const MODE = process.env.TOKENLEAN_WRITE_MODE || 'guard';
const MIN_BYTES = Number(process.env.TOKENLEAN_WRITE_MIN_BYTES || 800); // ignore tiny files

function readStdin() { try { return readFileSync(0, 'utf8'); } catch { return ''; } }
const input = (() => { try { return JSON.parse(readStdin() || '{}'); } catch { return {}; } })();

if (MODE === 'off' || input.tool_name !== 'Write') process.exit(0);

const path = input.tool_input?.file_path || input.tool_input?.path;
const newContent = input.tool_input?.content ?? '';
if (!path || !existsSync(path)) process.exit(0); // new file → Write is correct, allow

let size = 0;
try { size = statSync(path).size; } catch { process.exit(0); }
if (size < MIN_BYTES) process.exit(0); // small file → rewriting is cheap, allow

// Heuristic: if the new content is similar in size to the old, this is probably
// a small edit dressed up as a full rewrite — exactly what Edit is for.
const ratio = newContent.length / size;
const looksLikeEdit = ratio > 0.5 && ratio < 1.8;

const reason =
  `[tokenlean] Write would overwrite ${path} (${size} bytes) in full, re-emitting every line as ` +
  `OUTPUT tokens. If this is a targeted change, use Edit instead — it only emits the changed lines ` +
  `(typically 40-95% fewer output tokens).` +
  (looksLikeEdit ? ` The new content is a similar size to the original, which usually means a small edit.` : ``);

if (MODE === 'warn') {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: reason },
  }) + '\n');
  process.exit(0);
}

// guard (default): ask
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: reason,
  },
}) + '\n');
