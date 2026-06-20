# tokenlean-mcp 完整方案设计文档

> **一句话**:一个零依赖单文件 MCP 服务,把"省 token"从"求模型自觉"变成"工具契约强制",可同时以**本地 CLI 形态**和**网页端 copilot 形态**部署到任意支持 MCP 的客户端。
>
> **版本**:0.2.0 · 双传输架构 · 64/64 测试通过(stdio 38 + http 26)
> **运行要求**:Node ≥ 18,无 npm 依赖。

---

## 0. 文档导航

| 你想要 | 看哪一节 |
|---|---|
| 整体方案在解决什么、怎么解决 | Part 1 - 2 |
| 架构与代码组织 | Part 3 |
| **本地 CLI vs 网页端 copilot 的区别**(核心问题) | **Part 4** |
| 直接抄的部署步骤(逐个 agent) | Part 5 |
| 工具清单与协议 | Part 6 |
| 安全模型 | Part 7 |
| 验证结果与节省数据 | Part 8 |
| 文件清单 | 附录 |

---

## Part 1:问题与设计目标

### 1.1 三个 Token 维度

Coding agent 的账单由三个独立维度构成,必须分开优化:

| 维度 | 含义 | 本方案能否在工具层解决 |
|---|---|---|
| **OUTPUT** | 模型本轮生成的 token(尤其是文件编辑时复述 old_str) | ✅ hash 锚点编辑,-40~55% |
| **FUTURE INPUT** | 大工具输出进入历史后,在后续每一轮被重复计费 | ✅ 工具内置硬预算,-50~80% |
| **INPUT** | 当轮输入(prefix cache 命中决定其单价) | ❌ MCP 层够不到,需网关代理(Part 9) |

### 1.2 为什么不是 Skill

上一版用 Claude 的 SKILL.md + bash 脚本,有四个结构性缺陷:

1. **载体不通用** — SKILL.md 是 Anthropic 专有格式,Cursor/Copilot/Codex 各有方言
2. **执行靠自觉** — skill 只能"建议"模型用某脚本,模型会忘
3. **不在工具协议内** — bash 输出是无结构文本,heredoc 传参易被转义坑
4. **不可观测** — 无法统计省了多少

### 1.3 设计目标(本方案)

- **通用**:一份代码,跑在所有 MCP 客户端(Claude Code / OpenCode / Codex CLI / Cursor / Windsurf / VS Code Copilot / Claude.ai 等)
- **强制**:配合权限 deny 原生编辑工具,使 hash 编辑调用率 ≈ 100%,而非靠提示
- **零依赖**:单进程、无 node_modules,复制即部署
- **双形态**:同一套核心逻辑,既能被本地 agent spawn(stdio),也能作为网络服务给网页端 copilot(http)

---

## Part 2:核心思路 —— 从"建议模型"到"工具契约"

关键转变:**把 token 纪律做进工具实现本身**。

举例,"读大文件前应分页"这条纪律:

```
旧版(skill 建议):
  SKILL.md 写"读大文件请先 wc -l,超 200 行用分页"
  → 模型可以遵守,也可以无视

新版(工具契约):
  fs_read_hashed 收到无范围的大文件请求
  → 服务端强制截断到 200 行,附带"建议先 fs_outline"的提示
  → 模型物理上拿不到 17500 token 的全量输出
```

FUTURE INPUT 的膨胀源头被工具直接堵死,与模型自觉无关。OUTPUT 维度同理:`fs_edit_hash` 用 `line:hash` 锚点替代 `old_str`,模型想复述原文也没有那个字段可填。

---

## Part 3:架构

### 3.1 三层分离(这是双形态的关键)

```
        ┌─────────────────────────────────────────────┐
        │  lib/core.mjs   —— 纯逻辑,传输无关            │
        │  createCore({root, readOnly})                │
        │    → { dispatch(msg), tools, stats }          │
        │  6 个工具 + MCP JSON-RPC dispatch             │
        │  不碰 stdin/网络,只接收 message、返回 result   │
        └───────────────┬──────────────┬───────────────┘
                        │              │
          ┌─────────────▼───┐    ┌─────▼──────────────┐
          │ bin/stdio.mjs   │    │ bin/http.mjs       │
          │ 本地 CLI 传输    │    │ 网页端传输          │
          │ readline stdin  │    │ node:http + 鉴权    │
          │ → core.dispatch │    │ + 会话 → dispatch   │
          └─────────────────┘    └────────────────────┘
                  ▲                       ▲
            agent spawn 子进程       网页 copilot HTTP 连接
```

**为什么这样分**:省 token 的逻辑(工具实现)只写一次,放在 `core.mjs`。两种使用形态只是"消息怎么进来、结果怎么出去"的差异,各写一个薄传输层。新增一种传输(比如 WebSocket)也只需再写一个 `bin/*.mjs`,核心零改动。

### 3.2 文件组织

```
tokenlean-mcp/
├── lib/core.mjs          # 纯逻辑:6 工具 + dispatch(405 行)
├── bin/
│   ├── stdio.mjs         # 本地 CLI 传输(~45 行)
│   └── http.mjs          # 网页端传输 + 鉴权 + 会话(~140 行)
├── tokenlean.mjs         # 统一启动器:tokenlean stdio|http|test
├── server.mjs            # 向后兼容 shim(= 旧的 node server.mjs)
├── install.sh            # 环境检查 + 自测 + 可选软链
├── test/
│   ├── test-stdio.mjs    # 本地形态协议测试(38 断言)
│   └── test-http.mjs     # 网页形态测试(26 断言)
├── configs/              # 逐客户端集成配置
│   ├── claude-code.md  opencode.md  codex-cli.md
│   ├── cursor-vscode.md  chatbot.md
└── README.md
```

---

## Part 4:两种使用形态的本质区别 ★

这是整个方案最需要讲清的部分。两种形态的差异**不在功能,在传输层与信任边界**——功能(6 个工具、省 token 行为)完全一致,因为它们共享同一个 `core.mjs`。

### 4.1 一张表看懂

| | **本地 CLI 形态**(stdio) | **网页端 copilot 形态**(http) |
|---|---|---|
| 适用客户端 | Claude Code, OpenCode, Codex CLI, Cursor, Windsurf, VS Code Copilot | Claude.ai 连接器, ChatGPT, 自建 chatbot |
| 启动方式 | **agent 自动 spawn** 子进程 | **你手动**启一个常驻网络服务 |
| 传输协议 | stdio(stdin/stdout 上的 NDJSON JSON-RPC) | HTTP(MCP Streamable HTTP,`POST /mcp`) |
| 进程生命周期 | 每个 agent 会话起一个,会话结束即退 | 长期常驻,服务多个请求/会话 |
| **文件在哪** | **你的本机**(agent、服务、代码同一台机器) | **服务进程所在的机器**(VPS / 容器 / 通过隧道暴露的本机) |
| 信任边界 | 操作系统进程边界,`--root` 是沙箱 | 网络边界,**必须** Bearer token + `--root` 沙箱 |
| 鉴权 | 无需(本地进程) | **强制**(无 token 拒绝启动) |
| 会话管理 | 无(一进程一会话) | 有(`mcp-session-id`,每会话独立 core) |
| 网络暴露 | 不监听任何端口 | 监听端口;默认绑 127.0.0.1,公网需隧道/TLS |
| 典型命令 | `tokenlean stdio --root .` | `TOKENLEAN_TOKEN=xxx tokenlean http --root /srv/repo` |

### 4.2 为什么文件位置是最大的概念差异

这是最容易搞混的点:

**本地 CLI 形态** —— agent、MCP 服务、你的代码仓库,三者在同一台机器上。agent 把服务当子进程拉起,服务直接读写本地磁盘。`fs_edit_hash` 改的就是你眼前编辑器里的文件。

```
你的笔记本
┌────────────────────────────────────┐
│  Claude Code ──spawn──▶ stdio.mjs   │
│       │                    │        │
│       └── stdin/stdout ─────┘        │
│                            │        │
│                     ~/myrepo/*.ts    │  ← 直接读写
└────────────────────────────────────┘
```

**网页端 copilot 形态** —— 浏览器里的 Claude.ai 不可能直接 spawn 你笔记本上的进程。所以服务必须跑成一个**网络可达的常驻服务**,代码必须在**那个服务能访问到的地方**。两种常见拓扑:

```
拓扑 A:服务跑在远程主机(VPS/容器)
┌──────────┐   HTTPS    ┌──────────────────────────┐
│ Claude.ai│ ─────────▶ │ VPS                       │
│ (浏览器)  │  Bearer   │  http.mjs :8765           │
└──────────┘   token    │     │                     │
                        │  /srv/repo/*.ts  ← 读写    │
                        └──────────────────────────┘

拓扑 B:服务跑在你本机,通过隧道暴露
┌──────────┐  HTTPS  ┌─────────────┐   ┌──────────────────┐
│ Claude.ai│ ──────▶ │ cloudflared │──▶│ 你的本机          │
│          │         │   隧道       │   │  http.mjs :8765   │
└──────────┘         └─────────────┘   │  ~/myrepo/*.ts    │
                                       └──────────────────┘
```

拓扑 B 让网页端 copilot 也能操作你本机的代码,但代价是要开隧道并妥善保管 token。

### 4.3 安全后果(为什么 http 形态强制鉴权)

本地 stdio 形态没有网络面,操作系统的进程隔离就是边界,无需鉴权。

网页 http 形态一旦监听端口,任何能访问该端口的人都能读写 `--root` 下的代码。因此:

- **无 token 直接拒绝启动**(`http.mjs` 里硬编码:没有 `--token`/`TOKENLEAN_TOKEN` 就 `exit(2)`)
- 每个请求校验 `Authorization: Bearer <token>`,失败返回 401
- 默认绑 `127.0.0.1`(只能本机访问),要公网必须显式 `--host 0.0.0.0` 并自行加 TLS
- 强烈建议网页端配 `--read-only`:只暴露读/搜/outline,不暴露编辑,适合代码问答类 chatbot

### 4.4 怎么选

```
你用的是命令行 / IDE 里的 coding agent?
  (Claude Code, Cursor, OpenCode, Codex, Copilot)
  → 本地 CLI 形态(stdio)。agent 配置里填一行 command 即可。

你用的是浏览器里的 Claude.ai / ChatGPT / 自建网页 chatbot?
  → 网页端形态(http)。自己起服务 + 鉴权 + (隧道)。
     只读问答场景加 --read-only。
```

两种可以并存:同一台机器上,本地 agent 用 stdio,同时跑一个 http 实例给网页端用,互不干扰(各自独立进程、独立 core)。

---

## Part 5:部署步骤(可直接抄)

### 5.0 安装(两种形态通用)

```bash
# 解压后进入目录
cd tokenlean-mcp
bash install.sh            # 检查 Node、跑双传输自测
bash install.sh --link     # 额外:软链到 /usr/local/bin/tokenlean(可选)
```

零依赖,install 实质只是环境检查 + 自测。

### 5.1 本地 CLI 形态

#### Claude Code

项目根 `.mcp.json`:

```json
{
  "mcpServers": {
    "tokenlean": {
      "command": "node",
      "args": ["/abs/path/to/tokenlean-mcp/tokenlean.mjs", "stdio", "--root", "."]
    }
  }
}
```

**关键一步**(把契约从"建议"变"强制")—— `.claude/settings.json` 禁用原生编辑:

```json
{
  "permissions": {
    "deny": ["Edit", "MultiEdit", "Write(src/**)"],
    "allow": ["mcp__tokenlean__*"]
  }
}
```

没有这步,模型有时会退回原生 Edit;deny 之后只剩 hash 编辑一条路。

#### OpenCode

`opencode.json`:

```json
{
  "mcp": {
    "tokenlean": {
      "type": "local",
      "command": ["node", "/abs/path/to/tokenlean-mcp/tokenlean.mjs", "stdio", "--root", "."],
      "enabled": true
    }
  },
  "permission": { "edit": "deny" }
}
```

#### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.tokenlean]
command = "node"
args = ["/abs/path/to/tokenlean-mcp/tokenlean.mjs", "stdio", "--root", "."]
```

Codex 无逐工具 deny,改在 `AGENTS.md` 引导:

```
For multi-line file edits use the tokenlean MCP tools
(fs_read_hashed → fs_edit_hash). Use search_lean instead of grep.
```

#### Cursor / Windsurf / VS Code Copilot

Cursor `.cursor/mcp.json`(VS Code 用 `.vscode/mcp.json`,字段 `servers` + `type:"stdio"`):

```json
{
  "mcpServers": {
    "tokenlean": {
      "command": "node",
      "args": ["/abs/path/to/tokenlean-mcp/tokenlean.mjs", "stdio", "--root", "${workspaceFolder}"]
    }
  }
}
```

无权限系统,靠 `.cursorrules` / `copilot-instructions.md` 引导(同上 AGENTS.md 文案)。

### 5.2 网页端 copilot 形态

#### 起服务

```bash
# 生成 token 并启动(只读问答推荐加 --read-only)
export TOKENLEAN_TOKEN=$(openssl rand -hex 16)
echo "token: $TOKENLEAN_TOKEN"          # 记下来,客户端要用
node tokenlean.mjs http --root /srv/repo --port 8765 --read-only
```

#### 暴露给 Claude.ai(隧道方式,无需公网 IP)

```bash
cloudflared tunnel --url http://127.0.0.1:8765
# 输出一个 https://xxx.trycloudflare.com 地址
```

然后 Claude.ai → Settings → Connectors → 添加自定义连接器,URL 填 `https://xxx.trycloudflare.com/mcp`,鉴权头填 `Authorization: Bearer <你的 token>`。

#### 自建 chatbot 直连

```
POST https://your-host/mcp
Headers:  Authorization: Bearer <token>
          Content-Type: application/json
Body:     标准 MCP JSON-RPC(initialize → tools/list → tools/call)
健康检查: GET /healthz  (无需鉴权)
```

---

## Part 6:工具清单与协议

### 6.1 六个工具

| 工具 | 维度 | 作用 | read-only 可用 |
|---|---|---|---|
| `fs_outline` | FUTURE | 文件结构目录 + 行锚点,~100 token 替代全量读 | ✅ |
| `fs_read_hashed` | FUTURE | 分页读取(默认 200/上限 600 行),每行 4 字符 hash | ✅ |
| `search_lean` | FUTURE | 正则搜索,硬预算(25/上限 80 条,行截 200 字符) | ✅ |
| `fs_edit_hash` | OUTPUT | 按 `line:hash` 锚点替换,mismatch fail-fast + 自动重定位 | ❌ |
| `fs_multi_edit_hash` | OUTPUT | 一文件多处编辑,先全校验后原子应用 | ❌ |
| `token_report` | 观测 | 会话级 OUTPUT 节省统计 | ✅ |

### 6.2 典型工作流

```
fs_outline(file)                     # 先看结构(~100 token)
  → fs_read_hashed(file, 起, 止)      # 只读相关区间,拿到锚点
  → fs_edit_hash(file, "42:f3", "47:c2", 新内容)   # 按锚点改,不复述原文
  → token_report()                   # 会话末看省了多少
```

### 6.3 协议要点

- MCP JSON-RPC 2.0,实现 `initialize` / `tools/list` / `tools/call` / `ping` / `notifications/initialized`
- stdio 形态:NDJSON(一行一条消息)
- http 形态:`POST /mcp`,`initialize` 时在响应头下发 `mcp-session-id`,后续请求带回以路由到独立 core
- 错误经 `isError: true` + 文本返回,而非 JSON-RPC error(便于模型读懂并自我纠正)

---

## Part 7:安全模型

| 风险 | 本地 stdio | 网页 http |
|---|---|---|
| 越权读写仓库外文件 | `--root` 路径守卫(`../` 一律拒绝) | 同左 |
| 未授权访问 | 不适用(无网络面) | Bearer token,无 token 拒绝启动 |
| 公网暴露 | 不监听端口 | 默认绑 localhost,公网需显式 + TLS |
| 误删/误改 | `--read-only` 可选 | `--read-only` 强烈建议(问答场景) |
| 请求体攻击 | 不适用 | body 上限 8MB,超限断连 |
| 会话串扰 | 不适用 | 每 `initialize` 独立 core + session id |

`--root` 路径守卫在 `core.mjs` 里,对两种传输都生效——这正是把校验放在核心层而非传输层的好处。

---

## Part 8:验证与节省数据

### 8.1 测试结果(全部真实运行)

```
本地 CLI 形态(test-stdio.mjs):  38 passed, 0 failed
网页端形态(test-http.mjs):     26 passed, 0 failed
合计:64/64
```

stdio 套件覆盖:握手、tools/list、带锚点读、大文件强制分页、outline、编辑成功、过期锚点 fail-fast、锚点自动重定位、批量原子性、搜索硬预算、路径逃逸防护、token_report、真实 tool_use JSON 对比。

http 套件覆盖:握手、鉴权(401)、healthz、读→改→验证的网络往返、fail-fast 在 HTTP 下保持、沙箱在 HTTP 下保持、会话隔离。

### 8.2 OUTPUT 节省曲线(模型实际生成的 tool_use JSON 计量)

| 被替换行数 | native Edit | fs_edit_hash | 节省 |
|---|---|---|---|
| 1 | 44 tok | 35 tok | 20% |
| 3 | 97 tok | 58 tok | 40% |
| 5 | 149 tok | 81 tok | 46% |
| 10 | 280 tok | 139 tok | 50% |
| 20 | 553 tok | 259 tok | 53% |
| 40+ | — | — | ~55%(渐近) |
| 删除 30 行 | 470 tok | 23 tok | **95%** |

结论:单行编辑不值得(故工具描述里写明单行用原生);3 行以上稳定 40-55%;删除/移动类重构最大赢家。

### 8.3 FUTURE INPUT 节省

- `fs_outline` 替代全量读:~17500 tok → ~117 tok(-99.3%,单次);在 50 轮会话里这份读取本会被重复计费 ~47 次,累计节省放大近 50 倍
- `search_lean` 封顶:无论模型怎么请求,grep 式海量输出都进不了历史

---

## Part 9:INPUT 维度(本方案的边界 + 配套设计)

MCP 工具无法干预 harness 如何构造 LLM 请求(消息排序、`cache_control` 断点位置),所以 **INPUT 维度(prefix cache 命中)在本方案范围之外**。

通用解法是一层对 agent 透明的 **LLM 网关代理**:agent 改 `base_url` 指向代理,代理负责注入 `cache_control` 断点、强制 `ttl:1h`、监控 hit/miss。LiteLLM 原生支持 `cache_control_injection_points`,自建约 200 行中间件。这是 `tokenlean-gateway` 的设计方向,作为本 MCP 服务的配套件,留待下一步实现。

三层组合的预期综合收益(不换 agent、不 fork 源码约束下):**-60~80%**。达不到 Reasonix 的 97.7%——那需要 harness 级 append-only 不变量,是通用方案的天花板。

---

## 附录:完整文件清单

```
tokenlean-mcp/
├── lib/core.mjs              # 纯逻辑核心(6 工具 + dispatch)
├── bin/stdio.mjs             # 本地 CLI 传输
├── bin/http.mjs              # 网页端传输(鉴权 + 会话)
├── tokenlean.mjs             # 统一启动器
├── server.mjs                # 向后兼容 shim
├── install.sh                # 安装 / 自测脚本
├── test/test-stdio.mjs       # 38 断言
├── test/test-http.mjs        # 26 断言
├── configs/
│   ├── claude-code.md  opencode.md  codex-cli.md
│   ├── cursor-vscode.md  chatbot.md
└── README.md
```

运行速查:

```bash
tokenlean stdio --root .                              # 本地 CLI 形态
TOKENLEAN_TOKEN=xxx tokenlean http --root /srv/repo   # 网页端形态
tokenlean test                                        # 跑全部测试
node server.mjs --root .                               # 旧式调用仍可用
```
