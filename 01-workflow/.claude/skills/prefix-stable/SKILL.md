---
name: prefix-stable
description: Use when reviewing, creating, or editing CLAUDE.md / AGENTS.md / system-prompt files, or when the user asks about prompt-cache hit rate, token cost, "why is my agent so expensive", high input cost in long sessions, or hitting quota fast. Keeps the always-loaded prefix byte-stable so prompt caching actually fires (INPUT dimension). Pairs with the session-start hook (auto-audit) and /cache-report command.
---

# Prefix-Stable Prompt Hygiene (INPUT)

## Why
Prompt caching needs a **byte-exact prefix match**. CLAUDE.md is re-sent on every
turn; if it contains anything that changes between requests, the cache MISSES and
the entire conversation is re-billed at full input price each turn.

## The rules
1. **No timestamps** in CLAUDE.md — no `{{date}}`, no ISO times, no `$(date)`.
2. **No random IDs** — no UUIDs, session ids, nonces.
3. **Static before dynamic** — stable rules/architecture first; never lead with
   a "current task / today" section.
4. **Keep it small** — under ~1500 tokens is ideal, 3000 is a soft ceiling.
   Move volatile detail (open files, git status) to on-demand tool calls.

## How to act
- When asked to edit CLAUDE.md, first check it against the rules above. If the
  repo has the workflow installed, run: `node .claude/lib/cache-doctor.mjs` is
  wrapped by the `/cache-report` command — suggest running it.
- When you catch yourself about to add a timestamp or "as of now" line to a
  system file, don't — put that in a normal message instead.
- If the user reports high cost, check CLAUDE.md stability FIRST; it's the most
  common cause of a sub-30% hit rate.

## Good vs bad
```
✗ BAD
# Session 2026-01-15T08:30  (ID 550e8400-...)
# Current task: {{task}}
[big architecture dump]

✓ GOOD
# Project Foo
## Architecture        ← stable, cacheable
## Conventions         ← stable, cacheable
## Commands            ← stable, cacheable
(volatile context comes from tool calls, not from this file)
```

## What this can't do
It can't change how the harness places cache breakpoints or the server TTL.
For sparse sessions, also prefer a 1h cache TTL where your client exposes it.
See DESIGN.md "INPUT dimension" for the gateway-level options.
