# TokenLean Suite 与 edimuj/tokenlean 深度对比分析

> 对比时间：2026-06-21
> 对比对象：本仓库 (`tohnee/tokenlean-suite`, 2 commits) vs `edimuj/tokenlean` (284 commits, v0.50.6)
> 分析角度：定位、架构、MCP 实现、Hook 机制、Token 节省策略、设计哲学

---

## 一、宏观定位

| 维度 | `tohnee/tokenlean-suite` | `edimuj/tokenlean` |
|---|---|---|
| **本质** | **架构框架** — 四层可叠加干预系统 | **工具包** — 60+ 单体 CLI 工具 + MCP 服务 |
| **目标用户** | 架构研究者、自己搭建 token 优化管线的开发者 | 即装即用的一人开发者、想立刻省 token 的 Claude Code 用户 |
| **分发方式** | Git clone + shell 脚本组装 | `npm i -g tokenlean` |
| **代码量** | ~60 文件（含文档、配置、测试） | ~120+ 文件（src 层 45+ 模块 + 57 bin CLI + 测试） |
| **提交数** | 2 commits | 284 commits |
| **版本** | ~0.1.0（早期） | v0.50.6（成熟） |
| **npm 生态** | 否，纯 git 分发 | 是，npm 包 + 可发布 |

**核心差异**：edimuj 是 npm 可安装的 **token-saving Swiss Army Knife**；本仓库是一个 **architecture blueprint + 参考实现**，面向需要深度定制干预策略的开发者。

---

## 二、目录结构与组件映射

### edimuj/tokenlean（单体 monorepo）

```
tokenlean/
├── bin/         # 57 个 tl-*.mjs CLI 入口 + 主入口 tl.mjs
├── src/         # 45+ 个核心模块（含完整测试 *.test.mjs）
├── skills/      # Claude Code + Codex CLI 的 SKILL.md（两平台副本）
├── docs/        # 配置、语言支持、工具列表、工作流
├── scripts/     # 基准脚本
└── package.json # 4 个依赖（@modelcontextprotocol/sdk, zod, typescript, node-html-markdown）
```

### 本仓库（分层 monorepo）

```
tokenlean-suite/
├── 01-workflow/          # 自定义 hooks + skills + commands（含完整测试）
│   ├── claude-code/      # Claude Code 专用 hooks/lib
│   ├── opencode/         # OpenCode 插件（ts 文件）
│   └── test/             # 35+63 测试
├── 02-mcp-server/        # 自定义 MCP 服务（零依赖）
│   ├── lib/core.mjs      # createCore → dispatch, tools, stats
│   ├── bin/stdio.mjs     # stdio 传输形态
│   ├── bin/http.mjs      # HTTP 传输形态（鉴权+会话）
│   └── test/             # 38 stdio + 26 http 断言
├── 03-rag-server/        # RAG MCP 服务（chatbot 场景）
│   ├── lib/rag-core.mjs  # createRagCore, 复用 04 的 assembler
│   ├── bin/http.mjs      # HTTP 传输（Bearer auth, session TTL）
│   └── test/             # 36 unit + 12 sim + 35 e2e
├── 04-prompt-assembler/  # 纯函数缓存感知拼装层
│   └── lib/assembler.mjs # planRag, normalizeRetrieved, assemble
├── 05-gateway-design/    # 网关代理设计（未实现）
├── install-stack.sh      # 全栈一键安装器
└── 多份 README/指南文档
```

组件关系：
- `04-prompt-assembler` → **被** `03-rag-server` **引用**（共享 `planRag`/`normalizeRetrieved`）
- `02-mcp-server` 与 `03-rag-server` **对等独立**，共享双传输设计模式
- `01-workflow` 与 `02-mcp-server` **互补**：workflow 拦截浪费行为，MCP 提供省 token 的工具

---

## 三、Token 节省策略对比

| 优化维度 | edimuj/tokenlean | 本仓库 |
|---|---|---|
| **基本策略** | **Awareness + Tools** — 让 agent 用更省 token 的工具替代原生操作 | **Intervention + Protocol** — 在 4 个独立干预层系统性地阻断浪费 |
| **工具数量** | 57 个 CLI 工具覆盖代码理解/分析/审计/安全 | 6 个 MCP 工具（读/编辑/搜索）+ 4 个 RAG 工具 |
| **OUTPUT 优化** | 无专用工具 | `fs_edit_hash` — hash 锚点编辑，省复述 token |
| **INPUT 优化** | 无专用工具（但 `audit` 能发现浪费） | `04-prompt-assembler` — 显式缓存布局设计 |
| **FUTURE 优化** | `tl run` 智能截断命令输出 | `bash-guard hook` 确定性拦截 + 命令改写 |
| **RAG 优化** | 不涉及 | `03-rag-server` — cache-aware RAG MCP |
| **Hooks** | 预定义规则（`tl-hook install`） | 完全自定义的 4 个 guard hook |

**关键差异**：edimuj 的策略是"给模型更好的工具，它会用更少 token"；本仓库的策略是"建立分层干预机制，在确定性层面让浪费不可能发生"。

---

## 四、MCP 实现深度对比

这是差异最大的层面。

| 对比项 | edimuj/tokenlean | 本仓库 |
|---|---|---|
| **MCP SDK** | 使用 `@modelcontextprotocol/sdk` | **零依赖**，手写 JSON-RPC dispatch |
| **工具注册** | `McpServer.tool(name, desc, schema, handler)` | `dispatch(msg)` 内 switch-case 路由 |
| **传输** | 仅 stdio | **双传输**：stdio + HTTP（Streamable HTTP） |
| **工具数量** | 57 个 | 6 个 MCP + 4 个 RAG |
| **工具执行** | 子进程 dispatch（`execFile → tl-*.mjs`） | 进程内纯函数（`core.dispatch` 直接返回） |
| **Input Schema** | Zod 验证 | 手动定义 schema 对象 |
| **鉴权** | 无（仅 stdio 本地使用） | HTTP 形态强制 Bearer token |
| **会话** | 无 | HTTP 形态有 session ID + TTL 清理 |
| **核心优势** | 开箱即用，57 个工具 | 零依赖，双形态，auth，session 隔离 |

### MCP 架构对比

**edimuj 的 MCP 架构（SDK + 子进程转发）：**

```
MCP Client (stdio)
    │
    ▼
@modelcontextprotocol/sdk  ← 外部依赖
    │
    ▼
mcp-tools.mjs
    │
    ▼  (execFile 调用)
tl-symbols.mjs  tl-run.mjs  tl-deps.mjs  ...  57 个子进程
```

每个工具调用 = 一个 Node 子进程的 fork 开销 + 4 个依赖包。

**本仓库的 MCP 架构（零依赖 + 进程内）：**

```
MCP Client (stdio 或 HTTP)
    │
    ▼
bin/stdio.mjs 或  bin/http.mjs  ← 薄传输层
    │
    ▼
lib/core.mjs: dispatch(msg)  ← 单进程，纯函数
    │
    ▼  (函数调用，零开销)
handleReadHashed(args)  handleEditHash(args)  ...
```

每个工具调用 = 一个函数调用，零外部依赖。

### 代码级别对比

**edimuj（SDK + 子进程）：**
```javascript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
const server = new McpServer({ name: 'tokenlean', version });
server.tool('tl_symbols', 'Get function/class signatures', schema,
  async (args) => {
    const { stdout } = await execFile('node', ['tl-symbols.mjs', ...args]);
    return { content: [{ type: 'text', text: stdout }] };
  }
);
```

**本仓库（零依赖 + 进程内）：**
```javascript
export function createCore({ root }) {
  function dispatch(msg) {
    switch (msg.method) {
      case 'tools/call': {
        const tool = tools.find(t => t.name === msg.params?.name);
        return tool.handler(msg.params.arguments);
      }
    }
  }
  return { dispatch, tools, stats };
}
```

---

## 五、Hook 机制对比

| 对比项 | edimuj/tokenlean `tl-hook` | 本仓库 hooks |
|---|---|---|
| **安装方式** | `tl-hook install claude-code` | `bash install-stack.sh` / 手动复制 |
| **Hook 来源** | 预定义在 `src/hook-policy.mjs` 中 | 完全自定义的 `.mjs` 文件 |
| **触发规则** | 硬编码（大文件→`tl-symbols`，测试→`tl-run`） | 高度可配置（3 模式：guard/auto/off） |
| **输出控制** | `nudge` 格式 — 简短建议 + 未来抑制 | 完整 ask/auto/off 3 模式 |
| **本质** | **Audit + 建议**（"你忘了用 tl-run"） | **Guard + 改写**（"我帮你截断并写出有界版本"） |
| **语言支持** | 仅 Claude Code | Claude Code + OpenCode 双平台 |

---

## 六、重复代码与功能重叠分析

两个仓库 **没有直接的重叠代码**，但有两个概念层面的概念相似点：

### 1. `tl-run` vs `bash-guard hook`

edimuj 的 `tl-run` 用 CLI 工具包裹命令，输出自动摘要。本仓库的 `bash-guard hook` 在 PreToolUse 阶段拦截无界命令。

| 对比 | edimuj `tl-run` | 本仓库 `bash-guard` |
|---|---|---|
| **调用方式** | 模型主动用 `tl-run "npm test"` | hook 自动拦截 `npm test` |
| **强制力** | 靠模型自觉 | guard 模式 → ask；auto 模式 → 强制改写 |
| **后处理** | 智能摘要（测试/构建/链接类型检测） | 截断 + bounded 改写建议 |
| **可互补** | ✅ 两者可同时运行 | ✅ 两者可同时运行 |

### 2. `tl-browse` vs `defuddle` skill

edimuj 的 `tl-browse` 用 `node-html-markdown` 抓取 URL 转文本。本仓库通过 `search_lean` MCP 工具 + defuddle skill 做类似工作。

---

## 七、设计哲学总结

```
edimuj/tokenlean（实用工具腰带）
  284 commits · v0.50.6 · npm install · 57 CLI + MCP tools
  策略: "给模型更好的工具，它会用更少 token"
  MCP: SDK-based · stdio only · subprocess dispatch
  Hooks: 预定义框架 · audit + suggest
  优势: 成熟，零配置，57 个工具即装即用

tohnee/tokenlean-suite（架构框架）
  2 commits · ~0.1.0 · git clone + bash install · 6+4 MCP tools
  策略: "建立分层干预：协议 + hooks + 拼装器"
  MCP: 零依赖 · stdio+HTTP 双形态 · 进程内 dispatch
  Hooks: 自定义 guard · guard/auto/off 3 模式
  优势: 深度架构，cache-aware RAG，hash 锚点编辑，HTTP auth+session
```

**两者不是竞争关系，而是不同抽象层的互补品。** edimuj 提供即装即用的工具（"给我一个钳子"），本仓库提供搭建自己工具管线的框架（"给你一套钳子+锤子+螺丝刀的图纸和制造机"）。用 `bash install-stack.sh` 全栈安装后，本仓库的 hooks 做强制干预，edimuj 的 `tl` 工具做补充意识 — 两者可以同时运行。

---

## 八、互相可借鉴之处

### 本仓库可以从 edimuj 借鉴

| 借鉴点 | 当前 | 建议方向 |
|---|---|---|
| **`tl audit` — token 消耗审计** | 无类似 CLI 工具 | 加一个 CLI 入口，基于 transcripts 分析实际 token 消耗 |
| **`tl-symbols` / `tl-snippet`** | 仅 MCP 工具有 `fs_outline`/`fs_read_hashed` | 包装为独立 CLI 入口，供非 MCP 场景使用 |
| **`tl-run` 智能摘要** | bash-guard 只拦截不做摘要 | auto 模式下可加算法摘要 |
| **npm 发布** | 纯 git 分发 | npm 包降低使用门槛 |
| **统一 help 格式** | 每个脚本自己实现 | 统一 help 生成器 |

### edimuj 可以从本仓库借鉴

| 借鉴点 | 当前 | 建议方向 |
|---|---|---|
| **session 隔离** | MCP 无 session 概念 | HTTP MCP 场景按用户隔离 stats |
| **RAG 缓存优化** | 不涉及 | 可整合 `normalizeRetrieved` 概念 |
| **零依赖核心** | 依赖 MCP SDK + zod | 核心 dispatch 可改为零依赖 |
| **HTTP MCP 传输** | 仅 stdio | 可加 `--http` 选项 |
| **双形态 core** | MCP 与 CLI 是两条独立路径 | 可复用 `createCore` + 薄传输层模式 |
