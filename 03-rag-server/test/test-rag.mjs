#!/usr/bin/env node
/**
 * test-rag.mjs — protocol-level test suite for tokenlean-rag.
 * Tests the core dispatch (MCP JSON-RPC) via in-process createRagCore calls.
 */

import { createRagCore } from '../lib/rag-core.mjs';

// ── KB fixture ──
const TEST_KB = {
  index: 'KB INDEX: product docs, API reference, support articles.',
  docs: [
    { id: 'd42', text: 'Refunds are processed in 5-7 business days. Contact support@example.com for refund requests.' },
    { id: 'd17', text: 'Premium plan includes: priority support, unlimited API calls, custom integrations.' },
    { id: 'd99', text: 'API rate limits: 1000 req/min for free tier, 10000 req/min for premium.' },
    { id: 'd33', text: 'Two-factor authentication (2FA) can be enabled in Account > Security settings.' },
    { id: 'd55', text: 'Data retention policy: logs stored for 90 days, backups for 30 days.' },
  ],
};

const core = createRagCore({ kb: TEST_KB, pinHotCount: 2 });

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${d}`)); };

function call(method, params) {
  const id = Math.floor(Math.random() * 100000);
  return core.dispatch({ jsonrpc: '2.0', id, method, params });
}

function callTool(name, args) {
  const r = call('tools/call', { name, arguments: args });
  return { text: r.result?.content?.[0]?.text ?? '', isError: r.result?.isError, raw: r };
}

console.log('═══ tokenlean-rag test suite ═══\n');

// ── 1. Handshake ──
console.log('[1] MCP handshake');
const init = call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
check('returns serverInfo', init.result?.serverInfo?.name === 'tokenlean-rag');
check('returns tools capability', !!init.result?.capabilities?.tools);
check('returns prompt layout instructions', /breakpoint/.test(init.result?.instructions || ''));
call('notifications/initialized', {});

// ── 2. tools/list ──
console.log('\n[2] tools/list');
const list = call('tools/list', {});
const names = (list.result?.tools ?? []).map((t) => t.name);
check('4 tools exposed', names.length === 4, `got: ${names.join(',')}`);
check('has rag_search', names.includes('rag_search'));
check('has kb_pin', names.includes('kb_pin'));
check('has headroom_retrieve', names.includes('headroom_retrieve'));
check('has token_report', names.includes('token_report'));

// ── 3. rag_search with external results ──
console.log('\n[3] rag_search with external results');
const results = [
  { id: 'd42', text: 'Refunds are processed in 5-7 business days.', score: 0.93, rank: 1, timestamp: 't1' },
  { id: 'd17', text: 'Premium plan includes priority support.', score: 0.81, rank: 2, timestamp: 't1' },
];
const sr = callTool('rag_search', { query: 'refund policy', top_k: 5, results });
check('returns results header', sr.text.includes('rag_search results'));
check('shows query text', sr.text.includes('refund policy'));
check('normalized output has id-sorted chunks', /id:d17/.test(sr.text) && /id:d42/.test(sr.text));
check('no score in output text', !/score/.test(sr.text));
check('no rank in output text', !/rank/.test(sr.text));

// ── 4. rag_search with re-ask detection ──
console.log('\n[4] rag_search re-ask detection (same chunks, different order)');
// Second call: same chunks, different order, different scores — normalized should be identical
const results2 = [
  { id: 'd17', text: 'Premium plan includes priority support.', score: 0.90, rank: 1, timestamp: 't2' },
  { id: 'd42', text: 'Refunds are processed in 5-7 business days.', score: 0.77, rank: 2, timestamp: 't2' },
];
const sr2 = callTool('rag_search', { query: 'support plans', top_k: 5, results: results2 });
check('detects re-ask: mentions byte-stable tail', sr2.text.includes('cache hit possible'), sr2.text.slice(0, 500));

// ── 5. rag_search with normalized ordering proof ──
console.log('\n[5] rag_search normalization ordering proof');
const sr3 = callTool('rag_search', { query: 'test', top_k: 5, results: results2 });
// The normalized chunk text should be identical across calls (same chunk set)
const extractTail = (t) => { const m = t.split('--- chunk text ---'); return m.length > 1 ? m[1].trim() : m[0].trim(); };
const tail2 = extractTail(sr2.text);
const tail3 = extractTail(sr3.text);
check('same chunk set across 3 calls produces same normalized tail', tail2 === tail3, `tails differ: "${tail2.slice(0,80)}" vs "${tail3.slice(0,80)}"`);
check('re-ask count >= 1', core.stats.reaskHits >= 1, `count=${core.stats.reaskHits}`);

// ── 5b. re-ask detection must hash content, not only id/length ──
console.log('\n[5b] rag_search re-ask content-hash safety');
core.resetStats();
const sameLenA = [{ id: 'same', text: 'alpha', score: 0.9 }];
const sameLenB = [{ id: 'same', text: 'bravo', score: 0.9 }]; // same id and same length, different bytes
callTool('rag_search', { query: 'same-len-a', top_k: 1, results: sameLenA });
const sameLenSecond = callTool('rag_search', { query: 'same-len-b', top_k: 1, results: sameLenB });
check('same id+length but changed text is not a re-ask hit', !sameLenSecond.text.includes('cache hit possible') && core.stats.reaskHits === 0, `hits=${core.stats.reaskHits}`);

// ── 5c. top_k is enforced for external and fallback results ──
console.log('\n[5c] rag_search top_k enforcement');
const tooMany = TEST_KB.docs.map((d) => ({ id: d.id, text: d.text, score: 1 }));
const top2External = callTool('rag_search', { query: 'top2 external', top_k: 2, results: tooMany });
const externalIds = (top2External.text.match(/^\[\d+\] id:/gm) || []).length;
check('top_k limits external result count', externalIds === 2, `shown=${externalIds}`);
const topTooHighFallback = callTool('rag_search', { query: 'top clamp fallback', top_k: 999 });
const fallbackIds = (topTooHighFallback.text.match(/^\[\d+\] id:/gm) || []).length;
check('top_k clamps fallback result count to KB size/max', fallbackIds === TEST_KB.docs.length, `shown=${fallbackIds}`);

// ── 5d. F-8: non-adjacent re-ask detection (ring buffer) + unified criteria ──
console.log('\n[5d] rag_search non-adjacent re-ask detection (F-8)');
core.resetStats();
const setA = [
  { id: 'd42', text: 'Refunds are processed in 5-7 business days.', score: 0.9 },
  { id: 'd17', text: 'Premium plan includes priority support.', score: 0.8 },
];
const setB = [
  { id: 'd99', text: 'API rate limits: 1000 req/min.', score: 0.9 },
  { id: 'd33', text: 'Two-factor authentication (2FA).', score: 0.8 },
];
// call 1: setA (first call, no re-ask)
callTool('rag_search', { query: 'q1', top_k: 5, results: setA });
check('call 1: no re-ask yet', core.stats.reaskHits === 0, `hits=${core.stats.reaskHits}`);
// call 2: setB (different — no re-ask)
callTool('rag_search', { query: 'q2', top_k: 5, results: setB });
check('call 2: different set, no re-ask', core.stats.reaskHits === 0, `hits=${core.stats.reaskHits}`);
// call 3: setA again (non-adjacent repeat — old code only compares with previous call)
const sr3b = callTool('rag_search', { query: 'q3', top_k: 5, results: setA });
check('call 3: non-adjacent repeat detected (ring buffer)', core.stats.reaskHits >= 1, `hits=${core.stats.reaskHits}`);
// F-8: the "same chunk set seen before" note must use the SAME criteria as isReask
// (i.e. appear on the first re-ask, not require reaskHits > 1)
check('re-ask note appears on first detection', /same chunk set|cache hit/i.test(sr3b.text), `text=${sr3b.text.slice(0, 200)}`);

// ── 6. kb_pin ──
console.log('\n[6] kb_pin');
const pin = callTool('kb_pin', { doc_ids: ['d42', 'd17'] });
check('pins 2 docs', pin.text.includes('pinned:     2'));
check('total pinned 2', pin.text.includes('total pinned: 2'));

const pinDup = callTool('kb_pin', { doc_ids: ['d42'] }); // already pinned
check('duplicate pin does not double-count', pinDup.text.includes('total pinned: 2'));

const pinMissing = callTool('kb_pin', { doc_ids: ['nonexistent'] });
check('pinning nonexistent doc reports 0 pinned', pinMissing.text.includes('not found'));

const pinBatch = callTool('kb_pin', { doc_ids: ['d99', 'd33'] });
check('batch pin adds 2 more', pinBatch.text.includes('total pinned: 4'));

// ── 7. headroom_retrieve ──
console.log('\n[7] headroom_retrieve (CCR on-demand retrieval)');
const hr = callTool('headroom_retrieve', { chunk_id: 'd42' });
check('retrieves full chunk text', hr.text.includes('Refunds are processed'));
check('reports content length', /content length/.test(hr.text));

const hrQuery = callTool('headroom_retrieve', { chunk_id: 'd42', query: 'refund' });
check('query filters within chunk', hrQuery.text.toLowerCase().includes('refund'));
// Use a multi-line chunk for real length difference testing
const hrMulti = callTool('headroom_retrieve', { chunk_id: 'd42', query: 'nonexistent_query_xyz' });
check('query with no matches shows note', hrMulti.text.includes('no lines matched'));

const hrMissing = callTool('headroom_retrieve', { chunk_id: 'no_such' });
check('missing chunk returns error message', hrMissing.text.includes('not found'));

// ── 8. token_report ──
console.log('\n[8] token_report');
const rep = callTool('token_report', {});
check('reports search count', /rag_search calls:\s+\d+/.test(rep.text));
check('reports pin count', /kb_pin operations:\s+\d+/.test(rep.text));
check('reports re-ask hits', /re-ask cache hits:\s+\d+/.test(rep.text), `got: ${rep.text.slice(0, 200)}`);
check('reports KB index presence', /KB index present/.test(rep.text));

// ── 9. resetStats ──
console.log('\n[9] resetStats');
core.resetStats();
const repAfter = callTool('token_report', {});
check('searches reset to 0', /rag_search calls:\s+0/.test(repAfter.text));
check('pins reset to 0', /kb_pin operations:\s+0/.test(repAfter.text));

// ── 10. rag_search without results (KB fallback) ──
console.log('\n[10] rag_search KB fallback (no results param)');
const fallback = callTool('rag_search', { query: 'fallback', top_k: 3 });
check('fallback returns something', fallback.text.length > 50, `len=${fallback.text.length}`);

// ── 11. Tool error handling ──
console.log('\n[11] tool error handling');
const badTool = call('tools/call', { name: 'nonexistent', arguments: {} });
check('unknown tool returns error', !!badTool.error);
check('error code -32602', badTool.error?.code === -32602);

// ── 12. ping ──
console.log('\n[12] ping');
const ping = call('ping', {});
check('ping returns ok', ping.result !== undefined);

// ── Done ──
console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
