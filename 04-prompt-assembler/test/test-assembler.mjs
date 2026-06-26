#!/usr/bin/env node
/**
 * test-assembler.mjs — proves the cache-aware assembler behaves correctly on
 * the four review scenarios. Pure, deterministic, no network.
 */
import { assemble, planRag, normalizeRetrieved, scanVolatile, reportAssembly, toAnthropicMessages, STABILITY } from '../lib/assembler.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${d}`)); };

console.log('═══ prompt-assembler test suite ═══\n');

// ── Q2/Q3: long system + tool defs + history ordered most-stable-first ──
console.log('[1] assembly orders stable-first, breakpoint at the seam (Q2/Q3)');
{
  const big = 'x'.repeat(5000); // ensure prefix clears the 1024-tok minimum
  const segs = [
    { id: 'history', role: 'messages', stability: STABILITY.ROLLING, text: 'turn1...turn2...' },
    { id: 'user-q', role: 'messages', stability: STABILITY.VOLATILE, text: 'what is X?' },
    { id: 'tools', role: 'tools', stability: STABILITY.STATIC, text: big },
    { id: 'system', role: 'system', stability: STABILITY.STATIC, text: 'You are a coding agent. ' + big },
    { id: 'project-ctx', role: 'system', stability: STABILITY.SESSION, text: 'Project Foo conventions ' + big },
  ];
  const plan = assemble(segs);
  const ids = plan.ordered.map((s) => s.id);
  ok('tools first', ids[0] === 'tools', ids.join(','));
  ok('system before messages', ids.indexOf('system') < ids.indexOf('history'));
  ok('volatile user-q is last', ids[ids.length - 1] === 'user-q');
  ok('prefix holds the 3 stable segments', plan.prefix.length === 3, `prefix=${plan.prefix.map(s=>s.id)}`);
  ok('tail holds history + user-q', plan.tail.length === 2);
  ok('has a prefix/volatile breakpoint', plan.breakpoints.some((b) => b.kind === 'prefix/volatile seam'));
  ok('cacheable (clears min, no leaks)', plan.cacheable === true);
}

// ── Q3: a timestamp in the system prompt leaks into the prefix → flagged ──
console.log('\n[2] volatile leak in prefix is detected (Q3)');
{
  const big = 'x'.repeat(5000);
  const segs = [
    { id: 'system', role: 'system', stability: STABILITY.STATIC, text: 'Today is 2026-06-17T08:30 ' + big },
    { id: 'user-q', role: 'messages', stability: STABILITY.VOLATILE, text: 'hi' },
  ];
  const plan = assemble(segs);
  ok('leak detected', plan.leaks.length === 1 && plan.leaks[0].id === 'system');
  ok('leak reason names timestamp', /timestamp/.test(plan.leaks[0].reasons.join()));
  ok('not cacheable while leaking', plan.cacheable === false);
  ok('scanVolatile finds uuid too', scanVolatile('id 550e8400-e29b-41d4-a716-446655440000').length === 1);
}

// ── Q2: prefix below provider minimum is flagged (too short to cache) ──
console.log('\n[3] below-minimum prefix flagged (Q2)');
{
  const plan = assemble([
    { id: 'system', role: 'system', stability: STABILITY.STATIC, text: 'short prompt' },
    { id: 'q', role: 'messages', stability: STABILITY.VOLATILE, text: 'hi' },
  ]);
  ok('belowMin true', plan.belowMin === true);
  ok('not cacheable when below min', plan.cacheable === false);
}

// ── Q4: RAG — retrieved chunks go AFTER the pinned stable layer ──
console.log('\n[4] RAG: pinned KB stays in prefix, retrieved chunks go to tail (Q4)');
{
  const kb = {
    index: 'KB INDEX: [doc1: auth] [doc2: billing] [doc3: search] ' + 'x'.repeat(5000),
    docs: [{ id: 'doc1', text: 'auth canonical doc' }, { id: 'doc2', text: 'billing canonical doc' }],
  };
  const retrieved = [
    { id: 'c7', text: 'chunk about tokens', score: 0.91, rank: 1, timestamp: 'now' },
    { id: 'c2', text: 'chunk about sessions', score: 0.88, rank: 2, timestamp: 'now' },
  ];
  const { pinned, retrievedTail, normalizedRetrieved } = planRag(kb, retrieved, { hotCount: 2 });
  ok('index is pinned & session-stable', pinned[0].id === 'kb-index' && pinned[0].stability === STABILITY.SESSION);
  ok('hot docs pinned in id order', pinned[1].id === 'kb-doc:doc1' && pinned[2].id === 'kb-doc:doc2');
  ok('retrieved chunks are VOLATILE tail', retrievedTail.every((s) => s.stability === STABILITY.VOLATILE));
  ok('volatile metadata stripped (no score in text)', !/score|rank|timestamp/.test(JSON.stringify(normalizedRetrieved)));

  // assemble the whole thing and confirm pinned lands in prefix, retrieved in tail
  const plan = assemble([
    { id: 'system', role: 'system', stability: STABILITY.STATIC, text: 'You answer from the KB. ' + 'x'.repeat(2000) },
    ...pinned,
    ...retrievedTail,
    { id: 'user-q', role: 'messages', stability: STABILITY.VOLATILE, text: 'how do tokens work?' },
  ]);
  ok('pinned KB in cacheable prefix', plan.prefix.some((s) => s.id === 'kb-index'));
  ok('retrieved chunks in volatile tail', plan.tail.some((s) => s.id === 'ret:c7'));
  ok('whole thing cacheable', plan.cacheable === true);
}

// ── Q4 core: re-retrieval with different SCORES/ORDER yields identical tail text ──
console.log('\n[5] RAG cache-hit: score jitter & reorder produce byte-identical tail (Q4)');
{
  // query 1 returns c7 (score .91) then c2 (score .88)
  const q1 = normalizeRetrieved([
    { id: 'c7', text: 'tokens chunk', score: 0.91, rank: 1 },
    { id: 'c2', text: 'sessions chunk', score: 0.88, rank: 2 },
  ]);
  // query 2 (a re-ask) returns the SAME chunks but reordered with jittered scores
  const q2 = normalizeRetrieved([
    { id: 'c2', text: 'sessions chunk', score: 0.95, rank: 1 },
    { id: 'c7', text: 'tokens chunk', score: 0.80, rank: 2 },
  ]);
  const t1 = JSON.stringify(q1.map((c) => c.text));
  const t2 = JSON.stringify(q2.map((c) => c.text));
  ok('same chunk set → identical normalized order', t1 === t2, `t1=${t1} t2=${t2}`);
  ok('sorted by id not score', q1[0].id === 'c2' && q1[1].id === 'c7');

  // de-dupe across overlapping retrieval
  const dd = normalizeRetrieved([
    { id: 'c1', text: 'a' }, { id: 'c1', text: 'a' }, { id: 'c3', text: 'b' },
  ]);
  ok('overlapping chunks de-duped', dd.length === 2);

  // raw string chunks get a stable id
  const raw = normalizeRetrieved(['hello world', 'hello world']);
  ok('raw-string chunks de-duped by content hash', raw.length === 1);
}

// ── Q1: scope annotations distinguish tenant-reusable vs request-only ──
console.log('\n[6] scope annotations model single-tenant reuse (Q1)');
{
  const { pinned, retrievedTail } = planRag(
    { index: 'idx ' + 'x'.repeat(4000) }, [{ id: 'c1', text: 'x' }], {}
  );
  ok('pinned KB scoped to session (reusable across YOUR requests)', pinned[0].scope === 'session');
  ok('retrieved scoped to request (not reusable)', retrievedTail[0].scope === 'request');
}

// ── report renders ──
console.log('\n[7] report renders a structure plan');
{
  const plan = assemble([
    { id: 'tools', role: 'tools', stability: STABILITY.STATIC, text: 'x'.repeat(5000) },
    { id: 'q', role: 'messages', stability: STABILITY.VOLATILE, text: 'hi' },
  ]);
  const r = reportAssembly(plan);
  ok('report shows breakpoint marker', /── breakpoint ──/.test(r));
  ok('report shows cacheable verdict', /cacheable prefix:/.test(r));
}

// ── provider adapter: make the plan directly usable by Anthropic-style APIs ──
console.log('\n[8] Anthropic adapter emits cache_control at planned breakpoints');
{
  const plan = assemble([
    { id: 'tools', role: 'tools', stability: STABILITY.STATIC, text: 'tool defs ' + 'x'.repeat(5000) },
    { id: 'system', role: 'system', stability: STABILITY.STATIC, text: 'system rules ' + 'x'.repeat(5000) },
    { id: 'kb', role: 'system', stability: STABILITY.SESSION, text: 'kb index ' + 'x'.repeat(5000) },
    { id: 'history', role: 'messages', stability: STABILITY.ROLLING, text: 'previous turn' },
    { id: 'q', role: 'messages', stability: STABILITY.VOLATILE, text: 'current question' },
  ]);
  const out = toAnthropicMessages(plan);
  const cacheBlocks = [...out.tools, ...out.system, ...out.messages.flatMap((m) => m.content)]
    .filter((b) => b.cache_control?.type === 'ephemeral');
  ok('adapter keeps tools/system/messages separated', out.tools.length === 1 && out.system.length === 2 && out.messages.length === 2);
  ok('adapter marks every planned breakpoint', cacheBlocks.length === plan.breakpoints.length, `blocks=${cacheBlocks.length}, breakpoints=${plan.breakpoints.length}`);
  ok('volatile user question is not cache-marked', !out.messages.at(-1).content[0].cache_control);
}

// ── F-3: Anthropic adapter blocks must be API-safe (no non-standard keys) ──
console.log('\n[9] Anthropic adapter blocks contain only API-legal keys (F-3)');
{
  const plan = assemble([
    { id: 'tools', role: 'tools', stability: STABILITY.STATIC, text: 'tool defs ' + 'x'.repeat(5000), scope: 'tenant' },
    { id: 'system', role: 'system', stability: STABILITY.STATIC, text: 'system rules ' + 'x'.repeat(5000) },
    { id: 'kb', role: 'system', stability: STABILITY.SESSION, text: 'kb index ' + 'x'.repeat(5000), scope: 'session' },
    { id: 'history', role: 'messages', stability: STABILITY.ROLLING, text: 'previous turn' },
    { id: 'q', role: 'messages', stability: STABILITY.VOLATILE, text: 'current question', scope: 'request' },
  ]);
  const out = toAnthropicMessages(plan);
  const allBlocks = [...out.tools, ...out.system, ...out.messages.flatMap((m) => m.content)];
  ok('no block carries a tokenlean field', allBlocks.every((b) => !('tokenlean' in b)));
  ok('every block key is API-legal (type/text/cache_control)', allBlocks.every((b) => Object.keys(b).every((k) => ['type', 'text', 'cache_control'].includes(k))));
  const segs = out.diagnostics.segments;
  ok('diagnostics.segments carries parallel metadata', Array.isArray(segs) && segs.length === allBlocks.length);
  ok('segment metadata has id/stability/scope', Array.isArray(segs) && segs.every((s) => 'id' in s && 'stability' in s && 'scope' in s));
  ok('segment metadata records breakpoint flag', Array.isArray(segs) && segs.every((s) => typeof s.hasBreakpoint === 'boolean'));
  // the cache_control-bearing block's segment must flag hasBreakpoint
  const bpSegs = Array.isArray(segs) ? segs.filter((s) => s.hasBreakpoint) : [];
  ok('breakpoint segments count matches cache_control blocks', bpSegs.length === allBlocks.filter((b) => b.cache_control).length);
}

// ── F-7: assemble() pulls minPrefixTokens from cache-ttl PROVIDERS via opts.provider ──
console.log('\n[10] provider-aware minPrefixTokens (F-7)');
{
  // ~600-token prefix: below anthropic min (1024), above deepseek min (null/0)
  const medPrefix = 'x'.repeat(2400); // ~600 tokens
  const segs = [
    { id: 'system', role: 'system', stability: STABILITY.STATIC, text: medPrefix },
    { id: 'q', role: 'messages', stability: STABILITY.VOLATILE, text: 'hi' },
  ];

  // default: no provider → 1024 (unchanged backward compat)
  const def = assemble(segs);
  ok('default minPrefixTokens is 1024', def.belowMin === true, `belowMin=${def.belowMin}`);

  // anthropic provider → 1024 from PROVIDERS
  const ant = assemble(segs, { provider: 'anthropic' });
  ok('anthropic provider min = 1024 (belowMin)', ant.belowMin === true, `belowMin=${ant.belowMin}`);

  // deepseek provider → null min (from-token-0), so NOT belowMin
  const ds = assemble(segs, { provider: 'deepseek' });
  ok('deepseek provider min = null (not belowMin)', ds.belowMin === false, `belowMin=${ds.belowMin}`);

  // openai provider → 1024 from PROVIDERS
  const oai = assemble(segs, { provider: 'openai' });
  ok('openai provider min = 1024 (belowMin)', oai.belowMin === true, `belowMin=${oai.belowMin}`);

  // gemini provider → 1024 from PROVIDERS
  const gem = assemble(segs, { provider: 'gemini' });
  ok('gemini provider min = 1024 (belowMin)', gem.belowMin === true, `belowMin=${gem.belowMin}`);

  // explicit minPrefixTokens overrides provider
  const explicit = assemble(segs, { provider: 'anthropic', minPrefixTokens: 100 });
  ok('explicit minPrefixTokens overrides provider', explicit.belowMin === false, `belowMin=${explicit.belowMin}`);

  // large prefix clears anthropic min
  const big = 'x'.repeat(5000);
  const bigPlan = assemble([
    { id: 'system', role: 'system', stability: STABILITY.STATIC, text: big },
    { id: 'q', role: 'messages', stability: STABILITY.VOLATILE, text: 'hi' },
  ], { provider: 'anthropic' });
  ok('large prefix clears anthropic provider min', bigPlan.belowMin === false && bigPlan.cacheable === true);
}

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
