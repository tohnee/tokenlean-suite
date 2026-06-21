#!/usr/bin/env node
/**
 * tl-mcp.mjs — Start the tokenlean MCP server.
 *
 * Usage:
 *   tl-mcp stdio [--root DIR]          # stdio mode (Claude Code, etc.)
 *   tl-mcp http --token SECRET [opts]  # HTTP mode (web copilots)
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const binDir = join(here, '..', '02-mcp-server', 'bin');
const [, , transport, ...rest] = process.argv;

if (transport === 'stdio') {
  spawn('node', [join(binDir, 'stdio.mjs'), ...rest], { stdio: 'inherit' });
} else if (transport === 'http') {
  spawn('node', [join(binDir, 'http.mjs'), ...rest], { stdio: 'inherit' });
} else {
  console.log(`tl-mcp — Start tokenlean MCP server

Usage:
  tl-mcp stdio [--root DIR]            Local CLI agents (Claude Code, OpenCode…)
  tl-mcp http --token SECRET [--port]  Web copilots (HTTP transport)

Examples:
  tl-mcp stdio --root .
  tl-mcp http --token secret --port 8765
`);
  process.exit(1);
}
