#!/usr/bin/env node
/**
 * chatbot-rag-benchmark.mjs — local chatbot+RAG savings lab.
 *
 * This is a deterministic, no-network test environment for measuring the token
 * economics of TokenLean's cache-aware RAG layout. It compares:
 *   1. naive RAG: volatile retrieval metadata is prepended before stable prompt
 *   2. cache-aware RAG: stable system/KB/pinned docs first, normalized chunks last
 *
 * The harness intentionally measures prompt bytes/tokens and a provider-like
 * cache billing model. For production, replace the estimated usage with your
 * provider's real usage fields; the report explains where to plug them in.
 */

import { writeFileSync } from 'node:fs';
import { normalizeRetrieved, estTokens } from '../../04-prompt-assembler/lib/assembler.mjs';

const money = (n) => `$${n.toFixed(6)}`;
const pct = (n) => `${Math.round(n)}%`;

export function defaultScenario() {
  const longPolicy = [
    'You are AcmeSupport, a production customer-support chatbot.',
    'Answer only from the supplied knowledge base context.',
    'When evidence is insufficient, ask a clarifying question instead of guessing.',
    'Always preserve source ids internally for citation rendering.',
    'Keep answers concise but complete.',
  ].join('\n');

  const docs = [
    { id: 'refunds', text: 'Refunds are processed in 5-7 business days. Refund requests require an order id and the original payment method.' },
    { id: 'premium', text: 'Premium plan includes priority support, unlimited API calls, custom integrations, audit logs, and a 99.9% SLA.' },
    { id: 'limits', text: 'API rate limits are 1000 requests/min for free tier and 10000 requests/min for premium. 429 responses include retry-after.' },
    { id: 'security', text: 'Two-factor authentication can be enabled in Account > Security. SSO is available on Enterprise plans.' },
    { id: 'billing', text: 'Invoices are generated monthly. Payment methods include credit card, PayPal, ACH, and wire transfer.' },
    { id: 'retention', text: 'Data retention policy: logs are stored for 90 days, backups for 30 days, and deleted data is recoverable for 7 days.' },
  ];

  const kbIndex = [
    'KB INDEX:',
    '- refunds: refund timing and request requirements',
    '- premium: plan benefits and SLA',
    '- limits: API quotas and retry-after behavior',
    '- security: 2FA and SSO',
    '- billing: invoice and payment methods',
    '- retention: logs, backups, and deletion windows',
    // Make the stable prefix large enough for local cache-economics testing.
    'NAVIGATION NOTES: '.repeat(220),
  ].join('\n');

  const byId = new Map(docs.map((d) => [d.id, d]));
  const turns = [
    { query: 'How long do refunds take?', ids: ['refunds', 'billing', 'premium'] },
    { query: 'What does premium include?', ids: ['premium', 'limits', 'refunds'] },
    { query: 'Explain API limits for premium', ids: ['limits', 'premium', 'security'] },
    { query: 'Can I use 2FA and SSO?', ids: ['security', 'premium', 'retention'] },
    { query: 'How do monthly invoices work?', ids: ['billing', 'refunds', 'retention'] },
    { query: 'Remind me what premium includes', ids: ['premium', 'limits', 'refunds'] },
    { query: 'Refund request requirements again', ids: ['refunds', 'billing', 'premium'] },
  ].map((turn, turnIndex) => ({
    ...turn,
    results: turn.ids.map((id, rank) => ({
      id,
      text: byId.get(id).text,
      score: Number((0.97 - rank * 0.11 - turnIndex * 0.003).toFixed(3)),
      rank: rank + 1,
      retrieved_at: `2026-06-24T12:${String(turnIndex).padStart(2, '0')}:00Z`,
    })),
  }));

  return {
    name: 'AcmeSupport chatbot repeated-KB workload',
    system: longPolicy,
    kb: { index: kbIndex, docs },
    pinnedDocIds: ['refunds', 'premium'],
    turns,
  };
}

function rawRetrievedBlock(results) {
  return results.map((c) => `[score=${c.score}][rank=${c.rank}][retrieved_at=${c.retrieved_at}][id=${c.id}] ${c.text}`).join('\n');
}

function normalizedRetrievedBlock(results) {
  return normalizeRetrieved(results)
    .map((c, i) => `[${i + 1}] id:${c.id}\n${c.text}`)
    .join('\n');
}

function sourceIds(results) {
  return normalizeRetrieved(results).map((c) => c.id).sort().join('|');
}

function commonPrefixBytes(a, b) {
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  return i;
}

function price(tokens, perMTok) {
  return (tokens / 1_000_000) * perMTok;
}

function scoreVariant(turns, opts) {
  const minCacheTokens = opts.minCacheTokens ?? 1024;
  const uncachedInputPerMTok = opts.uncachedInputPerMTok ?? 3;
  const cachedReadPerMTok = opts.cachedReadPerMTok ?? 0.3;
  // F-6: the first time a prefix is written to cache, Anthropic charges a 1.25×
  // write premium on those tokens. This is applied symmetrically to both naive
  // and cache-aware variants (whichever writes a cacheable prefix pays it).
  const cacheWritePremium = opts.cacheWritePremium ?? 1.25;
  let previousPrefix = '';
  let cacheHitTurns = 0;
  let fullInputTokens = 0;
  let billedInputTokens = 0;
  let totalCost = 0;

  const scoredTurns = turns.map((turn, i) => {
    const inputTokens = estTokens(turn.prompt);
    const prefixTokens = estTokens(turn.cachePrefix);
    const canHit = i > 0 && prefixTokens >= minCacheTokens && previousPrefix === turn.cachePrefix;
    const cachedTokens = canHit ? prefixTokens : 0;
    const uncachedTokens = inputTokens - cachedTokens;
    const billedTokens = uncachedTokens + cachedTokens * (cachedReadPerMTok / uncachedInputPerMTok);
    // F-6: if this turn writes a new cacheable prefix (not a hit), the prefix
    // portion pays the write premium. Cache-read turns pay the read price.
    const cacheWriteTokens = (!canHit && prefixTokens >= minCacheTokens) ? prefixTokens : 0;
    const prefixPortion = cacheWriteTokens > 0 ? cacheWriteTokens : 0;
    const restTokens = inputTokens - prefixPortion;
    const cost = canHit
      ? price(restTokens, uncachedInputPerMTok) + price(cachedTokens, cachedReadPerMTok)
      : price(restTokens, uncachedInputPerMTok) + price(prefixPortion, uncachedInputPerMTok * cacheWritePremium);
    const commonPrefixWithPrevious = i > 0 ? commonPrefixBytes(turn.prompt, turns[i - 1].prompt) : 0;

    if (canHit) cacheHitTurns++;
    fullInputTokens += inputTokens;
    billedInputTokens += billedTokens;
    totalCost += cost;
    previousPrefix = turn.cachePrefix;

    return {
      index: i + 1,
      query: turn.query,
      prompt: turn.prompt,
      sourceIds: turn.sourceIds,
      inputTokens,
      prefixTokens,
      cachedTokens,
      uncachedTokens,
      cacheWriteTokens,
      billedTokens,
      cost,
      cacheHit: canHit,
      commonPrefixWithPrevious,
    };
  });

  return { turns: scoredTurns, cacheHitTurns, fullInputTokens, billedInputTokens, totalCost };
}

export function runBenchmark(scenario = defaultScenario(), opts = {}) {
  const pinnedDocs = scenario.kb.docs
    .filter((d) => scenario.pinnedDocIds.includes(d.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const stablePrefix = [
    `SYSTEM:\n${scenario.system}`,
    `KB_INDEX:\n${scenario.kb.index}`,
    `PINNED_DOCS:\n${pinnedDocs.map((d) => `[${d.id}] ${d.text}`).join('\n')}`,
  ].join('\n\n');

  const naiveTurns = scenario.turns.map((turn) => {
    const volatileFirst = rawRetrievedBlock(turn.results);
    const prompt = [
      `RETRIEVED_CONTEXT:\n${volatileFirst}`,
      stablePrefix,
      `USER:\n${turn.query}`,
    ].join('\n\n');
    // Naive RAG's cacheable prefix is effectively the first volatile block; it
    // changes because score/rank/timestamp/order are part of the leading bytes.
    return { query: turn.query, prompt, cachePrefix: `RETRIEVED_CONTEXT:\n${volatileFirst}`, sourceIds: sourceIds(turn.results) };
  });

  const cacheAwareTurns = scenario.turns.map((turn) => {
    const normalizedTail = normalizedRetrievedBlock(turn.results);
    const prompt = [
      stablePrefix,
      '--- CACHE BREAKPOINT: stable prefix above / volatile RAG below ---',
      `RETRIEVED_CONTEXT_NORMALIZED:\n${normalizedTail}`,
      `USER:\n${turn.query}`,
    ].join('\n\n');
    return { query: turn.query, prompt, cachePrefix: stablePrefix, sourceIds: sourceIds(turn.results) };
  });

  const naive = scoreVariant(naiveTurns, opts);
  const cacheAware = scoreVariant(cacheAwareTurns, opts);
  const savingsPct = (1 - cacheAware.totalCost / naive.totalCost) * 100;

  const conclusion = {
    kind: 'local-estimate',
    savingsPct,
    summary: `Local estimate: cache-aware RAG reduces billed input cost by ${pct(savingsPct)} in this repeated-KB chatbot workload (${cacheAware.cacheHitTurns}/${cacheAware.turns.length} turns hit the reusable prefix).`,
    caveat: 'This is a deterministic local estimate, not a provider bill. Use live-provider-compare.mjs with your base URL and API key to collect real usage.',
  };

  return {
    scenario: scenario.name,
    options: {
      minCacheTokens: opts.minCacheTokens ?? 1024,
      uncachedInputPerMTok: opts.uncachedInputPerMTok ?? 3,
      cachedReadPerMTok: opts.cachedReadPerMTok ?? 0.3,
    },
    naive,
    cacheAware,
    savingsPct,
    conclusion,
    quality: {
      sameSourceCoverage: naive.turns.every((t, i) => t.sourceIds === cacheAware.turns[i].sourceIds),
      note: 'Quality proxy only checks that both layouts expose the same normalized source ids; run answer-quality evals with your real model separately.',
    },
  };
}

export function renderMarkdownReport(result) {
  const rows = [
    ['Naive RAG', result.naive],
    ['Cache-aware RAG', result.cacheAware],
  ].map(([name, r]) => `| ${name} | ${r.turns.length} | ${r.cacheHitTurns} | ${Math.round(r.billedInputTokens)} | ${money(r.totalCost)} |`).join('\n');

  const turnRows = result.cacheAware.turns.map((t) =>
    `| ${t.index} | ${t.cacheHit ? 'yes' : 'no'} | ${t.prefixTokens} | ${t.cachedTokens} | ${Math.round(t.billedTokens)} | ${money(t.cost)} | ${t.query} |`
  ).join('\n');

  return `# Chatbot + RAG Token Savings Benchmark\n\n` +
    `Scenario: **${result.scenario}**\n\n` +
    `Pricing model: uncached input ${money(result.options.uncachedInputPerMTok)}/Mtok, cached read ${money(result.options.cachedReadPerMTok)}/Mtok, minimum cache prefix ~${result.options.minCacheTokens} tokens.\n\n` +
    `| Variant | Turns | Cache-hit turns | Input tokens billed | Cost |\n` +
    `|---|---:|---:|---:|---:|\n${rows}\n\n` +
    `Estimated savings: **${pct(result.savingsPct)}**\n\n` +
    `## Local benchmark conclusion\n\n` +
    `${result.conclusion.summary}\n\n` +
    `Caveat: ${result.conclusion.caveat}\n\n` +
    `## Cache-aware turn details\n\n` +
    `| Turn | Cache hit | Prefix tokens | Cached tokens | Billed tokens | Cost | Query |\n` +
    `|---:|---|---:|---:|---:|---:|---|\n${turnRows}\n\n` +
    `## How to plug in real provider usage\n\n` +
    `1. Keep the same A/B layouts: naive volatile-first RAG vs stable-prefix cache-aware RAG.\n` +
    `2. Send both variants to your provider with identical model/settings and representative conversations.\n` +
    `3. Replace estimated \`inputTokens/cachedTokens/cost\` with provider usage fields such as uncached input, cache creation, and cache read tokens.\n` +
    `4. Keep the quality proxy: both variants must expose the same source ids, then run answer-quality/citation evals before accepting savings.\n` +
    `5. Compute savings as \`1 - cacheAwareCost / naiveCost\`.\n`;
}

function parseArgs(argv) {
  const out = { json: false, output: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--out') out.output = argv[++i] || '';
    else if (a === '--min-cache-tokens') out.minCacheTokens = Number(argv[++i]);
    else if (a === '--uncached-input-per-mtok') out.uncachedInputPerMTok = Number(argv[++i]);
    else if (a === '--cached-read-per-mtok') out.cachedReadPerMTok = Number(argv[++i]);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const result = runBenchmark(defaultScenario(), args);
  const body = args.json ? JSON.stringify(result, null, 2) : renderMarkdownReport(result);
  if (args.output) writeFileSync(args.output, body + '\n', 'utf8');
  else console.log(body);
}
