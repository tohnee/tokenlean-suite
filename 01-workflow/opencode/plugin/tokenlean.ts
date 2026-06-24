/**
 * tokenlean.ts — OpenCode plugin: the same three-dimension token discipline as
 * the Claude Code hooks, expressed in OpenCode's plugin API.
 *
 * Install: copy to .opencode/plugin/tokenlean.ts (project) or
 *          ~/.config/opencode/plugin/tokenlean.ts (global).
 *
 * Dimensions:
 *   FUTURE INPUT — tool.execute.before on the bash tool bounds unbounded
 *                  output commands (cat/grep -r/find/log/test/git log).
 *   OUTPUT       — tool.execute.before on write warns when overwriting a large
 *                  existing file (prefer edit).
 *   INPUT        — session start: audit AGENTS.md/CLAUDE.md for prefix hazards.
 *
 * Zero dependencies beyond Node builtins. The lint logic mirrors
 * claude-code/lib/bash-lint.mjs and cache-doctor.mjs so behavior is identical.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

// ── shared lint logic (kept in-file so the plugin is self-contained) ──
// Parity target: claude-code/lib/bash-lint.mjs + claude-code/lib/cache-doctor.mjs
//
// IMPORTANT: OpenCode loads plugins from a single file with no transpile step,
// so we cannot `import` the .mjs source-of-truth at runtime — the rules are
// duplicated below. A structural parity test (test/test-opencode-plugin.mjs,
// Layer 2) reads this file and the .mjs source and fails CI if any rule,
// regex, or check diverges. If you change a rule on ONE side, change it on
// the OTHER side in the same commit.
const BOUNDED = /\|\s*(head|tail|wc|jq|grep\s+-m)|--max-count|-m\s*\d|-n\s*\d|-maxdepth|head\s+-c|sed\s+-n/;
const RISKY: { name: string; re: RegExp; bound: (c: string) => string }[] = [
  { name: "cat",    re: /^\s*cat\s+(?!.*\|)/,                                bound: (c) => c.replace(/^\s*cat\s+/, 'sed -n "1,200p" ') },
  { name: "grep-r", re: /^\s*grep\s+.*-[rR]/,                                bound: (c) => `${c} | head -n 100` },
  { name: "find",   re: /^\s*find\s+/,                                       bound: (c) => `${c} | head -n 100` },
  { name: "log",    re: /\b(tail|cat)\s+[^|]*\.log\b/,                       bound: (c) => c.replace(/\b(tail|cat)\s+/, "tail -n 200 ") },
  { name: "test",   re: /\b(npm\s+test|pytest|make(\s+\w+)?|go\s+test|cargo\s+test|jest|vitest)\b/, bound: (c) => `${c} 2>&1 | tail -n 100` },
  { name: "gitlog", re: /^\s*git\s+log(?!.*-n\s*\d)/,                        bound: (c) => c.replace(/^\s*git\s+log/, "git log -n 30") },
  { name: "ls-R",   re: /^\s*ls\s+.*-[a-zA-Z]*R/,                            bound: (c) => `${c} | head -n 200` },
];
function lintCommand(command: string) {
  if (!command || BOUNDED.test(command)) return { risky: false as const };
  for (const r of RISKY) {
    if (r.re.test(command)) return { risky: true as const, rule: r.name, suggestion: r.bound(command) };
  }
  return { risky: false as const };
}

const TIMESTAMP_RE = /(\{\{\s*(date|now|today|timestamp|time)\s*\}\}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\$\(date|`date|new Date\(\)|Date\.now)/;
const UUID_RE = /(\{\{\s*(uuid|nanoid|session_id|sessionId|random)\s*\}\}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const PLACEHOLDER_RE = /\{\{\s*[a-zA-Z_]+\s*\}\}|\$\{[a-zA-Z_]+\}/;
const KNOWN_DYNAMIC = /(date|now|today|timestamp|time|uuid|nanoid|session_id|sessionId|random)/;

function auditPromptFile(dir: string): string | null {
  const f = [join(dir, "AGENTS.md"), join(dir, "CLAUDE.md")].find(existsSync);
  if (!f) return null;
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n");
  const issues: string[] = [];
  const toks = Math.ceil(text.length / 4);

  // 1. size (critical >5000, warning >3000)
  if (toks > 5000) issues.push(`~${toks} tokens (>5000), re-sent every turn`);
  else if (toks > 3000) issues.push(`~${toks} tokens (>3000), consider trimming`);

  // 2. timestamps (critical)
  lines.forEach((l: string, i: number) => {
    if (TIMESTAMP_RE.test(l)) issues.push(`line ${i + 1}: timestamp (breaks prefix cache)`);
  });

  // 3. random IDs (critical)
  lines.forEach((l: string, i: number) => {
    if (UUID_RE.test(l)) issues.push(`line ${i + 1}: UUID/session id (breaks prefix cache)`);
  });

  // 4. unknown dynamic placeholders (warning)
  lines.forEach((l: string, i: number) => {
    const m = l.match(PLACEHOLDER_RE);
    if (m && !KNOWN_DYNAMIC.test(m[0])) issues.push(`line ${i + 1}: unknown placeholder ${m[0]}`);
  });

  // 5. ordering: dynamic-looking section before static (warning)
  let dynLine = -1, staticLine = -1;
  lines.forEach((l: string, i: number) => {
    if (dynLine < 0 && /^#+\s+.*(current|today|session|live|now|recent|latest)/i.test(l)) dynLine = i + 1;
    if (staticLine < 0 && /^#+\s+.*(rule|convention|architecture|guideline|workflow|command)/i.test(l)) staticLine = i + 1;
  });
  if (dynLine > 0 && staticLine > 0 && dynLine < staticLine) {
    issues.push(`dynamic heading at line ${dynLine} precedes static heading at line ${staticLine}`);
  }

  return issues.length ? `[tokenlean] ${f}: ${issues.join("; ")}` : null;
}

const MODE_BASH = process.env.TOKENLEAN_BASH_MODE || "guard";
const MODE_WRITE = process.env.TOKENLEAN_WRITE_MODE || "guard";
const WRITE_MIN_BYTES = Number(process.env.TOKENLEAN_WRITE_MIN_BYTES || 800);

export const TokenLeanPlugin = async ({ project, directory, $ }: any) => {
  const root = directory || project?.worktree || process.cwd();

  // INPUT: one-time prefix audit, surfaced as a toast/log
  const audit = auditPromptFile(root);
  if (audit) {
    try { console.error(audit); } catch {}
  }

  return {
    /**
     * Runs before any tool executes. We can inspect and mutate args.
     * OpenCode passes ({ tool, sessionID, callID }, output) where output.args
     * is the (mutable) tool input.
     */
    "tool.execute.before": async (input: any, output: any) => {
      const tool = input?.tool;
      const args = output?.args || {};

      // FUTURE INPUT: bound unbounded bash output
      if (MODE_BASH !== "off" && (tool === "bash" || tool === "shell")) {
        const cmd: string = args.command || args.cmd || "";
        const v = lintCommand(cmd);
        if (v.risky) {
          if (MODE_BASH === "auto") {
            // rewrite in place
            if ("command" in args) args.command = v.suggestion;
            else if ("cmd" in args) args.cmd = v.suggestion;
            console.error(`[tokenlean] bounded "${v.rule}" command → ${v.suggestion}`);
          } else {
            // guard: throw to require user attention with a concrete suggestion
            throw new Error(
              `[tokenlean] "${v.rule}" can emit large output that lingers in context (FUTURE INPUT cost). ` +
              `Prefer: ${v.suggestion}  — or proceed deliberately and summarize the key lines after.`
            );
          }
        }
      }

      // OUTPUT: discourage full-file overwrite of large existing files
      if (MODE_WRITE !== "off" && (tool === "write" || tool === "Write")) {
        const path = args.filePath || args.path || args.file_path;
        const content = args.content ?? "";
        if (path && existsSync(path)) {
          let size = 0;
          try { size = statSync(path).size; } catch {}
          if (size >= WRITE_MIN_BYTES) {
            const msg =
              `[tokenlean] writing ${path} (${size} B) in full re-emits every line as OUTPUT tokens. ` +
              `Use the edit tool for targeted changes (40-95% fewer output tokens).`;
            if (MODE_WRITE === "warn") console.error(msg);
            else throw new Error(msg);
          }
        }
      }
    },
  };
};
