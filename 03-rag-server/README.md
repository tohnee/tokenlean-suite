# tokenlean-rag

Cache-aware RAG MCP server for chatbots. Reuses `04-prompt-assembler`'s `planRag()` and `normalizeRetrieved()` to produce byte-stable, cache-friendly prompt prefixes.

## Problem

Naive RAG prepends retrieved chunks (which change every query) before the system prompt. This makes the prefix different every request — **100% cache miss rate**. Each query pays full input price.

## Solution

Two principles applied at the MCP tool level:

1. **Pin stable content**: KB index + hot docs go in the cache prefix (behind a breakpoint). They persist across queries.
2. **Normalize volatile content**: Retrieved chunks are id-sorted, metadata-stripped (no scores/timestamps/rank), and placed AFTER the breakpoint. Same chunk set = byte-identical tail = **cache hits on the tail too**.

## Tools

| Tool | What it does | Dimension |
|---|---|---|
| `rag_search(query, results?)` | Normalize retrieved chunks for cache-friendly layout. Pass results from your vector DB; server handles normalization. | FUTURE INPUT (prevents prefix drift) |
| `kb_pin(doc_ids)` | Pin hot docs into the stable cache prefix. Pinned docs persist across queries, id-sorted. | INPUT (extends cacheable prefix) |
| `headroom_retrieve(chunk_id, query?)` | CCR-style on-demand full-text retrieval. Get the full chunk text by its stable id. Optionally filter by text query. | FUTURE INPUT (enable compact presentation) |
| `token_report` | Session-level cache optimization stats. | Observability |

## Usage

### Start the server

```bash
# Basic
TOKENLEAN_RAG_TOKEN=secret node bin/http.mjs --port 8766

# With a KB index
TOKENLEAN_RAG_TOKEN=secret node bin/http.mjs \
  --kb-index "Our knowledge base covers: product docs, API reference, support."

# Expose to Claude.ai via cloudflared
cloudflared tunnel --url http://127.0.0.1:8766
```

### Prompt layout for optimal caching

When building your prompt, arrange content in this order:

```
  [STATIC]  system prompt (rarely changes)
  ── cache_control breakpoint (1) ──
  [SESSION] KB index + pinned docs (changes daily)
  ── cache_control breakpoint (2) ──
  [VOLATILE] rag_search output (changes every query)
  [VOLATILE] user message
```

This way, the system prompt + KB index are cacheable across queries.
Only the retrieved chunks and user message are re-billed at full price.

### API

Connect your chatbot's MCP client:

```json
{
  "mcpServers": {
    "tokenlean-rag": {
      "url": "http://localhost:8766/mcp",
      "headers": {
        "Authorization": "Bearer your-TOKENLEAN_RAG_TOKEN"
      }
    }
  }
}
```

## Test

```bash
node test/test-rag.mjs
# 36 assertions, all pass
```

## Architecture

```
04-prompt-assembler/lib/assembler.mjs
  └── planRag() + normalizeRetrieved()  (pure functions, tested)
          │
          ▼
03-rag-server/lib/rag-core.mjs
  └── createRagCore()  (MCP dispatch, 4 tools)
          │
          ▼
03-rag-server/bin/http.mjs
  └── Streamable HTTP transport (Bearer auth, sessions, CORS)
```

## Dependencies

Zero (`04-prompt-assembler/lib/assembler.mjs` is pure JS, no npm deps).
Node >= 18.
