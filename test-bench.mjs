#!/usr/bin/env node
/** Regression tests for unified tl bench report. */
import { runSuiteBench, renderSuiteBench } from './bin/tl-bench.mjs';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${d}`)); };

console.log('═══ unified benchmark test ═══\n');

const result = await runSuiteBench({ turns: 12 });
check('reports OUTPUT dimension', Number.isFinite(result.output.hashVsWriteSavingsPct));
check('reports FUTURE dimension', result.future.totals.futureSavingsPct >= 30);
check('reports CODING AGENT combined usage dimension', result.codingAgent.costs.savingsVsFullRewritePct >= 30);
check('reports INPUT/RAG dimension', Number.isFinite(result.rag.savingsPct) && result.rag.conclusion);

const md = renderSuiteBench(result);
check('markdown contains benchmark dimension table', md.includes('| OUTPUT |') && md.includes('| FUTURE INPUT |') && md.includes('| CODING AGENT |') && md.includes('| INPUT/RAG |'));
check('markdown keeps honesty caveat', md.includes('accounting benchmark'));

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
