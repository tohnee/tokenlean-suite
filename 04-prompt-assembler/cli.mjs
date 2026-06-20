#!/usr/bin/env node
/**
 * cli.mjs — inspect and plan prompt assembly from the command line.
 *
 *   node cli.mjs plan segments.json      # print the cache-aware plan for a segment spec
 *   node cli.mjs demo                     # run the built-in RAG before/after demo
 *
 * segments.json: [{ id, role, stability, text }]  (stability: 0=STATIC 1=SESSION 2=ROLLING 3=VOLATILE)
 */
import { readFileSync } from 'node:fs';
import { assemble, planRag, normalizeRetrieved, reportAssembly, estTokens, STABILITY } from './lib/assembler.mjs';
import { report as ttlReport, recommendTtl, PROVIDERS, BOUNDING_FORCES } from './lib/cache-ttl.mjs';

const cmd = process.argv[2];

if (cmd === 'ttl') {
  const prov = process.argv[3];
  if (prov && PROVIDERS[prov]) { console.log(ttlReport(prov)); process.exit(0); }
  console.log('# cache lifetime — why you cannot cache history forever\n');
  console.log('Three bounding forces:');
  for (const f of BOUNDING_FORCES) console.log(`  • ${f.force}: ${f.detail}`);
  console.log('\nPer-provider warm window:');
  for (const k of Object.keys(PROVIDERS)) {
    const p = PROVIDERS[k];
    const win = p.diskBacked ? 'hours (disk)' : p.defaultTtlSec ? `${Math.round(p.defaultTtlSec/60)}min default` : 'n/a';
    const ext = p.extendedTtlSec ? `, up to ${Math.round(p.extendedTtlSec/60)}min` : '';
    console.log(`  ${p.label.padEnd(18)} ${win}${ext}  · read ${p.readCost}x · refresh-on-hit ${p.refreshOnHit ? 'yes' : 'no'}`);
  }
  console.log('\nUsage: cli.mjs ttl <anthropic|openai|deepseek|gemini>  for the full per-provider report');
  process.exit(0);
}

if (cmd === 'plan') {
  const file = process.argv[3];
  if (!file) { console.error('usage: cli.mjs plan <segments.json>'); process.exit(64); }
  const segs = JSON.parse(readFileSync(file, 'utf8'));
  console.log(reportAssembly(assemble(segs)));
  process.exit(0);
}

if (cmd === 'demo') {
  console.log('═══ RAG cache-hit demo: naive vs cache-aware ═══\n');

  const SYSTEM = 'You are a support assistant. Answer ONLY from the knowledge base. ' + 'guidance '.repeat(400);
  const KB_INDEX = 'KB INDEX\n' + Array.from({ length: 200 }, (_, i) => `[doc${i}] topic ${i}`).join('\n');

  // simulate two successive user questions that retrieve overlapping chunks
  const retr1 = [
    { id: 'd42', text: 'Refunds are processed in 5-7 days.', score: 0.93, rank: 1, retrieved_at: 't1' },
    { id: 'd17', text: 'Premium plan includes priority support.', score: 0.81, rank: 2, retrieved_at: 't1' },
  ];
  const retr2 = [ // re-ask; same chunks, different scores/order
    { id: 'd17', text: 'Premium plan includes priority support.', score: 0.90, rank: 1, retrieved_at: 't2' },
    { id: 'd42', text: 'Refunds are processed in 5-7 days.', score: 0.77, rank: 2, retrieved_at: 't2' },
  ];

  // ---- NAIVE: prepend raw retrieved chunks (with scores) before the system prompt ----
  const naive = (retr) =>
    'CONTEXT (top-k):\n' + retr.map((c) => `[score=${c.score} @${c.retrieved_at}] ${c.text}`).join('\n') + '\n\n' + SYSTEM + '\n' + KB_INDEX;
  const n1 = naive(retr1), n2 = naive(retr2);
  const naivePrefixStable = n1.slice(0, 200) === n2.slice(0, 200);

  // ---- CACHE-AWARE: stable system+index prefix, normalized retrieved chunks appended ----
  const norm1 = normalizeRetrieved(retr1), norm2 = normalizeRetrieved(retr2);
  const aware = (norm) => SYSTEM + '\n' + KB_INDEX; // the cacheable PREFIX is identical both times
  const a1 = aware(norm1), a2 = aware(norm2);
  const awarePrefixStable = a1 === a2;
  const tail1 = JSON.stringify(norm1.map((c) => c.text));
  const tail2 = JSON.stringify(norm2.map((c) => c.text));

  const prefixTokens = estTokens(SYSTEM + KB_INDEX);

  console.log('NAIVE (retrieved chunks prepended, scores inline):');
  console.log(`  prefix byte-stable across the 2 queries?  ${naivePrefixStable ? 'yes' : 'NO'}  → cache ${naivePrefixStable ? 'hits' : 'MISSES every query'}`);
  console.log(`  ~${prefixTokens} prefix tokens re-billed at FULL price each query\n`);

  console.log('CACHE-AWARE (stable system+index prefix, normalized chunks appended after breakpoint):');
  console.log(`  prefix byte-stable across the 2 queries?  ${awarePrefixStable ? 'YES' : 'no'}  → cache ${awarePrefixStable ? 'HITS (0.1x price)' : 'misses'}`);
  console.log(`  normalized tail identical for same chunk set? ${tail1 === tail2 ? 'YES' : 'no'}  → even the tail can hit on re-ask`);
  console.log(`  ~${prefixTokens} prefix tokens billed at 0.1x on query 2+\n`);

  const saved = Math.round((1 - 0.1) * 100);
  console.log(`Effect: the ~${prefixTokens}-token KB prefix goes from full price every query (naive)`);
  console.log(`to ~${saved}% cheaper on every repeat query (cache-aware). The fix is ORDER + NORMALIZATION,`);
  console.log(`not compression: same bytes to the model, fraction of the cost.`);
  process.exit(0);
}

console.error('usage: cli.mjs plan <segments.json> | demo | ttl [provider]');
process.exit(64);
