# TokenLean Suite — 专用接入指南

> 本文是面向开发者的**逐步接入手册**，覆盖 Coding Agent 和 Chatbot + RAG 两类场景。
> 每一步都包含具体配置参数、连接步骤和验证方法。

---

## 目录

- [A. Coding Agent 接入指南](#a-coding-agent-接入指南)
  - [A1. 前置条件](#a1-前置条件)
  - [A2. 一键安装](#a2-一键安装)
  - [A3. 配置 Claude Code MCP](#a3-配置-claude-code-mcp)
  - [A4. 配置 Hooks（自动生效）](#a4-配置-hooks自动生效)
  - [A5. 配置权限（强制走 MCP 编辑）](#a5-配置权限强制走-mcp-编辑)
  - [A6. 启动 rtk 包裹器](#a6-启动-rtk-包裹器)
  - [A7. 可用工具速查](#a7-可用工具速查)
  - [A8. 验证接入](#a8-验证接入)
- [B. Chatbot + RAG 接入指南](#b-chatbot--rag-接入指南)
  - [B1. 前置条件](#b1-前置条件)
  - [B2. 一键安装 + 自动启动](#b2-一键安装--自动启动)
  - [B3. 验证服务运行](#b3-验证服务运行)
  - [B4. 配置 Chatbot MCP 客户端](#b4-配置-chatbot-mcp-客户端)
  - [B5. rag_search 调用参数](#b5-rag_search-调用参数)
  - [B6. 缓存优化的 Prompt 布局](#b6-缓存优化的-prompt-布局)
  - [B7. 会话管理](#b7-会话管理)
  - [B8. 验证接入](#b8-验证接入)
  - [B9. 生产部署](#b9-生产部署)

---

## A. Coding Agent 接入指南

适用于 Claude Code、OpenCode、Cursor、Codex CLI 等 AI 编码工具。

### A1. 前置条件

| 依赖 | 最低版本 | 检查命令 |
|------|---------|---------|
| Node.js | >= 18 | `node -v` |
| npm | >= 9 | `npm -v` |
| Rust/Cargo（rtk 用） | >= 1.70 | `cargo --version` |
| Claude Code | 最新版 | `claude --version` |

### A2. 一键安装

```bash
# 进入项目目录
cd /path/to/tokenlean-suite

# 全栈安装（workflow + MCP + rtk + caveman）
bash install-stack.sh

# 或最小安装（仅 tokenlean 核心组件）
bash install-stack.sh --only-tokenlean

# 或全栈 + Headroom API 代理
bash install-stack.sh --with-headroom
```

安装脚本会自动：
1. 复制 workflow hooks 到 `~/.claude/` 并合并 `settings.json`
2. 安装 rtk（`cargo install rtk`）
3. 安装 caveman（`npm install -g caveman`）
4. 运行测试验证（35 断言 + 50 断言）

### A3. 配置 Claude Code MCP

在项目根目录创建或编辑 `.claude/settings.json`：

```json
{
  "mcpServers": {
    "tokenlean": {
      "command": "node",
      "args": [
        "/绝对路径/tokenlean-suite/02-mcp-server/tokenlean.mjs",
        "stdio",
        "--root", "."
      ]
    }
  }
}
```

**关键参数：**

| 参数 | 值 | 说明 |
|------|---|------|
| `command` | `node` | Node.js 运行时 |
| `args[0]` | MCP 入口脚本路径 | 必须用绝对路径 |
| `args[1]` | `stdio` | 传输方式（coding agent 用 stdio） |
| `--root` | `.` | 工作根目录（文件操作限制在此目录） |

### A4. 配置 Hooks（自动生效）

安装脚本会自动合并以下 hooks 到 `settings.json`。如需手动配置：

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "command": "node ~/.claude/hooks/bash-guard.mjs" },
      { "matcher": "Write", "command": "node ~/.claude/hooks/write-guard.mjs" }
    ],
    "SessionStart": [
      { "command": "node ~/.claude/hooks/session-start.mjs" }
    ],
    "PreCompact": [
      { "command": "node ~/.claude/hooks/precompact.mjs" }
    ]
  }
}
```

| Hook | 触发时机 | 作用 | 环境变量 |
|------|---------|------|---------|
| `bash-guard` | 执行 Bash 命令前 | 拦截无界输出（如 `cat huge.log`），建议 bounded 写法 | `TOKENLEAN_BASH_MODE=guard\|auto\|off` |
| `write-guard` | Write 工具调用前 | 提醒改用 Edit（省 OUTPUT token） | `TOKENLEAN_WRITE_MODE=guard\|warn\|off` |
| `session-start` | 会话启动 | 审计 CLAUDE.md 中的缓存破坏内容 | — |
| `precompact` | 上下文压缩前 | 指导保留决策/约束，丢弃噪声 | — |

### A5. 配置权限（强制走 MCP 编辑）

在 `settings.json` 中添加 `deny` 规则，强制模型使用 MCP 的 `fs_edit_hash` 而非原生 Write：

```json
{
  "permissions": {
    "deny": [
      "Write(src/**)",
      "Write(lib/**)"
    ]
  }
}
```

这样当模型尝试 Write 覆盖源码文件时会被拦截，引导其改用 `fs_edit_hash` 进行精确编辑。

### A6. 启动 rtk 包裹器

rtk 在 CLI 层面压缩命令输出，减少 FUTURE INPUT 维度的 token 堆积：

```bash
# 用 rtk 包裹 Claude Code 启动
rtk -- claude code

# 用 rtk 包裹 OpenCode
rtk -- opencode

# 用 rtk 包裹 Cursor CLI
rtk -- cursor
```

rtk 的工作方式：拦截子进程的 stdout/stderr，对超长输出做有损压缩（保留首尾 + 摘要），平均减少 80% 的命令输出 token。

### A7. 可用工具速查

MCP server 启动后，模型可调用以下工具：

| 工具 | 替代原生工具 | 关键参数 | 节省效果 |
|------|------------|---------|---------|
| `fs_read_hashed` | Read | `path`, `start?`, `limit?`, `hash?` | 硬分页 + hash 锚点，避免重复读 |
| `fs_outline` | Read（全量） | `path` | 只返回结构，减少 99% 读 token |
| `fs_edit_hash` | Edit / Write | `path`, `hash`, `old`, `new` | hash 锚点防错改 + 省 OUTPUT |
| `fs_multi_edit_hash` | 多次 Edit | `path`, `edits[]` | 一次调用多编辑，原子提交 |
| `search_lean` | Bash grep | `pattern`, `glob?`, `max?` | 硬结果上限，防海量输出 |
| `token_report` | — | — | 查看编辑节省统计 |

**`fs_edit_hash` 调用示例：**

```json
{
  "name": "fs_edit_hash",
  "arguments": {
    "path": "src/utils.ts",
    "hash": "a1b2c3d4",
    "old": "function oldName() {",
    "new": "function newName() {"
  }
}
```

`hash` 是文件内容的 SHA-256 前 8 位，作为安全锚点——如果文件在编辑期间被其他进程修改，hash 不匹配会立即报错，防止错误覆盖。

### A8. 验证接入

```bash
# 1. 验证 MCP server 运行
cd tokenlean-suite/02-mcp-server
node test/test-stdio.mjs
# 预期: 50 passed, 0 failed

# 2. 验证 workflow hooks
cd tokenlean-suite/01-workflow
node test/test-hooks.mjs
# 预期: 35 passed, 0 failed

# 3. 在 Claude Code 会话中验证
#    启动 claude code，输入:
#    /cache-report    → 查看缓存命中率
#    /lean-compact    → 手动触发精简压缩
```

---

## B. Chatbot + RAG 接入指南

适用于 Claude.ai Connector、ChatGPT GPT Actions、自建 chatbot 后端。

### B1. 前置条件

| 依赖 | 最低版本 | 检查命令 |
|------|---------|---------|
| Node.js | >= 18 | `node -v` |
| curl | 任意 | `curl --version` |
| openssl | 任意 | `openssl version` |

**不需要** npm 依赖、Rust、Cargo。03-rag-server 是纯 Node ESM，零依赖。

### B2. 一键安装 + 自动启动

```bash
cd /path/to/tokenlean-suite

# 自动构建 + 启动 + 生成开机自启服务
bash install-stack.sh --rag --start --port 8766
```

**`--start` 完成的 6 个步骤：**

| 步骤 | 说明 |
|------|------|
| 1. 构建验证 | 检查 Node >= 18，运行 36 断言测试套件 |
| 2. Token 生成 | `openssl rand -hex 16` 生成 32 字符 Bearer token |
| 3. 后台启动 | `nohup node bin/http.mjs` 拉起 HTTP 服务 |
| 4. 健康检查 | 轮询 `/healthz` 最多 5 秒，确认就绪 |
| 5. 服务单元 | macOS 生成 launchd plist / Linux 生成 systemd unit |
| 6. 输出配置 | 打印 MCP 客户端 JSON 配置 |

脚本输出示例：

```
  ✓ RAG server started (PID 80204), logging to /path/tokenlean-rag.log
  ✓ Health check passed (http://127.0.0.1:8766/healthz)
  ✓ launchd plist written: ~/Library/LaunchAgents/com.tokenlean.rag.plist

  ── Chatbot MCP config ──
  {
    "mcpServers": {
      "tokenlean-rag": {
        "url": "http://127.0.0.1:8766/mcp",
        "headers": { "Authorization": "Bearer a1b2c3d4e5f6..." }
      }
    }
  }

  Token saved in env: export TOKENLEAN_RAG_TOKEN=a1b2c3d4e5f6...
```

### B3. 验证服务运行

```bash
# 健康检查（无需 token）
curl http://127.0.0.1:8766/healthz

# 预期响应:
# {"ok":true,"sessions":0,"server":"tokenlean-rag","version":"0.1.0"}

# 查看 PID
cat tokenlean-rag.pid

# 查看日志
tail -f tokenlean-rag.log
```

### B4. 配置 Chatbot MCP 客户端

#### Claude.ai Connector

在 Claude.ai 的 Settings → Connectors 中添加：

```json
{
  "mcpServers": {
    "tokenlean-rag": {
      "url": "https://your-tunnel-url/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKENLEAN_RAG_TOKEN"
      }
    }
  }
}
```

> Claude.ai 要求 HTTPS URL。用 cloudflared 暴露本地服务：
> ```bash
> cloudflared tunnel --url http://127.0.0.1:8766
> ```

#### 自建 Chatbot（Node.js 示例）

```javascript
const RAG_URL = 'http://127.0.0.1:8766/mcp';
const RAG_TOKEN = process.env.TOKENLEAN_RAG_TOKEN;

// 1. 初始化 MCP 会话
const initRes = await fetch(RAG_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${RAG_TOKEN}`,
  },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'my-chatbot', version: '1.0.0' },
    },
  }),
});
const sessionId = initRes.headers.get('mcp-session-id');

// 2. 调用 rag_search（传入你的向量数据库检索结果）
const searchRes = await fetch(RAG_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${RAG_TOKEN}`,
    'mcp-session-id': sessionId,
  },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 2,
    method: 'tools/call',
    params: {
      name: 'rag_search',
      arguments: {
        query: userQuestion,
        top_k: 5,
        results: vectorDbResults.map(r => ({
          id: r.id,
          text: r.content,
          score: r.similarity,
        })),
      },
    },
  }),
});
const searchData = await searchRes.json();
const ragContext = searchData.result.content[0].text;

// 3. 拼装 prompt（参考 B6 布局）
const prompt = [
  { role: 'system', content: SYSTEM_PROMPT },           // 固定不变
  { role: 'system', content: KB_INDEX },                 // 日级别更新
  { role: 'user', content: ragContext + '\n\n' + userQuestion },
];

// 4. 调用 LLM API
const llmResponse = await callLLM(prompt);
```

#### Python 示例

```python
import requests, json, os

RAG_URL = "http://127.0.0.1:8766/mcp"
RAG_TOKEN = os.environ["TOKENLEAN_RAG_TOKEN"]
headers = {
    "Content-Type": "application/json",
    "Authorization": f"Bearer {RAG_TOKEN}",
}

# 1. 初始化
resp = requests.post(RAG_URL, headers=headers, json={
    "jsonrpc": "2.0", "id": 1,
    "method": "initialize",
    "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "py-bot", "version": "1.0"}},
})
session_id = resp.headers["mcp-session-id"]
headers["mcp-session-id"] = session_id

# 2. rag_search
resp = requests.post(RAG_URL, headers=headers, json={
    "jsonrpc": "2.0", "id": 2,
    "method": "tools/call",
    "params": {"name": "rag_search", "arguments": {
        "query": user_question,
        "top_k": 5,
        "results": [{"id": r["id"], "text": r["content"], "score": r["score"]} for r in vector_results],
    }},
})
rag_context = resp.json()["result"]["content"][0]["text"]
```

### B5. rag_search 调用参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 是 | — | 用户问题（用于元数据/统计，不做实际检索） |
| `top_k` | integer | 否 | 5 | 期望返回的 chunk 数量上限 |
| `results` | array | 否 | — | 外部检索结果，每项 `{id, text, score?}`。若省略则回退到 KB 热点文档 |

**`results` 数组每项结构：**

```typescript
{
  id: string,       // 必填 — chunk 的稳定唯一 ID（用于排序和去重）
  text: string,     // 必填 — chunk 文本内容
  score?: number,   // 可选 — 相似度分数（会被归一化剥离，不进入输出）
  rank?: number,    // 可选 — 排名（会被归一化剥离）
  timestamp?: string, // 可选 — 时间戳（会被归一化剥离）
}
```

**归一化处理：**

1. **按 id 排序** → 字节稳定的顺序（不按 score 排序，因为 score 每次不同）
2. **剥离元数据** → score/rank/timestamp 不出现在输出文本中
3. **按 id 去重** → 相同 id 的 chunk 只保留一条

### B6. 缓存优化的 Prompt 布局

这是 RAG 缓存优化的**核心**。正确的 prompt 布局决定缓存命中率：

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: System Prompt (STATIC)                         │  ← 永远不变
│   "You are a helpful assistant. Answer based on..."     │     被缓存（0.1x 计价）
├─────────────────────────────────────────────────────────┤
│ Layer 2: KB Index + Pinned Docs (SESSION)              │  ← 日级别更新
│   "KB INDEX: products, support, billing, API..."       │     被缓存
│   [pinned doc d42: Refunds are processed in...]        │
├──────── ── cache_control breakpoint ── ────────────────┤
│ Layer 3: rag_search Output (VOLATILE)                  │  ← 每次查询变化
│   [1] id:d17 Premium plan includes...                  │     全价计费
│   [2] id:d42 Refunds are processed in...               │
├─────────────────────────────────────────────────────────┤
│ Layer 4: User Message + History                         │  ← 每次变化
│   "What is the refund policy?"                          │     全价计价
└─────────────────────────────────────────────────────────┘
```

**关键规则：**
- Layer 1 + 2 占据 token 大头 → 放在 breakpoint 前 → 被缓存
- Layer 3 + 4 变化频繁 → 放在 breakpoint 后 → 全价
- Layer 3 虽然每次不同，但经 `normalizeRetrieved()` 归一化后，**相同 chunk 集合的输出字节相同** → re-ask 场景也能命中缓存

**代码实现（使用 04-prompt-assembler）：**

```javascript
import { planRag, normalizeRetrieved } from './04-prompt-assembler/lib/assembler.mjs';

// 归一化检索结果
const normalized = normalizeRetrieved(vectorDbResults);

// 规划缓存布局
const plan = planRag({
  system: SYSTEM_PROMPT,        // Layer 1
  kbIndex: KB_INDEX_TEXT,       // Layer 2
  pinnedDocs: pinnedChunks,     // Layer 2
  retrieved: normalized,        // Layer 3
  userMessage: userQuestion,    // Layer 4
});

// plan.breakpoints = [系统层末尾, KB层末尾]
// plan.segments = [...systemSegments, ...kbSegments, ...retrievedSegments, userSegment]
```

### B7. 会话管理

| 概念 | 说明 |
|------|------|
| Session ID | `initialize` 响应头 `mcp-session-id` 返回的 UUID |
| Session 隔离 | 每个 session 有独立的 stats 和 pinned docs，互不影响 |
| Session TTL | 默认 30 分钟无活动自动清理（`TOKENLEAN_SESSION_TTL_MS`） |
| Session 上限 | 默认 1000 个并发 session（`TOKENLEAN_SESSION_MAX`） |
| 默认 session | 未传 `mcp-session-id` 的请求共享 `__default__` session（不推荐） |

**最佳实践：** 每个 chatbot 用户分配一个独立 session（用用户 ID 作为 session 标识传入 initialize）。

**环境变量配置：**

```bash
# 会话超时（默认 30 分钟）
export TOKENLEAN_SESSION_TTL_MS=1800000

# 最大并发会话数（默认 1000）
export TOKENLEAN_SESSION_MAX=1000

# KB 索引文本（会进入缓存前缀）
export TOKENLEAN_KB_INDEX="产品文档, API参考, 支持文章, 计费FAQ"
```

### B8. 验证接入

```bash
# 1. HTTP 端到端测试（自动启动临时服务器，35 断言）
cd tokenlean-suite/03-rag-server
node test/http-e2e.mjs

# 预期输出:
#   Part 1: MCP initialize 握手 ✓
#   Part 3: rag_search 缓存命中验证 ✓
#     ✓ Q2 返回相同 chunk 集合
#     ✓ Q2 chunk 内容与 Q1 字节相同
#     ✓ Q2 触发 re-ask cache hit 标记
#   Part 8: session 隔离 ✓
#   通过: 35  失败: 0  总计: 35

# 2. 库级别模拟测试（12 断言，含成本对比）
node test/simulate-chatbot.mjs

# 预期输出:
#   Naive total cost (2 queries):           $0.7380
#   Cache-aware cost (2 queries):           $0.6954
#   Savings:                                 6%

# 3. 手动 curl 验证
TOKENLEAN_RAG_TOKEN=your_token_here

# 健康检查
curl http://127.0.0.1:8766/healthz

# MCP initialize
curl -X POST http://127.0.0.1:8766/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKENLEAN_RAG_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}'

# rag_search
curl -X POST http://127.0.0.1:8766/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKENLEAN_RAG_TOKEN" \
  -H "mcp-session-id: SESSION_ID_FROM_INIT" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"rag_search","arguments":{"query":"refund policy","top_k":3,"results":[{"id":"d1","text":"Refunds take 5-7 days","score":0.95}]}}}'
```

### B9. 生产部署

#### macOS（launchd 自启动）

```bash
# 安装脚本已自动生成 plist，启用自启动：
launchctl load ~/Library/LaunchAgents/com.tokenlean.rag.plist

# 停止自启动：
launchctl unload ~/Library/LaunchAgents/com.tokenlean.rag.plist
```

#### Linux（systemd user 自启动）

```bash
# 安装脚本已自动生成 unit 文件，启用：
systemctl --user daemon-reload
systemctl --user enable --now tokenlean-rag

# 查看状态：
systemctl --user status tokenlean-rag

# 停止：
systemctl --user disable --now tokenlean-rag
```

#### Docker 部署

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY 03-rag-server/ ./03-rag-server/
COPY 04-prompt-assembler/ ./04-prompt-assembler/
ENV TOKENLEAN_RAG_TOKEN=change-me
ENV TOKENLEAN_KB_INDEX="Your KB index"
EXPOSE 8766
CMD ["node", "03-rag-server/bin/http.mjs", "--port", "8766", "--host", "0.0.0.0"]
```

```bash
docker build -t tokenlean-rag .
docker run -d -p 8766:8766 \
  -e TOKENLEAN_RAG_TOKEN=$(openssl rand -hex 16) \
  -e TOKENLEAN_KB_INDEX="产品文档, API参考" \
  tokenlean-rag
```

#### 暴露到公网

| 方式 | 命令 | 适用场景 |
|------|------|---------|
| cloudflared | `cloudflared tunnel --url http://127.0.0.1:8766` | Claude.ai Connector（需 HTTPS） |
| ngrok | `ngrok http 8766` | 快速测试 |
| Nginx + TLS | Nginx 反向代理 + Let's Encrypt | 生产环境 |
| `--host 0.0.0.0` | 服务器启动时指定 | 配合防火墙 + TLS 使用 |

> **安全警告：** 暴露到公网时必须设置强 token（`openssl rand -hex 32`），并配合 TLS。

---

## 附录：完整启动参数

### install-stack.sh 参数

| 参数 | 说明 |
|------|------|
| `--rag` | 安装 RAG 服务器 |
| `--start` | 自动构建 + 启动 RAG 服务器（隐含 `--rag`） |
| `--port N` | RAG 服务器端口（默认 8766） |
| `--with-headroom` | 同时安装 Headroom API 代理 |
| `--no-rtk` | 跳过 rtk 安装 |
| `--no-caveman` | 跳过 caveman 安装 |
| `--only-tokenlean` | 仅安装 tokenlean 核心组件 |
| `--dest DIR` | 指定安装目标目录 |

### RAG 服务器环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TOKENLEAN_RAG_TOKEN` | — | Bearer 认证 token（**必填**） |
| `TOKENLEAN_KB_INDEX` | — | KB 索引描述文本（进入缓存前缀） |
| `TOKENLEAN_SESSION_TTL_MS` | 1800000 | Session 超时（毫秒） |
| `TOKENLEAN_SESSION_MAX` | 1000 | 最大并发 session 数 |
| `PORT` | 8766 | 端口（可被 `--port` 覆盖） |

### MCP 协议端点

| 端点 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/mcp` | POST | Bearer token | MCP JSON-RPC 请求 |
| `/mcp` | DELETE | Bearer token | 终止 session |
| `/healthz` | GET | 无 | 健康检查 |
