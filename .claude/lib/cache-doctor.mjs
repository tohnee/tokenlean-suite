/**
 * cache-doctor.mjs — detect content that breaks prompt-cache prefix stability.
 * Pure function, no I/O side effects on import. Used by the SessionStart hook,
 * the /cache-report command, and the test suite.
 *
 * INPUT-dimension optimization: a byte-unstable prefix means every request is a
 * cache MISS, so the whole conversation is re-billed at full input price every
 * turn. This finds the usual culprits before they cost you.
 */

const TIMESTAMP_RE =
  /(\{\{\s*(date|now|today|timestamp|time)\s*\}\}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\$\(date|`date|new Date\(\)|Date\.now)/;
const UUID_RE =
  /(\{\{\s*(uuid|nanoid|session_id|sessionId|random)\s*\}\}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const PLACEHOLDER_RE = /\{\{\s*[a-zA-Z_]+\s*\}\}|\$\{[a-zA-Z_]+\}/;
const KNOWN_DYNAMIC = /(date|now|today|timestamp|time|uuid|nanoid|session_id|sessionId|random)/;

const estTokens = (s) => Math.ceil(s.length / 4);

/**
 * @param {string} text  contents of CLAUDE.md / AGENTS.md / system prompt file
 * @returns {{ critical: object[], warnings: object[], estTokens: number, ok: boolean }}
 */
export function diagnose(text) {
  const lines = text.split('\n');
  const critical = [];
  const warnings = [];

  // 1. size
  const toks = estTokens(text);
  if (toks > 5000) {
    critical.push({ check: 'size', detail: `~${toks} tokens (> 5000). This is re-sent every turn.` });
  } else if (toks > 3000) {
    warnings.push({ check: 'size', detail: `~${toks} tokens (> 3000). Consider trimming.` });
  }

  // 2. timestamps (critical)
  lines.forEach((l, i) => {
    if (TIMESTAMP_RE.test(l)) {
      critical.push({ check: 'timestamp', line: i + 1, detail: l.trim().slice(0, 80) });
    }
  });

  // 3. random IDs (critical)
  lines.forEach((l, i) => {
    if (UUID_RE.test(l)) {
      critical.push({ check: 'random-id', line: i + 1, detail: l.trim().slice(0, 80) });
    }
  });

  // 4. unknown dynamic placeholders (warning)
  lines.forEach((l, i) => {
    const m = l.match(PLACEHOLDER_RE);
    if (m && !KNOWN_DYNAMIC.test(m[0])) {
      warnings.push({ check: 'placeholder', line: i + 1, detail: m[0] });
    }
  });

  // 5. ordering: dynamic-looking section before static (warning)
  let dynLine = -1, staticLine = -1;
  lines.forEach((l, i) => {
    if (dynLine < 0 && /^#+\s+.*(current|today|session|live|now|recent|latest)/i.test(l)) dynLine = i + 1;
    if (staticLine < 0 && /^#+\s+.*(rule|convention|architecture|guideline|workflow|command)/i.test(l)) staticLine = i + 1;
  });
  if (dynLine > 0 && staticLine > 0 && dynLine < staticLine) {
    warnings.push({ check: 'ordering', detail: `dynamic-looking heading at line ${dynLine} precedes static heading at line ${staticLine}` });
  }

  return { critical, warnings, estTokens: toks, ok: critical.length === 0 };
}

/** Human-readable report (used by /cache-report and SessionStart hook). */
export function report(text, filename = 'CLAUDE.md') {
  const r = diagnose(text);
  const out = [`cache-doctor: ${filename}  (~${r.estTokens} tokens)`];
  if (r.critical.length === 0 && r.warnings.length === 0) {
    out.push('  ✓ prefix-stable, no issues');
    return { text: out.join('\n'), ...r };
  }
  for (const c of r.critical) {
    out.push(`  ✗ CRITICAL [${c.check}]${c.line ? ' line ' + c.line : ''}: ${c.detail}`);
  }
  for (const w of r.warnings) {
    out.push(`  ⚠ warning  [${w.check}]${w.line ? ' line ' + w.line : ''}: ${w.detail}`);
  }
  if (r.critical.length) {
    out.push('  → Fix: remove timestamps/IDs from the always-loaded prompt; move dynamic data to tool calls.');
  }
  return { text: out.join('\n'), ...r };
}
