# TokenLean Suite — 重构计划

> 基于 `COMPARISON-REPORT.md` 的分析结果，梳理可落地改进项，含 npm 发布方案。
> 计划分为 4 个阶段，每阶段独立见效、可随时停下来。

---

## 目录

- [阶段 0：现状评估](#阶段-0现状评估)
- [阶段 1：CLI 工具化（借鉴 `tl-symbols`/`tl-run`）](#阶段-1cli-工具化借鉴-tl-symbolstl-run)
- [阶段 2：npm 发布](#阶段-2npm-发布)
- [阶段 3：核心优化](#阶段-3核心优化)
- [阶段 4：长期可借鉴](#阶段-4长期可借鉴)
- [文件变更清单](#文件变更清单)

---

## 阶段 0：现状评估

### 当前优势（保持，不改）

- **零依赖核心** — `core.mjs` / `rag-core.mjs` / `assembler.mjs` 均零 npm 依赖，这比 edimuj 依赖 4 个包更轻量
- **双传输形态** — stdio + HTTP 双形态，edimuj 只有 stdio
- **HTTP auth + session** — Bearer token + session TTL，适合生产部署
- **cache-aware RAG** — edimuj 完全不涉及这个领域
- **hash 锚点编辑** — edimuj 无对应工具

### 当前缺失（可改进）

| 缺失项 | edimuj 对应 | 优先级 |
|---|---|---|
| **CLI 入口** — 不能 `npm i -g` 后直接 `tl xxx` | `tl.mjs` + 57 个入口 | P0 |
| **`tl audit`** — token 消耗审计 CLI | `tl audit --all --savings` | P0 |
| **`tl-symbols` 风格 CLI** — 代码结构预览 | `tl symbols` / `tl snippet` | P1 |
| **`tl-run` 智能摘要** — 命令输出摘要 | `tl run "npm test"` | P1 |
| **统一 help 格式** — 每个脚本自行处理参数解析 | `parseCommonArgs` + `COMMON_OPTIONS_HELP` | P2 |
| **npm 发布自动化** | `npm publish` | P0 |

---

## 阶段 1：CLI 工具化（P0-P1）

### 1.1 根目录统一入口 `tl.mjs`

创建 `/bin/tl.mjs` 作为单入口 CLI，仿照 edimuj 的 `tl` 命令模式，但只注册我们独有的工具：

```bash
tl help              # 列出所有命令
tl mcp               # 启动 MCP 服务
tl rag               # 启动 RAG 服务
tl assemble          # prompt 拼装分析
tl audit             # token 消耗审计
tl normalize         # normalizeRag 工具
tl plan              # planRag 工具
```

#### 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `bin/tl.mjs` | **新建** | 统一 CLI 入口，仿 edimuj 的 `tl.mjs` 模式 |
| `bin/tl-mcp.mjs` | **新建** | `tl mcp` — 启动 02-mcp-server（stdio 或 http） |
| `bin/tl-rag.mjs` | **新建** | `tl rag` — 启动 03-rag-server（http） |
| `bin/tl-audit.mjs` | **新建** | `tl audit` — token 消耗审计 |
| `bin/tl-plan.mjs` | **新建** | `tl plan` / `tl normalize` — prompt 拼装工具 |
| `package.json` | **修改** | 添加 `"bin"` 节，注册 `tl`、`tl-mcp`、`tl-rag` 等 |

#### `bin/tl.mjs` 设计

```javascript
#!/usr/bin/env node
const HELP = `
Usage: tl <command> [options]

Token-saving tools for AI agents.

Commands:
  mcp                 Start MCP server (stdio or http)
  rag                 Start RAG MCP server (http)
  audit               Analyze token usage from transcripts
  plan                Analyze cache-aware prompt layout
  normalize           Normalize RAG chunks by stable id
  help                Show this message

Examples:
  tl mcp stdio                                # Start MCP in stdio mode
  tl rag http --token secret --port 8766      # Start RAG server
  tl audit --claudecode                       # Audit Claude Code transcripts
`;
```

### 1.2 CLI `tl audit`（P0 — 高价值，低工作量）

从 `01-workflow/claude-code/lib/hit-rate.mjs` 抽取审计逻辑，封装为独立 CLI。

```bash
tl audit                          # 分析当前项目 .claude/transcripts
tl audit --claudecode             # 分析 Claude Code 会话 JSONL
tl audit --savings                # 估算 token 节省空间
tl audit --json                   # JSON 输出
```

**实现路径**：从 `01-workflow/claude-code/lib/hit-rate.mjs` 抽出核心逻辑，封装为 `bin/tl-audit.mjs`。该模块已有 `parseTranscripts`、`computeHitRate`、`estimateSavings` 等函数，只需添加 CLI 参数解析层。

#### 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `bin/tl-audit.mjs` | **新建** | CLI 入口，复用 `01-workflow` 的 hit-rate 和 cache-doctor 逻辑 |
| `01-workflow/claude-code/lib/hit-rate.mjs` | **修改** | 导出 `parseTranscripts`、`computeHitRate`、`estimateSavings` |
| `01-workflow/claude-code/lib/cache-doctor.mjs` | **修改** | 导出 `diagnosePrefix`、`scanVolatileContent` |

### 1.3 CLI `tl plan` / `tl normalize`（P1）

将 `04-prompt-assembler` 的 `planRag()`、`normalizeRetrieved()`、`assemble()` 包装为 CLI。

```bash
tl plan "system prompt" "kb index" "user question"    # 分析缓存布局
tl normalize results.json                              # 从 JSON 文件读取并归一化
```

#### 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `bin/tl-plan.mjs` | **新建** | 包装 `planRag()` 和 `assemble()` |
| `bin/tl-normalize.mjs` | **新建** | 包装 `normalizeRetrieved()` |

### 1.4 统一 Help 和参数解析（P2）

仿照 edimuj 的 `parseCommonArgs` + `COMMON_OPTIONS_HELP` 模式，新建共享参数解析模块。

```bash
# 所有工具默认支持：
-l N       Limit output lines
-t N       Limit output tokens
-j         JSON output
-q         Quiet mode
-h         Help
```

#### 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `lib/cli-args.mjs` | **新建** | 统一参数解析，仿 `parseCommonArgs` |
| `lib/cli-output.mjs` | **新建** | 统一输出格式（JSON/plain/quiet） |

---

## 阶段 2：npm 发布

### 2.1 根目录 `package.json`

当前项目没有根目录 `package.json`。需要创建一个来承载 npm 发布：

```json
{
  "name": "tokenlean-suite",
  "version": "0.1.0",
  "description": "Token-saving architecture framework: layered intervention for AI agents and chatbots. MCP + hooks + cache-aware RAG + prompt assembler.",
  "type": "module",
  "bin": {
    "tl": "bin/tl.mjs",
    "tl-mcp": "bin/tl-mcp.mjs",
    "tl-rag": "bin/tl-rag.mjs",
    "tl-audit": "bin/tl-audit.mjs",
    "tl-plan": "bin/tl-plan.mjs",
    "tl-normalize": "bin/tl-normalize.mjs"
  },
  "files": [
    "bin/*.mjs",
    "lib/*.mjs",
    "02-mcp-server/lib/*.mjs",
    "02-mcp-server/bin/*.mjs",
    "03-rag-server/lib/*.mjs",
    "03-rag-server/bin/*.mjs",
    "README.md",
    "DEPLOYMENT-GUIDE.md",
    "INTEGRATION-GUIDE.md",
    "STACK-README.md"
  ],
  "scripts": {
    "test": "cd 01-workflow && node test/test-hooks.mjs && cd ../02-mcp-server && npm test && cd ../03-rag-server && node test/http-e2e.mjs && cd ../04-prompt-assembler && node test/test-assembler.mjs"
  },
  "keywords": ["mcp", "token-optimization", "prefix-cache", "rag", "claude-code", "coding-agent", "token-saving"],
  "license": "MIT",
  "engines": {
    "node": ">=18.0.0"
  }
}
```

### 2.2 发布流程

```bash
# 1. 构建 CLI 入口
npm run build         # 如果需要编译（当前纯 JS 无需编译）

# 2. 测试
npm test              # 运行全部 4 个子项目测试

# 3. 发布
npm publish            # 发布到 npm registry

# 4. 安装验证
npm i -g tokenlean-suite
tl help
```

### 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `package.json` | **新建** | 根目录 package.json，定义 bin 入口和测试脚本 |
| `npmignore` 或 `package.json#files` | **新建** | 排除 `01-workflow/node_modules/`、测试文件、文档副本 |

### 2.3 CI/CD 建议

GitHub Actions 工作流（`.github/workflows/publish.yml`）：

```yaml
name: Publish to npm
on:
  push:
    tags: 'v*'
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', registry-url: 'https://registry.npmjs.org' }
      - run: npm test
      - run: npm publish
        env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }
```

#### 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `.github/workflows/publish.yml` | **新建** | npm 自动发布 CI |

---

## 阶段 3：核心优化

### 3.1 MCP 工具增加 Zod Schema 验证（可选）

当前 `core.mjs` 手动编写 `inputSchema`，可以引入 `zod` 做类型验证（但保持入口 dispatch 零依赖 — Zod 只用于 schema 描述，不用于运行时）。

```javascript
// 当前
const tools = [{
  name: 'fs_read_hashed',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, start: { type: 'integer' } },
    required: ['path'],
  },
}];

// 可选改进（增加 Zod 做类型推导，不增加运行时依赖）
const tools = [{
  name: 'fs_read_hashed',
  inputSchema: /** @type {const} */ ({
    type: 'object',
    properties: { path: { type: 'string' }, start: { type: 'integer' } },
    required: ['path'],
  }),
  // 在 MCP SDK 兼容层中可以用 Zod 做深度验证
}];
```

**注意**：是否引入 Zod 取决于 MCP 客户端是否需要完整的 JSON Schema 验证。当前手动 schema 已通过测试。此优化为 **P2**。

### 3.2 `tl-run` 风格智能摘要加入 `bash-guard`（P1）

当前 `bash-guard hook` 在 `auto` 模式只是截断输出。可以借鉴 `tl-run` 的算法，在截断后做智能摘要（识别测试/构建/链接输出类型，只保留错误行）。

#### 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `01-workflow/claude-code/lib/bash-lint.mjs` | **修改** | 添加输出摘要功能（detect 输出类型 → extract 关键行） |
| `01-workflow/claude-code/hooks/bash-guard.mjs` | **修改** | auto 模式启用输出摘要 |

### 3.3 `symbols` / `snippet` CLI（P1）

将 `02-mcp-server` 的 `fs_outline` 和 `fs_read_hashed` 的核心逻辑包装为独立 CLI，供非 MCP 场景使用。

#### 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `bin/tl-symbols.mjs` | **新建** | 输出文件结构签名（复用 `core.mjs` 的 outline 逻辑） |
| `bin/tl-snippet.mjs` | **新建** | 提取指定函数（复用 `core.mjs` 的 read 逻辑） |

---

## 阶段 4：长期可借鉴

### 4.1 `token-audit` MCP 工具（P2）

将 `01-workflow` 的 `cache-report` 和 `token-audit` 命令包装为 MCP 工具，让模型在会话中直接调用：

```json
{
  "name": "token_audit",
  "description": "Analyze token usage from session transcripts. Provides hit rate, dimension breakdown, and savings estimate.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "scope": { "type": "string", "enum": ["session", "project", "global"] }
    }
  }
}
```

### 4.2 子项目独立 npm 包（P2）

考虑将 `02-mcp-server`、`03-rag-server`、`04-prompt-assembler` 发布为独立 npm 包：

| 包名 | 内容 |
|------|------|
| `tokenlean-mcp` | MCP 服务核心（零依赖） |
| `tokenlean-rag` | RAG 缓存优化 MCP |
| `tokenlean-assembler` | 纯函数拼装器（零依赖） |
| `tokenlean-suite` | 聚合包（dependencies 引用以上 3 个） |

**何时做**：当有外部用户需要单独安装 `tokenlean-mcp`（不含 RAG）时再做。当前阶段先发聚合包。

---

## 文件变更总清单

### 新建文件

| 文件 | 阶段 | 优先级 |
|------|------|--------|
| `package.json` | 2 | P0 |
| `bin/tl.mjs` | 1 | P0 |
| `bin/tl-mcp.mjs` | 1 | P0 |
| `bin/tl-rag.mjs` | 1 | P0 |
| `bin/tl-audit.mjs` | 1 | P0 |
| `bin/tl-plan.mjs` | 1 | P1 |
| `bin/tl-normalize.mjs` | 1 | P1 |
| `bin/tl-symbols.mjs` | 3 | P1 |
| `bin/tl-snippet.mjs` | 3 | P1 |
| `lib/cli-args.mjs` | 1 | P2 |
| `lib/cli-output.mjs` | 1 | P2 |
| `.github/workflows/publish.yml` | 2 | P1 |

### 修改文件

| 文件 | 阶段 | 说明 |
|------|------|------|
| `01-workflow/claude-code/lib/hit-rate.mjs` | 1 | 导出核心函数供 CLI 使用 |
| `01-workflow/claude-code/lib/cache-doctor.mjs` | 1 | 导出核心函数供 CLI 使用 |
| `01-workflow/claude-code/lib/bash-lint.mjs` | 3 | 添加输出摘要逻辑 |
| `01-workflow/claude-code/hooks/bash-guard.mjs` | 3 | auto 模式启用摘要 |
| `README.md` | 2 | 增加 npm 安装说明 |
| `INDEX.md` | 2 | 更新总目录 |

### 不修改的文件

以下文件保持原有零依赖、零改动：

- `02-mcp-server/lib/core.mjs` — 核心 MCP dispatch（零依赖核心）
- `02-mcp-server/bin/stdio.mjs` / `bin/http.mjs` — 传输层
- `03-rag-server/lib/rag-core.mjs` — RAG 核心
- `04-prompt-assembler/lib/assembler.mjs` — 纯函数拼装器
- `install-stack.sh` — 安装脚本
- `.claude/hooks/*.mjs` — Claude Code 专属 hooks（保持与 bin/CLI 独立）

---

## 实施路线图

```
当前（0.1.0）                 阶段 1（0.2.0）         阶段 2（0.3.0）         阶段 3（0.4.0）
                                                      │
 git clone + install-stack.sh   CLI 入口                 npm 发布                智能摘要
                                 bin/tl.mjs              package.json            bash-lint 输出分析
 01-workflow/                    bin/tl-mcp.mjs           npm publish
 02-mcp-server/                  bin/tl-rag.mjs           GitHub Actions
 03-rag-server/                  bin/tl-audit.mjs                                   
 04-prompt-assembler/                                                             symbols/snippet CLI
```

每阶段的安装方式：
```
阶段 1:  git clone + bash install-stack.sh + npm link
阶段 2:  npm i -g tokenlean-suite
阶段 3:  npm i -g tokenlean-suite   （无变化）
```
