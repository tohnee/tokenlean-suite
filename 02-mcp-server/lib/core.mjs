/**
 * tokenlean-mcp core — transport-agnostic.
 *
 * Exposes createCore({ root, readOnly }) → { tools, dispatch, stats, serverInfo }
 * The same core is driven by:
 *   bin/stdio.mjs  (local CLI agents: Claude Code, OpenCode, Codex, Cursor…)
 *   bin/http.mjs   (web copilots / chatbots over Streamable HTTP)
 *
 * Zero dependencies. Node >= 18.
 *
 * Design constants (kept in sync with DESIGN.md):
 *   - Hash anchor length: 4 hex chars (16-bit space, ~256x lower false-relocation
 *     risk than the original 2-char hash). See HASH_LEN below.
 *   - Test suite: 64 assertions total (38 stdio + 26 http). Run via `npm test`.
 *     See test/test-stdio.mjs and test/test-http.mjs.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, sep, basename } from 'node:path';

export const SERVER_INFO = { name: 'tokenlean-mcp', version: '0.2.0' };

export const LIMITS = {
  READ_DEFAULT_MAX_LINES: 200,
  READ_HARD_MAX_LINES: 600,
  OUTLINE_MAX_ITEMS: 120,
  SEARCH_DEFAULT_MAX_RESULTS: 25,
  SEARCH_HARD_MAX_RESULTS: 80,
  SEARCH_MATCH_MAX_CHARS: 200,
  READ_MAX_FILE_BYTES: Number(process.env.TOKENLEAN_READ_MAX_BYTES || 1_000_000),
  SEARCH_MAX_FILE_BYTES: 1_000_000,
  // SEARCH_MAX_FILES caps how many files search_lean walks. Lower this for
  // large repos on the HTTP transport (sync I/O blocks the event loop).
  // Override via env: TOKENLEAN_SEARCH_MAX_FILES=1000
  SEARCH_MAX_FILES: Number(process.env.TOKENLEAN_SEARCH_MAX_FILES || 4000),
  RESPONSE_SOFT_CHAR_BUDGET: 24_000,
  RELOCATE_WINDOW: 40,
};

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '.next', '.venv',
  'venv', '__pycache__', '.cache', 'coverage', 'vendor', '.idea', '.vscode',
]);

export class ToolError extends Error {}

// 4 hex chars = 16-bit space (65536). Chosen to keep anchors compact while
// cutting single-line false-relocation risk by ~256x vs the old 2-char hash.
// See resolveAnchors for the additional uniqueness + context guards.
const HASH_LEN = 4;
const hashLine = (s) => createHash('sha256').update(s).digest('hex').slice(0, HASH_LEN);
// F-10: shared estTokens to prevent drift across modules.
import { estTokens } from '../../lib/est-tokens.mjs';

const OUTLINE_PATTERNS = [
  /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+\w+/,
  /^\s*(export\s+)?(abstract\s+)?class\s+\w+/,
  /^\s*(export\s+)?interface\s+\w+/,
  /^\s*(export\s+)?type\s+\w+\s*=/,
  /^\s*(export\s+)?const\s+\w+\s*=\s*(async\s*)?\(/,
  /^\s*(public|private|protected)?\s*(static\s+)?(async\s+)?\w+\s*\([^)]*\)\s*[:{]/,
  /^\s*(def|class)\s+\w+/,
  /^\s*(pub\s+)?(async\s+)?fn\s+\w+/,
  /^\s*(pub\s+)?(struct|enum|trait|impl)\b/,
  /^\s*func\s+(\(\w+\s+\*?\w+\)\s+)?\w+/,
  /^(#{1,4})\s+\S/,
];

/**
 * Build a core instance bound to a workspace root.
 * @param {{root: string, readOnly?: boolean}} opts
 */
export function createCore({ root, readOnly = false }) {
  const ROOT = resolve(root);
  const stats = { edits: 0, rejected: 0, relocated: 0, actualOutTokens: 0, baselineOutTokens: 0 };

  /**
   * Reset session stats. Useful when a single core is reused across
   * multiple sessions (e.g. stdio mode where the process lives for the
   * entire agent lifetime). Calling this between sessions isolates
   * token_report to the current session's activity.
   */
  function resetStats() {
    stats.edits = 0;
    stats.rejected = 0;
    stats.relocated = 0;
    stats.actualOutTokens = 0;
    stats.baselineOutTokens = 0;
  }

  // ── path safety: every fs operation is confined to ROOT ──
  function safePath(p) {
    const abs = isAbsolute(p) ? resolve(p) : resolve(ROOT, p);
    const rel = relative(ROOT, abs);
    if (rel.startsWith('..' + sep) || rel === '..') {
      throw new ToolError(`path escapes workspace root (${ROOT}): ${p}`);
    }
    return abs;
  }

  function readFileLines(absPath) {
    if (!existsSync(absPath)) throw new ToolError(`file not found: ${absPath}`);
    const st = statSync(absPath);
    if (st.isDirectory()) throw new ToolError(`path is a directory: ${absPath}`);
    if (st.size > LIMITS.READ_MAX_FILE_BYTES) {
      throw new ToolError(
        `file too large: ${absPath} is ${st.size} bytes, exceeds READ_MAX_FILE_BYTES=${LIMITS.READ_MAX_FILE_BYTES}. ` +
        `Use fs_outline to inspect structure, or raise TOKENLEAN_READ_MAX_BYTES if you intentionally want to load it.`
      );
    }
    const raw = readFileSync(absPath, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const body = raw.endsWith(eol) ? raw.slice(0, -eol.length) : raw;
    return { lines: body.length ? body.split(eol) : [], eol, trailing: raw.endsWith(eol) };
  }

  function writeFileLines(absPath, lines, eol, trailing) {
    if (readOnly) throw new ToolError('server is in read-only mode; edits are disabled');
    writeFileSync(absPath, lines.join(eol) + (trailing ? eol : ''), 'utf8');
  }

  function parseAnchor(a) {
    const m = /^(\d+):([0-9a-f]{2,6})$/.exec(String(a).trim());
    if (!m) throw new ToolError(`bad anchor '${a}' — expected '<line>:<hash>' like '42:f3'`);
    return { line: Number(m[1]), hash: m[2] };
  }

  function fmtHashed(lines, startIdx, endIdx) {
    const out = [];
    const width = String(endIdx + 1).length;
    for (let i = startIdx; i <= endIdx; i++) {
      out.push(`${String(i + 1).padStart(width)}:${hashLine(lines[i])}  ${lines[i]}`);
    }
    return out.join('\n');
  }

  function capText(text, note) {
    if (text.length <= LIMITS.RESPONSE_SOFT_CHAR_BUDGET) return text;
    const head = text.slice(0, LIMITS.RESPONSE_SOFT_CHAR_BUDGET);
    return head + `\n\n[!] output truncated at ${LIMITS.RESPONSE_SOFT_CHAR_BUDGET} chars (~${estTokens(head)} tokens). ${note || 'Narrow your request (line range / stricter pattern).'}`;
  }

  function resolveAnchors(lines, start, end, allowRelocate) {
    const span = end.line - start.line;
    const ok = (ln, h) => ln >= 1 && ln <= lines.length && hashLine(lines[ln - 1]) === h;

    // exact match at the given line numbers — always preferred
    if (ok(start.line, start.hash) && ok(end.line, end.hash)) {
      return { ok: true, s: start.line - 1, e: end.line - 1, relocated: false };
    }

    if (allowRelocate) {
      // Collect ALL candidate offsets in the window where both anchors match.
      // If more than one matches, relocation is ambiguous → refuse (never guess).
      const matches = [];
      for (let d = 1; d <= LIMITS.RELOCATE_WINDOW; d++) {
        for (const cand of [start.line + d, start.line - d]) {
          if (ok(cand, start.hash) && ok(cand + span, end.hash)) {
            matches.push(cand);
          }
        }
      }
      // span === 0 (single-line edit) is intrinsically unsafe to relocate on a
      // single 16-bit hash: refuse and let the model re-read. Multi-line spans
      // require BOTH endpoint hashes to match, which is far less collision-prone.
      if (span === 0 && matches.length > 0) {
        return { ok: false, ambiguous: true, which: 'start', anchor: start,
                 reason: 'single-line anchor is stale; relocation is unsafe for single lines (re-read to get the current anchor)' };
      }
      if (matches.length === 1) {
        const cand = matches[0];
        return { ok: true, s: cand - 1, e: cand + span - 1, relocated: true };
      }
      if (matches.length > 1) {
        return { ok: false, ambiguous: true, which: 'start', anchor: start,
                 reason: `anchor matches ${matches.length} locations in the relocation window; refusing to guess (re-read to disambiguate)` };
      }
    }

    const which = ok(start.line, start.hash) ? 'end' : 'start';
    return { ok: false, which, anchor: which === 'start' ? start : end };
  }

  function applyEdits(path, rawEdits, allowRelocate) {
    const abs = safePath(path);
    const { lines, eol, trailing } = readFileLines(abs);

    const edits = [];
    for (const e of rawEdits) {
      const start = parseAnchor(e.start);
      const end = parseAnchor(e.end);
      if (end.line < start.line) throw new ToolError(`end line < start line (${e.end} < ${e.start})`);
      edits.push({ start, end, content: String(e.content) });
    }

    const resolved = [];
    for (const e of edits) {
      const r = resolveAnchors(lines, e.start, e.end, allowRelocate);
      if (!r.ok) {
        stats.rejected++;
        const lo = Math.max(0, e.start.line - 4), hi = Math.min(lines.length - 1, e.end.line + 2);
        const headline = r.ambiguous
          ? `AMBIGUOUS ANCHOR ${r.anchor.line}:${r.anchor.hash} — ${r.reason}. NO edits applied.`
          : `HASH MISMATCH at ${r.which} anchor ${r.anchor.line}:${r.anchor.hash} — file changed since read. NO edits applied.`;
        throw new ToolError(
          `${headline}\n` +
          `Current anchors near the target:\n${fmtHashed(lines, lo, hi)}\n` +
          `Fix the anchors from the lines above and retry (no need to re-read the whole file).`
        );
      }
      if (r.relocated) stats.relocated++;
      resolved.push({ s: r.s, e: r.e, content: e.content, relocated: r.relocated });
    }

    const sorted = [...resolved].sort((a, b) => a.s - b.s);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].s <= sorted[i - 1].e) throw new ToolError(`edit ranges overlap — split into separate calls`);
    }

    let out = lines.slice();
    const summary = [];
    for (const r of [...resolved].sort((a, b) => b.s - a.s)) {
      const replacedText = out.slice(r.s, r.e + 1).join('\n');
      const newLines = r.content === '' ? [] : r.content.split('\n');
      out.splice(r.s, r.e - r.s + 1, ...newLines);
      stats.actualOutTokens += estTokens(r.content) + 8;
      stats.baselineOutTokens += estTokens(replacedText) + estTokens(r.content) + 8;
      stats.edits++;
      summary.push(`  lines ${r.s + 1}-${r.e + 1} → ${newLines.length} line(s)${r.relocated ? '  [anchors auto-relocated]' : ''}`);
    }

    writeFileLines(abs, out, eol, trailing);

    const first = sorted[0];
    const lo = Math.max(0, first.s - 2);
    const hi = Math.min(out.length - 1, first.s + 8);
    return [
      `✓ ${resolved.length} edit(s) applied: ${path}  (${lines.length} → ${out.length} lines)`,
      ...summary, ``, `Fresh anchors around the change:`, fmtHashed(out, lo, hi),
    ].join('\n');
  }

  // ── tool definitions ──
  const editTools = [
    {
      name: 'fs_edit_hash',
      description:
        'Replace lines [start..end] of a file using hash anchors from fs_read_hashed. ' +
        'Anchors look like "42:f3" (line 42, content-hash f3). The server re-hashes the actual lines before touching the file: ' +
        'on mismatch the edit is REJECTED (file unchanged) and current anchors for the region are returned so you can retry without re-reading. ' +
        'If the file merely shifted (lines inserted above), anchors are auto-relocated by content hash. ' +
        'DO NOT reproduce unchanged context in `content` — anchors replace old_str. This is mainly a SAFETY and reliability win (fail-fast on stale content; helps weaker models avoid old_str mismatch retry loops). vs a full-file rewrite it saves most output tokens; vs a competent tight str_replace it is roughly neutral. ' +
        'PREFER this over native str_replace edits for any multi-line change.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start: { type: 'string', description: 'start anchor "line:hash", e.g. "42:f3"' },
          end: { type: 'string', description: 'end anchor "line:hash" (same as start for single-line)' },
          content: { type: 'string', description: 'replacement text (may be empty to delete lines)' },
          allow_relocate: { type: 'boolean', description: 'auto-relocate stale line numbers by hash (default true)' },
        },
        required: ['path', 'start', 'end', 'content'],
      },
      handler: (a) => applyEdits(a.path, [{ start: a.start, end: a.end, content: a.content }], a.allow_relocate !== false),
    },
    {
      name: 'fs_multi_edit_hash',
      description:
        'Apply MULTIPLE hash-anchored edits to one file atomically (all verified first; one bad anchor rejects the whole batch, file untouched). ' +
        'Edits may be given in any order; applied bottom-up so line numbers stay valid. Ranges must not overlap. ' +
        'Use this instead of several fs_edit_hash calls when refactoring multiple spots in one file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          edits: {
            type: 'array',
            items: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' }, content: { type: 'string' } }, required: ['start', 'end', 'content'] },
          },
          allow_relocate: { type: 'boolean' },
        },
        required: ['path', 'edits'],
      },
      handler: (a) => applyEdits(a.path, a.edits, a.allow_relocate !== false),
    },
  ];

  const readTools = [
    {
      name: 'fs_read_hashed',
      description:
        'Read a file (or line range) with a 4-char content hash per line, formatted as "LINE:HASH  content". ' +
        'These anchors are REQUIRED by fs_edit_hash — always read before editing. ' +
        'Hard page cap of ' + LIMITS.READ_DEFAULT_MAX_LINES + ' lines keeps results lean; for big files read fs_outline first, then fetch only the ranges you need. ' +
        'PREFER this over any native full-file read when you plan to edit, or when the file may be large.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'integer', description: '1-based start line (default 1)' },
          end_line: { type: 'integer', description: '1-based end line inclusive (default start+199)' },
        },
        required: ['path'],
      },
      handler: ({ path, start_line, end_line }) => {
        const abs = safePath(path);
        const { lines } = readFileLines(abs);
        const total = lines.length;
        if (total === 0) return `(empty file) ${path}`;
        let s = Math.max(1, start_line ?? 1);
        let e = Math.min(total, end_line ?? s + LIMITS.READ_DEFAULT_MAX_LINES - 1);
        if (e - s + 1 > LIMITS.READ_HARD_MAX_LINES) e = s + LIMITS.READ_HARD_MAX_LINES - 1;
        if (s > total) throw new ToolError(`start_line ${s} > file length ${total}`);
        const header = `# ${path}  [lines ${s}-${e} of ${total}]`;
        let hint = '';
        if (start_line === undefined && total > LIMITS.READ_DEFAULT_MAX_LINES) {
          hint = `\n\n[!] file has ${total} lines; showing first ${e}. Use fs_outline for structure, then fs_read_hashed with start_line/end_line for the parts you need.`;
        }
        return capText(`${header}\n${fmtHashed(lines, s - 1, e - 1)}${hint}`);
      },
    },
    {
      name: 'fs_outline',
      description:
        'Structural outline of a code/markdown file: declarations (functions, classes, methods, headings) with line:hash anchors. ' +
        'Costs ~50-300 tokens instead of thousands for a full read. ALWAYS use first for unfamiliar files, then fs_read_hashed only the relevant ranges.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: ({ path }) => {
        const abs = safePath(path);
        const { lines } = readFileLines(abs);
        const items = [];
        for (let i = 0; i < lines.length && items.length < LIMITS.OUTLINE_MAX_ITEMS; i++) {
          if (OUTLINE_PATTERNS.some((re) => re.test(lines[i]))) {
            items.push(`${i + 1}:${hashLine(lines[i])}  ${lines[i].trim().slice(0, 140)}`);
          }
        }
        if (!items.length) return `# outline: ${path} (${lines.length} lines)\n(no recognizable declarations — use fs_read_hashed with a line range)`;
        return capText(`# outline: ${path} (${lines.length} lines, ${items.length} items)\n${items.join('\n')}`);
      },
    },
    {
      name: 'search_lean',
      description:
        'Regex search across the workspace with hard result budgets: max ' + LIMITS.SEARCH_DEFAULT_MAX_RESULTS + ' matches (cap ' + LIMITS.SEARCH_HARD_MAX_RESULTS + '), ' +
        LIMITS.SEARCH_MATCH_MAX_CHARS + ' chars/line, binary/oversized files skipped, node_modules/.git ignored. ' +
        'Results carry line:hash anchors usable directly by fs_edit_hash. PREFER over shell grep — unbudgeted grep bloats history and is re-billed every later turn.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JS regex (no flags; use [aA] for case-insensitivity)' },
          path: { type: 'string', description: 'file or directory (default: workspace root)' },
          max_results: { type: 'integer' },
          ext: { type: 'string', description: 'limit to extension, e.g. "ts"' },
        },
        required: ['pattern'],
      },
      handler: ({ pattern, path, max_results, ext }) => {
        let re;
        try { re = new RegExp(pattern); } catch (e) { throw new ToolError(`bad regex: ${e.message}`); }
        const cap = Math.min(max_results ?? LIMITS.SEARCH_DEFAULT_MAX_RESULTS, LIMITS.SEARCH_HARD_MAX_RESULTS);
        const startAbs = safePath(path ?? '.');
        const files = [];
        (function walk(dir) {
          if (files.length >= LIMITS.SEARCH_MAX_FILES) return;
          // F-9: don't descend into IGNORE_DIRS even when explicitly requested
          // as the starting path (e.g. path: '.git'). Children are already
          // filtered by name below, but the starting directory itself was not.
          if (IGNORE_DIRS.has(basename(dir))) return;
          const st = statSync(dir);
          if (st.isFile()) { files.push(dir); return; }
          for (const name of readdirSync(dir)) {
            if (IGNORE_DIRS.has(name) || name.startsWith('.')) continue;
            const p = join(dir, name);
            let s; try { s = statSync(p); } catch { continue; }
            if (s.isDirectory()) walk(p);
            else if (s.isFile() && s.size <= LIMITS.SEARCH_MAX_FILE_BYTES) { if (!ext || p.endsWith('.' + ext)) files.push(p); }
            if (files.length >= LIMITS.SEARCH_MAX_FILES) return;
          }
        })(startAbs);
        const hits = [];
        let scanned = 0, totalMatches = 0;
        for (const f of files) {
          let raw; try { raw = readFileSync(f); } catch { continue; }
          if (raw.includes(0)) continue;
          scanned++;
          const fileLines = raw.toString('utf8').split(/\r?\n/);
          for (let i = 0; i < fileLines.length; i++) {
            if (re.test(fileLines[i])) {
              totalMatches++;
              if (hits.length < cap) {
                const lineTxt = fileLines[i].length > LIMITS.SEARCH_MATCH_MAX_CHARS ? fileLines[i].slice(0, LIMITS.SEARCH_MATCH_MAX_CHARS) + '…' : fileLines[i];
                hits.push(`${relative(ROOT, f) || f}:${i + 1}:${hashLine(fileLines[i])}  ${lineTxt}`);
              }
            }
          }
        }
        const head = `# search /${pattern}/ — ${totalMatches} match(es) in ${scanned} file(s)` + (totalMatches > cap ? ` (showing first ${cap}; refine pattern or set ext)` : '');
        return capText(`${head}\n${hits.join('\n') || '(no matches)'}`);
      },
    },
    {
      name: 'token_report',
      description:
        'Report this session\'s hash-anchored edit activity and OUTPUT-token accounting. ' +
        'Shows actual tokens emitted vs a NAIVE old_str upper bound; note that vs a competent ' +
        'minimal-unique str_replace the savings are typically small or neutral on strong models ' +
        '(see bench-output.mjs). The real wins are: safety (fail-fast on stale anchors) and big ' +
        'savings only when the alternative was a full-file rewrite.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        // F-4: baselineOutTokens = naive full-block old_str (the str_replace
        // tool-call: old_str+new_str), NOT a full-file Write. Labelling it
        // "full-rewrite" overstated savings. This is an UPPER BOUND on the
        // str_replace cost, not the Write cost.
        const vsRewrite = Math.max(0, stats.baselineOutTokens - stats.actualOutTokens);
        const pctRewrite = stats.baselineOutTokens ? Math.round((vsRewrite / stats.baselineOutTokens) * 100) : 0;
        return [
          `# tokenlean session report`,
          `edits applied:            ${stats.edits}`,
          `edits rejected (stale):   ${stats.rejected}`,
          `anchors auto-relocated:   ${stats.relocated}`,
          ``,
          `OUTPUT tokens (chars/4 estimate — run bench-output.mjs for BPE-accurate numbers):`,
          `  hash-anchored actual:        ~${stats.actualOutTokens}`,
          `  naive old_str upper bound:   ~${stats.baselineOutTokens}  (naive str_replace: old_str+new_str)`,
          `  saved vs naive old_str:      ~${vsRewrite}  (${pctRewrite}%)  ← UPPER BOUND only`,
          ``,
          `Honest note: vs a competent minimal-unique str_replace, hash editing is roughly`,
          `neutral on strong models (often within ±10%). Its durable value is fail-fast safety`,
          `and avoiding full-file rewrites — not beating a tight diff on token count.`,
          ``,
          `To reset these counters for a new session (e.g. in stdio mode), call`,
          `resetStats() on the core object. HTTP sessions auto-reset on new initialize.`,
        ].join('\n');
      },
    },
  ];

  const tools = readOnly ? readTools : [...readTools, ...editTools];

  // ── MCP JSON-RPC dispatch (transport-agnostic) ──
  // Returns a response object, or null for notifications (no reply expected).
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
            'Token-lean filesystem tools. Workflow: fs_outline → fs_read_hashed (ranges) → fs_edit_hash / fs_multi_edit_hash. ' +
            'Use search_lean instead of shell grep. Never reproduce unchanged code in edit content. Call token_report at session end.',
        });
      case 'notifications/initialized':
      case 'initialized':
        return null; // notification
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
          const msg2 = e instanceof ToolError ? e.message : `internal error: ${e.message}`;
          return ok({ content: [{ type: 'text', text: `✗ ${msg2}` }], isError: true });
        }
      }
      default:
        return id !== undefined ? err(-32601, `method not found: ${method}`) : null;
    }
  }

  return { tools, dispatch, stats, resetStats, serverInfo: SERVER_INFO, root: ROOT };
}
