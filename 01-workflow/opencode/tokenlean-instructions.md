# tokenlean token discipline (all three dimensions)

## INPUT — keep AGENTS.md prefix-stable
No timestamps, no UUIDs/session ids, static rules before dynamic notes, keep it small.
Volatile context (git status, open files) comes from tool calls, not this file.

## INPUT — compress every prompt
Use structured formats (YAML/key-value/tables) over prose paragraphs. Kill filler
words ("please", "you need to"), merge redundant instructions, use abbreviations.
A 3,500-token prose prompt compresses to ~1,200 tokens with zero information loss.

## OUTPUT — surgical edits, not rewrites
Use the edit tool for partial changes; reserve write for new files. Never re-emit
unchanged content. Deletions: replace with empty, don't rewrite the file.

## OUTPUT — budget your response
Cap output with `max_tokens` (classify: 10-50, review: 200-400, implement: 600-1200).
Prefer JSON/YAML over prose for data (40-60% fewer tokens). Batch non-urgent work.

## FUTURE INPUT — lean tool output
Bound every noisy command (head/tail/-n limits). Probe file size before reading;
read ranges, not whole large files. Summarize big results in one line, then move on.
The tokenlean plugin will stop unbounded commands and full-file overwrites of large files.
