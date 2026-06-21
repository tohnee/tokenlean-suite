---
name: surgical-edits
description: Use whenever modifying existing code or text files. Enforces minimal, targeted edits over full-file rewrites so the model emits far fewer OUTPUT tokens (the most expensive token class). Pairs with the write-guard hook, which asks before a Write overwrites a large existing file. Use Edit/targeted replacement; never reproduce unchanged content.
---

# Surgical Edits (OUTPUT)

## Why
Output tokens cost ~4-5× input tokens. Rewriting a whole file with `Write`
forces the model to re-emit every unchanged line. A targeted `Edit` emits only
the changed region — typically 40-95% fewer output tokens for the same result.

## The rules
1. **Edit, don't rewrite.** To change part of an existing file, use the `Edit`
   tool (targeted old→new replacement), never `Write` the whole file.
2. **`Write` is for new files only** (or genuine full replacements like
   regenerating a lockfile).
3. **Don't reproduce unchanged context.** Quote only the minimal `old_str`
   needed to locate the change uniquely; keep it tight.
4. **Batch related edits** in one pass rather than re-reading between each.
5. **Deletions are nearly free** — to remove a block, replace it with empty
   content; don't rewrite the surrounding file.

## How to act
- Before writing a file, ask: does it already exist? If yes and the change is
  partial → `Edit`.
- If you find yourself pasting most of a file back with one line changed, stop
  and convert it to a single `Edit` of just that line/region.
- For multi-spot refactors in one file, prefer the editor's multi-edit form
  (one tool call, several targeted replacements) over a full rewrite.

## Savings shape (replacing N lines, realistic refactor)
```
   1 line   ~20% fewer output tokens   (marginal — Edit fine, don't over-think)
   3 lines  ~40%
  10 lines  ~50%
  20+ lines ~53-55%
  pure delete of 30 lines  ~95%
```

## What this can't do
Without a custom edit tool it can't change the wire format of `Edit` itself.
It's behavioral: it keeps you choosing the cheap tool and the tight diff. The
write-guard hook backs it up by interrupting full-file overwrites of large files.

## Compatible tools

**caveman** (telegraphic output compression) is fully compatible with this skill.
  - caveman compresses the **natural language narration** the model produces
    (explanations, reasoning, commentary) by ~65%, while this skill reduces
    **edit tool-call size** (the code content in old_str/new_str).
  - They act on **different parts of the OUTPUT token bill** — caveman on
    prose, surgical-edits on code diffs. The savings are multiplicative.
  - If you use both, your agent will write shorter explanations and tighter
    edits. Neither interferes with the other.
  - Install: `npm install -g caveman` and add a line to CLAUDE.md:
    "You communicate in compressed telegraphic style (caveman mode)."

**rtk** (Rust Token Killer) compresses CLI command output before it reaches the
  agent. This is a FUTURE INPUT optimization, orthogonal to OUTPUT editing.
  No interaction concerns.

**tokenlean MCP** (`fs_edit_hash`) replaces native Edit with hash-anchored
  edits. When both are active, prefer MCP's `fs_edit_hash` for the safety
  (fail-fast on stale content) and `surgical-edits` behavioral guidance for
  fallback to native Edit when MCP isn't available.
