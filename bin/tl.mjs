#!/usr/bin/env node

/**
 * tokenlean-suite unified CLI entry point.
 *
 * Usage:
 *   tl help                         # Show help
 *   tl mcp [stdio|http] [options]   # Start MCP server
 *   tl rag http --token SECRET ...  # Start RAG server
 *   tl audit                        # Token usage audit
 *   tl plan <system> <kb> <query>   # Cache layout analysis
 *   tl normalize <file>             # Normalize RAG chunks
 *   tl symbols <path>               # Code structure outline
 *   tl snippet <name> [path]        # Extract function/class by name
 *   tl bench                        # Run unified savings benchmark
 *   tl test                         # Run all test suites
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [, , cmd, ...args] = process.argv;

const BIN_TL = (name) => join(here, `tl-${name}.mjs`);

function run(file) {
  if (!existsSync(file)) {
    console.error(`[tokenlean] tool not found: ${file}`);
    process.exit(1);
  }
  const p = spawn('node', [file, ...args], { stdio: 'inherit' });
  p.on('exit', (c) => process.exit(c ?? 0));
}

function showHelp() {
  console.log(`tokenlean-suite — Token-saving architecture framework

USAGE
  tl help              Show this message
  tl mcp stdio         Start MCP server in stdio mode (for Claude Code, etc.)
  tl mcp http          Start MCP server in HTTP mode (for web copilots)
  tl rag http          Start RAG MCP server (for chatbots)
  tl audit             Analyze token usage from session transcripts
  tl plan [json]       Analyze cache-aware prompt layout
  tl normalize [file]  Normalize RAG chunks by stable id
  tl symbols [path]    Show code structure outline
  tl snippet [name]    Extract function/class by name
  tl bench             Run OUTPUT + FUTURE + INPUT/RAG benchmarks
  tl test              Run all test suites

EXAMPLES
  tl mcp stdio --root .
  tl rag http --token secret --port 8766
  tl audit --claudecode
  tl bench --out SAVINGS-REPORT.md
  tl normalize results.json`);
}

switch (cmd) {
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
  case 'test':
    execSync('npm test', { cwd: here, stdio: 'inherit' });
    break;
  case 'mcp':
    run(BIN_TL('mcp'));
    break;
  case 'rag':
    run(BIN_TL('rag'));
    break;
  case 'audit':
    run(BIN_TL('audit'));
    break;
  case 'plan':
    run(BIN_TL('plan'));
    break;
  case 'normalize':
    run(BIN_TL('normalize'));
    break;
  case 'symbols':
    run(BIN_TL('symbols'));
    break;
  case 'snippet':
    run(BIN_TL('snippet'));
    break;
  case 'bench':
    run(BIN_TL('bench'));
    break;
  default:
    if (cmd) console.error(`[tokenlean] unknown command: ${cmd}\n`);
    showHelp();
    process.exit(cmd ? 1 : 0);
}
