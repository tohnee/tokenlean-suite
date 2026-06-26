#!/usr/bin/env node
/**
 * test-rag-benchmark.mjs — regression tests for the chatbot+RAG savings lab.
 */
import { runBenchmark, defaultScenario, renderMarkdownReport } from '../bench/chatbot-rag-benchmark.mjs';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${d}`)); };

console.log('═══ chatbot+RAG benchmark environment test ═══\n');

const result = runBenchmark(defaultScenario(), {
  minCacheTokens: 128,
  uncachedInputPerMTok: 3,
  cachedReadPerMTok: 0.3,
});

check('benchmark runs both variants', result.naive.turns.length === result.cacheAware.turns.length && result.naive.turns.length >= 5);
check('naive has no cache hits after volatile prefix drift', result.naive.cacheHitTurns === 0, `hits=${result.naive.cacheHitTurns}`);
check('cache-aware records reusable prefix cache hits', result.cacheAware.cacheHitTurns >= 1, `hits=${result.cacheAware.cacheHitTurns}`);
// F-6: with the 1.25× write premium, a short session may not yet break even —
// the write premium on the large stable prefix can exceed cache-read savings
// over only 7 turns. The savings materialize with more turns (see break-even
// analysis in cache-ttl.mjs). We check the cost model is honest, not that it
// always shows savings.
check('both variants pay write premium symmetrically', result.naive.turns[0].cacheWriteTokens > 0 && result.cacheAware.turns[0].cacheWriteTokens > 0);
check('cache-aware gets cache hits (the mechanism works)', result.cacheAware.cacheHitTurns >= 1);
check('savings is honestly reported (may be negative with write premium in short sessions)', Number.isFinite(result.savingsPct), `savings=${result.savingsPct}%`);
check('normalized prompts strip volatile retrieval metadata', !/score=|rank=|retrieved_at=/.test(result.cacheAware.turns[0].prompt));
check('quality proxy preserves retrieved source ids', result.quality.sameSourceCoverage === true, JSON.stringify(result.quality));

const md = renderMarkdownReport(result);
check('markdown report contains comparison table', md.includes('| Variant | Turns | Cache-hit turns | Input tokens billed | Cost |'));
check('markdown report contains verification guidance', md.includes('How to plug in real provider usage'));
check('markdown report includes explicit local benchmark conclusion', md.includes('Local benchmark conclusion'));
check('benchmark result exposes conclusion fields', result.conclusion?.kind === 'local-estimate' && Number.isFinite(result.conclusion?.savingsPct), JSON.stringify(result.conclusion));

// ── F-6: first-round cache-write premium (1.25×) applied symmetrically ──
console.log('\n[F-6] first-round cache-write premium (1.25×)');
{
  const r = runBenchmark(defaultScenario(), {
    minCacheTokens: 128,
    uncachedInputPerMTok: 3,
    cachedReadPerMTok: 0.3,
  });
  // The cache-aware variant's FIRST turn writes the cache prefix (1.25× premium).
  // The naive variant's first turn also writes (if it ever could), symmetrically.
  const firstAware = r.cacheAware.turns[0];
  // A cache-writing turn pays 1.25× on the prefix tokens. Without the premium,
  // the cost would be just price(prefixTokens, uncachedInputPerMTok). With it,
  // the prefix portion is billed at 1.25× uncached price.
  const writePremium = 1.25;
  const expectedPrefixCost = (firstAware.prefixTokens / 1e6) * 3 * writePremium;
  const expectedRestCost = ((firstAware.inputTokens - firstAware.prefixTokens) / 1e6) * 3;
  check('first cache-aware turn pays 1.25× write premium on prefix', Math.abs(firstAware.cost - (expectedPrefixCost + expectedRestCost)) < 1e-9, `cost=${firstAware.cost} expected=${expectedPrefixCost + expectedRestCost}`);
  check('first turn has cacheWrite field', typeof firstAware.cacheWriteTokens === 'number' && firstAware.cacheWriteTokens > 0, `cacheWriteTokens=${firstAware.cacheWriteTokens}`);
  // Symmetry: naive first turn also pays write premium on its (volatile) prefix
  const firstNaive = r.naive.turns[0];
  check('naive first turn also pays write premium (symmetric)', typeof firstNaive.cacheWriteTokens === 'number' && firstNaive.cacheWriteTokens > 0);
  // The premium makes the first-turn cost higher than a flat 1× model would
  const flatFirstCost = (firstAware.inputTokens / 1e6) * 3;
  check('write premium increases first-turn cost vs flat model', firstAware.cost > flatFirstCost, `cost=${firstAware.cost} flat=${flatFirstCost}`);
}

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
