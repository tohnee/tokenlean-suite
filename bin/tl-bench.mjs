#!/usr/bin/env node
/** Unified TokenLean benchmark: OUTPUT + FUTURE INPUT + CODING AGENT + INPUT/RAG. */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOutputBench } from '../02-mcp-server/test/bench-output.mjs';
import { runFutureBench } from '../02-mcp-server/test/bench-future.mjs';
import { runCodingAgentBench } from '../02-mcp-server/test/bench-coding-agent.mjs';
import { defaultScenario, runBenchmark as runRagBench } from '../03-rag-server/bench/chatbot-rag-benchmark.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const pct = (n) => `${Math.round(n)}%`;

export async function runSuiteBench(opts = {}) {
  const turns = Number(opts.turns || 12);
  const [output, future, codingAgent] = await Promise.all([
    runOutputBench(),
    runFutureBench({ turns, root: repoRoot }),
    runCodingAgentBench({ turns, root: repoRoot }),
  ]);
  const rag = runRagBench(defaultScenario());
  return {
    generatedAt: new Date().toISOString(),
    note: 'Deterministic accounting benchmark: measures token/layout mechanics, not autonomous model behavior or final provider bills.',
    output,
    future,
    codingAgent,
    rag,
  };
}

export function renderSuiteBench(result) {
  return `# TokenLean savings report\n\n` +
    `Generated: ${result.generatedAt}\n\n` +
    `Honesty note: this is an accounting benchmark. It quantifies emitted/output bytes, tool-output history re-billing, and cache-aware RAG layout economics; it does not prove a real model will always choose the lean path.\n\n` +
    `| Dimension | Scenario | Main result | Caveat |\n` +
    `|---|---|---:|---|\n` +
    `| OUTPUT | coding edit tool-call bytes | ${pct(result.output.hashVsWriteSavingsPct)} vs full Write / ${pct(result.output.hashVsEditSavingsPct)} vs competent Edit | Hash anchors are reliability-first vs strong native Edit. |\n` +
    `| FUTURE INPUT | coding-agent tool output re-billed over ${result.future.turns} turns | ${pct(result.future.totals.futureSavingsPct)} cumulative context-token-turn savings | Depends on how often risky tool calls occur. |\n` +
    `| CODING AGENT | combined input re-billing + edit output cost | ${pct(result.codingAgent.costs.savingsVsFullRewritePct)} vs full-rewrite agent / ${pct(result.codingAgent.costs.savingsVsNativeEditPct)} vs native-Edit agent | Accounting model assumes the agent follows lean tools. |\n` +
    `| INPUT/RAG | chatbot repeated-KB cache-aware layout | ${pct(result.rag.savingsPct)} billed-input savings | Local cache economics; verify with live provider usage. |\n\n` +
    `## FUTURE INPUT detail\n\n` +
    `Cumulative context-token-turns: lean ${result.future.totals.leanFutureTokenTurns}, naive ${result.future.totals.naiveFutureTokenTurns}.\n\n` +
    `## Reproduce\n\n` +
    `- \`node 02-mcp-server/test/bench-output.mjs\`\n` +
    `- \`node 02-mcp-server/test/bench-future.mjs\`\n` +
    `- \`node 02-mcp-server/test/bench-coding-agent.mjs\`\n` +
    `- \`node 03-rag-server/bench/chatbot-rag-benchmark.mjs\`\n`;
}

function parseArgs(argv) {
  const out = { json: false, output: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--out') out.output = argv[++i] || '';
    else if (a === '--turns') out.turns = Number(argv[++i]);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const result = await runSuiteBench(args);
  const body = args.json ? JSON.stringify(result, null, 2) : renderSuiteBench(result);
  if (args.output) writeFileSync(args.output, body + '\n', 'utf8');
  else console.log(body);
}
