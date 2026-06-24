# TokenLean savings report

Generated: 2026-06-24T23:00:00.000Z

Honesty note: this is an accounting benchmark. It quantifies emitted/output bytes, tool-output history re-billing, and cache-aware RAG layout economics; it does not prove a real model will always choose the lean path.

| Dimension | Scenario | Main result | Caveat |
|---|---|---:|---|
| OUTPUT | coding edit tool-call bytes | 86% vs full Write / -8% vs competent Edit | Hash anchors are reliability-first vs strong native Edit. |
| FUTURE INPUT | coding-agent tool output re-billed over 12 turns | 73% cumulative context-token-turn savings | Depends on how often risky tool calls occur. |
| CODING AGENT | combined input re-billing + edit output cost | 74% vs full-rewrite agent / 73% vs native-Edit agent | Accounting model assumes the agent follows lean tools. |
| INPUT/RAG | chatbot repeated-KB cache-aware layout | 70% billed-input savings | Local cache economics; verify with live provider usage. |

## FUTURE INPUT detail

Cumulative context-token-turns: lean 44713, naive 167080.

## Reproduce

- `node 02-mcp-server/test/bench-output.mjs`
- `node 02-mcp-server/test/bench-future.mjs`
- `node 02-mcp-server/test/bench-coding-agent.mjs`
- `node 03-rag-server/bench/chatbot-rag-benchmark.mjs`
