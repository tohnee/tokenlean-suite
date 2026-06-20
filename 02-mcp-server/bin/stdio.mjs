#!/usr/bin/env node
/**
 * bin/stdio.mjs — STDIO transport (LOCAL CLI form).
 *
 * For coding agents that spawn the server as a child process and talk
 * newline-delimited JSON-RPC over stdin/stdout:
 *   Claude Code, OpenCode, Codex CLI, Cursor, Windsurf, VS Code Copilot.
 *
 * The agent, this server, and the files all live on the SAME machine.
 * No network, no auth, no session management — the OS process boundary
 * is the security boundary, and --root is the sandbox.
 *
 * Usage:  node bin/stdio.mjs [--root /path/to/workspace] [--read-only]
 */

import { createInterface } from 'node:readline';
import { createCore } from '../lib/core.mjs';

function argOf(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const root = argOf('--root', process.cwd());
const readOnly = process.argv.includes('--read-only');

const core = createCore({ root, readOnly });

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try {
    const res = core.dispatch(msg);
    if (res) write(res);
  } catch (e) {
    if (msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } });
  }
});

process.stderr.write(`[tokenlean-mcp] stdio transport ready · root=${core.root}${readOnly ? ' · read-only' : ''}\n`);
