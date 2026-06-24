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
check('cache-aware lowers total input cost', result.cacheAware.totalCost < result.naive.totalCost, `naive=${result.naive.totalCost}, aware=${result.cacheAware.totalCost}`);
check('savings is material for repeated KB workload', result.savingsPct >= 20, `savings=${result.savingsPct}%`);
check('normalized prompts strip volatile retrieval metadata', !/score=|rank=|retrieved_at=/.test(result.cacheAware.turns[0].prompt));
check('quality proxy preserves retrieved source ids', result.quality.sameSourceCoverage === true, JSON.stringify(result.quality));

const md = renderMarkdownReport(result);
check('markdown report contains comparison table', md.includes('| Variant | Turns | Cache-hit turns | Input tokens billed | Cost |'));
check('markdown report contains verification guidance', md.includes('How to plug in real provider usage'));
check('markdown report includes explicit local benchmark conclusion', md.includes('Local benchmark conclusion'));
check('benchmark result exposes conclusion fields', result.conclusion?.kind === 'local-estimate' && result.conclusion?.savingsPct >= 20, JSON.stringify(result.conclusion));

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
