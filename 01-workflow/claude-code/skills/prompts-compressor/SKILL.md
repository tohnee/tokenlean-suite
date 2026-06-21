---
name: prompts-compressor
description: Use when the user asks you to write system prompts, agent instructions,
  role definitions, or any structured instruction text. Compresses verbose natural-language
  prompts into compact structured formats, cutting token count by 40-70% with zero
  information loss.
---

# Prompt Compression (INPUT)

## Why
Every token in your prompt costs the same as a token of reasoning — don't waste
the budget on filler words. Structured formats (YAML, key-value, tables) carry
the same meaning in 30-60% fewer tokens than prose paragraphs. On a 3,500-token
system prompt, compression saves ~2,000 tokens per request — and with prompt
caching (0.1× after first write), those savings compound across every session.

## The rules
1. **Kill filler words.** Delete "请你", "你需要", "请确保", "务必注意",
   "Please make sure to", "you need to", "it is important to". Say it once,
   don't beg.

2. **Structure over prose.** Replace natural-language paragraphs with
   YAML-like key-value, pipe-separated lists, or compact tables.
   ```
   ✗ "You are a helpful assistant that carefully analyzes user questions
      and provides detailed, comprehensive answers."
   ✓ role: assistant | rule: analyze + detail | style: concise
   ```

3. **Merge redundant instructions.** Two rules that say "be accurate" → one.
   A role description and a "you are a" preamble → merge them.

4. **Use abbreviations and symbols.** `→` for "leads to/becomes", `↓` for
   "decrease", `↑` for "increase", `✗`/`✓` for bad/good. Every LLM understands
   these.

## Templates

### Role definition
```
✗ VERBOSE (286 tok)
You are a professional customer service agent. When a user asks you a question,
you need to carefully analyze the user's problem, then provide a detailed,
comprehensive, and accurate answer. Please make sure your answer contains
enough detail and practical suggestions.

✓ COMPRESSED (97 tok)
role: customer-service
rules: accurate+concise | admit uncertainty | suggest pro help if out of scope
format: direct answer + follow-up advice
```

### Code review instruction
```
✗ VERBOSE (~400 tok)
When reviewing code, check for correct error handling, ensure all edge cases
are covered, verify the code follows conventions, look for performance issues,
and check security vulnerabilities. Also pay attention to clean code principles…

✓ COMPRESSED (~180 tok)
review checklist:
  - errors: handle + propagate | no silent catch
  - edge cases: empty/null/zero/overflow/unexpected input
  - style: project conventions (see CLAUDE.md)
  - perf: N+1 queries? hot loops? unnecessary allocations?
  - security: injection? auth bypass? secret leak?
  - clean code: dead code? over-abstraction? magic numbers?
```

### Agent instruction
```
✗ VERBOSE (~520 tok)
You are an AI coding agent with access to tools. When working on a task,
first understand the requirements by reading the relevant files. Then plan
your approach. Then implement the changes. After implementing, run the
tests to verify everything works correctly…

✓ COMPRESSED (~220 tok)
workflow:
  1. understand → read files + ask clarifying questions
  2. plan → outline approach before coding (share plan with user)
  3. implement → surgical edits, no full rewrites
  4. verify → run tests, fix failures
rules: ask before destructive ops | commit per task |
       log key decisions (arch, why, rejected options)
```

## Savings shape
```
  Prose role definition     →  YAML format        ~50-70%
  Verbose agent instruction →  rule list           ~40-60%
  Paragraph constraints     →  pipe-separated      ~30-50%
  Mixed prose+examples      →  table               ~40-60%
```

## Related
- `prefix-stable` skill: keeps the compressed prompt from being undone by
  timestamps/UUIDs that bust the cache prefix.
- `surgical-edits` skill: OUTPUT-side complement — compress what the model emits
  *in response*, not just what you send.
- `lean-context` skill: FUTURE INPUT complement — keep tool output compact.
