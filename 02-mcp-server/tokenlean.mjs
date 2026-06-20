#!/usr/bin/env node
/**
 * tokenlean — unified launcher.
 *
 *   tokenlean stdio  [--root DIR] [--read-only]              # local CLI agents
 *   tokenlean http   --token SECRET [--root DIR] [--port N]  # web copilots
 *   tokenlean test                                           # run both test suites
 *   tokenlean help
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [, , cmd, ...rest] = process.argv;

function run(file, args, opts = {}) {
  const p = spawn('node', [join(here, file), ...args], { stdio: 'inherit', ...opts });
  p.on('exit', (c) => process.exit(c ?? 0));
}

switch (cmd) {
  case 'stdio':
    run('bin/stdio.mjs', rest);
    break;
  case 'http':
    run('bin/http.mjs', rest);
    break;
  case 'test': {
    const stdio = spawn('node', [join(here, 'test/test-stdio.mjs')], { stdio: 'inherit' });
    stdio.on('exit', (c1) => {
      const http = spawn('node', [join(here, 'test/test-http.mjs')], { stdio: 'inherit' });
      http.on('exit', (c2) => process.exit((c1 || 0) || (c2 || 0)));
    });
    break;
  }
  default:
    console.log(`tokenlean — token-lean MCP tools for any coding agent or web copilot

USAGE
  tokenlean stdio [--root DIR] [--read-only]
      Local CLI form. For Claude Code, OpenCode, Codex CLI, Cursor, etc.
      The agent spawns this; files and agent share one machine. No network.

  tokenlean http --token SECRET [--root DIR] [--port 8765] [--host 127.0.0.1] [--read-only]
      Web copilot form. A long-lived network service for Claude.ai connectors,
      ChatGPT, custom chatbots. Files live where THIS process runs. Auth required.

  tokenlean test
      Run both transport test suites (stdio + http).

EXAMPLES
  # Claude Code / Cursor (configured in their MCP json — see configs/)
  tokenlean stdio --root .

  # Expose to a web copilot from your own machine via a tunnel
  TOKENLEAN_TOKEN=$(openssl rand -hex 16) tokenlean http --root ~/myrepo
  cloudflared tunnel --url http://127.0.0.1:8765
`);
    process.exit(cmd && cmd !== 'help' ? 1 : 0);
}
