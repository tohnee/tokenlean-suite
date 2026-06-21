#!/usr/bin/env node
/**
 * tokenlean.mjs — unified launcher for the RAG MCP server.
 *
 *   tokenlean-rag http  --token SECRET [--port N] [--kb-index "str"]
 *   tokenlean-rag test
 *   tokenlean-rag help
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
  case 'http':
    run('bin/http.mjs', rest);
    break;
  case 'test':
    run('test/test-rag.mjs', rest);
    break;
  default:
    console.log(`tokenlean-rag — cache-aware RAG MCP server

USAGE
  tokenlean-rag http --token SECRET [--port 8766] [--kb-index "str"]
      HTTP transport for chatbot connectors. Auth required.

  tokenlean-rag test
      Run the test suite.

EXAMPLES
  # Start with a simple KB index
  TOKENLEAN_RAG_TOKEN=secret tokenlean-rag http --port 8766

  # With a KB index describing your knowledge base
  TOKENLEAN_RAG_TOKEN=secret tokenlean-rag http \\
    --kb-index "Our knowledge base covers: product docs, API reference, support articles."

  # Expose via a tunnel for Claude.ai connectors
  cloudflared tunnel --url http://127.0.0.1:8766
`);
    process.exit(cmd && cmd !== 'help' ? 1 : 0);
}
