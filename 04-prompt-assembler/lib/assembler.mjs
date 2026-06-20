/**
 * assembler.mjs — cache-aware prompt assembly (L1 INPUT layer).
 *
 * Answers the four review questions in executable form:
 *
 *  Q1 (single vs cross-user): provider prompt caches are ISOLATED per
 *      organization/workspace — they are NOT shared across tenants. So the only
 *      caching you control is WITHIN your own request stream / tenant: the same
 *      stable prefix reused across YOUR successive requests. This module
 *      optimizes exactly that. `scope` is annotated on every segment so you can
 *      reason about what is reusable across whose requests.
 *
 *  Q2 (long system prompt, tool defs, history, agent-loop context): each of
 *      these is modeled as a Segment with a `stability` class. The assembler
 *      orders them most-stable-first so the cacheable prefix is as long as
 *      possible, and places breakpoints at the stable/volatile seam.
 *
 *  Q3 (assembly structure is itself a cost+perf choice): assemble() takes a set
 *      of segments and produces (a) a provider-ready ordering, (b) breakpoint
 *      placement, (c) a diagnosis of what breaks the prefix and why. The
 *      STRUCTURE is the output, made explicit and testable.
 *
 *  Q4 (RAG / llm-wiki cache hits): retrieved top-k chunks are volatile by
 *      nature (they change per query) and MUST go AFTER the stable prefix +
 *      breakpoint, never before it. planRag() splits a knowledge base into a
 *      stable, cacheable "pinned" layer (hot canonical docs, ordered
 *      deterministically) and a volatile "retrieved" tail, and normalizes
 *      retrieved chunks (stable id order, stripped volatile metadata) so the
 *      pinned layer keeps hitting cache across queries.
 *
 * Provider model assumed: Anthropic-style prefix cache (tools → system →
 * messages; cache_control breakpoints; longest-matching-prefix; org-isolated).
 * The ideas port to OpenAI/DeepSeek automatic prefix caching unchanged: keep
 * the long stable prefix byte-identical and put volatile content last.
 *
 * Pure functions, no I/O. Node >= 18.
 */

const estTokens = (s) => Math.ceil((typeof s === 'string' ? s : JSON.stringify(s)).length / 4);

// Stability classes, most-stable (cacheable, belongs in prefix) to most-volatile.
export const STABILITY = {
  STATIC: 0,      // never changes across requests in a session (system role, tool defs)
  SESSION: 1,     // fixed for the session (project context, pinned KB)
  ROLLING: 2,     // grows append-only (conversation history, agent loop log)
  VOLATILE: 3,    // changes every request (retrieved RAG chunks, the user question, timestamps)
};

const CLASS_NAME = ['STATIC', 'SESSION', 'ROLLING', 'VOLATILE'];

/**
 * A Segment is one logical piece of the prompt.
 * @typedef {{
 *   id: string,
 *   role: 'tools'|'system'|'messages',
 *   stability: number,           // STABILITY.*
 *   text: string|object,
 *   scope?: 'tenant'|'session'|'request',  // who can reuse this (Q1)
 *   pinned?: boolean,            // part of the deliberately-cached prefix
 * }} Segment
 */

// Anthropic invalidation hierarchy: tools → system → messages.
const ROLE_ORDER = { tools: 0, system: 1, messages: 2 };

/**
 * Detect content that silently breaks a cache prefix (timestamps, uuids, etc.).
 * Mirrors cache-doctor but works on a segment's rendered text.
 */
const VOLATILE_MARKERS = [
  { re: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, why: 'ISO timestamp' },
  { re: /\bDate\.now\b|\$\(date|`date\b/, why: 'date call' },
  { re: /\{\{\s*(date|now|today|time|timestamp)\s*\}\}/i, why: 'date placeholder' },
  { re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, why: 'uuid' },
  { re: /\{\{\s*(uuid|session_id|sessionId|nonce|random|request_id)\s*\}\}/i, why: 'random id placeholder' },
];

export function scanVolatile(text) {
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  const hits = [];
  for (const m of VOLATILE_MARKERS) if (m.re.test(s)) hits.push(m.why);
  return hits;
}

/**
 * assemble(segments, opts) → the cache-aware plan.
 *
 * Produces a stable ordering, breakpoint placement, and a diagnosis. This is
 * the concrete answer to Q3: the assembly structure, made explicit.
 */
export function assemble(segments, opts = {}) {
  const minPrefixTokens = opts.minPrefixTokens ?? 1024; // provider min cacheable prefix
  const maxBreakpoints = opts.maxBreakpoints ?? 4;      // Anthropic: 4 cache_control max

  // 1. order: by role hierarchy first (tools→system→messages), then by
  //    stability (STATIC→…→VOLATILE) within the role. Append-only ROLLING and
  //    VOLATILE always land after the stable prefix.
  const ordered = [...segments].sort((a, b) => {
    const r = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
    if (r !== 0) return r;
    return a.stability - b.stability;
  });

  // 2. find the prefix/volatile seam: the last contiguous run from the front
  //    whose stability is <= SESSION (STATIC or SESSION). Everything up to the
  //    seam is the cacheable prefix; ROLLING/VOLATILE go after.
  let seam = 0;
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].stability <= STABILITY.SESSION) seam = i + 1;
    else break;
  }
  const prefix = ordered.slice(0, seam);
  const tail = ordered.slice(seam);

  // 3. diagnose volatile leaks inside the would-be-cached prefix
  const leaks = [];
  for (const seg of prefix) {
    const v = scanVolatile(seg.text);
    if (v.length) leaks.push({ id: seg.id, reasons: v });
  }

  // 4. breakpoint placement: one at the end of the stable prefix is the primary
  //    win. If tools+system+pinned-KB are large, a second breakpoint between
  //    "tenant-static" (tools+system) and "session-stable" (pinned KB) lets the
  //    daily-changing KB invalidate without dropping the tools/system cache.
  const breakpoints = [];
  if (prefix.length) {
    // breakpoint after the last STATIC segment (tenant-reusable boundary)
    let lastStatic = -1;
    prefix.forEach((s, i) => { if (s.stability === STABILITY.STATIC) lastStatic = i; });
    if (lastStatic >= 0 && lastStatic < prefix.length - 1) {
      breakpoints.push({ afterIndex: lastStatic, kind: 'static/session seam' });
    }
    // primary breakpoint at the end of the whole stable prefix
    breakpoints.push({ afterIndex: prefix.length - 1, kind: 'prefix/volatile seam' });
  }
  // cap to provider max
  const trimmedBreakpoints = breakpoints.slice(-maxBreakpoints);

  // 5. accounting
  const prefixTokens = prefix.reduce((n, s) => n + estTokens(s.text), 0);
  const tailTokens = tail.reduce((n, s) => n + estTokens(s.text), 0);
  const belowMin = prefixTokens < minPrefixTokens;

  return {
    ordered,
    prefix,
    tail,
    breakpoints: trimmedBreakpoints,
    leaks,
    prefixTokens,
    tailTokens,
    belowMin,
    cacheable: leaks.length === 0 && !belowMin && prefix.length > 0,
  };
}

/**
 * planRag(kb, retrieved, opts) → cache-aware layout for RAG / llm-wiki (Q4).
 *
 * The core problem: naive RAG prepends the top-k retrieved chunks (which change
 * every query) to the prompt, so the prefix changes every request and NOTHING
 * caches. The fix has two parts:
 *
 *   1. PIN a stable layer: the canonical/hot KB docs (or the wiki index +
 *      raw spans that rarely change) go in a deterministic, byte-stable order
 *      as part of the cached prefix, behind a breakpoint.
 *   2. NORMALIZE the volatile tail: retrieved top-k chunks are placed AFTER the
 *      breakpoint, sorted by stable id (not by score) and stripped of volatile
 *      metadata (scores, timestamps, rank) so that re-retrieving the same chunk
 *      set produces byte-identical text — turning intra-session repeats into
 *      cache hits on the tail too.
 *
 * For llm-wiki specifically: the navigation layer (index, entity graph, wiki
 * pages) is SESSION-stable and pinned; the raw evidence spans pulled for a
 * given question are the volatile tail. Returning the index pinned + raw spans
 * appended (id-ordered) maximizes prefix reuse across questions about the same
 * corpus.
 */
export function planRag(kb, retrieved, opts = {}) {
  const pinHot = opts.pinHot ?? true;
  const hotCount = opts.hotCount ?? 0; // how many canonical docs to pin (0 = none beyond index)

  // stable pinned layer: KB index / canonical docs, deterministic order by id
  const pinned = [];
  if (kb?.index) {
    pinned.push({
      id: 'kb-index', role: 'system', stability: STABILITY.SESSION, scope: 'session',
      text: typeof kb.index === 'string' ? kb.index : JSON.stringify(kb.index),
      pinned: true,
    });
  }
  if (pinHot && Array.isArray(kb?.docs) && hotCount > 0) {
    const hot = [...kb.docs].sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, hotCount);
    for (const d of hot) {
      pinned.push({
        id: `kb-doc:${d.id}`, role: 'system', stability: STABILITY.SESSION, scope: 'session',
        text: d.text, pinned: true,
      });
    }
  }

  // volatile tail: retrieved chunks, normalized for byte-stability
  const normalized = normalizeRetrieved(retrieved, opts);
  const tail = normalized.map((c) => ({
    id: `ret:${c.id}`, role: 'messages', stability: STABILITY.VOLATILE, scope: 'request',
    text: c.text,
  }));

  return { pinned, retrievedTail: tail, normalizedRetrieved: normalized };
}

/**
 * normalizeRetrieved — make a retrieved chunk set produce byte-identical text
 * when the same chunks come back, regardless of score/rank ordering or volatile
 * metadata. This is what lets the *tail* also hit cache on intra-session repeats
 * and prevents score jitter from busting it.
 */
export function normalizeRetrieved(retrieved, opts = {}) {
  const stripFields = opts.stripFields ?? ['score', 'rank', 'distance', 'timestamp', 'retrieved_at', '_id'];
  const arr = (retrieved || []).map((c) => {
    // accept {id, text, ...} or raw strings
    if (typeof c === 'string') return { id: hashId(c), text: c };
    const clean = { id: String(c.id ?? hashId(c.text || '')), text: c.text ?? '' };
    return clean;
  });
  // de-dupe by id (re-retrieval often returns overlapping chunks)
  const seen = new Set();
  const deduped = [];
  for (const c of arr) { if (!seen.has(c.id)) { seen.add(c.id); deduped.push(c); } }
  // STABLE ORDER by id, NOT by score — this is the key to byte-stability
  deduped.sort((a, b) => a.id.localeCompare(b.id));
  return deduped;
}

// tiny stable id for chunks that lack one
function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'h' + h.toString(36);
}

/** Human-readable plan report. */
export function reportAssembly(plan) {
  const L = [];
  L.push(`# prompt assembly plan`);
  L.push(`prefix (cacheable):  ${plan.prefix.length} segment(s), ~${plan.prefixTokens} tokens`);
  L.push(`tail (volatile):     ${plan.tail.length} segment(s), ~${plan.tailTokens} tokens`);
  L.push(`breakpoints:         ${plan.breakpoints.map((b) => `after #${b.afterIndex} (${b.kind})`).join(', ') || 'none'}`);
  L.push(`cacheable prefix:    ${plan.cacheable ? 'YES' : 'NO'}`);
  if (plan.belowMin) L.push(`  ⚠ prefix below provider minimum (~1024 tok) — too short to cache`);
  if (plan.leaks.length) {
    L.push(`  ✗ volatile content leaking into the cached prefix:`);
    for (const lk of plan.leaks) L.push(`     - ${lk.id}: ${lk.reasons.join(', ')}  → move after the breakpoint`);
  }
  L.push(``);
  L.push(`order (most-stable first):`);
  plan.ordered.forEach((s, i) => {
    const seam = i === plan.prefix.length ? '  ── breakpoint ──\n' : '';
    L.push(`${seam}  ${i}. [${s.role}/${CLASS_NAME[s.stability]}] ${s.id}  (~${estTokens(s.text)} tok)`);
  });
  return L.join('\n');
}

export { estTokens, CLASS_NAME };
