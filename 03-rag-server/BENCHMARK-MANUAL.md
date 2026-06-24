# Chatbot + RAG Benchmark Test Manual

This manual lets you compare **naive RAG** vs **TokenLean cache-aware RAG** with only:

1. a provider **base URL**
2. an **API key**

The live runner uses an OpenAI-compatible `POST /chat/completions` API. You can pass a model explicitly, or rely on the default `gpt-4o-mini`.

## 1. Local dry run first

Run the deterministic no-network benchmark:

```bash
node 03-rag-server/bench/chatbot-rag-benchmark.mjs
# or
npx tokenlean tl-rag bench
```

Expected local conclusion for the built-in repeated-KB scenario:

- naive RAG: volatile retrieval metadata is placed first, so it gets **0 cache-hit turns**;
- cache-aware RAG: stable system/KB/pinned-doc prefix is reused, so turns after the first can hit cache;
- local estimate should show a material cost reduction, but it is still a simulation, not a provider bill.

## 2. Live provider comparison

Use environment variables:

```bash
export TOKENLEAN_PROVIDER_BASE_URL="https://api.openai.com/v1"
export TOKENLEAN_PROVIDER_API_KEY="$OPENAI_API_KEY"
export TOKENLEAN_PROVIDER_MODEL="gpt-4o-mini" # optional

node 03-rag-server/bench/live-provider-compare.mjs --turns 3
```

Or pass values directly:

```bash
node 03-rag-server/bench/live-provider-compare.mjs \
  --base-url "https://api.openai.com/v1" \
  --api-key "$OPENAI_API_KEY" \
  --model "gpt-4o-mini" \
  --turns 3
```

After package install/link, the same command is available as:

```bash
tl-rag live --base-url "https://api.openai.com/v1" --api-key "$OPENAI_API_KEY" --turns 3
```

## 3. JSON output for dashboards

```bash
tl-rag live \
  --base-url "https://api.openai.com/v1" \
  --api-key "$OPENAI_API_KEY" \
  --model "gpt-4o-mini" \
  --turns 5 \
  --json \
  --out /tmp/tokenlean-rag-live.json
```

The JSON includes:

- provider endpoint and model;
- request count for each variant;
- prompt tokens, completion tokens, total tokens;
- cached tokens when the provider exposes them;
- a local benchmark conclusion for comparison;
- per-turn raw usage summaries.

## 4. How to interpret results

A good result looks like this:

- cache-aware `cachedTokens` is greater than naive `cachedTokens`, **or** cache-aware prompt tokens/cost are lower;
- answer quality remains acceptable;
- both layouts preserve the same retrieved source ids in the test harness.

If `cachedTokens` is always zero:

1. your provider may not expose cache accounting;
2. your model may not support prompt caching;
3. the provider cache threshold may be higher than the benchmark prompt;
4. your base URL may be an OpenAI-compatible proxy that strips detailed usage fields.

In that case, use the deterministic local benchmark as a layout sanity check, and rely on your provider's billing dashboard or raw usage export for final cost validation.

## 5. Production A/B checklist

For a real chatbot rollout:

1. Use the same user turns, retriever, reranker, model, temperature, and max output for both variants.
2. Compare naive volatile-first RAG vs stable-prefix cache-aware RAG.
3. Record provider usage fields for every request.
4. Keep source-id coverage equal before accepting savings.
5. Add answer-quality and citation-correctness checks; token savings are only valid if answer quality is preserved.
