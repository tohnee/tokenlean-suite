#!/usr/bin/env node
/**
 * bench-coding-agent.mjs — combines OUTPUT and FUTURE INPUT into a coding-agent
 * cost model.
 *
 * It answers: if a coding agent does repo orientation/search/inspection and a
 * representative edit batch, how much input/output token cost does TokenLean's
 * lean-tool path avoid versus naive baselines?
 *
 * F-1 fix: the old headline "X% vs native Edit" conflated two independent
 * levers — lean READING (FUTURE INPUT) and hash EDITING (OUTPUT). The native-Edit
 * baseline paired a smart edit with a DUMB full-file read (strawman), so ~99% of
 * the headline savings came from lean reading, not hash editing. This version
 * decomposes cost into a 2×2+ matrix (read axis: naive/lean × edit axis:
 * write/edit/hash) and adds an apples-to-apples comparison (lean+Edit vs
 * lean+Hash) that isolates the edit-axis effect.
 *
 * F-2 fix: the old dollar model billed re-billed history tokens at full 1× input
 * price. In reality a stable prefix means history tool output is re-billed at
 * cache-read price (~0.1×). The token-TURNS percentage (context occupancy) is
 * immune to this discount and stays honest; but the absolute dollar figures were
 * overstated ~10×. This version separates one-shot tokens (first occurrence,
 * full price) from re-billed tokens (subsequent turns, cache-read price).
 */
import { join } from 'node:path';
import { runOutputBench } from './bench-output.mjs';
import { runFutureBench } from './bench-future.mjs';

const money = (n) => `$${n.toFixed(6)}`;
const pct = (n) => `${Math.round(n)}%`;
const cost = (tokens, perMTok) => (tokens / 1_000_000) * perMTok;

export async function runCodingAgentBench(opts = {}) {
  const turns = Number(opts.turns || 12);
  const root = opts.root || join(process.cwd(), '..');
  const pricing = {
    inputPerMTok: Number(opts.inputPerMTok || 3),
    outputPerMTok: Number(opts.outputPerMTok || 15),
  };
  // F-2: re-billed history tokens are cache-read (~0.1× base input), not full
  // price. This resolves the ~10× dollar overstatement in the old model. The
  // token-TURNS percentage (context occupancy) is immune to this discount and
  // stays honest. 0.1 mirrors the Anthropic cache-read multiplier (readCost).
  const historyCacheReadMultiplier = Number(opts.historyCacheReadMultiplier ?? 0.1);

  const [output, future] = await Promise.all([
    runOutputBench(),
    runFutureBench({ turns, root }),
  ]);

  // F-2: separate one-shot tool-output tokens (first occurrence, full input
  // price) from re-billed tokens (subsequent turns, cache-read price).
  const naiveOneShot = future.totals.naiveTokens;
  const leanOneShot = future.totals.leanTokens;
  const naiveFutureTokenTurns = future.totals.naiveFutureTokenTurns;
  const leanFutureTokenTurns = future.totals.leanFutureTokenTurns;
  const naiveRebill = Math.max(0, naiveFutureTokenTurns - naiveOneShot);
  const leanRebill = Math.max(0, leanFutureTokenTurns - leanOneShot);

  // FUTURE INPUT dollar costs: one-shot at full price + re-bills at cache-read
  const naiveFutureCost =
    cost(naiveOneShot, pricing.inputPerMTok) +
    cost(naiveRebill, pricing.inputPerMTok * historyCacheReadMultiplier);
  const leanFutureCost =
    cost(leanOneShot, pricing.inputPerMTok) +
    cost(leanRebill, pricing.inputPerMTok * historyCacheReadMultiplier);

  // ── F-2 detailed logging: cache-read discount breakdown ──
  if (process.env.TL_BENCH_VERBOSE) {
    const fmt = (n) => n.toLocaleString();
    process.stderr.write([
      '\n━━━ F-2: Cache-read discount breakdown ━━━',
      `  historyCacheReadMultiplier = ${historyCacheReadMultiplier}× (cache-read vs full-price input)`,
      '',
      '  NAIVE (full-file reads):',
      `    one-shot tokens      = ${fmt(naiveOneShot)}  → cost = ${money(cost(naiveOneShot, pricing.inputPerMTok))}  (full ${pricing.inputPerMTok}/Mtok)`,
      `    re-billed tokens     = ${fmt(naiveRebill)}  → cost = ${money(cost(naiveRebill, pricing.inputPerMTok * historyCacheReadMultiplier))}  (${(pricing.inputPerMTok * historyCacheReadMultiplier).toFixed(2)}/Mtok)`,
      `    total (cached model) = ${money(naiveFutureCost)}`,
      `    total (old 1× model) = ${money(cost(naiveFutureTokenTurns, pricing.inputPerMTok))}  ← old overstatement`,
      `    overstatement factor = ${(cost(naiveFutureTokenTurns, pricing.inputPerMTok) / naiveFutureCost).toFixed(1)}×`,
      '',
      '  LEAN (outline/bounded reads):',
      `    one-shot tokens      = ${fmt(leanOneShot)}  → cost = ${money(cost(leanOneShot, pricing.inputPerMTok))}`,
      `    re-billed tokens     = ${fmt(leanRebill)}  → cost = ${money(cost(leanRebill, pricing.inputPerMTok * historyCacheReadMultiplier))}`,
      `    total (cached model) = ${money(leanFutureCost)}`,
      `    total (old 1× model) = ${money(cost(leanFutureTokenTurns, pricing.inputPerMTok))}  ← old overstatement`,
      '',
    ].join('\n') + '\n');
  }

  const futureInput = {
    naiveTokens: naiveFutureTokenTurns,
    tokenleanTokens: leanFutureTokenTurns,
    naiveOneShotTokens: naiveOneShot,
    leanOneShotTokens: leanOneShot,
    naiveCostFullPrice: cost(naiveFutureTokenTurns, pricing.inputPerMTok),
    naiveCostCached: naiveFutureCost,
    leanCostCached: leanFutureCost,
  };

  const outputTokens = {
    writeTokens: output.totals.write,
    nativeEditTokens: output.totals.edit,
    tokenleanHashTokens: output.totals.hash,
  };

  // F-1: 2×2 decomposition — read axis (naive/lean) × edit axis (write/edit/hash).
  // Isolates the two independent savings levers instead of conflating them.
  const matrix = {
    readAxis: ['naive', 'lean'],
    editAxis: ['write', 'edit', 'hash'],
    costs: {
      'naive+write': naiveFutureCost + cost(outputTokens.writeTokens, pricing.outputPerMTok),
      'naive+edit':  naiveFutureCost + cost(outputTokens.nativeEditTokens, pricing.outputPerMTok),
      'lean+edit':   leanFutureCost + cost(outputTokens.nativeEditTokens, pricing.outputPerMTok),
      'lean+hash':   leanFutureCost + cost(outputTokens.tokenleanHashTokens, pricing.outputPerMTok),
    },
  };

  const fullRewriteBaseline = matrix.costs['naive+write'];
  const nativeEditBaseline  = matrix.costs['naive+edit'];  // strawman: smart edit + dumb reads
  const leanEditBaseline    = matrix.costs['lean+edit'];   // apples-to-apples: smart edit + lean reads
  const tokenlean           = matrix.costs['lean+hash'];

  // ── F-1 detailed logging: 2×2 matrix decomposition ──
  if (process.env.TL_BENCH_VERBOSE) {
    const readAxisPct = (1 - leanFutureCost / naiveFutureCost) * 100;
    const editAxisPct = (1 - tokenlean / leanEditBaseline) * 100;
    process.stderr.write([
      '━━━ F-1: 2×2 cost matrix decomposition ━━━',
      `  Read axis: naive → lean   (isolates lean reading effect)`,
      `  Edit axis: write → edit → hash   (isolates edit method effect)`,
      '',
      '  Cost matrix (read × edit):',
      `    naive + write = ${money(matrix.costs['naive+write'])}   (full-rewrite baseline)`,
      `    naive + edit  = ${money(matrix.costs['naive+edit'])}   (strawman: smart edit + dumb reads)`,
      `    lean  + edit  = ${money(matrix.costs['lean+edit'])}   (apples-to-apples: smart edit + lean reads)`,
      `    lean  + hash  = ${money(matrix.costs['lean+hash'])}   (TokenLean: hash edit + lean reads)`,
      '',
      '  Lever isolation:',
      `    Read-axis effect  (naive+edit → lean+edit):   ${pct(readAxisPct)} savings ← THE BIG LEVER`,
      `    Edit-axis effect  (lean+edit → lean+hash):   ${pct(editAxisPct)} savings ← hash vs Edit, apples-to-apples`,
      `    Combined effect   (naive+edit → lean+hash):  ${pct((1 - tokenlean / nativeEditBaseline) * 100)} savings ← old headline number`,
      '',
      `  OUTPUT tokens: write=${outputTokens.writeTokens} edit=${outputTokens.nativeEditTokens} hash=${outputTokens.tokenleanHashTokens}`,
      `  FUTURE INPUT tokens: naive=${naiveFutureTokenTurns} lean=${leanFutureTokenTurns}`,
      '',
    ].join('\n') + '\n');
  }

  return {
    dimension: 'CODING AGENT',
    turns,
    pricing,
    historyCacheReadMultiplier,
    matrix,
    components: { futureInput, output: outputTokens },
    costs: {
      fullRewriteBaseline,
      nativeEditBaseline,
      leanEditBaseline,
      tokenlean,
      savingsVsFullRewritePct: (1 - tokenlean / fullRewriteBaseline) * 100,
      savingsVsNativeEditPct: (1 - tokenlean / nativeEditBaseline) * 100,
      savingsVsLeanEditPct: (1 - tokenlean / leanEditBaseline) * 100,
    },
    attribution:
      'Savings are dominated by lean reading (FUTURE INPUT), not hash editing. ' +
      'Compare lean+edit vs lean+hash to isolate the edit-axis effect; ' +
      'compare naive+edit vs lean+edit to isolate the read-axis effect.',
    caveat:
      'Accounting model only: it assumes the agent follows the lean path. Real savings require measuring tool-choice compliance and task success. ' +
      `Re-billed history tokens are billed at ${historyCacheReadMultiplier}× base input (cache-read), not full price.`,
  };
}

export function renderCodingAgentReport(result) {
  const m = result.matrix.costs;
  const readAxisPct = (1 - result.costs.leanEditBaseline / result.costs.nativeEditBaseline) * 100;
  return `# Coding-agent benchmark\n\n` +
    `Session length: ${result.turns} turns\n\n` +
    `Pricing: input ${money(result.pricing.inputPerMTok)}/Mtok, output ${money(result.pricing.outputPerMTok)}/Mtok\n` +
    `History re-bill: ${result.historyCacheReadMultiplier}× base input (cache-read discount on re-billed FUTURE INPUT)\n\n` +
    `## 2×2 cost decomposition (read axis × edit axis)\n\n` +
    `| Read \\ Edit | Write (full rewrite) | Edit (str_replace) | Hash (fs_edit_hash) |\n` +
    `|---|---:|---:|---:|\n` +
    `| **naive** (full-file reads) | ${money(m['naive+write'])} | ${money(m['naive+edit'])} | — |\n` +
    `| **lean** (outline/bounded/search) | — | ${money(m['lean+edit'])} | ${money(m['lean+hash'])} |\n\n` +
    `## Savings summary\n\n` +
    `| Variant | Cost | Savings |\n` +
    `|---|---:|---:|\n` +
    `| Full-rewrite baseline (naive+write) | ${money(result.costs.fullRewriteBaseline)} | — |\n` +
    `| Native-Edit baseline (naive+edit) | ${money(result.costs.nativeEditBaseline)} | ${pct(result.costs.savingsVsFullRewritePct)} vs full rewrite |\n` +
    `| **Lean-read + Edit** (apples-to-apples) | ${money(result.costs.leanEditBaseline)} | ${pct((1 - result.costs.leanEditBaseline / result.costs.fullRewriteBaseline) * 100)} vs full rewrite |\n` +
    `| TokenLean (lean+hash) | ${money(result.costs.tokenlean)} | ${pct(result.costs.savingsVsFullRewritePct)} vs full rewrite / ${pct(result.costs.savingsVsNativeEditPct)} vs native Edit |\n\n` +
    `### Attribution (F-1)\n` +
    `Savings are dominated by **lean reading** (FUTURE INPUT), not hash editing.\n` +
    `- Read-axis effect (naive+edit → lean+edit): ${pct(readAxisPct)} — this is the big lever.\n` +
    `- Edit-axis effect (lean+edit → lean+hash): ${pct(result.costs.savingsVsLeanEditPct)} — isolates hash vs Edit with identical reads (apples-to-apples).\n` +
    `- Old headline "${pct(result.costs.savingsVsNativeEditPct)} vs native Edit" conflated both axes; the honest edit-only number is ${pct(result.costs.savingsVsLeanEditPct)}.\n\n` +
    `Components: FUTURE INPUT ${result.components.futureInput.tokenleanTokens}/${result.components.futureInput.naiveTokens} token-turns (TokenLean/naive), OUTPUT ${result.components.output.tokenleanHashTokens}/${result.components.output.writeTokens} emitted tokens (hash/full-write).\n\n` +
    `Caveat: ${result.caveat}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runCodingAgentBench({ root: join(process.cwd(), '..') });
  console.log(renderCodingAgentReport(result));
}
