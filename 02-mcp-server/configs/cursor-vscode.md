# Cursor / Windsurf / VS Code Copilot 集成

## Cursor — `.cursor/mcp.json`(项目)或 `~/.cursor/mcp.json`(全局)

```json
{
  "mcpServers": {
    "tokenlean": {
      "command": "node",
      "args": ["/absolute/path/to/tokenlean-mcp/server.mjs", "--root", "${workspaceFolder}"]
    }
  }
}
```

## VS Code (GitHub Copilot agent mode) — `.vscode/mcp.json`

```json
{
  "servers": {
    "tokenlean": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/tokenlean-mcp/server.mjs", "--root", "${workspaceFolder}"]
    }
  }
}
```

## 引导规则(.cursorrules / copilot-instructions.md)

```
Multi-line edits MUST go through tokenlean tools:
fs_outline → fs_read_hashed (range) → fs_edit_hash.
Use search_lean instead of built-in grep for codebase search.
```
