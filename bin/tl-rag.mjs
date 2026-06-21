#!/usr/bin/env node
/**
 * tl-rag.mjs — Start the tokenlean RAG MCP server.
 *
 * Usage:
 *   tl-rag http --token SECRET [--port 8766] [--kb-index "str"]
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ragBin = join(here, '..', '03-rag-server', 'bin', 'http.mjs');
const [, , transport, ...rest] = process.argv;

if (transport === 'http') {
  spawn('node', [ragBin, ...rest], { stdio: 'inherit' });
} else {
  console.log(`tl-rag — Start tokenlean RAG MCP server

Usage:
  tl-rag http --token SECRET [--port 8766] [--kb-index "str"]

Examples:
  tl-rag http --token secret --port 8766
  tl-rag http --token secret --kb-index "Product docs, API ref"
`);
  process.exit(1);
}
