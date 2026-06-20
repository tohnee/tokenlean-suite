#!/usr/bin/env node
/**
 * test-http.mjs — exercises the WEB form (Streamable HTTP transport).
 * Spawns bin/http.mjs, then drives it with real HTTP requests exactly as a
 * web copilot connector would: Bearer auth, POST /mcp, Mcp-Session-Id.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTTP = join(__dirname, '..', 'bin', 'http.mjs');
const SANDBOX = join('/tmp', 'tokenlean-http-' + Date.now());
const TOKEN = 'test-secret-token';
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

mkdirSync(join(SANDBOX, 'src'), { recursive: true });
writeFileSync(join(SANDBOX, 'src', 'app.ts'),
  `function greet(name) {\n  return "hi " + name;\n}\n\nfunction bye(name) {\n  return "bye " + name;\n}\n`);

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${d}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. refuses to start without token ──
console.log('═══ tokenlean-mcp HTTP (web) transport test ═══\n');
console.log('[0] refuses to start without a token');
const noTok = spawn('node', [HTTP, '--root', SANDBOX, '--port', String(PORT + 1)], { stdio: 'pipe' });
let noTokErr = '';
noTok.stderr.on('data', (d) => (noTokErr += d));
const noTokCode = await new Promise((r) => noTok.on('exit', r));
check('exits non-zero without token', noTokCode === 2, `code=${noTokCode}`);
check('explains why', /no auth token/.test(noTokErr));

// ── boot the real server ──
const srv = spawn('node', [HTTP, '--root', SANDBOX, '--port', String(PORT), '--token', TOKEN], { stdio: 'pipe' });
srv.stderr.on('data', () => {});
await sleep(400);

let nextId = 1;
let sessionId = null;
async function rpc(method, params, { auth = true, sid = sessionId } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers['authorization'] = `Bearer ${TOKEN}`;
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }) });
  const text = await res.text();
  return { status: res.status, sid: res.headers.get('mcp-session-id'), json: text ? JSON.parse(text) : null };
}
const callTool = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return { text: r.json?.result?.content?.[0]?.text ?? '', isError: r.json?.result?.isError, status: r.status };
};

// ── 2. health check (no auth) ──
console.log('\n[1] health check (no auth)');
const health = await fetch(`${BASE}/healthz`).then((r) => r.json());
check('healthz ok', health.ok === true);

// ── 3. auth enforcement ──
console.log('\n[2] auth enforcement');
const noauth = await rpc('tools/list', {}, { auth: false });
check('401 without bearer token', noauth.status === 401, `status=${noauth.status}`);
const badauth = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
check('401 with wrong token', badauth.status === 401);

// ── 4. initialize → session id ──
console.log('\n[3] initialize establishes a session');
const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'web-test', version: '0' } });
check('initialize 200', init.status === 200);
check('returns serverInfo', init.json?.result?.serverInfo?.name === 'tokenlean-mcp');
check('returns Mcp-Session-Id header', !!init.sid, `sid=${init.sid}`);
sessionId = init.sid;

// ── 5. tools/list over HTTP ──
console.log('\n[4] tools/list over HTTP');
const list = await rpc('tools/list', {});
const names = (list.json?.result?.tools ?? []).map((t) => t.name);
check('6 tools', names.length === 6, names.join(','));

// ── 6. full read→edit→verify round trip over HTTP ──
console.log('\n[5] read → edit → verify (web round trip)');
const read = await callTool('fs_read_hashed', { path: 'src/app.ts' });
check('read returns anchors', /\d+:[0-9a-f]{2,6}\s\s/.test(read.text));
const a1 = /^\s*1:([0-9a-f]{2,6})/m.exec(read.text)?.[1];
const a2 = /^\s*2:([0-9a-f]{2,6})/m.exec(read.text)?.[1];
const a3 = /^\s*3:([0-9a-f]{2,6})/m.exec(read.text)?.[1];
const edit = await callTool('fs_edit_hash', { path: 'src/app.ts', start: `1:${a1}`, end: `3:${a3}`, content: 'function greet(name) {\n  return `hi ${name}!`;\n}' });
check('edit applied over HTTP', edit.text.includes('✓') && !edit.isError, edit.text.slice(0, 120));
const verify = await callTool('fs_read_hashed', { path: 'src/app.ts', start_line: 1, end_line: 3 });
check('change persisted', verify.text.includes('`hi ${name}!`'));

// ── 7. stale anchor still fails fast over HTTP ──
// line 2 genuinely changed (return body), so its OLD hash is now stale
console.log('\n[6] fail-fast preserved over HTTP');
const stale = await callTool('fs_edit_hash', { path: 'src/app.ts', start: `2:${a2}`, end: `2:${a2}`, content: 'X', allow_relocate: false });
check('stale rejected', stale.isError === true && stale.text.includes('HASH MISMATCH'));

// ── 8. sandbox holds over HTTP ──
console.log('\n[7] sandbox enforced over HTTP');
const escape = await callTool('fs_read_hashed', { path: '../../../etc/passwd' });
check('escape blocked', escape.isError === true && escape.text.includes('escapes workspace'));

// ── 9. session isolation ──
console.log('\n[8] per-session isolation');
const init2 = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'web-test-2', version: '0' } });
check('second session has different id', init2.sid && init2.sid !== sessionId, `s1=${sessionId} s2=${init2.sid}`);

// ── 10. DELETE /mcp terminates a session (spec compliance + leak fix) ──
console.log('\n[9] session termination via DELETE /mcp');
const delInit = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'web-del', version: '0' } });
const delSid = delInit.sid;
const healthBefore = await fetch(`${BASE}/healthz`).then((r) => r.json());
const delRes = await fetch(`${BASE}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}`, 'mcp-session-id': delSid } });
const delBody = await delRes.json();
check('DELETE returns ok', delRes.status === 200 && delBody.ok === true, `status=${delRes.status}`);
const healthAfter = await fetch(`${BASE}/healthz`).then((r) => r.json());
check('session count decreased after DELETE', healthAfter.sessions < healthBefore.sessions, `before=${healthBefore.sessions} after=${healthAfter.sessions}`);
const delUnknown = await fetch(`${BASE}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}`, 'mcp-session-id': 'no-such-session' } });
check('DELETE unknown session → 404', delUnknown.status === 404);
const delNoAuth = await fetch(`${BASE}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': delSid } });
check('DELETE requires auth', delNoAuth.status === 401);

// ── 11. __default__ fallback session (sessionless client tolerance) ──
// A client that omits mcp-session-id on a non-initialize request should still
// get service via a shared __default__ core. Two such clients share state.
console.log('\n[10] __default__ fallback for sessionless clients');
// capture stderr to verify the warning is logged
let stderrBuf = '';
srv.stderr.on('data', (d) => { stderrBuf += d.toString(); });
// request without mcp-session-id and without going through initialize first
const sessBefore = (await fetch(`${BASE}/healthz`).then((r) => r.json())).sessions;
const fb1 = await rpc('tools/call', { name: 'fs_read_hashed', arguments: { path: 'src/app.ts' } }, { sid: null });
check('sessionless request succeeds via fallback', fb1.status === 200 && !!fb1.json?.result?.content?.[0]?.text, `status=${fb1.status}`);
check('fallback warning logged on stderr', /WARNING.*__default__/.test(stderrBuf), `stderr: ${stderrBuf.slice(0, 200)}`);
const sessAfter = (await fetch(`${BASE}/healthz`).then((r) => r.json())).sessions;
check('__default__ session created', sessAfter === sessBefore + 1, `before=${sessBefore} after=${sessAfter}`);
// a second sessionless request reuses the same __default__ (no new session)
const fb2 = await rpc('tools/call', { name: 'token_report', arguments: {} }, { sid: null });
check('second sessionless request reuses __default__', (await fetch(`${BASE}/healthz`).then((r) => r.json())).sessions === sessAfter, `sessions grew unexpectedly`);
// __default__ shares state: the read above is visible in token_report's accounting? 
// (token_report tracks edits, not reads, so we verify isolation differently:
//  two sessionless clients share the SAME core, so edits by one are visible to the other)
const fbEdit = await rpc('tools/call', {
  name: 'fs_edit_hash',
  arguments: { path: 'src/app.ts', start: '1:0000', end: '1:0000', content: 'X', allow_relocate: false },
}, { sid: null });
check('sessionless edit attempt handled (rejected as stale)', fbEdit.json?.result?.isError === true);
// __default__ can be DELETEd too (TTL eviction parity)
const delDef = await fetch(`${BASE}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}`, 'mcp-session-id': '__default__' } });
check('DELETE __default__ returns ok', delDef.status === 200);
const sessAfterDel = (await fetch(`${BASE}/healthz`).then((r) => r.json())).sessions;
check('__default__ evicted by DELETE', sessAfterDel === sessAfter - 1, `expected ${sessAfter - 1}, got ${sessAfterDel}`);
// clean up stderr listener
srv.stderr.removeAllListeners('data');

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
srv.kill();
rmSync(SANDBOX, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
