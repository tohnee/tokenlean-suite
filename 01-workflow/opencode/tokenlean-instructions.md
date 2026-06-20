# tokenlean token discipline (all three dimensions)

## INPUT — keep AGENTS.md prefix-stable
No timestamps, no UUIDs/session ids, static rules before dynamic notes, keep it small.
Volatile context (git status, open files) comes from tool calls, not this file.

## OUTPUT — surgical edits, not rewrites
Use the edit tool for partial changes; reserve write for new files. Never re-emit
unchanged content. Deletions: replace with empty, don't rewrite the file.

## FUTURE INPUT — lean tool output
Bound every noisy command (head/tail/-n limits). Probe file size before reading;
read ranges, not whole large files. Summarize big results in one line, then move on.
The tokenlean plugin will stop unbounded commands and full-file overwrites of large files.
