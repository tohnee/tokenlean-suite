#!/usr/bin/env node
/**
 * bench-coding-agent.mjs — combines OUTPUT and FUTURE INPUT into a coding-agent
 * cost model.
 *
 * It answers: if a coding agent does repo orientation/search/inspection and a
 * representative edit batch, how much input/output token cost does TokenLean's
 * lean-tool path avoid versus naive baselines?
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
  const [output, future] = await Promise.all([
    runOutputBench(),
    runFutureBench({ turns, root }),
  ]);

  const futureInput = {
    naiveTokens: future.totals.naiveFutureTokenTurns,
    tokenleanTokens: future.totals.leanFutureTokenTurns,
  };
  const outputTokens = {
    writeTokens: output.totals.write,
    nativeEditTokens: output.totals.edit,
    tokenleanHashTokens: output.totals.hash,
  };

  const fullRewriteBaseline =
    cost(futureInput.naiveTokens, pricing.inputPerMTok) +
    cost(outputTokens.writeTokens, pricing.outputPerMTok);
  const nativeEditBaseline =
    cost(futureInput.naiveTokens, pricing.inputPerMTok) +
    cost(outputTokens.nativeEditTokens, pricing.outputPerMTok);
  const tokenlean =
    cost(futureInput.tokenleanTokens, pricing.inputPerMTok) +
    cost(outputTokens.tokenleanHashTokens, pricing.outputPerMTok);

  return {
    dimension: 'CODING AGENT',
    turns,
    pricing,
    components: {
      futureInput,
      output: outputTokens,
    },
    costs: {
      fullRewriteBaseline,
      nativeEditBaseline,
      tokenlean,
      savingsVsFullRewritePct: (1 - tokenlean / fullRewriteBaseline) * 100,
      savingsVsNativeEditPct: (1 - tokenlean / nativeEditBaseline) * 100,
    },
    caveat: 'Accounting model only: it assumes the agent follows the lean path. Real savings require measuring tool-choice compliance and task success.',
  };
}

export function renderCodingAgentReport(result) {
  return `# Coding-agent benchmark\n\n` +
    `Session length: ${result.turns} turns\n\n` +
    `Pricing: input ${money(result.pricing.inputPerMTok)}/Mtok, output ${money(result.pricing.outputPerMTok)}/Mtok\n\n` +
    `| Variant | Cost | Savings vs variant |\n` +
    `|---|---:|---:|\n` +
    `| Full-rewrite baseline | ${money(result.costs.fullRewriteBaseline)} | — |\n` +
    `| Native-Edit baseline | ${money(result.costs.nativeEditBaseline)} | — |\n` +
    `| TokenLean | ${money(result.costs.tokenlean)} | ${pct(result.costs.savingsVsFullRewritePct)} vs full rewrite / ${pct(result.costs.savingsVsNativeEditPct)} vs native Edit |\n\n` +
    `Components: FUTURE INPUT ${result.components.futureInput.tokenleanTokens}/${result.components.futureInput.naiveTokens} token-turns (TokenLean/naive), OUTPUT ${result.components.output.tokenleanHashTokens}/${result.components.output.writeTokens} emitted tokens (hash/full-write).\n\n` +
    `Caveat: ${result.caveat}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runCodingAgentBench({ root: join(process.cwd(), '..') });
  console.log(renderCodingAgentReport(result));
}
