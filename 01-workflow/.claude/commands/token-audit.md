---
description: One-shot audit of all three token dimensions for this project (INPUT / OUTPUT / FUTURE INPUT).
allowed-tools: Bash(node:*), Bash(ls:*), Bash(wc:*)
---

## INPUT — prefix cache health
!`node .claude/lib/hit-rate.mjs "$(ls -d ~/.claude/projects/*/ 2>/dev/null | head -1)" 2>/dev/null || echo "no transcripts yet"`

## INPUT — CLAUDE.md stability
!`test -f CLAUDE.md && node -e "import('./.claude/lib/cache-doctor.mjs').then(m=>console.log(m.report(require('fs').readFileSync('CLAUDE.md','utf8'),'CLAUDE.md').text))" 2>/dev/null || echo "no CLAUDE.md"`

## CLAUDE.md size (re-sent every turn)
!`test -f CLAUDE.md && wc -lw CLAUDE.md || echo "no CLAUDE.md"`

Summarize the three token dimensions for this project and give the single
highest-ROI action to take next. Be specific and brief.
