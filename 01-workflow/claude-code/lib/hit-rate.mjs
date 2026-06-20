/**
 * hit-rate.mjs — parse Claude Code session transcript(s) and report prompt-cache
 * hit rate + estimated savings (INPUT dimension observability).
 *
 * Works on a single transcript file (the path a hook receives in
 * `transcript_path`) or a directory of them.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Sonnet 4.6 reference prices ($/Mtok)
const PRICE = { in: 3.0, hitRead: 0.3, write5m: 3.75, write1h: 6.0, out: 15.0 };

function collectFiles(p) {
  if (!existsSync(p)) return [];
  const st = statSync(p);
  if (st.isFile()) return [p];
  const out = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      let s; try { s = statSync(f); } catch { continue; }
      if (s.isDirectory()) walk(f);
      else if (f.endsWith('.jsonl')) out.push(f);
    }
  })(p);
  return out;
}

export function analyze(pathOrDir) {
  const files = collectFiles(pathOrDir);
  const acc = { input: 0, hit: 0, write: 0, out: 0, eph5: 0, eph1h: 0, calls: 0 };

  for (const f of files) {
    let raw; try { raw = readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      const u = obj?.message?.usage || obj?.usage;
      if (!u) continue;
      acc.calls++;
      acc.input += u.input_tokens || 0;
      acc.hit += u.cache_read_input_tokens || 0;
      acc.write += u.cache_creation_input_tokens || 0;
      acc.out += u.output_tokens || 0;
      acc.eph5 += u.cache_creation?.ephemeral_5m_input_tokens || 0;
      acc.eph1h += u.cache_creation?.ephemeral_1h_input_tokens || 0;
    }
  }

  const totalIn = acc.input + acc.hit + acc.write;
  const hitRate = totalIn ? (acc.hit / totalIn) * 100 : 0;
  const cost =
    (acc.input / 1e6) * PRICE.in +
    (acc.hit / 1e6) * PRICE.hitRead +
    (acc.write / 1e6) * PRICE.write5m +
    (acc.out / 1e6) * PRICE.out;
  const noCache = (totalIn / 1e6) * PRICE.in + (acc.out / 1e6) * PRICE.out;
  const savedPct = noCache ? (1 - cost / noCache) * 100 : 0;

  return { files: files.length, ...acc, totalIn, hitRate, cost, noCache, savedPct };
}

export function report(pathOrDir) {
  const r = analyze(pathOrDir);
  if (!r.files) return `no session transcripts found at ${pathOrDir}`;
  const lines = [
    `# cache report  (${r.files} transcript${r.files > 1 ? 's' : ''}, ${r.calls} API calls)`,
    `cache HIT RATE:   ${r.hitRate.toFixed(1)}%`,
    `  hits:           ${r.hit.toLocaleString()} tok (billed 0.1×)`,
    `  writes:         ${r.write.toLocaleString()} tok`,
    `  misses:         ${r.input.toLocaleString()} tok (billed 1×)`,
    `  output:         ${r.out.toLocaleString()} tok`,
    `est. cost:        $${r.cost.toFixed(4)}  (no-cache baseline $${r.noCache.toFixed(4)}, saved ${r.savedPct.toFixed(1)}%)`,
  ];
  if (r.eph5 + r.eph1h > 0) {
    const p5 = Math.round((r.eph5 / (r.eph5 + r.eph1h)) * 100);
    lines.push(`TTL mix:          ${p5}% 5min / ${100 - p5}% 1h` + (p5 > 50 ? '  ⚠ mostly 5min — sparse sessions will miss; prefer 1h' : ''));
  }
  if (r.hitRate < 50) lines.push(`⚠ hit rate < 50% — run cache-doctor on CLAUDE.md; check for prefix drift.`);
  return lines.join('\n');
}
