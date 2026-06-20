---
description: Compact the conversation while preserving decisions, constraints, and open tasks (FUTURE INPUT dimension).
---

Before we compact, produce a tight handoff summary that PRESERVES:
1. Decisions made + one-line rationale each
2. Active constraints (style, deadlines, API contracts, "do not touch")
3. Open tasks / next steps still pending
4. File paths and identifiers currently in play

DISCARD: raw tool output, superseded reasoning, resolved dead-ends.

Output the summary, then run `/compact` using it as the focus. Keep the last few
turns intact. Do not invent anything — summarize only what was actually said.
