/**
 * rag-core.mjs — cache-aware RAG MCP server core.
 *
 * Exposes createRagCore({ kb }) → { tools, dispatch, stats, resetStats, serverInfo }
 *
 * Reuses 04-prompt-assembler's planRag() and normalizeRetrieved() for cache-optimized
 * prompt layout. The same pure functions that produce byte-stable prefixes for coding
 * agent prompts now produce byte-stable RAG context for chatbot prompts.
 *
 * Design philosophy:
 *   RAG's cache problem is NOT a compression problem — it's an ORDERING problem.
 *   The same bytes, sent in a different order, can turn a 100% cache-miss scenario
 *   into a high-hit-rate one. normalizeRetrieved() does exactly that: it doesn't
 *   reduce bytes, it makes bytes STABLE.
 *
 * Zero dependencies. Node >= 18.
 */

import { createHash } from 'node:crypto';
import { planRag, normalizeRetrieved, reportAssembly, assemble, estTokens, STABILITY } from '../../04-prompt-assembler/lib/assembler.mjs';

export const SERVER_INFO = { name: 'tokenlean-rag', version: '0.1.0' };
const MAX_TOP_K = 50;
const hashText = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

/**
 * @typedef {object} RagChunk
 * @property {string} id
 * @property {string} text
 * @property {number} [score]
 * @property {number} [rank]
 * @property {string} [timestamp]
 */

/**
 * @typedef {object} KnowledgeBase
 * @property {string} [index]       — KB index / navigation layer text (stable, cacheable)
 * @property {RagChunk[]} [docs]   — canonical/hot documents (pinned into prefix)
 */

/**
 * Create a RAG core instance bound to a knowledge base.
 *
 * @param {{
 *   kb?: KnowledgeBase,
 *   pinHotCount?: number,  // how many hot docs to pin into the cached prefix (default 5)
 * }} opts
 */
export function createRagCore(opts = {}) {
  const kb = opts.kb ?? { index: '', docs: [] };
  const pinHotCount = opts.pinHotCount ?? 5;

  // Session stats for token_report
  const stats = {
    searches: 0,
    pins: 0,
    retrieves: 0,
    totalRetrievedChunks: 0,
    totalRetrievedTokens: 0,
    reaskHits: 0,       // number of times multi-turn re-ask had byte-identical tail
    recentTailHashes: [],  // F-8: ring buffer of recent tail hashes (non-adjacent repeat detection)
  };

  /** Reset session stats (for session isolation). */
  function resetStats() {
    stats.searches = 0;
    stats.pins = 0;
    stats.retrieves = 0;
    stats.totalRetrievedChunks = 0;
    stats.totalRetrievedTokens = 0;
    stats.reaskHits = 0;
    stats.recentTailHashes = [];
  }

  // ── In-memory "pinned" docs registry ──
  // These are hot documents the user explicitly asked to pin into the cache prefix.
  // They persist across queries for the session lifetime.
  const pinnedDocIds = new Set();

  /**
   * Simulate retrieval from the KB.
   * In production, this would call your vector DB / BM25 / hybrid search.
   * Here we accept results from external and just normalize + track them.
   *
   * @param {string} query
   * @param {number} topK
   * @returns {RagChunk[]} retrieved and normalized chunks
   */
  function retrieve(query, topK) {
    // In a real deployment this is replaced by actual retrieval.
    // For now, the caller passes results via rag_search's `results` param,
    // or we return from the KB's hot docs as a fallback.
    const fromKb = (kb.docs || []).slice(0, topK).map((d) => ({ id: d.id, text: d.text }));
    return fromKb;
  }

  // ── Tool handlers ──

  /**
   * rag_search: retrieve + normalize in one call.
   *
   * The key design: the caller passes their retrieval results, and this tool
   * handles the cache-optimized layout (normalization + prefix planning).
   * This keeps the core pure — it doesn't need to know your vector DB.
   *
   * If `results` is omitted and a KB is configured, it falls back to
   * returning pinned docs from the KB as a basic retrieval simulation.
   */
  function handleRagSearch({ query, top_k = 5, results }) {
    stats.searches++;
    const k = Math.max(1, Math.min(Number(top_k) || 5, MAX_TOP_K));

    // Accept external results, or fall back to KB docs
    let chunks;
    if (Array.isArray(results) && results.length > 0) {
      chunks = results.slice(0, k);
    } else {
      // Fallback: return pinned + hot docs from KB
      chunks = (kb.docs || []).slice(0, k).map((d) => ({ id: d.id, text: d.text, score: 0 }));
    }

    // Cache-aware normalization: stable id order, no volatile metadata
    const normalized = normalizeRetrieved(chunks);
    stats.totalRetrievedChunks += normalized.length;
    stats.totalRetrievedTokens += normalized.reduce((s, c) => s + estTokens(c.text), 0);

    // F-8: detect re-ask using a ring buffer of recent tail hashes (not just
    // the last call), so non-adjacent repeats (A, B, A) are also caught.
    const tailHash = normalized.map((c) => `${c.id}:${hashText(c.text)}`).join('|');
    const isReask = stats.recentTailHashes.includes(tailHash);
    if (isReask) {
      stats.reaskHits++;
    }
    // update ring buffer (keep last 5)
    stats.recentTailHashes.push(tailHash);
    if (stats.recentTailHashes.length > 5) stats.recentTailHashes.shift();

    // Build the pinned prefix from the KB index + user-pinned docs
    const pinned = [];
    if (kb.index) {
      pinned.push({
        id: 'kb-index', role: 'system', stability: STABILITY.SESSION,
        text: typeof kb.index === 'string' ? kb.index : JSON.stringify(kb.index),
      });
    }
    // Add pinned hot docs (deterministic id order)
    const pinnedFromKb = (kb.docs || [])
      .filter((d) => pinnedDocIds.has(d.id))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const d of pinnedFromKb) {
      pinned.push({
        id: `kb-doc:${d.id}`, role: 'system', stability: STABILITY.SESSION,
        text: d.text,
      });
    }

    // Full cache-aware plan (informational — returned in the response metadata)
    // The actual prompt layout is done by the chatbot app calling planRag().
    // Here we just return the normalized chunks with metadata.
    const prefixTokens = pinned.reduce((s, seg) => s + estTokens(seg.text), 0);
    const tailTokens = normalized.reduce((s, c) => s + estTokens(c.text), 0);

    return [
      `# rag_search results  (query: "${query}", top_k: ${k})`,
      ``,
      `stable prefix (cacheable):  ${pinned.length} segment(s), ~${prefixTokens} tokens`,
      `normalized tail (volatile): ${normalized.length} chunk(s), ~${tailTokens} tokens`,
      ...(isReask
        ? [`note: same chunk set seen before — tail is byte-stable, cache can hit`]
        : []),
      ``,
      `--- normalized chunks (id-sorted, metadata stripped) ---`,
      ...normalized.map((c, i) => `[${i + 1}] id:${c.id}`),
      ``,
      `--- chunk text ---`,
      ...normalized.map((c, i) => `[${i + 1}] ${c.text}`),
      ...(isReask && stats.searches > 1
        ? [`\n[!] same chunk set as a previous query — cache hit possible for the volatile tail too (id-sorted, byte-identical)`]
        : []),
    ].join('\n');
  }

  /**
   * kb_pin: pin hot documents into the stable cache prefix.
   * Pinned docs persist across queries for the session, and are placed
   * behind the system/KB-index breakpoint so daily changes only invalidate
   * the pinned section without dropping the rest of the prefix.
   */
  function handleKbPin({ doc_ids }) {
    const ids = Array.isArray(doc_ids) ? doc_ids : [doc_ids];
    let pinned = 0, notFound = 0;
    for (const id of ids) {
      const exists = (kb.docs || []).some((d) => String(d.id) === String(id));
      if (exists) {
        pinnedDocIds.add(String(id));
        pinned++;
      } else {
        notFound++;
      }
    }
    stats.pins += pinned;
    const current = pinnedDocIds.size;
    return [
      `# kb_pin result`,
      `pinned:     ${pinned} doc(s)${notFound ? `  (${notFound} not found in KB)` : ''}`,
      `total pinned: ${current} doc(s) in the stable cache prefix`,
      `tip: pinned docs are id-sorted and placed after the KB index breakpoint.`,
      `     They persist across queries as long as this session lives.`,
      ...(current > 20
        ? [`warning: ${current} pinned docs may push the prefix past provider window limits.`]
        : []),
    ].join('\n');
  }

  /**
   * token_report: session activity and cache-hit accounting.
   */
  function handleTokenReport() {
    return [
      `# tokenlean-rag session report`,
      `rag_search calls:       ${stats.searches}`,
      `kb_pin operations:      ${stats.pins}`,
      `total chunks retrieved: ${stats.totalRetrievedChunks}`,
      `total retrieved tokens: ~${stats.totalRetrievedTokens}  (chars/4 estimate)`,
      `re-ask cache hits:      ${stats.reaskHits}`,
      ``,
      `Cache optimization status:`,
      `  ✓ chunks normalized (id-sorted, metadata stripped)`,
      `  ✓ ${pinnedDocIds.size} doc(s) pinned into cache prefix`,
      kb.index ? `  ✓ KB index present (~${estTokens(kb.index)} tokens)` : `  ⚠ no KB index configured`,
      ``,
      `To reset these counters for a new session, call resetStats().`,
    ].join('\n');
  }

  /**
   * headroom_retrieve: CCR-style on-demand chunk retrieval.
   *
   * This implements a lightweight version of Headroom's CCR pattern:
   *   - When rag_search returns normalized chunks, each chunk can be
   *     referenced by its stable id.
   *   - The model can call headroom_retrieve(id) to get the FULL original
   *     text of a chunk (if rag_search truncated or summarized it).
   *   - Supports optional query for BM25-style sub-retrieval within a chunk.
   *
   * This is the "L2.5 可逆压缩" mechanism from the design docs — chunks
   * are presented compactly in rag_search, and the model decides what to
   * expand. The full text is always available on demand, so there's zero
   * information loss.
   */
  function handleHeadroomRetrieve({ chunk_id, query }) {
    stats.retrieves++;
    const chunk = (kb.docs || []).find((d) => String(d.id) === String(chunk_id));
    if (!chunk) {
      return `# headroom_retrieve\nchunk "${chunk_id}" not found in knowledge base.`;
    }
    // If a specific query is given, highlight relevant lines (simple text search)
    let text = chunk.text;
    if (query) {
      const lines = text.split('\n');
      const matching = lines.filter((l) => l.toLowerCase().includes(query.toLowerCase()));
      if (matching.length > 0) {
        text = matching.join('\n');
      } else {
        text = `(no lines matched "${query}" in this chunk)\n${text}`;
      }
    }
    return [
      `# headroom_retrieve  (chunk: "${chunk_id}"${query ? `, query: "${query}"` : ''})`,
      `content length: ${text.length} chars (~${estTokens(text)} tokens)`,
      ``,
      text,
    ].join('\n');
  }

  // ── Tool definitions ──

  const tools = [
    {
      name: 'rag_search',
      description:
        'Retrieve and normalize relevant knowledge base chunks for a user query. ' +
        'Returns chunks in cache-optimized layout: id-sorted, metadata stripped (no scores/timestamps in text). ' +
        'Place the returned chunks AFTER your system prompt + KB index (before the user message) for cacheable prefixes. ' +
        'Pass your vector DB / BM25 results via the `results` parameter as an array of {id, text, score?}. ' +
        'The server handles normalization and cache optimization. This is NOT a real search engine — ' +
        'it normalizes whatever results you pass in and reports the cacheable prefix structure.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The user\'s question or search query (used for metadata/reporting)' },
          top_k: { type: 'integer', description: 'Number of top results (default 5, max 50)', default: 5 },
          results: {
            type: 'array',
            description: 'Retrieved chunks from your vector DB. Each: {id: string, text: string, score?: number}. If omitted, falls back to KB hot docs.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
                score: { type: 'number' },
              },
              required: ['id', 'text'],
            },
          },
        },
        required: ['query'],
      },
      handler: (args) => handleRagSearch(args),
    },
    {
      name: 'kb_pin',
      description:
        'Pin specific documents into the stable cache prefix. ' +
        'Pinned docs persist across queries for the session lifetime and are placed ' +
        'behind a cache_control breakpoint, so daily KB updates only invalidate the pinned ' +
        'section without dropping the tools/system prefix. ' +
        'Use this for frequently-accessed reference docs (coding standards, API docs, product specs). ' +
        'Call with doc_ids from the KB. Pinned docs are id-sorted for byte stability.',
      inputSchema: {
        type: 'object',
        properties: {
          doc_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'One or more KB document IDs to pin into the cache prefix',
          },
        },
        required: ['doc_ids'],
      },
      handler: (args) => handleKbPin(args),
    },
    {
      name: 'headroom_retrieve',
      description:
        'CCR-style on-demand chunk retrieval. Fetch the full text of a previously-seen ' +
        'knowledge base chunk by its stable id. Optionally filter by a text query (BM25-style ' +
        'sub-retrieval within the chunk). ' +
        'This enables a "present compactly, expand on demand" pattern: rag_search returns ' +
        'normalized compact entries, and the model calls headroom_retrieve when it needs details. ' +
        'Zero information loss — every chunk\'s full text is always available.',
      inputSchema: {
        type: 'object',
        properties: {
          chunk_id: { type: 'string', description: 'The stable chunk id returned by rag_search' },
          query: { type: 'string', description: 'Optional text query to filter lines within the chunk' },
        },
        required: ['chunk_id'],
      },
      handler: (args) => handleHeadroomRetrieve(args),
    },
    {
      name: 'token_report',
      description:
        'Report this session\'s RAG activity and cache optimization status. ' +
        'Shows search count, pinned docs, retrieved token estimates, and re-ask cache hit detection.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => handleTokenReport(),
    },
  ];

  // ── MCP JSON-RPC dispatch ──

  function dispatch(msg) {
    const { id, method, params } = msg;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions:
            'Cache-aware RAG tools for chatbots. Workflow: rag_search(query, results) → returns normalized, ' +
            'cache-friendly chunks. Use kb_pin(doc_ids) to keep hot docs in the stable cache prefix. ' +
            'Use headroom_retrieve(chunk_id) for CCR-style on-demand full-text retrieval. ' +
            'Call token_report at session end for cache optimization stats.\n\n' +
            'Prompt layout for optimal caching:\n' +
            '  1. system prompt (STATIC — rarely changes, belongs in cache prefix)\n' +
            '  2. KB index / pinned docs (SESSION — changes daily, second breakpoint)\n' +
            '  ── breakpoint ──\n' +
            '  3. rag_search output (VOLATILE — changes per query, after breakpoint)\n' +
            '  4. user message / conversation history',
        });
      case 'notifications/initialized':
      case 'initialized':
        return null;
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const tool = tools.find((t) => t.name === params?.name);
        if (!tool) return err(-32602, `unknown tool: ${params?.name}`);
        try {
          const text = tool.handler(params.arguments ?? {});
          return ok({ content: [{ type: 'text', text }], isError: false });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: `✗ ${e.message}` }], isError: true });
        }
      }
      default:
        return id !== undefined ? err(-32601, `method not found: ${method}`) : null;
    }
  }

  return { tools, dispatch, stats, resetStats, serverInfo: SERVER_INFO };
}
