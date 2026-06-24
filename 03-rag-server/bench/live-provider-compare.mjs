#!/usr/bin/env node
/**
 * live-provider-compare.mjs — run the same chatbot+RAG A/B prompts against an
 * OpenAI-compatible chat completions endpoint.
 *
 * Minimal inputs:
 *   TOKENLEAN_PROVIDER_BASE_URL=https://api.openai.com/v1
 *   TOKENLEAN_PROVIDER_API_KEY=...
 * Optional:
 *   TOKENLEAN_PROVIDER_MODEL=gpt-4o-mini
 */

import { writeFileSync } from 'node:fs';
import { defaultScenario, runBenchmark } from './chatbot-rag-benchmark.mjs';

const DEFAULT_MODEL = 'gpt-4o-mini';

function endpointFromBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || '').replace(/\/+$/, '');
  if (!trimmed) throw new Error('baseUrl is required (use --base-url or TOKENLEAN_PROVIDER_BASE_URL)');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

function usageOf(json) {
  const usage = json?.usage || {};
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens);
  const cachedTokens =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.input_token_details?.cached_tokens ??
    usage.cache_read_input_tokens ??
    usage.cached_input_tokens ??
    0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens ?? 0;
  return { promptTokens, completionTokens, totalTokens, cachedTokens, cacheCreationTokens, raw: usage };
}

async function callChat({ endpoint, apiKey, model, prompt, maxTokens, temperature, fetchImpl }) {
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`provider request failed: HTTP ${res.status} ${text.slice(0, 500)}`);
  return { json, usage: usageOf(json) };
}

function aggregate(rows) {
  return rows.reduce((acc, r) => {
    acc.requests += 1;
    acc.promptTokens += r.usage.promptTokens;
    acc.completionTokens += r.usage.completionTokens;
    acc.totalTokens += r.usage.totalTokens;
    acc.cachedTokens += r.usage.cachedTokens;
    acc.cacheCreationTokens += r.usage.cacheCreationTokens;
    return acc;
  }, { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0 });
}

export async function runLiveComparison(opts = {}) {
  const baseUrl = opts.baseUrl || process.env.TOKENLEAN_PROVIDER_BASE_URL;
  const apiKey = opts.apiKey || process.env.TOKENLEAN_PROVIDER_API_KEY;
  const model = opts.model || process.env.TOKENLEAN_PROVIDER_MODEL || DEFAULT_MODEL;
  const turns = Math.max(1, Number(opts.turns || process.env.TOKENLEAN_PROVIDER_TURNS || 3));
  const maxTokens = Math.max(1, Number(opts.maxTokens || process.env.TOKENLEAN_PROVIDER_MAX_TOKENS || 64));
  const temperature = Number(opts.temperature ?? process.env.TOKENLEAN_PROVIDER_TEMPERATURE ?? 0);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!apiKey) throw new Error('apiKey is required (use --api-key or TOKENLEAN_PROVIDER_API_KEY)');
  if (!fetchImpl) throw new Error('fetch is unavailable; use Node >=18');

  const endpoint = endpointFromBaseUrl(baseUrl);
  const local = runBenchmark(defaultScenario());
  const selectedNaive = local.naive.turns.slice(0, turns);
  const selectedAware = local.cacheAware.turns.slice(0, turns);

  const naiveRows = [];
  const awareRows = [];
  for (let i = 0; i < Math.min(selectedNaive.length, selectedAware.length); i++) {
    const naive = await callChat({ endpoint, apiKey, model, prompt: selectedNaive[i].prompt, maxTokens, temperature, fetchImpl });
    naiveRows.push({ turn: i + 1, query: selectedNaive[i].query, usage: naive.usage });
    const aware = await callChat({ endpoint, apiKey, model, prompt: selectedAware[i].prompt, maxTokens, temperature, fetchImpl });
    awareRows.push({ turn: i + 1, query: selectedAware[i].query, usage: aware.usage });
  }

  const naiveAgg = aggregate(naiveRows);
  const awareAgg = aggregate(awareRows);
  const promptTokenSavingsPct = naiveAgg.promptTokens > 0
    ? (1 - awareAgg.promptTokens / naiveAgg.promptTokens) * 100
    : 0;

  return {
    endpoint,
    model,
    turns: naiveRows.length,
    localConclusion: local.conclusion.summary,
    note: 'Live results use provider-reported usage. If cachedTokens stays 0, your provider/model/base URL may not expose prompt-cache accounting or the prompt may be below that provider cache threshold.',
    naive: naiveAgg,
    cacheAware: awareAgg,
    promptTokenSavingsPct,
    rows: { naive: naiveRows, cacheAware: awareRows },
  };
}

export function renderLiveMarkdown(result) {
  return `# Live Chatbot + RAG Provider Comparison\n\n` +
    `Endpoint: ${result.endpoint}\n\n` +
    `Model: ${result.model}\n\n` +
    `Turns: ${result.turns}\n\n` +
    `Local benchmark conclusion: ${result.localConclusion}\n\n` +
    `| Variant | Requests | Prompt tokens | Cached tokens | Completion tokens | Total tokens |\n` +
    `|---|---:|---:|---:|---:|---:|\n` +
    `| Naive RAG | ${result.naive.requests} | ${result.naive.promptTokens} | ${result.naive.cachedTokens} | ${result.naive.completionTokens} | ${result.naive.totalTokens} |\n` +
    `| Cache-aware RAG | ${result.cacheAware.requests} | ${result.cacheAware.promptTokens} | ${result.cacheAware.cachedTokens} | ${result.cacheAware.completionTokens} | ${result.cacheAware.totalTokens} |\n\n` +
    `Provider prompt-token delta: ${Math.round(result.promptTokenSavingsPct)}%\n\n` +
    `Note: ${result.note}\n`;
}

function parseArgs(argv) {
  const out = { json: false, output: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') out.baseUrl = argv[++i];
    else if (a === '--api-key') out.apiKey = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--turns') out.turns = Number(argv[++i]);
    else if (a === '--max-tokens') out.maxTokens = Number(argv[++i]);
    else if (a === '--temperature') out.temperature = Number(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--out') out.output = argv[++i] || '';
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runLiveComparison(args);
    const body = args.json ? JSON.stringify(result, null, 2) : renderLiveMarkdown(result);
    if (args.output) writeFileSync(args.output, body + '\n', 'utf8');
    else console.log(body);
  } catch (err) {
    console.error(`[tokenlean-rag] ${err.message}`);
    process.exit(1);
  }
}
