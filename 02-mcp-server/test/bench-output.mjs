#!/usr/bin/env node
/**
 * bench-output.mjs — REAL token measurement of edit strategies.
 *
 * What this measures: the OUTPUT tokens a model must EMIT to express an edit,
 * which is the dimension hash-anchored editing targets. Output tokens are the
 * model's tool-call: for native Edit that's {old_str, new_str}; for fs_edit_hash
 * that's {start, end, content}.
 *
 * Honesty rules baked in:
 *  - Uses a REAL BPE tokenizer (gpt-tokenizer), not chars/4.
 *  - The native-Edit baseline uses a COMPETENT minimal-unique old_str (the
 *    shortest contiguous slice that uniquely locates the edit), NOT a naive
 *    full-block reproduction. This is the fair comparison; it makes hash
 *    editing look LESS good than the old self-serving baseline, on purpose.
 *  - Reports the full tool-call JSON the model emits, including tool name and
 *    keys, because those are real output tokens too.
 *
 * What this does NOT measure (stated plainly): whether a real model actually
 * chooses these tokens, end-to-end latency, or input/cache effects. It is an
 * output-token accounting benchmark on real edit tasks, run deterministically.
 */
import { readFileSync } from 'node:fs';

// Real BPE tokenizer if installed (run `npm install` in this package), else a
// chars/4 estimate with a loud label so the numbers are never silently wrong.
let tok, TOKENIZER;
try {
  const { encode } = await import('gpt-tokenizer');
  tok = (s) => encode(s).length;
  TOKENIZER = 'gpt-tokenizer (BPE)';
} catch {
  tok = (s) => Math.ceil(s.length / 4);
  TOKENIZER = 'chars/4 ESTIMATE — run `npm install` for real BPE counts';
}

// ── a real, non-trivial source file (realistic 60-line module) ──
const FILE = `import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export class ConfigLoader {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.cache = new Map();
    this.watchers = [];
  }

  async load(name) {
    if (this.cache.has(name)) {
      return this.cache.get(name);
    }
    const path = join(this.rootDir, name + '.json');
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    this.cache.set(name, parsed);
    return parsed;
  }

  invalidate(name) {
    this.cache.delete(name);
  }

  clear() {
    this.cache.clear();
  }
}

export function mergeConfigs(base, override) {
  const result = {};
  for (const key of Object.keys(base)) {
    result[key] = base[key];
  }
  for (const key of Object.keys(override)) {
    result[key] = override[key];
  }
  return result;
}

export function validateConfig(config, schema) {
  for (const key of Object.keys(schema)) {
    if (schema[key].required && !(key in config)) {
      throw new Error('Missing required key: ' + key);
    }
  }
  return true;
}
`.split('\n');

// ── representative edit tasks (the kind that occur in real coding sessions) ──
const TASKS = [
  {
    name: 'single-line: fix a string',
    startLine: 21, endLine: 21,
    oldText: `    const raw = await readFile(path, 'utf8');`,
    newText: `    const raw = await readFile(path, 'utf-8');`,
  },
  {
    name: 'small (3 lines): add error handling',
    startLine: 13, endLine: 15,
    oldText: `    if (this.cache.has(name)) {
      return this.cache.get(name);
    }`,
    newText: `    if (this.cache.has(name)) {
      return structuredClone(this.cache.get(name));
    }`,
  },
  {
    name: 'medium (9 lines): refactor mergeConfigs to spread',
    startLine: 33, endLine: 43,
    oldText: `export function mergeConfigs(base, override) {
  const result = {};
  for (const key of Object.keys(base)) {
    result[key] = base[key];
  }
  for (const key of Object.keys(override)) {
    result[key] = override[key];
  }
  return result;
}`,
    newText: `export function mergeConfigs(base, override) {
  return { ...base, ...override };
}`,
  },
  {
    name: 'deletion: remove unused watchers field',
    startLine: 8, endLine: 8,
    oldText: `    this.watchers = [];`,
    newText: ``,
  },
];

// ── strategy 1: native Write (full file rewrite) ──
function nativeWrite(fileLines, task) {
  const out = [...fileLines];
  const newLines = task.newText === '' ? [] : task.newText.split('\n');
  out.splice(task.startLine - 1, task.endLine - task.startLine + 1, ...newLines);
  const content = out.join('\n');
  // model emits the whole file as tool-call content
  return tok(JSON.stringify({ name: 'Write', input: { file_path: 'config.js', content } }));
}

// ── strategy 2: native Edit with COMPETENT minimal-unique old_str ──
function minimalUniqueOldStr(fileLines, task) {
  const full = fileLines.join('\n');
  // shrink the old block from both ends while it still uniquely occurs
  let lines = task.oldText.split('\n');
  // try to drop leading/trailing lines if the remainder is still unique
  const occurs = (s) => {
    if (s.trim() === '') return 999;
    let i = 0, c = 0;
    while ((i = full.indexOf(s, i)) !== -1) { c++; i += s.length; if (c > 1) break; }
    return c;
  };
  // greedily trim leading lines
  while (lines.length > 1 && occurs(lines.slice(1).join('\n')) === 1) lines = lines.slice(1);
  // greedily trim trailing lines
  while (lines.length > 1 && occurs(lines.slice(0, -1).join('\n')) === 1) lines = lines.slice(0, -1);
  return lines.join('\n');
}
function nativeEdit(fileLines, task) {
  const oldStr = minimalUniqueOldStr(fileLines, task);
  return tok(JSON.stringify({ name: 'Edit', input: { file_path: 'config.js', old_str: oldStr, new_str: task.newText } }));
}

// ── strategy 3: fs_edit_hash (hash anchors) ──
import { createHash } from 'node:crypto';
const hashLine = (s) => createHash('sha256').update(s).digest('hex').slice(0, 4);
function hashEdit(fileLines, task) {
  const sH = hashLine(fileLines[task.startLine - 1]);
  const eH = hashLine(fileLines[task.endLine - 1]);
  return tok(JSON.stringify({
    name: 'fs_edit_hash',
    input: { path: 'config.js', start: `${task.startLine}:${sH}`, end: `${task.endLine}:${eH}`, content: task.newText },
  }));
}

// ── run ──
console.log(`═══ REAL OUTPUT-token benchmark · tokenizer: ${TOKENIZER} ═══`);
console.log('baseline = native Edit with COMPETENT minimal-unique old_str (fair, not inflated)\n');
console.log('task                                         Write   Edit  Hash  | Hash vs Write  Hash vs Edit');
console.log('─'.repeat(98));

let totW = 0, totE = 0, totH = 0;
for (const t of TASKS) {
  const w = nativeWrite(FILE, t), e = nativeEdit(FILE, t), h = hashEdit(FILE, t);
  totW += w; totE += e; totH += h;
  const vsW = Math.round((1 - h / w) * 100);
  const vsE = Math.round((1 - h / e) * 100);
  console.log(
    `${t.name.padEnd(44)} ${String(w).padStart(5)} ${String(e).padStart(5)} ${String(h).padStart(5)}  | ` +
    `${(vsW + '%').padStart(11)}  ${(vsE + '%').padStart(11)}`
  );
}
console.log('─'.repeat(98));
console.log(
  `${'TOTAL'.padEnd(44)} ${String(totW).padStart(5)} ${String(totE).padStart(5)} ${String(totH).padStart(5)}  | ` +
  `${((Math.round((1 - totH / totW) * 100)) + '%').padStart(11)}  ${((Math.round((1 - totH / totE) * 100)) + '%').padStart(11)}`
);

console.log('\nHonest reading:');
console.log(`  vs Write (full rewrite): hash saves ${Math.round((1 - totH / totW) * 100)}% output tokens — the big, real win.`);
console.log(`  vs competent Edit:       hash saves ${Math.round((1 - totH / totE) * 100)}% output tokens — smaller, because a good`);
console.log(`                           model already writes a tight old_str. This is the fair number.`);
console.log(`  Single-line edits:       hash is ~neutral or worse vs Edit; the anchor + JSON overhead`);
console.log(`                           competes with a short old_str. Use native Edit for 1-liners.`);
console.log('\nNOT measured here: whether a model picks these tokens, latency, or input/cache effects.');
