# tokenlean-mcp

Universal token-optimization MCP server for ANY coding agent or web copilot.
Zero-dependency single codebase, two transports (Node >= 18, no npm install):

| Transport | Form | Dimensions | Mechanism |
|---|---|---|---|
| `bin/stdio.mjs` | local CLI (agent spawns child) | OUTPUT + FUTURE INPUT | hash-anchored edits + hard budgets baked into read/search tools |
| `bin/http.mjs`  | web copilot (long-lived HTTP service) | OUTPUT + FUTURE INPUT | same core, plus Bearer auth + per-session cores |

Both transports share `lib/core.mjs` — the same 6 tools, the same path
sandbox, the same token discipline. The INPUT dimension (prefix cache
shaping) is **not** in this package; see `05-gateway-design/` and
`04-prompt-assembler/` for the companion design and library.

Works with: Claude Code, OpenCode, Codex CLI, Cursor, Windsurf, VS Code
Copilot (stdio), and Claude.ai connectors / ChatGPT / custom chatbots (http).

## Quick start

```bash
# 1. Verify environment + run self-tests (64 assertions, no API key needed)
bash install.sh

# 2. Local CLI form — register into your agent (merges, never clobbers)
#    See configs/ for per-agent JSON. Example for Claude Code .mcp.json:
#    { "mcpServers": { "tokenlean": { "command": "node",
#      "args": ["/abs/path/tokenlean.mjs", "stdio", "--root", "."] } } }
node tokenlean.mjs stdio --root .

# 3. Web copilot form — long-lived service, Bearer token REQUIRED
TOKENLEAN_TOKEN=$(openssl rand -hex 16) node tokenlean.mjs http --root /srv/repo
# then expose via tunnel:  cloudflared tunnel --url http://127.0.0.1:8765

# 4. Observe in-session: ask the model to call `token_report`
```

`--deny-native` (configured in your agent's permissions, see `configs/`)
disables the agent's built-in Edit tools so hash edits are mandatory
(100% adoption instead of ~50% with description-nudging alone).

## Tools (MCP)

| Tool | Dimension | read-only ok | Purpose |
|---|---|---|---|
| `fs_outline` | FUTURE INPUT | yes | structural outline + line anchors (~100 tokens vs full read) |
| `fs_read_hashed` | FUTURE INPUT + OUTPUT prep | yes | paged read (default 200 / hard cap 600 lines), each line tagged `line:hash` |
| `fs_edit_hash` | OUTPUT | no | replace `[start..end]` by `line:hash` anchors; mismatch fail-fast + auto-relocation |
| `fs_multi_edit_hash` | OUTPUT | no | batch edits, all-then-apply atomicity |
| `search_lean` | FUTURE INPUT | yes | regex search, hard budget (25 default / 80 cap, 200 chars/match) |
| `token_report` | observability | yes | session-level edit/reject/relocate counts + OUTPUT savings estimate |

Hash anchors are 4 hex chars (16-bit space). Single-line edits refuse
relocation; multi-line edits auto-relocate within a ±40-line window and
reject on multi-match. See `lib/core.mjs` `resolveAnchors` for the guards.

## HTTP transport env / flags

| Flag | Env | Default | Notes |
|---|---|---|---|
| `--token <secret>` | `TOKENLEAN_TOKEN` | — | **required**, server refuses to start without it |
| `--root <dir>` | — | `process.cwd()` | workspace sandbox root |
| `--port <n>` | `PORT` | `8765` | listen port |
| `--host <ip>` | — | `127.0.0.1` | set `0.0.0.0` to expose (ensure TLS + firewall) |
| `--read-only` | — | off | disable edit tools (recommended for Q&A chatbots) |
| — | `TOKENLEAN_SESSION_TTL_MS` | `1800000` (30 min idle) | per-session core eviction |
| — | `TOKENLEAN_SESSION_MAX` | `1000` | hard cap on concurrent sessions |
| — | `TOKENLEAN_SEARCH_MAX_FILES` | `4000` | cap on files walked by `search_lean` (sync I/O; lower for large repos on HTTP transport) |

HTTP endpoints:

- `POST /mcp` — MCP JSON-RPC (Bearer auth required; `initialize` returns `mcp-session-id` header)
- `DELETE /mcp` — terminate a session (Bearer auth + `mcp-session-id` header)
- `GET /healthz` — unauthenticated health check, returns `{ ok, sessions }`

Note: this is a practical subset of MCP Streamable HTTP — `POST /mcp`
returns a single JSON response (no server-initiated SSE stream; `GET /mcp`
is not implemented). Clients that require SSE on `GET /mcp` are not
supported; use the stdio form via `supergateway` if you need SSE.

## Testing

```bash
node test/test-stdio.mjs   # 38 assertions: handshake, tools, edits, relocation, sandbox, etc.
node test/test-http.mjs    # 26 assertions: auth, session isolation, DELETE /mcp, __default__ fallback, sandbox over HTTP
# or:  node tokenlean.mjs test   (runs both)
```

`test/bench-output.mjs` is an optional OUTPUT-token comparison script
(uses `gpt-tokenizer` if installed, falls back to chars/4). It is not
part of the self-test suite.

## Files

```
02-mcp-server/
├── lib/core.mjs           # pure logic: 6 tools + dispatch (transport-agnostic)
├── bin/stdio.mjs          # local CLI transport (readline stdin → core.dispatch)
├── bin/http.mjs           # web transport (node:http + Bearer auth + sessions)
├── tokenlean.mjs          # unified launcher: tokenlean stdio|http|test|help
├── server.mjs             # backward-compat shim (legacy `node server.mjs`)
├── install.sh             # env check + self-test + optional symlink
├── test/
│   ├── test-stdio.mjs     # 38 assertions
│   ├── test-http.mjs      # 26 assertions
│   └── bench-output.mjs   # optional OUTPUT-token benchmark
└── configs/               # per-client integration snippets
    ├── claude-code.md  opencode.md  codex-cli.md
    ├── cursor-vscode.md  chatbot.md
```

## Further reading

- `DESIGN.md` — full design (three-layer separation, dual-transport rationale,
  security model, savings curves, file inventory)
- `../docs/universal-token-optimization.md` — the analysis behind this package
  (what a universal layer can and cannot achieve, measured savings, honest limits)
- `../IMPLEMENTATION-AND-COMPOSITION.md` — how this package composes with
  `01-workflow` and `04-prompt-assembler` across the three token dimensions
