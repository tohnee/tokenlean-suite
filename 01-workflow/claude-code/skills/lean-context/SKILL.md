---
name: lean-context
description: Use whenever reading files, searching the codebase, running tests/builds, or inspecting logs — i.e. any tool call that can produce large output. Keeps tool output small and summarizes-then-discards so big dumps don't linger in history and get re-billed every later turn (FUTURE INPUT). Pairs with the bash-guard hook (bounds unbounded commands) and the precompact hook.
---

# Lean Context (FUTURE INPUT)

## Why
Every tool result stays in the conversation and is re-sent to the model on
every subsequent turn. A 500-line read on turn 3 is paid for again on turns
4…N. The biggest avoidable cost in long sessions is large tool output that
lingers.

## The rules
1. **Probe before reading.** Check size (`wc -l`) before reading a file; if
   >200 lines, read a specific range or get structure first.
2. **Bound every noisy command.** Pipe through `head`/`tail`; use `-n`/`-m`
   limits; `grep -rn ... | head`. Never `cat` a log or `grep -r` unbounded.
   (The bash-guard hook will prompt you if you forget.)
3. **Right tool for the question:**
   - "what's in this dir" → `ls`, not `cat *`
   - "find usages" → `grep -rn ... | head`, not read every file
   - "latest error" → `tail -n 50 x.log`, not `cat x.log`
   - "test result" → `npm test 2>&1 | tail -n 80`
4. **Summarize, then move on.** After a large read, write a 1-2 line summary of
   what mattered, so the raw dump can be dropped from working memory.
5. **Don't re-read.** Read once; rely on your summary instead of re-fetching.

## How to act
- Before any read/grep/log command, picture the output size. If it could be
  hundreds of lines, bound it.
- After a big tool result, immediately state the takeaway ("auth.ts: login at
  L42, no rate limiting") rather than silently continuing — the takeaway is
  what carries forward cheaply.
- Treat exploration output (build logs, full test dumps) as disposable: extract
  the failing lines, discard the rest.

## Rough impact
A 50-turn session with disciplined reads + bounded commands cuts cumulative
input by ~50-80% versus letting raw output pile up. Replacing one full-file
read (~17.5k tokens) with an outline + targeted range (~0.5k) saves that
delta on *every* later turn it would otherwise have ridden along on.

## What this can't do
It can't retroactively shrink output already in history (that's what
/lean-compact and the precompact hook are for). It prevents the bloat going in.
