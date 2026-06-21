#!/usr/bin/env node
/**
 * tl-normalize.mjs — Normalize RAG chunks by stable id.
 *
 * Reads JSON from stdin or a file and outputs byte-stable normalized chunks.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const asm = join(here, '..', '04-prompt-assembler', 'lib', 'assembler.mjs');

if (!existsSync(asm)) {
  console.error('[tokenlean] assembler library not found');
  process.exit(1);
}

const { normalizeRetrieved } = await import(asm);

const filePath = process.argv[2];
let raw;

if (filePath) {
  raw = readFileSync(filePath, 'utf8');
} else {
  // read stdin
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  raw = chunks.join('');
}

let data;
try { data = JSON.parse(raw); } catch {
  console.error('[tokenlean] invalid JSON input');
  process.exit(1);
}

const normalized = normalizeRetrieved(Array.isArray(data) ? data : data.results || []);
console.log(JSON.stringify(normalized, null, 2));
