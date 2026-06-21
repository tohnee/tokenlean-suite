# 本地运行指南：tokenlean 端到端验证

> 本文档演示如何在本地启动 tokenlean 并验证 token 节省效果。
> 覆盖 Coding Agent 场景（workflow + MCP）和 Chatbot/RAG 场景（RAG server）两类。

---

## 前置条件

```bash
# 检查 Node.js 版本（需要 >= 18）
node -v

# 检查 npm
npm -v

# 进入项目
cd /path/to/tokenlean-suite
```

---

## Part 1：快速启动

### 方式 A：Codint Agent 场景（workflow + MCP hooks）

```bash
# 安装 workflow hooks 到 Claude Code
bash install-stack.sh --only-tokenlean

# 验证 hooks 测试通过
cd 01-workflow && node test/test-hooks.mjs
# 预期: 35 passed, 0 failed

# 验证 skill 优化点（prompts-compressor + surgical-edits 扩展）
node test/test-skills.mjs
# 预期: 25 passed, 0 failed
```

安装后 hooks 自动生效，启动 Claude Code 即可：

```bash
rtk -- claude code
```

### 方式 B：Chatbot RAG 场景（HTTP MCP 服务）

```bash
# 一键启动 RAG 服务器（含三个项目的完整测试）
bash install-stack.sh --rag --start --port 8766

# 验证健康检查（无需 token）
curl http://127.0.0.1:8766/healthz
# 预期: {"ok":true,"sessions":0,"server":"tokenlean-rag","version":"0.1.0"}
```

### 方式 C：MCP 服务（通用 Coding Agent）

```bash
# 针对本地开发场景，启用 stdio 模式
cd 02-mcp-server && node bin/stdio.mjs --root .

# 针对远程协同场景，启用 HTTP 模式
TOKENLEAN_TOKEN=lean4demo node bin/http.mjs --port 8765 --token lean4demo
```

---

## Part 2：测试所有组件

```bash
# 01-workflow: 35 hook 断言 + 25 skill 断言 + 63 OpenCode 断言
cd 01-workflow && node test/test-hooks.mjs && node test/test-skills.mjs && node test/test-opencode-plugin.mjs

# 02-mcp-server: 38 stdio + 26 HTTP
cd 02-mcp-server && node test/test-stdio.mjs && node test/test-http.mjs

# 03-rag-server: 36 unit + 12 simulation + 35 HTTP E2E
cd 03-rag-server && node test/test-rag.mjs && node test/simulate-chatbot.mjs && TOKENLEAN_RAG_TOKEN=test node test/http-e2e.mjs

# 04-prompt-assembler: 28 断言
cd 04-prompt-assembler && node test/test-assembler.mjs && node test/test-ttl.mjs
```

---

## Part 3：验证 token 节省效果

### 3.1 输入压缩验证（prompts-compressor）

验证结构化格式比自然语言段落节省 40-70% token：

```bash
# 运行 skill 测试用例
cd 01-workflow && node test/test-skills.mjs
```

测试包含三个真实规模的模板对比：

| 模板类别 | 压缩前 | 压缩后 | 节省比例 |
|---|---|---|---|
| 角色定义（~3500 chars） | ~875 tok | ~300 tok | ≥50% |
| 代码审查指令 | ~480 tok | ~260 tok | ≥30% |
| Agent 工作流指令 | ~640 tok | ~320 tok | ≥30% |

### 3.2 输出约束验证（surgical-edits）

```bash
# 运行 hook 测试验证 write-guard 拦截大文件覆写
cd 01-workflow && node test/test-hooks.mjs --grep write-guard
```

效果：

| 场景 | 无约束 | 有约束 | 节省 |
|---|---|---|---|
| 覆写大文件（Write） | 复述全量文件（N tok） | Edit 仅改区域（~40-60% 更少） | ~40-95% |
| 分类任务 | 可能输出 300+ tok 段落 | max_tokens=50 | ~83% |
| 数据描述 | 自然语言段落 | JSON 结构化 | ~15-60% |
| 非实时任务 | 全价实时 API | Batch API 50% 折扣 | ~50% |

### 3.3 MCP 工具节省验证

```bash
cd 02-mcp-server && node test/bench-output.mjs
```

| 操作 | 原生工具 | MCP 工具 | 节省 |
|---|---|---|---|
| 大文件读取 | Read 全量 | `fs_outline` 探结构 + `fs_read_hashed` 分页 | ~90% INPUT |
| 代码搜索 | Bash grep（无界输出） | `search_lean`（硬上限 25 条/5KB） | ~95% FUTURE INPUT |
| 文件编辑 | Write 覆写 | `fs_edit_hash` 精确替换 | ~86% OUTPUT（vs Write） |

### 3.4 RAG 缓存命中验证

```bash
cd 03-rag-server && node test/http-e2e.mjs
```

缓存命中检测：
- Q1 首次搜索 → 全价（volatile tail）
- Q2 相同 chunk 集合（不同 score/rank/timestamp） → **归一化后字节相同 → tail 命中缓存**
- Q3 不同 chunk 集合 → 全价（正确行为）
- `token_report` 报告搜索次数和 re-ask cache hits

底层的 `simulate-chatbot.mjs` 还会做成本对比：

```bash
cd 03-rag-server && node test/simulate-chatbot.mjs
# 输出:
# Naive total cost (2 queries):      $0.7380
# Cache-aware cost (2 queries):      $0.6954
# Savings:                              6%
```

### 3.5 缓存规划验证

```bash
cd 04-prompt-assembler && node test/test-assembler.mjs
# 验证:
#   ✓ 稳定性排序（最稳的在最前）
#   ✓ 断点放置（稳定/易变接缝处）
#   ✓ 泄漏检测（捕获前缀中的时间戳/UUID）
#   ✓ 最小可缓存前缀警告（<1024 太短）
```

---

## Part 4：模拟真实对话流程

### 4.1 Coding Agent 会话

```bash
# 1. 启动 MCP server
cd 02-mcp-server && node bin/stdio.mjs --root /tmp/test-repo

# 2. 另开终端，模拟 5 轮对话（初始化 → 搜索 → 编辑 → 报告）
node test/test-stdio.mjs

# 3. 检查 stats
# token_report 工具显示: edits, rejected, relocated, savings 统计
```

### 4.2 Chatbot 会话

```bash
# 1. 启动 RAG server
bash install-stack.sh --rag --start --port 8767

# 2. HTTP E2E 测试模拟真实 chatbot 调用链
cd 03-rag-server && node test/http-e2e.mjs

# 3. 手动测试 MCP 协议
TOKEN=lean4demo

# Initialize
SESSION=$(curl -s -X POST http://127.0.0.1:8767/mcp \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' \
  | jq -r '.result.serverInfo.name') && echo "Session with: ${SESSION}"

# 获取 session-id（从响应头）
SID=$(curl -sI -X POST http://127.0.0.1:8767/mcp \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  | grep -i mcp-session-id | awk '{print $2}' | tr -d '\r') && echo "SID=${SID}"

# 调用 rag_search
curl -s -X POST http://127.0.0.1:8767/mcp \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: ${SID}" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"rag_search","arguments":{"query":"How do refunds work?","top_k":3,"results":[{"id":"d1","text":"Refunds take 5-7 business days.","score":0.95},{"id":"d2","text":"Contact support@example.com for refunds.","score":0.88}]}}}' \
  | jq '.result.content[0].text'
```

---

## Part 5：CLI 工具测试

验证 CLI 工具在 stdin MCP 协议下的行为：

```bash
# 模拟 Claude Code 发送 initialize 请求
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  | node bin/stdin-dispatch.mjs 2>/dev/null | head -5

# 模拟 tools/list 请求
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node bin/stdin-dispatch.mjs 2>/dev/null | jq '.result.tools[].name'
```

---

## Part 6：总体验证清单

```bash
# ── 全部测试通过
cd 01-workflow && node test/test-hooks.mjs          # 35/35
cd 01-workflow && node test/test-skills.mjs          # 25/25
cd 01-workflow && node test/test-opencode-plugin.mjs # 63/63
cd 02-mcp-server && node test/test-stdio.mjs        # 38/38
cd 02-mcp-server && node test/test-http.mjs          # 26/26
cd 03-rag-server && node test/test-rag.mjs           # 36/36
cd 03-rag-server && node test/simulate-chatbot.mjs   # 12/12
cd 03-rag-server && node test/http-e2e.mjs            # 35/35
cd 04-prompt-assembler && node test/test-assembler.mjs # 28/28

# ── 总计
echo "Total: 298 assertions"
```

---

## 预期结果摘要

| 测试组件 | 断言数 | 预期通过 | 节省验证内容 |
|---|---|---|---|
| 01-workflow hooks | 35 | ✓ | INPUT 缓存审计、OUTPUT write-guard、FUTURE bash-guard |
| 01-workflow skills | 25 | ✓ | 提示词压缩、输出约束、JSON 效率 |
| 01-workflow OpenCode | 63 | ✓ | OpenCode 插件 parity |
| 02-mcp-server stdio | 38 | ✓ | MCP 协议握手、hash 编辑、会话隔离 |
| 02-mcp-server http | 26 | ✓ | HTTP 传输、鉴权、CORS、IDEMPOTENT |
| 03-rag-server unit | 36 | ✓ | rag_search、kb_pin、headroom_retrieve、token_report |
| 03-rag-server sim | 12 | ✓ | re-ask 缓存命中检测、成本对比 |
| 03-rag-server e2e | 35 | ✓ | HTTP MCP 初始化、缓存命中、session 隔离 |
| 04-prompt-assembler | 28 | ✓ | 稳定性排序、断点放置、泄漏检测、TTL |
| **总计** | **298** | **✓** | |
