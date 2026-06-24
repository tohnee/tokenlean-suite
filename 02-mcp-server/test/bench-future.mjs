#!/usr/bin/env node
/**
 * bench-future.mjs — FUTURE INPUT benchmark for coding-agent tool output.
 *
 * FUTURE INPUT is the cost of tool output that enters the conversation history
 * and is re-billed on later turns. This benchmark compares lean TokenLean tool
 * outputs against naive full outputs, then multiplies each operation by the
 * number of remaining turns in a coding session.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createCore } from '../lib/core.mjs';

let tok, TOKENIZER;
try {
  const { encode } = await import('gpt-tokenizer');
  tok = (s) => encode(String(s)).length;
  TOKENIZER = 'gpt-tokenizer (BPE)';
} catch {
  tok = (s) => Math.ceil(String(s).length / 4);
  TOKENIZER = 'chars/4 ESTIMATE — run `npm install` for real BPE counts';
}

const IGNORE_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.next', 'target']);

function callTool(core, name, args) {
  const r = core.dispatch({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method: 'tools/call', params: { name, arguments: args } });
  if (r.error) throw new Error(r.error.message);
  const text = r.result?.content?.[0]?.text || '';
  if (r.result?.isError) throw new Error(text);
  return text;
}

function readText(root, path) {
  return readFileSync(join(root, path), 'utf8');
}

function walkFiles(root, dir = '.', out = []) {
  const abs = join(root, dir);
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(ent.name)) continue;
    const rel = dir === '.' ? ent.name : join(dir, ent.name);
    const full = join(root, rel);
    if (ent.isDirectory()) walkFiles(root, rel, out);
    else if (ent.isFile()) {
      const st = statSync(full);
      if (st.size <= 300_000) out.push(rel);
    }
  }
  return out;
}

function naiveSearch(root, pattern, dir = '.') {
  const needle = pattern.toLowerCase();
  const lines = [];
  for (const f of walkFiles(root, dir)) {
    let text;
    try { text = readText(root, f); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      if (line.toLowerCase().includes(needle)) lines.push(`${f}:${i + 1}: ${line}`);
    });
  }
  return [`# naive recursive search for ${pattern}`, ...lines].join('\n');
}

function op(name, leanText, naiveText, rebilledTurns) {
  const leanTokens = tok(leanText);
  const naiveTokens = tok(naiveText);
  return {
    name,
    leanTokens,
    naiveTokens,
    rebilledTurns,
    leanFutureTokenTurns: leanTokens * rebilledTurns,
    naiveFutureTokenTurns: naiveTokens * rebilledTurns,
    savingsPct: naiveTokens ? (1 - leanTokens / naiveTokens) * 100 : 0,
  };
}

export async function runFutureBench(opts = {}) {
  const root = opts.root || process.cwd();
  const turns = Number(opts.turns || 12);
  const core = createCore({ root });
  const operations = [];

  const corePath = '02-mcp-server/lib/core.mjs';
  const ragPath = '03-rag-server/lib/rag-core.mjs';
  const assemblerPath = '04-prompt-assembler/lib/assembler.mjs';

  operations.push(op(
    'orient: outline MCP core instead of full file read',
    callTool(core, 'fs_outline', { path: corePath }),
    `# full file ${corePath}\n${readText(root, corePath)}`,
    turns,
  ));
  operations.push(op(
    'inspect: read bounded RAG core region instead of full file',
    callTool(core, 'fs_read_hashed', { path: ragPath, start_line: 100, end_line: 190 }),
    `# full file ${ragPath}\n${readText(root, ragPath)}`,
    turns - 1,
  ));
  operations.push(op(
    'locate: lean search for normalizeRetrieved instead of recursive dump',
    callTool(core, 'search_lean', { pattern: 'normalizeRetrieved', path: '.', max_results: 20 }),
    naiveSearch(root, 'normalizeRetrieved', '.'),
    turns - 2,
  ));
  operations.push(op(
    'inspect: read assembler RAG planning slice instead of full file',
    callTool(core, 'fs_read_hashed', { path: assemblerPath, start_line: 158, end_line: 235 }),
    `# full file ${assemblerPath}\n${readText(root, assemblerPath)}`,
    turns - 3,
  ));

  const totals = operations.reduce((acc, item) => {
    acc.leanTokens += item.leanTokens;
    acc.naiveTokens += item.naiveTokens;
    acc.leanFutureTokenTurns += item.leanFutureTokenTurns;
    acc.naiveFutureTokenTurns += item.naiveFutureTokenTurns;
    return acc;
  }, { leanTokens: 0, naiveTokens: 0, leanFutureTokenTurns: 0, naiveFutureTokenTurns: 0 });
  totals.oneShotSavingsPct = (1 - totals.leanTokens / totals.naiveTokens) * 100;
  totals.futureSavingsPct = (1 - totals.leanFutureTokenTurns / totals.naiveFutureTokenTurns) * 100;

  return { dimension: 'FUTURE INPUT', tokenizer: TOKENIZER, turns, root: relative(process.cwd(), root) || '.', operations, totals };
}

const pct = (n) => `${Math.round(n)}%`;
export function renderFutureReport(result) {
  const lines = [];
  lines.push(`# FUTURE INPUT benchmark`);
  lines.push(`tokenizer: ${result.tokenizer}`);
  lines.push(`session length: ${result.turns} turns`);
  lines.push('');
  lines.push('| operation | lean tok | naive tok | rebilled turns | future saved |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const op of result.operations) {
    lines.push(`| ${op.name} | ${op.leanTokens} | ${op.naiveTokens} | ${op.rebilledTurns} | ${pct(op.savingsPct)} |`);
  }
  lines.push('');
  lines.push(`Cumulative context-token-turns: lean ${result.totals.leanFutureTokenTurns}, naive ${result.totals.naiveFutureTokenTurns}, saved ${pct(result.totals.futureSavingsPct)}.`);
  lines.push(`One-shot tool-output savings: ${pct(result.totals.oneShotSavingsPct)}.`);
  lines.push('');
  lines.push('Honest scope: this is an accounting benchmark for tool-output bytes entering history; it does not prove how often a real model chooses the lean tool path.');
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runFutureBench({ root: join(process.cwd(), '..') });
  console.log(renderFutureReport(result));
}
