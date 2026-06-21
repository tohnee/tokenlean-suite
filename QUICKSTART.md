# TokenLean Suite — 快速上手

> 3 分钟跑通，不需要读任何文档。

---

## 安装

```bash
# 方式 A：npm 全局安装（推荐）
npm install -g tokenlean-suite

# 方式 B：从源码安装
git clone https://github.com/tohnee/tokenlean-suite.git
cd tokenlean-suite && npm install -g .
```

验证安装：

```bash
tl help
# 预期输出：可用命令列表
```

---

## CLI 命令速查

安装后获得 `tl` 命令，支持 8 个子命令：

| 命令 | 作用 | 示例 |
|---|---|---|
| `tl mcp stdio` | 启动 MCP 服务（本地 coding agent） | `tl mcp stdio --root .` |
| `tl mcp http` | 启动 MCP 服务（HTTP/Web copilot） | `tl mcp http --token secret --port 8765` |
| `tl rag http` | 启动 RAG 服务（chatbot） | `tl rag http --token secret --port 8766` |
| `tl audit` | 分析 token 消耗 | `tl audit --claudecode --savings` |
| `tl plan` | 分析缓存布局 | `tl plan --example` |
| `tl normalize` | 归一化 RAG chunk | `tl normalize results.json` |
| `tl symbols` | 代码结构预览 | `tl symbols src/` |
| `tl snippet` | 提取函数/类 | `tl snippet handleSubmit` |

---

## 场景一：Coding Agent（本地）

### 第 1 步：安装 workflow

```bash
cd your-project
bash path/to/tokenlean-suite/01-workflow/install.sh
```

这会在项目 `.claude/` 中安装 4 个 hooks 和 4 个 skills。自动运行自测。

### 第 2 步：配置 MCP server

创建 `.claude/settings.json`：

```json
{
  "mcpServers": {
    "tokenlean": {
      "command": "tl",
      "args": ["mcp", "stdio", "--root", "."]
    }
  }
}
```

### 第 3 步：启动

```bash
rtk -- claude code
# 或直接启动
claude code
```

现在 hooks 自动保护：大文件写入会拦截、无界命令会被改写。skill 引导模型用 Edit 而非 Write。

---

## 场景二：Chatbot + RAG（HTTP 服务）

### 第 1 步：启动 RAG 服务

```bash
# 启动（端口 8766，自动生成 token）
tl rag http --token $(openssl rand -hex 16) --port 8766
```

### 第 2 步：验证

```bash
curl http://127.0.0.1:8766/healthz
# {"ok":true,"sessions":0,"server":"tokenlean-rag","version":"0.1.0"}
```

### 第 3 步：配置 chatbot MCP

在 Claude.ai / ChatGPT 的 MCP Connector 中添加：

```json
{
  "mcpServers": {
    "tokenlean-rag": {
      "url": "https://your-tunnel-url/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

---

## 场景三：全栈安装（推荐）

```bash
# 克隆仓库
git clone https://github.com/tohnee/tokenlean-suite.git
cd tokenlean-suite

# 全量安装（workflow + MCP + rtk + RAG）
bash install-stack.sh --rag --start --port 8766
```

这一条命令完成：

| 步骤 | 做什么 | 验证方式 |
|---|---|---|
| ① Workflow | 复制 hooks + skills 到 `.claude/` | 运行 35+25 断言 |
| ② MCP server | 安装依赖，准备 stdio+http 双形态 | 运行 64 断言 |
| ③ rtk (可选) | 编译 CLI 输出压缩工具 | `rtk -- claude code` |
| ④ RAG server | 后台启动 HTTP 服务 + launchd 自启 | `curl /healthz` |
| ⑤ 测试 | 全部 298 断言验证 | 日志输出通过数 |

---

## 实测节省效果

基准测试（200 行文件改 5 行，10 轮会话）：

```
                          OUTPUT tokens    INPUT tokens    总成本（$15/MTok output）
  无 tokenlean:            18,960           1,090           $0.288
  有 tokenlean:             1,610             250           $0.025
  节省:                     -92%             -77%           -91%
```

月度估算（50 次会话/天 × 22 天）：

```
  无 tokenlean:  $316/月
  有 tokenlean:  $27/月
  节省:          $289/月（-91%）
```

---

## 目录结构

```
tokenlean-suite/
├── 01-workflow/         # hooks + skills（INPUT/OUTPUT/FUTURE 行为层）
│   ├── claude-code/     # Claude Code 专用配置
│   ├── opencode/        # OpenCode 插件
│   └── test/            # 123 断言（35+25+63）
├── 02-mcp-server/       # MCP 工具（OUTPUT 协议层，64 断言）
├── 03-rag-server/       # RAG 缓存优化（chatbot 场景，83 断言）
├── 04-prompt-assembler/ # 缓存感知拼装器（INPUT 层，28 断言）
├── bin/                 # CLI 入口（tl, tl-mcp, tl-rag 等）
├── install-stack.sh     # 全栈安装器
└── QUICKSTART.md        # ← 就在这里
```

---

## 下一步

| 参考 | 用途 |
|---|---|
| [DEPLOYMENT-GUIDE.md](file:///Users/tohnee/Trae/github/tokenlean/tokenlean-suite/DEPLOYMENT-GUIDE.md) | 完整部署与使用流程 |
| [INTEGRATION-GUIDE.md](file:///Users/tohnee/Trae/github/tokenlean/tokenlean-suite/INTEGRATION-GUIDE.md) | Coding Agent + Chatbot 接入参数 |
| [LOCAL-VERIFY.md](file:///Users/tohnee/Trae/github/tokenlean/tokenlean-suite/LOCAL-VERIFY.md) | 本地验证与基准测试 |
| [COMPARISON-REPORT.md](file:///Users/tohnee/Trae/github/tokenlean/tokenlean-suite/COMPARISON-REPORT.md) | 与 edimuj/tokenlean 架构对比 |
