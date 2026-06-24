#!/usr/bin/env node
/**
 * test-client.mjs — protocol-level test suite for tokenlean-mcp.
 * Spawns the server as a child process and speaks real MCP (NDJSON JSON-RPC 2.0)
 * over stdio, exactly as Claude Code / Cursor / OpenCode would.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'bin', 'stdio.mjs');
const SANDBOX = join('/tmp', 'tokenlean-test-' + Date.now());

// ── sandbox fixtures ──
mkdirSync(join(SANDBOX, 'src'), { recursive: true });

writeFileSync(join(SANDBOX, 'src', 'app.ts'), `function greet(name: string) {
  console.log("Hello, " + name);
}

function farewell(name: string) {
  console.log("Bye, " + name);
}

export class UserService {
  private users: Map<string, string> = new Map();

  addUser(id: string, name: string) {
    this.users.set(id, name);
  }

  getUser(id: string) {
    return this.users.get(id);
  }
}
`);

// big file: 1200 lines
writeFileSync(join(SANDBOX, 'src', 'big.ts'),
  Array.from({ length: 1200 }, (_, i) =>
    i % 100 === 0 ? `export function chunk${i / 100}() {` :
    i % 100 === 99 ? `}` :
    `  const v${i} = ${i}; // filler line with deprecated_api maybe ${i % 37 === 0 ? 'deprecated_api()' : ''}`
  ).join('\n') + '\n');

// oversized file: should be rejected before full read
writeFileSync(join(SANDBOX, 'src', 'huge.log'), 'x'.repeat(1_100_000));

// ── minimal MCP client ──
const child = spawn('node', [SERVER, '--root', SANDBOX], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', () => {}); // ignore banner

let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return { text: r.result?.content?.[0]?.text ?? '', isError: r.result?.isError, raw: r };
};

// ── assertions ──
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

// ── run ──
const t0 = Date.now();
console.log('═══ tokenlean-mcp protocol test suite ═══\n');

// 1. handshake
console.log('[1] MCP handshake');
const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {}, clientInfo: { name: 'test-client', version: '0.0.1' },
});
check('initialize returns serverInfo', init.result?.serverInfo?.name === 'tokenlean-mcp');
check('initialize returns tools capability', !!init.result?.capabilities?.tools);
notify('notifications/initialized');

// 2. tools/list
console.log('\n[2] tools/list');
const list = await rpc('tools/list', {});
const names = (list.result?.tools ?? []).map((t) => t.name);
check('6 tools exposed', names.length === 6, `got: ${names.join(',')}`);
check('all tools have inputSchema', (list.result?.tools ?? []).every((t) => t.inputSchema?.type === 'object'));

// 3. fs_read_hashed
console.log('\n[3] fs_read_hashed');
const read1 = await call('fs_read_hashed', { path: 'src/app.ts' });
check('reads file with anchors', /\d+:[0-9a-f]{2,6}\s\s/.test(read1.text), read1.text.slice(0, 120));
check('shows line count header', read1.text.includes('lines 1-'), read1.text.split('\n')[0]);
const anchorOf = (text, lineNo) => {
  const m = new RegExp(`^\\s*${lineNo}:([0-9a-f]{2,6})`, 'm').exec(text);
  return m ? `${lineNo}:${m[1]}` : null;
};
const a1 = anchorOf(read1.text, 1), a3 = anchorOf(read1.text, 3);
check('anchors parseable', !!a1 && !!a3, `a1=${a1} a3=${a3}`);

// 4. lean-read enforcement on big file
console.log('\n[4] lean-read enforcement (1200-line file)');
const readBig = await call('fs_read_hashed', { path: 'src/big.ts' });
check('big read capped at 200 lines', readBig.text.includes('lines 1-200 of 1200'), readBig.text.split('\n')[0]);
check('nudges toward fs_outline', readBig.text.includes('fs_outline'));
check('response under char budget', readBig.text.length < 25000, `len=${readBig.text.length}`);

// 5. fs_outline
console.log('\n[5] fs_outline');
const outline = await call('fs_outline', { path: 'src/big.ts' });
const outlineLines = outline.text.split('\n').length;
check('outline finds chunk functions', outline.text.includes('chunk0') && outline.text.includes('chunk11'));
check('outline is tiny vs full file', outline.text.length < 2500, `len=${outline.text.length} (full file ~70KB)`);
console.log(`    → outline: ${outline.text.length} chars (~${Math.ceil(outline.text.length/4)} tokens) vs full read ~70000 chars (~17500 tokens)`);

// 5b. oversized read protection
console.log('\n[5b] oversized read protection');
const hugeRead = await call('fs_read_hashed', { path: 'src/huge.log' });
check('oversized file read rejected before full load', hugeRead.isError === true && hugeRead.text.includes('READ_MAX_FILE_BYTES'), hugeRead.text.slice(0, 200));

// 6. fs_edit_hash happy path
console.log('\n[6] fs_edit_hash success');
const edit1 = await call('fs_edit_hash', {
  path: 'src/app.ts', start: a1, end: a3,
  content: 'function greet(name: string, formal = false): void {\n  const msg = formal ? `Good day, ${name}` : `Hello, ${name}!`;\n  console.log(msg);\n}',
});
check('edit applied', edit1.text.includes('✓') && !edit1.isError, edit1.text.slice(0, 200));
check('returns fresh anchors', /Fresh anchors/.test(edit1.text));
const after = readFileSync(join(SANDBOX, 'src', 'app.ts'), 'utf8');
check('file content actually changed', after.includes('formal = false') && after.includes('Good day'));
check('untouched parts intact', after.includes('class UserService'));

// 7. stale anchor rejection
console.log('\n[7] stale anchor → fail-fast');
const editStale = await call('fs_edit_hash', {
  path: 'src/app.ts', start: a1, end: a3, content: 'SHOULD NOT APPLY', allow_relocate: false,
});
check('stale edit rejected', editStale.isError === true);
check('mentions HASH MISMATCH', editStale.text.includes('HASH MISMATCH'));
check('returns current anchors inline (no full re-read needed)', /\d+:[0-9a-f]{2,6}\s\s/.test(editStale.text));
const after2 = readFileSync(join(SANDBOX, 'src', 'app.ts'), 'utf8');
check('file untouched after rejection', !after2.includes('SHOULD NOT APPLY'));

// 8. auto-relocation: insert lines above target, reuse old anchors
console.log('\n[8] anchor auto-relocation');
const readNow = await call('fs_read_hashed', { path: 'src/app.ts' });
// find farewell function anchors (content unchanged since fixture)
const fwLineMatch = /^\s*(\d+):([0-9a-f]{2,6})\s\sfunction farewell/m.exec(readNow.text);
const fwLine = Number(fwLineMatch[1]);
const fwAnchor = `${fwLine}:${fwLineMatch[2]}`;
const fwEndMatch = new RegExp(`^\\s*(${fwLine + 2}):([0-9a-f]{2,6})`, 'm').exec(readNow.text);
const fwEnd = `${fwLine + 2}:${fwEndMatch[2]}`;
// shift file: add 3 comment lines at top via fresh-anchor edit
const top = await call('fs_read_hashed', { path: 'src/app.ts', start_line: 1, end_line: 1 });
const topAnchor = anchorOf(top.text, 1);
await call('fs_edit_hash', {
  path: 'src/app.ts', start: topAnchor, end: topAnchor,
  content: '// header line 1\n// header line 2\n// header line 3\n' + top.text.match(/^\s*1:[0-9a-f]{2,6}\s\s(.*)$/m)[1],
});
// now farewell anchors are stale by 3 lines — relocation should fix it
const editReloc = await call('fs_edit_hash', {
  path: 'src/app.ts', start: fwAnchor, end: fwEnd,
  content: 'function farewell(name: string): void {\n  console.log(`Goodbye, ${name}.`);\n}',
});
check('relocated edit applied', editReloc.text.includes('✓'), editReloc.text.slice(0, 200));
check('reports auto-relocation', editReloc.text.includes('auto-relocated'));
const after3 = readFileSync(join(SANDBOX, 'src', 'app.ts'), 'utf8');
check('relocated content correct', after3.includes('Goodbye, ${name}'));

// 9. multi-edit atomicity
console.log('\n[9] fs_multi_edit_hash atomicity');
const readMulti = await call('fs_read_hashed', { path: 'src/app.ts' });
const g1 = anchorOf(readMulti.text, 4); // inside greet
const badBatch = await call('fs_multi_edit_hash', {
  path: 'src/app.ts',
  edits: [
    { start: g1, end: g1, content: '  // touched A' },
    { start: '999:zz', end: '999:zz', content: 'bad' },
  ],
  allow_relocate: false,
});
check('batch with bad anchor rejected entirely', badBatch.isError === true || badBatch.text.includes('✗'));
const after4 = readFileSync(join(SANDBOX, 'src', 'app.ts'), 'utf8');
check('no partial application', !after4.includes('// touched A'));

// valid batch
const rm = await call('fs_read_hashed', { path: 'src/app.ts' });
const b1 = anchorOf(rm.text, 4), b2 = anchorOf(rm.text, 5);
const lastLineNo = rm.text.match(/lines 1-(\d+) of (\d+)/)[2];
const goodBatch = await call('fs_multi_edit_hash', {
  path: 'src/app.ts',
  edits: [
    { start: b1, end: b1, content: rm.text.match(new RegExp(`^\\s*4:[0-9a-f]{2,6}\\s\\s(.*)$`, 'm'))[1] + ' // edited-A' },
    { start: b2, end: b2, content: rm.text.match(new RegExp(`^\\s*5:[0-9a-f]{2,6}\\s\\s(.*)$`, 'm'))[1] + ' // edited-B' },
  ],
});
check('valid batch applies both', goodBatch.text.includes('2 edit(s) applied'), goodBatch.text.slice(0, 150));
const after5 = readFileSync(join(SANDBOX, 'src', 'app.ts'), 'utf8');
check('both edits present', after5.includes('// edited-A') && after5.includes('// edited-B'));

// 10. search_lean budgets
console.log('\n[10] search_lean budget enforcement');
const search = await call('search_lean', { pattern: 'deprecated_api', path: 'src' });
check('finds matches with anchors', /big\.ts:\d+:[0-9a-f]{2,6}/.test(search.text), search.text.split('\n')[1]);
check('reports total vs shown', /\d+ match\(es\)/.test(search.text));
const matchLines = search.text.split('\n').filter((l) => l.includes('big.ts:')).length;
check('respects default cap (25)', matchLines <= 25, `shown=${matchLines}`);
const searchAll = await call('search_lean', { pattern: 'const v', path: 'src', max_results: 999 });
const shownAll = searchAll.text.split('\n').filter((l) => l.includes('big.ts:')).length;
check('hard cap (80) enforced even when asked for 999', shownAll <= 80, `shown=${shownAll}`);

// 11. path safety
console.log('\n[11] workspace sandboxing');
const escape = await call('fs_read_hashed', { path: '../../etc/passwd' });
check('path escape rejected', escape.isError === true && escape.text.includes('escapes workspace'));

// 12. token_report
console.log('\n[12] token_report');
const report = await call('token_report', {});
check('reports edits count', /edits applied:\s+\d+/.test(report.text));
check('reports savings estimate', /saved vs full rewrite:\s+~\d+/.test(report.text));
console.log('\n--- session report ---\n' + report.text + '\n----------------------');

// ── OUTPUT token comparison (MCP-format realistic) ──
console.log('\n[13] OUTPUT token comparison (realistic tool-call JSON)');
// the model's actual output = the tool_use JSON it must generate
const replacedLines = `function greet(name: string) {\n  console.log("Hello, " + name);\n}`;
const newContent = 'function greet(name: string, formal = false): void {\n  const msg = formal ? `Good day, ${name}` : `Hello, ${name}!`;\n  console.log(msg);\n}';
const nativeCall = JSON.stringify({ name: 'Edit', input: { file_path: 'src/app.ts', old_str: replacedLines, new_str: newContent } });
const mcpCall = JSON.stringify({ name: 'fs_edit_hash', input: { path: 'src/app.ts', start: '1:b2', end: '3:d1', content: newContent } });
const tok = (s) => Math.ceil(s.length / 4);
console.log(`    native Edit tool_use JSON:   ${nativeCall.length} chars ≈ ${tok(nativeCall)} tokens`);
console.log(`    fs_edit_hash tool_use JSON:  ${mcpCall.length} chars ≈ ${tok(mcpCall)} tokens`);
console.log(`    savings: ${Math.round((1 - tok(mcpCall) / tok(nativeCall)) * 100)}% on this edit`);
check('hash-anchored call smaller than native', mcpCall.length < nativeCall.length);

// [14] relocation safety (regression for the 27% silent-misedit bug)
console.log('\n[14] relocation safety');
{
  // stale single-line anchor (wrong hash on an existing line):
  // must be REFUSED, never silently relocated to another matching line.
  const staleSingle = await call('fs_edit_hash', { path: 'src/app.ts', start: '2:0000', end: '2:0000', content: 'WRONGLY RELOCATED' });
  ok2('stale single-line anchor refused (not silently relocated)', staleSingle.isError === true);
  const body = readFileSync(join(SANDBOX, 'src', 'app.ts'), 'utf8');
  ok2('file NOT corrupted by relocation', !body.includes('WRONGLY RELOCATED'));
  ok2('error explains single-line relocation is unsafe', /single-line|AMBIGUOUS|MISMATCH/.test(staleSingle.text));
}
function ok2(n, c) { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } }


// ── done ──
console.log(`\n═══ ${pass} passed, ${fail} failed  (${Date.now() - t0}ms) ═══`);
child.kill();
rmSync(SANDBOX, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
