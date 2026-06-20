# OpenCode 集成

`opencode.json`(项目根)或全局配置:

```json
{
  "mcp": {
    "tokenlean": {
      "type": "local",
      "command": ["node", "/absolute/path/to/tokenlean-mcp/server.mjs", "--root", "."],
      "enabled": true
    }
  },
  "permission": {
    "edit": "deny"
  }
}
```

`permission.edit: deny` 禁用 OpenCode 原生编辑工具,
agent 将自然回落到 tokenlean 的 fs_edit_hash。
