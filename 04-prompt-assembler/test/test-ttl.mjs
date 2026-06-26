#!/usr/bin/env node
/**
 * test-ttl.mjs — verifies the cache-lifetime model (review Q2).
 */
import { PROVIDERS, recommendTtl, breakEvenReads, report, BOUNDING_FORCES, TTL_TABLE_AS_OF } from '../lib/cache-ttl.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${d}`)); };

console.log('═══ cache-ttl lifetime test suite ═══\n');

console.log('[1] verified provider numbers');
ok('anthropic default 5min', PROVIDERS.anthropic.defaultTtlSec === 300);
ok('anthropic extended 1h opt-in', /ttl:"1h"/.test(PROVIDERS.anthropic.extendedOptIn));
ok('anthropic break-even 5m ≈ 0.28', breakEvenReads('anthropic','5m') === 0.28);
ok('anthropic break-even 1h ≈ 1.11', breakEvenReads('anthropic','1h') === 1.11);
ok('openai free writes → break-even 0', breakEvenReads('openai') === 0);
ok('openai extended 24h exists', PROVIDERS.openai.extendedTtlSec === 86400);
ok('deepseek disk-backed (no fixed small TTL)', PROVIDERS.deepseek.diskBacked === true && PROVIDERS.deepseek.defaultTtlSec === null);
ok('gemini explicit charges storage', /token-hour/.test(PROVIDERS.gemini.storageCost));
ok('as-of stamp present', /^\d{4}-\d{2}$/.test(TTL_TABLE_AS_OF));

console.log('\n[F-7] provider minPrefixTokens configuration (F-7)');
ok('anthropic minPrefixTokens = 1024', PROVIDERS.anthropic.minPrefixTokens === 1024);
ok('anthropic maxBreakpoints = 4', PROVIDERS.anthropic.maxBreakpoints === 4);
ok('openai minPrefixTokens = 1024', PROVIDERS.openai.minPrefixTokens === 1024);
ok('openai maxBreakpoints = null (automatic)', PROVIDERS.openai.maxBreakpoints === null);
ok('deepseek minPrefixTokens = null (from token 0)', PROVIDERS.deepseek.minPrefixTokens === null);
ok('gemini minPrefixTokens = 1024', PROVIDERS.gemini.minPrefixTokens === 1024);
ok('all providers have minPrefixTokens defined', ['anthropic','openai','deepseek','gemini'].every(p => 'minPrefixTokens' in PROVIDERS[p]));

console.log('\n[2] three bounding forces documented');
ok('exactly 3 bounding forces', BOUNDING_FORCES.length === 3);
ok('covers TTL eviction', BOUNDING_FORCES.some(f => /eviction/i.test(f.force)));
ok('covers prefix-only', BOUNDING_FORCES.some(f => /prefix/i.test(f.force)));
ok('covers context rot / window ceiling', BOUNDING_FORCES.some(f => /context rot|window/i.test(f.detail)));

console.log('\n[3] TTL recommendation by usage pattern');
{
  // tight loop on anthropic → default 5min is fine
  const r1 = recommendTtl({ provider:'anthropic', avgGapSec:30, sessionSpanSec:1800, trafficSteady:true });
  ok('tight gaps → default tier', /default/.test(r1.tier), r1.tier);

  // sparse usage on anthropic → recommend extended 1h
  const r2 = recommendTtl({ provider:'anthropic', avgGapSec:900, sessionSpanSec:7200, trafficSteady:false });
  ok('900s gap → extended tier', /extended/.test(r2.tier), r2.tier);

  // very sparse → cache won't help
  const r3 = recommendTtl({ provider:'anthropic', avgGapSec:7200, sessionSpanSec:36000, trafficSteady:false });
  ok('2h gaps → cache will not help', /not help/.test(r3.tier), r3.tier);

  // deepseek → disk, always fine
  const r4 = recommendTtl({ provider:'deepseek', avgGapSec:1800, sessionSpanSec:36000, trafficSteady:false });
  ok('deepseek → disk-backed default', /disk/.test(r4.tier), r4.tier);

  // gemini → flags standing storage cost
  const r5 = recommendTtl({ provider:'gemini', avgGapSec:60, sessionSpanSec:3600, trafficSteady:true });
  ok('gemini → warns about storage cost', r5.reasons.some(x => /storage|token-hour/.test(x)));
}

console.log('\n[4] report renders');
ok('anthropic report has break-even', /break-even/.test(report('anthropic')));
ok('deepseek report says disk/hours', /hours/.test(report('deepseek')));

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
