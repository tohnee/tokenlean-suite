# TokenLean Suite — 部署与使用流程

> 本项目针对两类用户场景提供 token 节省方案：**Coding Agent** 和 **Chatbot**。
> 两类场景的干预层、工具链、部署方式不同，但核心机制（INPUT/OUTPUT/FUTURE 三维度分解）共享同一套原理。

---

## 一、场景选择速查

| | Coding Agent | Chatbot + RAG |
|---|---|---|
| 典型客户端 | Claude Code, OpenCode, Cursor, Codex CLI | Claude.ai, ChatGPT, 自建 chatbot |
| 主要 token 开销 | 文件编辑输出 + 命令输出 + 历史上下文 | 知识库检索结果 + 长对话历史 |
| 优化维度优先级 | FUTURE > OUTPUT > INPUT | INPUT > FUTURE > OUTPUT |
| 本项目组件 | workflow + MCP server + rtk + caveman | RAG server + Headroom |
| 干预方式 | 本地 hooks + MCP 工具 | HTTP MCP 服务 + API 代理 |
| 安装命令 | `bash install-stack.sh` | `bash install-stack.sh --rag --start` |

---

## 快速开始

```bash
# ── Coding Agent 场景（Claude Code / OpenCode / Cursor）──
bash install-stack.sh
# 安装后：rtk -- claude code  即可开始使用

# ── Chatbot + RAG 场景（Claude.ai / ChatGPT / 自建）──
bash install-stack.sh --rag --start
# 安装后：服务自动启动，脚本会打印 MCP 配置 JSON，粘贴到 chatbot 即可

# ── 全栈（两类场景都要）──
bash install-stack.sh --rag --start --with-headroom
```

---

## 二、Coding Agent 场景

### 2.1 用户画像

你是使用 AI 辅助编码的开发者，工具是 Claude Code / OpenCode / Cursor 等。你的 token 账单大头来自：

- 模型重复输出你已经写好的代码（OUTPUT 维度）
- 大命令输出堆积在对话历史里重复计费（FUTURE INPUT 维度）
- 长会话中 CLAUDE.md 的前缀不稳定导致缓存 miss（INPUT 维度）

### 2.2 安装

```bash
# 一键安装全部 coding agent 优化
bash install-stack.sh

# 或最小安装（仅本项目的核心 workflow + MCP）
bash install-stack.sh --only-tokenlean
```

### 2.3 组件用法

#### Workflow（开箱即用，零配置）

安装后 hooks 自动生效，你只需正常使用 Claude Code：

| 机制 | 自动触发时机 | 作用 |
|---|---|---|
| `bash-guard hook` | 执行超大命令时 | 拦截无界输出，建议改写为 bounded 形式 |
| `write-guard hook` | Write 覆盖大文件时 | 提醒改用 Edit（更省 OUTPUT token） |
| `session-start hook` | 每次会话启动 | 审计 CLAUDE.md 中破坏缓存前缀的内容 |
| `precompact hook` | 上下文压缩前 | 指导模型保留决策/约束，丢弃噪声 |
| `prefix-stable skill` | 编辑 CLAUDE.md 时 | 避免写入时间戳/UUID 等破坏缓存的内容 |
| `surgical-edits skill` | 编辑代码时 | 引导使用 Edit 而非 Write |
| `lean-context skill` | 读文件/执行命令时 | 保持输出简洁 |

手动命令：

```
/cache-report     # 查看缓存命中率
/lean-compact     # 手动触发精简压缩
```

#### MCP Server（提供新工具）

在 Claude Code 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "tokenlean": {
      "command": "node",
      "args": ["/path/to/tokenlean-suite/02-mcp-server/tokenlean.mjs", "stdio", "--root", "."]
    }
  }
}
```

可用工具：

| 工具 | 替代 | 节省原因 |
|---|---|---|
| `fs_read_hashed` | 原生 Read | 硬分页 + hash 行锚点，只读需要的行 |
| `fs_outline` | 全量读文件 | 先看结构再读具体行，减少 99% 的读 token |
| `fs_edit_hash` | 原生 Edit/Write | hash 锚点防错改 + 弱模型省 OUTPUT token |
| `fs_multi_edit_hash` | 多次 Edit | 一次调用多编辑，原子提交 |
| `search_lean` | shell grep | 硬结果上限，防止海量输出进历史 |
| `token_report` | — | 监控编辑节省 |

#### 可选第三方工具

| 工具 | 安装 | 用途 |
|---|---|---|
| rtk | `cargo install rtk` | 包裹 agent 启动命令，自动压缩 CLI 输出（-80%） |
| caveman | `npm install -g caveman` | 模型输出改用精简电报风格（-65% 叙述 token） |
| Headroom | `npm install -g headroom` | API 代理层，自动稳定前缀 + 注入缓存断点 |

### 2.4 最佳实践

```
# 日常开发（最大化节省）
rtk -- claude code

# 配置抑制原生 Write 工具强制走 MCP 编辑
# 在 settings.json 中添加:
{"permissions":{"deny":["Write(src/**)"]}}

# 长会话（>50 turn）使用 /lean-compact 定期压缩
```

---

## 三、Chatbot + RAG 场景

### 3.1 用户画像

你运营一个 AI 聊天机器人，后端对接 Claude/GPT/DeepSeek，前端是 Claude.ai / ChatGPT / 自建 Web UI。你的 token 账单大头来自：

- 每次用户提问都检索知识库，检索结果嵌入前缀（INPUT 维度冠军杀手 — 100% 缓存 miss）
- 每次问答的 history 累积重复计费（FUTURE INPUT 维度）
- 对话历史中的工具输出堆积（FUTURE INPUT 维度）

### 3.2 RAG 缓存问题的根因（重要，必读）

```
朴素 RAG 的拼装结构（100% cache MISS）：

  [retrieved chunks with scores/timestamps]   ← 每次查询，这里完全不同
  [system prompt]
  [user message]

  → 前缀从字节 0 就不同，全程冷 miss，每次支付全价
```

```
Cache-aware 的拼装结构（前缀命中率 ~80%）：

  [system prompt]                               ← 固定不变
  [KB index + pinned hot docs]                  ← 日级别更新
  ── cache_control breakpoint ──
  [normalized retrieved chunks]                 ← 每次查询变化，但在断点之后
  [user message]

  → system + KB index 占 token 大头的部分被缓存（0.1x 计价）
  → 仅有检索 chunk 和用户消息走全价
```

### 3.3 安装

```bash
# 推荐：一键安装 + 自动构建 + 自动启动 + 生成开机自启服务
bash install-stack.sh --rag --start

# 指定端口
bash install-stack.sh --rag --start --port 9000

# 安装 RAG 服务器 + Headroom 代理（不自动启动）
bash install-stack.sh --rag --with-headroom

# 仅安装 RAG 服务器（手动启动）
bash install-stack.sh --rag
```

`--start` 做了什么：

1. **自动构建**：检查 Node ≥ 18（03-rag-server 零 npm 依赖，无需 `npm install`），运行测试套件（36 断言）
2. **自动生成 token**：若环境变量 `TOKENLEAN_RAG_TOKEN` 未设置，用 `openssl rand -hex 16` 生成
3. **后台启动**：`nohup` 拉起 HTTP 服务，写入 PID 文件和日志文件
4. **健康检查**：轮询 `/healthz` 端点，确认服务就绪
5. **生成服务单元**：macOS 生成 launchd plist，Linux 生成 systemd user unit，实现崩溃自重启
6. **输出 MCP 配置**：打印可直接粘贴到 chatbot MCP 客户端的 JSON 配置

### 3.4 启动 RAG MCP 服务器

#### 方式一：自动启动（推荐）

```bash
# 自动构建 + 启动 + 生成服务单元 + 输出 MCP 配置
bash install-stack.sh --rag --start --port 8766
```

脚本会自动完成 token 生成、后台启动、健康检查、服务单元生成。启动后你会看到：

- PID 文件：`tokenlean-rag.pid`
- 日志文件：`tokenlean-rag.log`
- macOS 服务单元：`~/Library/LaunchAgents/com.tokenlean.rag.plist`
- Linux 服务单元：`~/.config/systemd/user/tokenlean-rag.service`

管理服务：

```bash
# macOS (launchd)
launchctl load   ~/Library/LaunchAgents/com.tokenlean.rag.plist   # 开机自启
launchctl unload ~/Library/LaunchAgents/com.tokenlean.rag.plist   # 停止自启

# Linux (systemd user)
systemctl --user daemon-reload
systemctl --user enable --now tokenlean-rag   # 开机自启 + 立即启动
systemctl --user disable --now tokenlean-rag  # 停止 + 取消自启

# 手动停止后台进程
kill $(cat tokenlean-rag.pid)
```

#### 方式二：手动启动

```bash
# 1. 生成一个 token
export TOKENLEAN_RAG_TOKEN=$(openssl rand -hex 16)

# 2. 启动服务（默认端口 8766）
node /path/to/tokenlean-suite/03-rag-server/bin/http.mjs \
  --token $TOKENLEAN_RAG_TOKEN \
  --port 8766 \
  --kb-index "Your KB name: product docs, API reference, support articles."

# 3. （可选）用 cloudflared 暴露给 Claude.ai / ChatGPT
cloudflared tunnel --url http://127.0.0.1:8766
```

### 3.5 配置 Chatbot MCP 客户端

**Claude.ai Connector**：

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

**自建 Chatbot**：

```javascript
// 调用 rag_search 工具
const response = await fetch('http://localhost:8766/mcp', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_TOKENLEAN_RAG_TOKEN',
    'Content-Type': 'application/json',
    'mcp-session-id': 'user-session-123'
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'rag_search',
      arguments: {
        query: '用户的问题',
        top_k: 5,
        results: [
          // 来自你的向量数据库的检索结果
          { id: 'doc_1', text: '匹配的文档内容...', score: 0.93 },
          { id: 'doc_2', text: '另一条匹配内容...', score: 0.81 }
        ]
      }
    }
  })
});
```

### 3.6 工具清单

| 工具 | 用途 | 调用时机 |
|---|---|---|
| `rag_search` | 传入检索结果，返回归一化缓存友好的输出 | 每次用户提问 |
| `kb_pin` | 钉住热点知识文档到缓存前缀 | 会话初始化时 |
| `headroom_retrieve` | CCR 按需取回完整 chunk 全文 | 模型需要更多细节时 |
| `token_report` | 查看缓存优化统计 | 会话结束 |

### 3.7 缓存优化验证

```bash
# 运行模拟测试，验证缓存命中逻辑
node tokenlean-suite/03-rag-server/test/simulate-chatbot.mjs

# 输出示例:
#   ✓ naive: prefix CHANGES between queries           ← 朴素方式 100% miss
#   ✓ rag_search detects re-ask (same chunk set)       ← 归一化后检测到重问
#   ✓ normalized chunk content is byte-identical       ← 尾部字节稳定
#   ✓ cache-aware Q2 prefix tokens billed at 0.1x      ← 缓存命中变便宜
```

### 3.8 与 Headroom 配合

如果安装了 Headroom（`--with-headroom`），建议将 `tokenlean-rag` 放在 Headroom 代理之后：

```
Chatbot → Headroom (CacheAligner + SmartCrusher) → tokenlean-rag → Vector DB
```

此时 Headroom 负责：
- **CacheAligner**：自动检测并修复 system prompt 中的时间戳/UUID
- **SmartCrusher**：压缩检索结果中的 JSON 元数据
- **CCR**：对 RAG chunk 做可逆压缩，模型按需取回全文

---

## 四、叠加架构总览

```
                        TokenLean Suite
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   Coding Agent            Chatbot              两条线共享
        │                     │                     │
   ┌────┴─────┐         ┌────┴─────┐          ┌────┴─────┐
   │ Workflow │         │ RAG MCP │          │ Prompt   │
   │ L3-L4    │         │ L1-L2   │          │ Assembler│
   │ hooks +  │         │ rag_    │          │ 纯函数库 │
   │ skills   │         │ search  │          │ planRag  │
   └────┬─────┘         │ kb_pin  │          │ normalize│
        │               └────┬─────┘          └────┬─────┘
   ┌────┴─────┐              │                     │
   │ MCP Serv │              │   ┌─────────────────┘
   │ L2       │              │   │ (被两个场景复用)
   │ hash 编辑│              │   │
   └────┬─────┘              │   │
        │                    │   │
   ┌────┴────────────────────┴───┴─────────┐
   │        可选的第三方集成                  │
   │  rtk (CLI 压缩)  /  caveman (叙述精简)   │
   │  Headroom (API 代理 / CCR)              │
   └─────────────────────────────────────────┘
```

---

## 五、维护与监控

### 5.1 日常检查

```bash
# Coding Agent：检查缓存命中
/cache-report   # 在 Claude Code 会话中执行

# Chatbot：检查 RAG 优化效果
node bin/http.mjs --health   # GET /healthz 端点
```

### 5.2 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TOKENLEAN_BASH_MODE` | `guard` | bash-guard 模式（guard/auto/off） |
| `TOKENLEAN_WRITE_MODE` | `guard` | write-guard 模式（guard/warn/off） |
| `TOKENLEAN_RAG_TOKEN` | — | RAG MCP 服务器 Bearer token（必填） |
| `TOKENLEAN_KB_INDEX` | — | 知识库索引描述文本 |
| `TOKENLEAN_SESSION_TTL_MS` | 1800000 (30min) | RAG 会话超时时间 |

### 5.3 更新升级

```bash
# 重新运行安装脚本即可更新
git pull origin main

# 仅更新本项目 coding agent 组件
bash install-stack.sh --only-tokenlean

# 更新 RAG 服务器并重启
bash install-stack.sh --rag --start
# （脚本会自动杀掉旧进程、重新构建测试、启动新版本）
```

### 5.4 卸载 RAG 服务

```bash
# 停止后台进程
kill $(cat tokenlean-rag.pid) 2>/dev/null

# macOS：移除 launchd 自启
launchctl unload ~/Library/LaunchAgents/com.tokenlean.rag.plist 2>/dev/null
rm ~/Library/LaunchAgents/com.tokenlean.rag.plist

# Linux：移除 systemd 自启
systemctl --user disable --now tokenlean-rag 2>/dev/null
rm ~/.config/systemd/user/tokenlean-rag.service

# 清理运行时文件
rm -f tokenlean-rag.pid tokenlean-rag.log
```

---

## 六、常见问题

### Q: Coding Agent 的 hooks 不生效？

确保你有 `.claude/settings.json` 或已手动合并 `settings.snippet.json`。运行 `install.sh` 时会自动提示。

### Q: chatbot RAG 的缓存命中率如何查看？

`token_report` 工具会返回 re-ask cache hits 统计。真正的 provider 级别命中率需要查看 provider 的 API 响应头 (`x- Anthropic-cache-hit` 或 OpenAI 的 `cached_tokens`)。

### Q: 同时使用 Headroom 和 tokenlean-rag 会冲突吗？

不会。Headroom 是 API 代理层（改请求的 cache_control 标记），tokenlean-rag 是 MCP 工具层（改 prompt 的拼装内容）。两者作用于不同层面，可以叠加使用。

### Q: 朴素 RAG 改成 cache-aware 后，信息有损失吗？

**完全没有损失**。`normalizeRetrieved()` 只是改变了内容的**顺序**（id 排序而非 score 排序）并去掉了**元数据**（score/rank/timestamp）。发给模型的字节数和信息量与修改前完全一样，只是前缀变稳定了。这就是"省 token 但不是压缩"——同样的字节，不同的顺序，十几倍的差价。

### Q: 存储所有测试结果

所有测试结果文件：
- `TEST-REPORT.md` — 完整测试报告（147 断言，0 失败）
- `03-rag-server/test/test-rag.mjs` — RAG 服务器协议测试（36 断言）
- `03-rag-server/test/simulate-chatbot.mjs` — Chatbot 缓存命中模拟测试（12 断言）
