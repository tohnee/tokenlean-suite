#!/usr/bin/env node
/** Regression tests for end-to-end coding-agent benchmark. */
import { runCodingAgentBench, renderCodingAgentReport } from './bench-coding-agent.mjs';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${d}`)); };

console.log('═══ coding-agent benchmark test ═══\n');

const result = await runCodingAgentBench({ turns: 12, root: process.cwd().replace(/\/02-mcp-server$/, '') });
check('combines input and output dimensions', result.components.futureInput.naiveTokens > 0 && result.components.output.writeTokens > 0);
check('calculates full-rewrite baseline savings', result.costs.savingsVsFullRewritePct >= 30, JSON.stringify(result.costs));
check('calculates fair native-edit baseline savings', Number.isFinite(result.costs.savingsVsNativeEditPct));
check('separates input and output prices', result.pricing.inputPerMTok < result.pricing.outputPerMTok);

const report = renderCodingAgentReport(result);
check('report is explicitly about coding agents', report.includes('Coding-agent benchmark'));
check('report includes tokenlean vs baselines', report.includes('TokenLean') && report.includes('Full-rewrite baseline'));

// ── F-1: 2×2 decomposition isolates read axis from edit axis ──
console.log('\n[F-1] 2×2 decomposition (read axis × edit axis)');
check('matrix exists with read/edit axes', !!result.matrix && Array.isArray(result.matrix.readAxis) && Array.isArray(result.matrix.editAxis));
check('matrix has 2 read axes (naive/lean)', result.matrix?.readAxis?.length === 2 && result.matrix?.readAxis?.includes('naive') && result.matrix?.readAxis?.includes('lean'));
check('matrix has 3 edit axes (write/edit/hash)', result.matrix?.editAxis?.length === 3);
check('matrix costs keyed by read+edit', result.matrix?.costs && 'naive+write' in result.matrix.costs && 'lean+hash' in result.matrix.costs);
check('apples-to-apples lean+edit baseline exists', Number.isFinite(result.costs.leanEditBaseline), JSON.stringify(result.costs));
check('savings vs lean+edit isolates edit axis', Number.isFinite(result.costs.savingsVsLeanEditPct));
check('lean+hash equals tokenlean total', Math.abs((result.matrix?.costs?.['lean+hash'] ?? -1) - result.costs.tokenlean) < 1e-9);
check('naive+edit equals nativeEdit baseline', Math.abs((result.matrix?.costs?.['naive+edit'] ?? -1) - result.costs.nativeEditBaseline) < 1e-9);
// The apples-to-apples comparison (lean+edit vs lean+hash) must be smaller than
// the mixed-axis comparison (naive+edit vs lean+hash) — this proves the old
// headline conflated read savings with edit savings.
check('apples-to-apples savings <= mixed-axis savings', result.costs.savingsVsLeanEditPct <= result.costs.savingsVsNativeEditPct, `leanEdit=${result.costs.savingsVsLeanEditPct} nativeEdit=${result.costs.savingsVsNativeEditPct}`);
check('report annotates savings source (lean reading)', /lean read/i.test(report) || /FUTURE INPUT|reading/i.test(report));

// ── F-2: history cache-read multiplier discounts re-billed FUTURE INPUT ──
console.log('\n[F-2] history cache-read multiplier on re-billing');
check('historyCacheReadMultiplier exposed', typeof result.historyCacheReadMultiplier === 'number' && result.historyCacheReadMultiplier > 0 && result.historyCacheReadMultiplier < 1);
check('default multiplier is 0.1 (cache-read ~10% of base)', Math.abs(result.historyCacheReadMultiplier - 0.1) < 1e-9);
check('future input cost uses multiplier (less than full-price)', result.components.futureInput.naiveCostFullPrice > result.components.futureInput.naiveCostCached, `full=${result.components.futureInput?.naiveCostFullPrice} cached=${result.components.futureInput?.naiveCostCached}`);
check('one-shot tokens tracked separately from re-billed', result.components.futureInput.naiveOneShotTokens > 0 && result.components.futureInput.naiveOneShotTokens < result.components.futureInput.naiveTokens);
check('report mentions cache-read discount on history', /cache.read|re-bill|0\.1/i.test(report));

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
