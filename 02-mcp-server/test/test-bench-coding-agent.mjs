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

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
