# Claude Code 集成

## 1. 注册 MCP server(项目级 .mcp.json)

```json
{
  "mcpServers": {
    "tokenlean": {
      "command": "node",
      "args": ["/absolute/path/to/tokenlean-mcp/server.mjs", "--root", "."]
    }
  }
}
```

或用户级:`claude mcp add tokenlean -- node /path/to/server.mjs --root .`

## 2. 关键一步:用权限把原生 Edit 关掉(强制走 hash 编辑)

`.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["Edit", "MultiEdit", "Write(src/**)"],
    "allow": ["mcp__tokenlean__*"]
  }
}
```

没有这一步,模型经常会"忘记"用 MCP 工具而退回原生 Edit。
deny 原生编辑 + allow tokenlean = 工具契约从"建议"变成"强制"。

## 3. 验证

会话结束时让模型调用 `token_report`,查看本次会话节省的 OUTPUT tokens。
