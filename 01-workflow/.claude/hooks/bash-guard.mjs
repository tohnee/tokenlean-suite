#!/usr/bin/env node
/**
 * bash-guard.mjs — Claude Code PreToolUse hook for the Bash tool.
 * FUTURE INPUT dimension: large command output lingers in history and is
 * re-billed every later turn. This intercepts commands likely to dump huge
 * output and, depending on mode, either asks for confirmation with a bounded
 * rewrite suggestion, or (auto mode) rewrites the command in place.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * NOTE: This hook uses a command-name blacklist approach, which is
 * inherently incomplete. For stronger, real-output-compression, install
 * rtk (Rust Token Killer, https://github.com/azat-io/rtk) alongside.
 *   rtk sits between the terminal and the agent, compressing every
 *   command's output in real Rust — bash-guard is a lightweight fallback
 *   that suggests bounded commands, rtk actually compresses the bytes.
 *   They are complementary: bash-guard prevents unbounded commands;
 *   rtk compresses what does come through.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Modes (env TOKENLEAN_BASH_MODE):
 *   guard (default) → permissionDecision "ask" with a suggested bounded command
 *   auto            → return updatedInput with the bounded command (requires a
 *                     Claude Code build that honors hookSpecificOutput.updatedInput)
 *   off             → no-op
 *
 * Hook wiring (settings.json):
 *   "PreToolUse": [{ "matcher": "Bash", "hooks": [
 *     { "type": "command", "command": "node .claude/hooks/bash-guard.mjs" }
 *   ]}]
 */
import { readFileSync } from 'node:fs';
import { lintCommand } from '../lib/bash-lint.mjs';

const MODE = process.env.TOKENLEAN_BASH_MODE || 'guard';

function readStdin() { try { return readFileSync(0, 'utf8'); } catch { return ''; } }
const input = (() => { try { return JSON.parse(readStdin() || '{}'); } catch { return {}; } })();

if (MODE === 'off' || input.tool_name !== 'Bash') process.exit(0);

const command = input.tool_input?.command || '';
const verdict = lintCommand(command);

if (!verdict.risky) process.exit(0);

if (MODE === 'auto') {
  // Try to rewrite the command in place. Falls back gracefully on older builds
  // (which ignore updatedInput) — in that case nothing changes and the model proceeds.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...input.tool_input, command: verdict.suggestion },
      additionalContext: `[tokenlean] bounded an unbounded "${verdict.rule}" command to limit FUTURE INPUT cost.`,
    },
  }) + '\n');
  process.exit(0);
}

// guard (default): ask, with the suggested bounded command in the reason
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: `[tokenlean] ${verdict.reason}`,
  },
}) + '\n');
