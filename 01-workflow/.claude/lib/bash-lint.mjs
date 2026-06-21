/**
 * bash-lint.mjs — analyze a shell command for unbounded output that will
 * bloat the conversation and be re-billed every subsequent turn (FUTURE INPUT).
 *
 * Returns a verdict plus a suggested bounded rewrite. Pure function; used by
 * the PreToolUse Bash hook and the test suite.
 */

// commands whose output is commonly huge and that support a cheap bound
const RISKY = [
  { name: 'cat',   re: /^\s*cat\s+(?!.*\|)/,                                 bound: (c) => c.replace(/^\s*cat\s+/, 'sed -n "1,200p" ') },
  { name: 'grep-r',re: /^\s*grep\s+.*-[rR]/,                                  bound: (c) => `${c} | head -n 100` },
  { name: 'find',  re: /^\s*find\s+/,                                         bound: (c) => `${c} | head -n 100` },
  { name: 'log',   re: /\b(tail|cat)\s+[^|]*\.log\b/,                         bound: (c) => c.replace(/\b(tail|cat)\s+/, 'tail -n 200 ') },
  { name: 'test',  re: /\b(npm\s+test|pytest|make(\s+\w+)?|go\s+test|cargo\s+test|jest|vitest)\b/, bound: (c) => `${c} 2>&1 | tail -n 100` },
  { name: 'gitlog',re: /^\s*git\s+log(?!.*-n\s*\d)/,                          bound: (c) => c.replace(/^\s*git\s+log/, 'git log -n 30') },
  { name: 'ls-R',  re: /^\s*ls\s+.*-[a-zA-Z]*R/,                              bound: (c) => `${c} | head -n 200` },
];

// tokens that mean the user already bounded the output
const BOUNDED = /\|\s*(head|tail|wc|jq|grep\s+-m)|--max-count|-m\s*\d|-n\s*\d|-maxdepth|head\s+-c|sed\s+-n/;

/**
 * @param {string} command
 * @returns {{risky:boolean, rule?:string, suggestion?:string, reason?:string}}
 */
export function lintCommand(command) {
  if (!command || typeof command !== 'string') return { risky: false };
  if (BOUNDED.test(command)) return { risky: false }; // already bounded

  for (const r of RISKY) {
    if (r.re.test(command)) {
      let suggestion;
      try { suggestion = r.bound(command); } catch { suggestion = `${command} | head -n 200`; }
      return {
        risky: true,
        rule: r.name,
        suggestion,
        reason:
          `This command can emit large output that will sit in the conversation and be re-billed ` +
          `on every later turn (FUTURE INPUT cost). Prefer a bounded form, e.g.:\n    ${suggestion}\n` +
          `If you truly need the full output, proceed — but summarize the key lines right after, ` +
          `so the raw dump can be dropped from context.`,
      };
    }
  }
  return { risky: false };
}
