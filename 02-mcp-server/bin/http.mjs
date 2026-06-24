#!/usr/bin/env node
/**
 * bin/http.mjs — STREAMABLE HTTP transport (WEB COPILOT / CHATBOT form).
 *
 * For web clients that CANNOT spawn a local process and must reach the
 * server over the network: Claude.ai connectors, ChatGPT, custom chatbots.
 *
 * Key differences from the stdio form:
 *   1. The server is a long-lived network service, not a per-call child.
 *   2. It is REMOTE: the files live where THIS process runs, not on the
 *      user's laptop. You point --root at a repo on the host (a VPS, a
 *      container, or your own machine exposed via a tunnel).
 *   3. Because it is network-reachable, auth + sandbox are MANDATORY.
 *      A bearer token is required (--token or TOKENLEAN_TOKEN). Every
 *      request is confined to --root by the core's path guard.
 *
 * Implements a practical subset of MCP "Streamable HTTP": POST /mcp returns a
 * single JSON response (no server-initiated SSE stream; GET /mcp is not used),
 * DELETE /mcp terminates a session, GET /healthz is unauthenticated. This works
 * with clients that accept JSON responses; clients that REQUIRE an SSE stream on
 * GET /mcp are not supported. Zero dependencies (node:http).
 *
 * Usage:
 *   TOKENLEAN_TOKEN=secret node bin/http.mjs --root /srv/repo --port 8765
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createCore, LIMITS } from '../lib/core.mjs';

function argOf(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const root = argOf('--root', process.cwd());
const port = Number(argOf('--port', process.env.PORT || '8765'));
const host = argOf('--host', '127.0.0.1'); // default localhost; set 0.0.0.0 to expose
const token = argOf('--token', process.env.TOKENLEAN_TOKEN || '');
const readOnly = process.argv.includes('--read-only');

if (!token) {
  process.stderr.write(
    '[tokenlean-mcp] REFUSING TO START: no auth token.\n' +
    '  A network-exposed MCP server must require a bearer token.\n' +
    '  Set --token <secret> or TOKENLEAN_TOKEN=<secret>.\n'
  );
  process.exit(2);
}

// One core per session id. A session is created on `initialize`.
// Each entry: { core, lastSeen }. Idle sessions are swept on a timer and the
// total is capped, so a long-running server cannot leak memory unboundedly.
//
// __default__ session: a fallback for clients that omit mcp-session-id on
// non-initialize requests (e.g. minimal one-shot scripts). All such clients
// SHARE one core, so their token_report stats and edit counters mix. This is
// acceptable for read-only Q&A but NOT for concurrent editing sessions —
// each editing client MUST send mcp-session-id. A warning is logged on first
// fallback use per idle period. __default__ is also TTL-evicted (unlike the
// previous behavior) so it cannot accumulate state forever.
const sessions = new Map(); // sid → { core, lastSeen }
const SESSION_TTL_MS = Number(process.env.TOKENLEAN_SESSION_TTL_MS || 30 * 60 * 1000); // 30 min idle
const SESSION_MAX = Number(process.env.TOKENLEAN_SESSION_MAX || 1000);
let defaultWarned = false; // suppress repeated warnings within one TTL window

function touch(sid) {
  const s = sessions.get(sid);
  if (s) s.lastSeen = Date.now();
}
function sweepSessions() {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    // __default__ is also evicted on idle — it gets recreated on next fallback
    if (now - s.lastSeen > SESSION_TTL_MS) {
      sessions.delete(sid);
      if (sid === '__default__') defaultWarned = false;
    }
  }
  // hard cap: if still over, evict oldest
  if (sessions.size > SESSION_MAX) {
    const sorted = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [sid] of sorted.slice(0, sessions.size - SESSION_MAX)) {
      sessions.delete(sid);
      if (sid === '__default__') defaultWarned = false;
    }
  }
}
const sweepTimer = setInterval(sweepSessions, 60 * 1000);
sweepTimer.unref?.(); // don't keep the process alive just for the sweep

function authed(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m && m[1] === token;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += buf.length;
      if (size > 8_000_000) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(buf);
    });
    req.on('end', () => {
      try { resolve(Buffer.concat(chunks).toString('utf8')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Tools that mutate the workspace; sessionless clients are NOT allowed to call
// these via the shared __default__ core (state would mix between unrelated
// clients). Read-only tools remain available as a best-effort Q&A fallback.
const MUTATING_TOOLS = new Set(['fs_edit_hash', 'fs_multi_edit_hash']);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // health check (no auth)
  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    return;
  }

  // everything else requires auth
  if (!authed(req)) {
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' } }));
    return;
  }

  // spec-compliant session termination (MCP Streamable HTTP: DELETE /mcp)
  if (req.method === 'DELETE' && url.pathname === '/mcp') {
    const sid = req.headers['mcp-session-id'];
    const existed = sid && sessions.delete(sid);
    res.writeHead(existed ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: !!existed }));
    return;
  }

  if (req.method !== 'POST' || url.pathname !== '/mcp') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found; POST /mcp (or DELETE /mcp to end a session)' }));
    return;
  }

  let msg;
  try {
    msg = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } }));
    return;
  }

  // session routing
  let sid = req.headers['mcp-session-id'];
  let core;
  if (msg.method === 'initialize') {
    sid = randomUUID();
    core = createCore({ root, readOnly });
    sessions.set(sid, { core, lastSeen: Date.now() });
  } else {
    const entry = sessions.get(sid);
    if (entry) {
      core = entry.core;
      touch(sid);
    } else {
      // tolerate sessionless clients: fall back to a default shared core.
      // WARNING: all sessionless clients share one core — token_report stats
      // and edit counters mix. Acceptable for read-only Q&A, NOT for concurrent
      // editing. Each editing client MUST send mcp-session-id.
      const def = sessions.get('__default__');
      core = def ? def.core : createCore({ root, readOnly });
      sessions.set('__default__', { core, lastSeen: Date.now() });
      sid = '__default__';
      if (!defaultWarned) {
        defaultWarned = true;
        process.stderr.write(
          '[tokenlean-mcp] WARNING: request without mcp-session-id fell back to shared __default__ core. ' +
          'All such clients share state. Send mcp-session-id (from initialize) for proper isolation.\n'
        );
      }
    }
  }

  let result;
  try {
    // Reject mutating tool calls on the shared __default__ core: state would
    // bleed between unrelated sessionless clients, and stale anchors would
    // surface in unpredictable ways. Read-only tools stay available.
    if (sid === '__default__'
        && msg.method === 'tools/call'
        && MUTATING_TOOLS.has(msg.params?.name)) {
      result = {
        jsonrpc: '2.0', id: msg.id,
        error: {
          code: -32001,
          message:
            `tool '${msg.params?.name}' requires an isolated session; send the mcp-session-id ` +
            `returned from initialize. Sessionless clients only get read-only fallback.`,
        },
      };
    } else {
      // core.dispatch is synchronous. search_lean walks up to SEARCH_MAX_FILES
      // with statSync/readFileSync, which blocks the event loop. For the HTTP
      // transport (multi-session), we yield to the event loop first so queued
      // requests from other sessions get a chance to start before this potentially
      // long sync call. For truly large repos, lower TOKENLEAN_SEARCH_MAX_FILES.
      await new Promise((r) => setImmediate(r));
      result = core.dispatch(msg);
    }
  } catch (e) {
    result = { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } };
  }

  const headers = { 'content-type': 'application/json' };
  if (msg.method === 'initialize') headers['mcp-session-id'] = sid;

  if (result === null) {
    res.writeHead(202, headers); // notification accepted, no body
    res.end();
  } else {
    res.writeHead(200, headers);
    res.end(JSON.stringify(result));
  }
});

server.listen(port, host, () => {
  process.stderr.write(
    `[tokenlean-mcp] HTTP transport ready · http://${host}:${port}/mcp · root=${root}${readOnly ? ' · read-only' : ''}\n` +
    `  endpoint:  POST /mcp           (Bearer token required)\n` +
    `  health:    GET  /healthz\n` +
    `  note:      search_lean uses sync I/O (caps at ${LIMITS.SEARCH_MAX_FILES} files); ` +
    `lower via TOKENLEAN_SEARCH_MAX_FILES for large repos.\n` +
    (host === '127.0.0.1'
      ? `  bound to localhost — expose via a tunnel (cloudflared/ngrok) or set --host 0.0.0.0 behind TLS.\n`
      : `  WARNING: bound to ${host} — ensure TLS + firewall are in place.\n`)
  );
});
