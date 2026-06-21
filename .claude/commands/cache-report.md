---
description: Report prompt-cache hit rate and estimated savings for this project's sessions (INPUT dimension).
allowed-tools: Bash(node:*)
---

Run the cache hit-rate analyzer over this project's Claude Code transcripts and
also audit CLAUDE.md for prefix stability.

!`node .claude/lib/hit-rate.mjs "$(ls -d ~/.claude/projects/*/ 2>/dev/null | head -1)" 2>/dev/null || echo "no transcripts yet"`

!`test -f CLAUDE.md && node -e "import('./.claude/lib/cache-doctor.mjs').then(m=>console.log(m.report(require('fs').readFileSync('CLAUDE.md','utf8'),'CLAUDE.md').text))" 2>/dev/null || echo "no CLAUDE.md"`

Based on the report above:
- If hit rate < 50%, identify the most likely cause (unstable CLAUDE.md, frequent prefix changes, or 5min TTL on sparse sessions) and propose a concrete fix.
- If CLAUDE.md has critical issues, offer to fix them now.
