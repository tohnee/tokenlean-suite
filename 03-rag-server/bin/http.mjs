#!/usr/bin/env node
/**
 * bin/http.mjs — STREAMABLE HTTP transport for the RAG MCP server.
 *
 * For chatbot platforms that connect via MCP Streamable HTTP:
 *   Claude.ai connectors, ChatGPT GPT Actions, custom chatbots.
 *
 * Features:
 *   - Full MCP Streamable HTTP subset (POST /mcp, DELETE /mcp, GET /healthz)
 *   - Bearer token auth (MANDATORY for network-exposed services)
 *   - Per-session core isolation (each chatbot user gets their own KB state)
 *   - Session TTL sweep (idle sessions cleaned after 30 min)
 *   - CORS headers for direct browser access
 *
 * Usage:
 *   TOKENLEAN_RAG_TOKEN=secret node bin/http.mjs --port 8766 --kb-index "..."
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRagCore, SERVER_INFO } from '../lib/rag-core.mjs';

function argOf(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const port = Number(argOf('--port', process.env.PORT || '8766'));
const host = argOf('--host', '127.0.0.1');
const token = argOf('--token', process.env.TOKENLEAN_RAG_TOKEN || '');
const kbIndex = argOf('--kb-index', process.env.TOKENLEAN_KB_INDEX || '');

if (!token) {
  process.stderr.write(
    '[tokenlean-rag] REFUSING TO START: no auth token.\n' +
    '  A network-exposed MCP server must require a bearer token.\n' +
    '  Set --token <secret> or TOKENLEAN_RAG_TOKEN=<secret>.\n'
  );
  process.exit(2);
}

// Default KB configuration
const defaultKb = kbIndex
  ? { index: kbIndex, docs: [] }
  : {
      index: 'Knowledge base index — add docs via kb_pin or configure TOKENLEAN_KB_INDEX.',
      docs: [],
    };

// ── Session management ──
const sessions = new Map();
const SESSION_TTL_MS = Number(process.env.TOKENLEAN_SESSION_TTL_MS || 30 * 60 * 1000);
const SESSION_MAX = Number(process.env.TOKENLEAN_SESSION_MAX || 1000);
let defaultWarned = false;

function touch(sid) {
  const s = sessions.get(sid);
  if (s) s.lastSeen = Date.now();
}

function sweepSessions() {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) {
      sessions.delete(sid);
      if (sid === '__default__') defaultWarned = false;
    }
  }
  if (sessions.size > SESSION_MAX) {
    const sorted = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [sid] of sorted.slice(0, sessions.size - SESSION_MAX)) {
      sessions.delete(sid);
      if (sid === '__default__') defaultWarned = false;
    }
  }
}
const sweepTimer = setInterval(sweepSessions, 60 * 1000);
sweepTimer.unref?.();

function authed(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m && m[1] === token;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 8_000_000) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// CORS headers for direct browser / chatbot connector access
function corsHeaders(req) {
  const origin = req.headers['origin'] || '*';
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, mcp-session-id',
    'access-control-max-age': '86400',
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cors = corsHeaders(req);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  // Health check (no auth)
  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size, server: SERVER_INFO.name, version: SERVER_INFO.version }));
    return;
  }

  // Everything else requires auth
  if (!authed(req)) {
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer', ...cors });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' } }));
    return;
  }

  // DELETE /mcp: session termination
  if (req.method === 'DELETE' && url.pathname === '/mcp') {
    const sid = req.headers['mcp-session-id'];
    const existed = sid && sessions.delete(sid);
    res.writeHead(existed ? 200 : 404, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ ok: !!existed }));
    return;
  }

  if (req.method !== 'POST' || url.pathname !== '/mcp') {
    res.writeHead(404, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: 'not found; POST /mcp (or DELETE /mcp to end a session)' }));
    return;
  }

  let msg;
  try {
    msg = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } }));
    return;
  }

  let sid = req.headers['mcp-session-id'];
  let core;

  if (msg.method === 'initialize') {
    sid = randomUUID();
    core = createRagCore({ kb: defaultKb });
    sessions.set(sid, { core, lastSeen: Date.now() });
  } else {
    const entry = sessions.get(sid);
    if (entry) {
      core = entry.core;
      touch(sid);
    } else {
      const def = sessions.get('__default__');
      core = def ? def.core : createRagCore({ kb: defaultKb });
      sessions.set('__default__', { core, lastSeen: Date.now() });
      sid = '__default__';
      if (!defaultWarned) {
        defaultWarned = true;
        process.stderr.write(
          '[tokenlean-rag] WARNING: request without mcp-session-id fell back to shared __default__ core. ' +
          'All such clients share state. Send mcp-session-id (from initialize) for proper isolation.\n'
        );
      }
    }
  }

  let result;
  try {
    await new Promise((r) => setImmediate(r));
    result = core.dispatch(msg);
  } catch (e) {
    result = { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } };
  }

  const headers = { 'content-type': 'application/json', ...cors };
  if (msg.method === 'initialize') headers['mcp-session-id'] = sid;

  if (result === null) {
    res.writeHead(202, headers);
    res.end();
  } else {
    res.writeHead(200, headers);
    res.end(JSON.stringify(result));
  }
});

server.listen(port, host, () => {
  process.stderr.write(
    `[tokenlean-rag] HTTP transport ready · http://${host}:${port}/mcp\n` +
    `  endpoint:  POST /mcp           (Bearer token required)\n` +
    `  health:    GET  /healthz\n` +
    `  ${
      kbIndex
        ? `KB index configured (~${kbIndex.length} chars)`
        : 'no KB index set — use --kb-index or TOKENLEAN_KB_INDEX'
    }\n` +
    (host === '127.0.0.1'
      ? `  bound to localhost — expose via cloudflared/ngrok or set --host 0.0.0.0 behind TLS.\n`
      : `  WARNING: bound to ${host} — ensure TLS + firewall are in place.\n`)
  );
});
