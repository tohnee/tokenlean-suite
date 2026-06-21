#!/usr/bin/env node
/**
 * tl-plan.mjs — Analyze cache-aware prompt layout.
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const asm = join(here, '..', '04-prompt-assembler', 'lib', 'assembler.mjs');

if (!existsSync(asm)) {
  console.error('[tokenlean] assembler library not found — are you in the right directory?');
  process.exit(1);
}

if (process.argv[2] === '--example') {
  const { assemble, STABILITY } = await import(asm);
  const plan = assemble([
    { id: 'sys', role: 'system', stability: STABILITY.STATIC, text: 'You are a helpful assistant.' },
    { id: 'kb', role: 'system', stability: STABILITY.SESSION, text: 'KB: product docs, API ref.' },
    { id: 'q', role: 'messages', stability: STABILITY.VOLATILE, text: 'What is the refund policy?' },
  ]);
  console.log('\nExample assembly plan:\n');
  console.log(JSON.stringify(plan, null, 2));
} else {
  console.log(`tl-plan — Cache-aware prompt layout analysis

Usage:
  tl-plan --example     Show an example assembly plan
  (Full CLI: pipe segments as JSON via stdin)

The assembler is a pure-function library. Import it in your code:
  import { assemble, planRag, normalizeRetrieved } from '04-prompt-assembler/lib/assembler.mjs'
`);
}
