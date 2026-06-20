# tokenlean-workflow

Out-of-the-box token optimization for **Claude Code** and **OpenCode** — no MCP,
just the agents' native skills / hooks / commands. Covers all three token
dimensions: **INPUT**, **OUTPUT**, **FUTURE INPUT**. Zero dependencies (Node ≥ 18).

## Install

```bash
# auto-detects Claude Code vs OpenCode from the current directory
bash install.sh

# or be explicit / global
bash install.sh --target claude            # project-level .claude/
bash install.sh --target opencode          # project-level .opencode/
bash install.sh --target claude --global   # ~/.claude/
```

Then do the one **final step** the installer prints:
- **Claude Code**: merge `settings.snippet.json` into `.claude/settings.json` (wires the hooks).
- **OpenCode**: merge `opencode.snippet.json` into `opencode.json` (the plugin auto-loads; this wires instructions).

Verify anytime:
```bash
node test/test-hooks.mjs      # 35 assertions
```

## What you get

| Dimension | Hook (deterministic) | Skill (behavioral) | Command |
|---|---|---|---|
| **INPUT** (cache hit rate) | session-start audits CLAUDE.md | prefix-stable | `/cache-report` |
| **OUTPUT** (generated tokens) | write-guard (Write→Edit nudge) | surgical-edits | — |
| **FUTURE INPUT** (history bloat) | bash-guard (bounds output) + precompact | lean-context | `/lean-compact` |
| all | — | — | `/token-audit` |

## Tuning (env vars)

```
TOKENLEAN_BASH_MODE   guard (default) | auto | off
TOKENLEAN_WRITE_MODE  guard (default) | warn | off
TOKENLEAN_WRITE_MIN_BYTES   default 800
```

- `guard` — asks before a wasteful action, with a concrete cheaper suggestion.
- `auto` — bash-guard rewrites unbounded commands in place (needs a recent client).
- `warn`/`off` — softer / disabled.

## Expected impact

INPUT −20~35%, OUTPUT (editing) −40~55%, FUTURE INPUT −50~80%. See `DESIGN.md`
for the full model, the per-agent mechanics, and the honest ceilings (and how
this composes with the MCP server + a gateway if you want to go further).
