#!/usr/bin/env node
/**
 * tl-rag.mjs — Start the tokenlean RAG MCP server.
 *
 * Usage:
 *   tl-rag http --token SECRET [--port 8766] [--kb-index "str"]
 *   tl-rag bench [--json] [--out report.md]
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ragBin = join(here, '..', '03-rag-server', 'bin', 'http.mjs');
const ragBench = join(here, '..', '03-rag-server', 'bench', 'chatbot-rag-benchmark.mjs');
const [, , transport, ...rest] = process.argv;

function run(file) {
  const p = spawn('node', [file, ...rest], { stdio: 'inherit' });
  p.on('exit', (code, signal) => {
    if (signal) { process.kill(process.pid, signal); return; }
    process.exit(code ?? 0);
  });
  p.on('error', (e) => { console.error(`[tokenlean] failed to spawn ${file}: ${e.message}`); process.exit(127); });
}

if (transport === 'http') {
  run(ragBin);
} else if (transport === 'bench') {
  run(ragBench);
} else {
  console.log(`tl-rag — Start tokenlean RAG MCP server

Usage:
  tl-rag http --token SECRET [--port 8766] [--kb-index "str"]
  tl-rag bench [--json] [--out report.md]

Examples:
  tl-rag http --token secret --port 8766
  tl-rag http --token secret --kb-index "Product docs, API ref"
  tl-rag bench
  tl-rag bench --json --out /tmp/tokenlean-rag-benchmark.json
`);
  process.exit(1);
}
