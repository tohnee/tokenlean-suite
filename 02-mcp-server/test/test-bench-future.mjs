#!/usr/bin/env node
/** Regression tests for FUTURE INPUT benchmark. */
import { runFutureBench, renderFutureReport } from './bench-future.mjs';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${d}`)); };

console.log('═══ FUTURE input benchmark test ═══\n');

const result = await runFutureBench({ turns: 12, root: process.cwd().replace(/\/02-mcp-server$/, '') });
check('benchmark has multiple coding-agent operations', result.operations.length >= 4, `ops=${result.operations.length}`);
check('uses real repo-backed lean and naive outputs', result.operations.every((op) => op.leanTokens > 0 && op.naiveTokens > 0));
check('lean outputs reduce one-shot tool tokens', result.totals.leanTokens < result.totals.naiveTokens, JSON.stringify(result.totals));
check('lean outputs reduce cumulative future token-turns', result.totals.leanFutureTokenTurns < result.totals.naiveFutureTokenTurns, JSON.stringify(result.totals));
check('future savings is material', result.totals.futureSavingsPct >= 30, `future=${result.totals.futureSavingsPct}`);
check('session length is modeled', result.turns === 12 && result.operations.every((op) => op.rebilledTurns >= 1));

const report = renderFutureReport(result);
check('report includes FUTURE INPUT heading', report.includes('FUTURE INPUT'));
check('report includes cumulative token-turn accounting', report.includes('context-token-turns'));

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
