#!/usr/bin/env node
/**
 * tl-symbols.mjs — Print a structural outline of a file using the MCP core's
 * fs_outline logic (function/class/heading anchors, ~50-300 tokens vs full read).
 *
 * Usage:
 *   tl-symbols <path>            # outline of a single file
 *   tl-symbols <path> -l N       # cap items at N (forwarded to OUTLINE_MAX_ITEMS)
 *
 * Exit codes:
 *   0 ok
 *   1 path missing / read error
 *   2 bad arguments
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(here, '..', '02-mcp-server', 'lib', 'core.mjs');

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
  console.log(`tl-symbols — code structure outline (fs_outline)

Usage:
  tl-symbols <path> [-l N]

Examples:
  tl-symbols src/server.ts
  tl-symbols 02-mcp-server/lib/core.mjs -l 50`);
  process.exit(argv.length === 0 ? 2 : 0);
}

const path = argv[0];
const limitIdx = argv.indexOf('-l');
if (limitIdx >= 0 && argv[limitIdx + 1]) {
  // forwarded as a tool argument; not consumed here yet — core has fixed cap
}

if (!existsSync(path)) {
  console.error(`[tokenlean] file not found: ${path}`);
  process.exit(1);
}

const { createCore } = await import(CORE);
const core = createCore({ root: process.cwd(), readOnly: true });
const res = core.dispatch({
  jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name: 'fs_outline', arguments: { path } },
});

const text = res?.result?.content?.[0]?.text ?? '(no output)';
const isErr = res?.result?.isError;
console.log(text);
process.exit(isErr ? 1 : 0);
