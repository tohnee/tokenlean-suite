/**
 * cache-ttl.mjs — the cache LIFETIME model (answers review Q2).
 *
 * Caches are NOT "keep everything forever". Every provider cache has a TTL and
 * an eviction policy. You cannot cache unbounded history; what you actually keep
 * warm is a stable PREFIX, refreshed by traffic, within a bounded window. This
 * module encodes the verified per-provider numbers and the decisions that follow
 * from them (which TTL tier, whether to keep-warm, what breaks on a quiet gap).
 *
 * All numbers verified against provider docs (2026-06). Pricing/TTL change
 * often — `asOf` is stamped so stale data is obvious.
 */

export const TTL_TABLE_AS_OF = '2026-06';

/**
 * Per-provider cache lifetime facts.
 *  defaultTtlSec / maxTtlSec — the in-memory window
 *  refreshOnHit — does each cache READ reset the TTL clock?
 *  extended — optional longer tier (sec) and how to opt in
 *  writeCost / readCost — multiples of base input price
 *  minPrefixTokens — below this, nothing caches regardless of stability
 *  isolation — sharing scope (answers Q1 too)
 */
export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic Claude',
    defaultTtlSec: 300,          // 5 min
    refreshOnHit: true,          // each hit resets the 5-min clock (free)
    extendedTtlSec: 3600,        // 1 hour, opt-in via cache_control ttl:"1h"
    extendedOptIn: 'cache_control: { type:"ephemeral", ttl:"1h" }',
    writeCost5m: 1.25, writeCost1h: 2.0, readCost: 0.10,
    minPrefixTokens: 1024,       // 2048 for Haiku-class
    maxBreakpoints: 4,
    isolation: 'organization (and workspace)',
    note: 'TTL refreshes on every hit, so an active session stays warm indefinitely as long as gaps < TTL. A quiet gap longer than the TTL evicts it; the next call silently re-writes (pay the write premium again). 2026-03 regression: default silently moved 1h→5min; set ttl:"1h" explicitly for sparse traffic.',
  },
  openai: {
    label: 'OpenAI',
    defaultTtlSec: 300,          // 5-10 min inactivity (use 300 as planning floor)
    defaultTtlMaxSec: 600,
    refreshOnHit: true,          // activity keeps it warm; quiet evicts
    quietMaxSec: 3600,           // may survive up to ~1h off-peak, NOT guaranteed
    extendedTtlSec: 86400,       // up to 24h via prompt_cache_retention:"24h" (GPT-5.x/4.1)
    extendedOptIn: 'prompt_cache_retention: "24h"',
    writeCost5m: 1.0, writeCost1h: 1.0, readCost: 0.50, // writes free; read ~0.25-0.5x by model
    minPrefixTokens: 1024,
    maxBreakpoints: null,        // automatic; no explicit breakpoints
    routingHint: 'prompt_cache_key',
    isolation: 'organization',
    note: 'Automatic; no breakpoints. Evicts after 5-10 min inactivity, up to ~1h off-peak (not guaranteed). Writes are free, so the downside of a miss is just latency + full input price that one call. Extended 24h tier exists for batch/long-running.',
  },
  deepseek: {
    label: 'DeepSeek',
    defaultTtlSec: null,         // disk-backed; hours-scale, not a fixed small TTL
    refreshOnHit: true,
    diskBacked: true,            // MLA compresses KV ~4-10x → feasible on disk
    writeCost5m: 1.0, writeCost1h: 1.0, readCost: 0.02, // ~98% off reads; writes free
    minPrefixTokens: null,       // works from token 0, exact-prefix only
    isolation: 'account',
    note: 'Context cache on distributed disk (MLA makes KV small enough to persist), so the warm window is hours-scale, not minutes — the most forgiving of quiet gaps. Reads ~98% cheaper. Still byte-exact-prefix from token 0.',
  },
  gemini: {
    label: 'Google Gemini',
    defaultTtlSec: 3600,         // explicit cache default 1h, custom TTL allowed
    refreshOnHit: false,         // explicit cache: you pay storage per token-hour
    explicit: true,
    storageCost: 'per token-hour (you pay to keep it warm)',
    writeCost5m: 1.0, readCost: 0.25, // read ~75% off (implicit); explicit adds storage
    minPrefixTokens: 1024,       // 4096 for some models
    isolation: 'project',
    note: 'Explicit caching: YOU set TTL and PAY storage per token-hour, so longer TTL costs more even with no traffic. Implicit caching (2.5+) behaves like OpenAI. The only provider where "cache longer" has a direct standing cost.',
  },
};

/**
 * Why you can't "cache all history": three bounding forces.
 */
export const BOUNDING_FORCES = [
  {
    force: 'TTL eviction',
    detail: 'Minutes-scale by default (Anthropic 5m, OpenAI 5-10m). A quiet gap longer than the TTL drops the cache. Only DeepSeek (disk) and Gemini explicit (paid) reach hours.',
  },
  {
    force: 'Prefix-only caching',
    detail: 'Only a byte-stable PREFIX caches, not arbitrary history. Anything that mutates or gets reordered after the breakpoint is never the cached part. So you cache the stable head, not the whole growing tail.',
  },
  {
    force: 'Context window + cost ceiling',
    detail: 'Even if a cache held forever, every cached token is still re-sent and re-billed (at 0.1x) every turn AND occupies the context window. Past ~12% of the window, quality degrades ("context rot"). So history must be compacted regardless of cache — caching makes re-sending cheap, not free, and never makes it weightless in the window.',
  },
];

/**
 * Recommend a TTL strategy from a usage pattern.
 * @param {{ provider:string, avgGapSec:number, sessionSpanSec:number, trafficSteady:boolean }} u
 */
export function recommendTtl(u) {
  const p = PROVIDERS[u.provider];
  if (!p) throw new Error(`unknown provider: ${u.provider}`);
  const out = { provider: p.label, asOf: TTL_TABLE_AS_OF, reasons: [] };

  const defTtl = p.defaultTtlSec ?? p.quietMaxSec ?? 3600;

  if (p.diskBacked) {
    out.tier = 'default (disk-backed, hours)';
    out.reasons.push('DeepSeek keeps context on disk for hours; quiet gaps rarely evict. No action needed.');
    return out;
  }

  if (u.avgGapSec <= defTtl) {
    out.tier = p.refreshOnHit ? 'default (refreshed by traffic)' : 'default';
    out.reasons.push(`avg gap ${u.avgGapSec}s ≤ default TTL ${defTtl}s` + (p.refreshOnHit ? ' and hits refresh the clock → stays warm.' : '.'));
  } else if (p.extendedTtlSec && u.avgGapSec <= p.extendedTtlSec) {
    out.tier = `extended (${Math.round(p.extendedTtlSec/60)} min+)`;
    out.reasons.push(`avg gap ${u.avgGapSec}s exceeds default ${defTtl}s → opt into extended: ${p.extendedOptIn}.`);
    if (p.writeCost1h) out.reasons.push(`extended write premium ~${p.writeCost1h}x base; worth it once the prefix is read ≥2x within the window.`);
  } else {
    out.tier = 'cache will not help (gaps too long)';
    out.reasons.push(`avg gap ${u.avgGapSec}s exceeds even the extended window → each call cold-misses. Either batch requests closer together, or accept full input price.`);
  }

  if (p.storageCost) out.reasons.push(`NOTE: ${p.label} charges ${p.storageCost} — longer TTL has a standing cost even with zero traffic.`);
  return out;
}

/**
 * Break-even: how many reads make a cache write pay off, for a given tier.
 * write + N*read < (N+1)*base  →  N > (write-1)/(1-read)
 */
export function breakEvenReads(provider, tier = '5m') {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider: ${provider}`);
  const write = tier === '1h' ? (p.writeCost1h ?? p.writeCost5m) : p.writeCost5m;
  const read = p.readCost;
  if (write <= 1) return 0; // free writes (OpenAI/DeepSeek) → always worth it
  const n = (write - 1) / (1 - read);
  return Math.max(0, Math.round(n * 100) / 100);
}

export function report(provider) {
  const p = PROVIDERS[provider];
  if (!p) return `unknown provider: ${provider}`;
  const L = [`# cache lifetime · ${p.label}  (as of ${TTL_TABLE_AS_OF})`];
  L.push(`default TTL:    ${p.defaultTtlSec ? p.defaultTtlSec + 's (' + Math.round(p.defaultTtlSec/60) + ' min)' : p.diskBacked ? 'disk-backed, hours-scale' : 'n/a'}`);
  if (p.extendedTtlSec) L.push(`extended TTL:   ${Math.round(p.extendedTtlSec/60)} min  via  ${p.extendedOptIn}`);
  L.push(`refresh on hit: ${p.refreshOnHit ? 'yes (active session stays warm)' : 'no (fixed window; ' + (p.storageCost||'') + ')'}`);
  L.push(`write / read:   ${p.writeCost5m}x / ${p.readCost}x base`);
  if (p.writeCost5m > 1) L.push(`break-even:     ${breakEvenReads(provider,'5m')} reads (5m)` + (p.writeCost1h ? `, ${breakEvenReads(provider,'1h')} reads (1h)` : ''));
  L.push(`min prefix:     ${p.minPrefixTokens ? p.minPrefixTokens + ' tokens' : 'from token 0'}`);
  L.push(`isolation:      ${p.isolation}`);
  L.push(`note: ${p.note}`);
  return L.join('\n');
}
