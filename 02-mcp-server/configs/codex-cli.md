# OpenAI Codex CLI 集成

`~/.codex/config.toml`:

```toml
[mcp_servers.tokenlean]
command = "node"
args = ["/absolute/path/to/tokenlean-mcp/server.mjs", "--root", "."]
```

Codex 没有逐工具 deny 机制,改用 instructions 引导:
在 `AGENTS.md` 中加入:

```
For all multi-line file edits, use the tokenlean MCP tools
(fs_read_hashed → fs_edit_hash). Never use apply_patch for
edits larger than 2 lines. Use search_lean instead of grep.
```
