#!/usr/bin/env node
/**
 * precompact.mjs — Claude Code PreCompact hook.
 * FUTURE INPUT dimension: compaction is the one moment the prefix is rewritten.
 * Done blindly it can drop decisions you needed and forces a cold cache. This
 * injects a structured instruction so the summary keeps the load-bearing facts
 * (decisions, constraints, open tasks) and discards only noise.
 *
 * Hook wiring (settings.json):
 *   "PreCompact": [{ "hooks": [
 *     { "type": "command", "command": "node .claude/hooks/precompact.mjs" }
 *   ]}]
 *
 * Reads: { trigger: "manual"|"auto", custom_instructions?, ... }
 * Emits additionalContext appended to the compaction instructions.
 */
import { readFileSync } from 'node:fs';

function readStdin() { try { return readFileSync(0, 'utf8'); } catch { return ''; } }
const input = (() => { try { return JSON.parse(readStdin() || '{}'); } catch { return {}; } })();

const guidance = [
  'When compacting, PRESERVE verbatim:',
  '  1. Decisions made and their rationale (one line each).',
  '  2. Active constraints (style, deadlines, API contracts, "do not touch X").',
  '  3. Open tasks / next steps still pending.',
  '  4. File paths and identifiers currently in play.',
  'DISCARD: raw tool output, superseded reasoning, resolved dead-ends, exploratory chatter.',
  'Keep the last few turns intact. Do not invent or speculate — summarize only what was actually said.',
].join('\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreCompact',
    additionalContext: `[tokenlean compaction policy]\n${guidance}`,
  },
}) + '\n');
