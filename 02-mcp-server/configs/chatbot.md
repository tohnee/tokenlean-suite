# Chatbot(Claude.ai / 任意支持 MCP 的对话端)集成

stdio server 需要包一层 HTTP/SSE 才能被远程 chatbot 使用。
最简单方式是 supergateway(零代码):

```bash
npx -y supergateway --stdio "node /path/to/server.mjs --root /path/to/workspace" --port 8765
```

然后在 Claude.ai → Settings → Connectors 添加 `http://your-host:8765/sse`。

安全提示:server 自带 workspace 沙箱(--root 之外的路径一律拒绝),
但暴露到公网前仍应加鉴权层。
