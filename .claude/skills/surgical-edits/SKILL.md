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

---

## Output budget (beyond editing)

### Set a token cap on every response
Output tokens cost 4-5× input. Don't generate more than needed.
- **Classification / formatting**: 10-50 tokens — you don't need paragraphs for
  a label.
- **Code review / brief summary**: 200-400 tokens.
- **Full implementation**: 600-1200 tokens — break into multiple turns if larger.
- **No explicit limit given**: default to 400 tokens, ask before exceeding.

### Prefer structured output
JSON or YAML carries the same information in 40-60% fewer tokens than prose:
```json
// Instead of:
"The register endpoint has three params: username (required, 3-20 chars),
 email (required, valid format), password (required, min 8 chars)."

// Use:
{ "register": {
    "username": "required, 3-20 chars",
    "email": "required, valid format",
    "password": "required, min 8 chars"
}}
```
When asked for structured data (configs, specs, test cases), default to JSON
unless prose is explicitly requested. This is not laziness — it's 3× token
efficiency for the same information.

### Batch non-urgent work
Tests, documentation generation, bulk conversions — these don't need real-time
responses. Queue them for the Batch API at 50% discount. If you're generating
>10 test cases, suggest: "Shall I batch these at half price?"

### Summary
```
  Unbounded prose response     →  set max_tokens + max 3 sentences    ~30-50%
  Verbose data description     →  JSON / YAML format                  ~40-60%
  Real-time generation (urgent) →  keep synchronous, cap at 400 tok   —
  Non-urgent generation        →  Batch API (50% discount)            ~50%
```
