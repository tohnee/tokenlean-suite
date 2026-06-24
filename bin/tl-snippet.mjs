#!/usr/bin/env node
/**
 * tl-snippet.mjs — Search for a function/class declaration and read its region
 * with hashed line anchors. Wraps the MCP core's search_lean + fs_read_hashed.
 *
 * Usage:
 *   tl-snippet <name>            # search workspace for `function|class|def NAME`
 *   tl-snippet <name> <path>     # restrict the search to <path>
 *
 * Exit codes:
 *   0 ok
 *   1 no match / read error
 *   2 bad arguments
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(here, '..', '02-mcp-server', 'lib', 'core.mjs');

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
  console.log(`tl-snippet — extract a function/class by name

Usage:
  tl-snippet <name> [path]

Examples:
  tl-snippet handleSubmit
  tl-snippet createCore 02-mcp-server/lib/core.mjs`);
  process.exit(argv.length === 0 ? 2 : 0);
}

const [name, scope] = argv;
const { createCore } = await import(CORE);
const core = createCore({ root: process.cwd(), readOnly: true });

// declaration-like prefixes covering JS/TS/Python/Go/Rust/Java/C#
const pattern = `\\b(function|class|def|fn|interface|type|struct|trait|impl|func)\\s+${name}\\b`;
const search = core.dispatch({
  jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name: 'search_lean', arguments: { pattern, path: scope ?? '.' } },
});
const text = search?.result?.content?.[0]?.text ?? '';
console.log(text);

const m = /^(\S+):(\d+):/m.exec(text);
if (!m) {
  console.error(`[tokenlean] no declaration named "${name}" found.`);
  process.exit(1);
}
const [, file, lineStr] = m;
const startLine = Math.max(1, Number(lineStr) - 1);
const read = core.dispatch({
  jsonrpc: '2.0', id: 2, method: 'tools/call',
  params: { name: 'fs_read_hashed', arguments: { path: file, start_line: startLine, end_line: startLine + 80 } },
});
console.log('\n' + (read?.result?.content?.[0]?.text ?? '(empty)'));
process.exit(read?.result?.isError ? 1 : 0);
