# 通用 Token 优化工具:从 Skills 到工具契约
## ——深度审查 + tokenlean 全栈(MCP server + Gateway)设计实现与验证

> **目标约束**(用户指定):方案必须**通用**,可迁移到任意 coding agent 或 copilot/chatbot,不绑定 Claude 生态。
>
> **TL;DR**:上一版 5 个 skills 有 4 个结构性缺陷,根因是"依赖模型自觉"且载体(SKILL.md)是 Anthropic 专有格式。本版把优化下沉到两个**通用层**:
> - **tokenlean-mcp**(零依赖单文件 MCP server):解决 OUTPUT + FUTURE INPUT 维度,35/35 协议级测试通过,实测 OUTPUT 节省 20-55%(随编辑规模),纯删除 95%,outline 替代全量读取 -99.3%
> - **tokenlean-gateway**(零依赖 LLM 代理):解决 INPUT 维度,23/23 测试通过,自动注入 cache_control 断点 + 强制 1h TTL + 前缀漂移检测 + 命中率仪表
>
> 两层对 agent 完全透明,合计 58 个自动化断言全部通过,附一键安装脚本(支持 Claude Code / OpenCode / Cursor / VS Code Copilot / Codex CLI)。

---

## Part 1:对上一版 5 个 Skills 的深度审查

### 1.1 通用性记分卡(这是上一版最大的问题)

| Skill | Claude Code | OpenCode | Codex CLI | Cursor | Copilot | 任意 chatbot |
|---|---|---|---|---|---|---|
| prefix-stable(SKILL.md) | ✓ | ✓(兼容) | ✗ | ✗ | ✗ | ✗ |
| hashline-lite(bash) | △ | △ | △ | ✗* | ✗* | ✗ |
| lean-tool-output | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| compaction-discipline | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| scratch-hygiene | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |

*Cursor/Copilot 没有 SKILL.md 机制;bash 脚本理论上可被调用,但没有任何机制让模型知道它们存在。

**结论:SKILL.md 是 Anthropic 专有格式。上一版方案 60% 的载体在 Claude 生态之外直接失效。**

### 1.2 四个结构性缺陷

**缺陷 1:载体不通用**。SKILL.md 只有 Claude Code / Claude.ai / OpenCode(兼容层)认识。Codex CLI 用 AGENTS.md,Cursor 用 .cursorrules,Copilot 用 copilot-instructions.md——每家一个方言,内容要重写 N 遍且语义不保证一致。

**缺陷 2:执行靠模型自觉**。这是致命伤。skill 说"请用 read-with-hashes.sh 而不是原生 Read"——模型在第 3 轮记得,第 17 轮就忘了。上一版自己也承认:"如果模型调用率 < 50%,skill 形同虚设"。但没有给出强制机制。

**缺陷 3:bash 脚本不在工具协议内**。模型调用 bash 脚本时,输出只是普通文本,没有结构化契约;heredoc 传多行内容易被引号/转义坑;Windows 上 bash 还不一定存在。

**缺陷 4:不可观测**。skill 无法统计自己被使用了多少次、省了多少 token。无法量化的优化等于不存在。

### 1.3 审查结论

上一版的**分析框架是对的**(三维度、四层分类、"75-85% 不可 skill 化"的判断都成立),但**交付载体选错了**。正确的载体是:

1. **MCP 工具**(OUTPUT + FUTURE INPUT):MCP 是当前唯一的跨 agent 标准——Claude Code、OpenCode、Codex CLI、Cursor、Windsurf、VS Code Copilot、JetBrains、Claude.ai/ChatGPT 桌面端全部支持;工具描述随协议传输,不需要每家写一遍方言;**工具的输出预算可以由工具自己强制执行**
2. **网关代理**(INPUT):MCP 工具无法干预 harness 如何构造 LLM 请求,但 agent 与 API 之间的代理可以——且对任何 agent 都只是改一个 base_url

---

## Part 2:核心设计转变——"建议模型" → "工具契约"

### 2.1 关键洞察

上一版把 lean-tool-output 做成行为指南:"读大文件前先 wc -l,超过 200 行用分页"。模型可以遵守,也可以不遵守。

本版把同样的纪律**做进工具实现**:

```
fs_read_hashed 收到无范围的大文件读取请求
  → 服务端强制截断到 200 行
  → 返回里附带提示:"此文件 1200 行,建议先 fs_outline 再按范围读取"
  → 模型物理上拿不到 17500 token 的全量输出
```

**FUTURE INPUT 的膨胀源头(大工具输出进入历史)被工具契约直接堵死,与模型是否自觉无关。**

### 2.2 三维度 × 通用载体映射(最终版)

| Token 维度 | 上一版载体 | 本版载体 | 通用性 | 强制力 |
|---|---|---|---|---|
| **OUTPUT** | bash 脚本 + skill 建议 | tokenlean-mcp:fs_edit_hash(hash 锚点编辑) | 所有 MCP 客户端 | 配合 deny 原生 Edit → 100% |
| **FUTURE INPUT** | skill 行为建议 | tokenlean-mcp:工具内置硬预算 | 所有 MCP 客户端 | **工具层强制,100%** |
| **INPUT** | skill 检测 CLAUDE.md | tokenlean-gateway:断点注入 + TTL 强制 + 漂移检测 | 任何 agent(改一个 base_url) | 代理层强制 |

### 2.3 "如何让模型用新工具"——最后一公里

工具做得再好,模型不用等于零。三层递进:

1. **工具描述自带引导**(所有客户端生效):每个工具的 description 写明 PREFER 语义
2. **关原生工具**(支持权限系统的客户端):Claude Code `permissions.deny: ["Edit","MultiEdit"]`、OpenCode `permission.edit: "deny"` → 模型只剩 hash 编辑一条路,**调用率 100%**(install.sh --deny-native 自动配置)
3. **规则文件兜底**(无权限系统的客户端):Cursor 的 .cursorrules / Codex 的 AGENTS.md 一句话引导(install.sh 自动追加)

---

## Part 3:tokenlean-mcp 设计与实现

### 3.1 形态选择:零依赖单文件

`server.mjs` 单文件,~430 行,**零 npm 依赖**(手写 NDJSON JSON-RPC 2.0),Node ≥18 即跑。这本身是通用性决策:没有 node_modules,没有版本地狱,复制一个文件到任何机器即部署。协议覆盖 initialize / tools/list / tools/call / ping。

### 3.2 六个工具

| 工具 | 优化维度 | 核心机制 |
|---|---|---|
| `fs_outline` | FUTURE INPUT | 结构化目录(函数/类/标题 + 行号锚点),~100 token 替代全量读取的数千 token |
| `fs_read_hashed` | FUTURE INPUT + OUTPUT 前置 | 分页读取(默认 200 行/硬上限 600),每行 2 字符 sha256 锚点 |
| `fs_edit_hash` | **OUTPUT** | hash 锚点替换 old_str;mismatch 时 fail-fast 且**在错误信息里直接返回当前锚点**(省一次重读);行号漂移自动重定位 |
| `fs_multi_edit_hash` | OUTPUT | 批量编辑,先全部校验后应用(原子性),自底向上保持行号有效 |
| `search_lean` | FUTURE INPUT | 正则搜索,硬预算:25 条(上限 80)、每行 200 字符、跳过二进制/超大文件,结果直接带可编辑锚点 |
| `token_report` | 可观测性 | 会话级统计:编辑数、拒绝数、重定位数、相对 str_replace 基线的 OUTPUT 节省估算 |

### 3.3 相对上一版 bash 脚本的关键升级

1. **重定位(relocation)**:文件上方插入几行导致行号漂移?旧版直接拒绝;新版在 ±40 行窗口内按 hash 内容重新定位(start/end 双锚点 + 跨度三重校验),内容未变就自动修正行号
2. **Mismatch 返回当前锚点**:旧版拒绝后要求重新读文件(一次额外全量读 = FUTURE INPUT 浪费);新版在错误消息里直接附上目标区域当前锚点,模型零成本重试
3. **原子批量编辑**:一批编辑里有一个锚点坏 → 整批拒绝、文件不动
4. **响应级硬封顶**:任何工具结果超过 24000 字符(~6000 token)强制截断并附收窄建议
5. **工作区沙箱**:`--root` 之外的路径一律拒绝,可安全暴露给 chatbot 场景
6. **内建计量**:token_report 让"省了多少"变成一条命令可查

---

## Part 4:tokenlean-mcp 验证结果(全部真实运行)

### 4.1 协议级测试:35/35 通过

测试客户端 spawn 真实 server 进程,走真实 stdio JSON-RPC(与 Claude Code/Cursor 连接方式完全一致),147ms 跑完 13 组:

```
[1] MCP 握手           ✓ serverInfo / capabilities
[2] tools/list          ✓ 6 工具 + inputSchema 完整
[3] 带锚点读取          ✓ "  12:a3  content" 格式
[4] 大文件强制分页       ✓ 1200 行被截到 200 行 + outline 引导
[5] fs_outline          ✓ 466 字符(~117 tok) vs 全量 ~70000 字符(~17500 tok) = -99.3%
[6] 编辑成功路径         ✓ 应用正确 + 返回新鲜锚点
[7] 过期锚点 fail-fast   ✓ 拒绝 + 文件不动 + 错误信息内嵌当前锚点
[8] 锚点自动重定位       ✓ 上方插 3 行后旧锚点仍正确落位
[9] 批量原子性          ✓ 一坏全拒,无部分应用;合法批次全部应用
[10] 搜索硬预算         ✓ 默认 25 上限;请求 999 仍被压到 80
[11] 路径逃逸防护        ✓ ../../etc/passwd 拒绝
[12] token_report       ✓ 会话累计:5 次编辑省 33% OUTPUT
[13] 真实 tool_use JSON  ✓ 同一编辑 native 72 tok vs hashed 59 tok
```

### 4.2 OUTPUT 节省曲线(模型实际生成的 tool_use JSON 计量)

| 被替换行数 | native Edit (old_str+new_str) | fs_edit_hash (锚点+new) | 节省 |
|---|---|---|---|
| 1 | 44 tok | 35 tok | 20% |
| 3 | 97 tok | 58 tok | 40% |
| 5 | 149 tok | 81 tok | 46% |
| 10 | 280 tok | 139 tok | 50% |
| 20 | 553 tok | 259 tok | 53% |
| 40 | 1098 tok | 499 tok | 55% |
| 80 | 2188 tok | 979 tok | 55% |
| **删除 30 行** | 470 tok | **23 tok** | **95%** |

三个诚实结论:
- **单行编辑不值得**(20%,且有读锚点的前置成本)——工具描述里明确写了单行用原生即可
- **3 行以上稳定 40-55%**,与 omp 原版宣称的 -50~61% 吻合(原版更高是因为协议层集成开销更低 + 弱模型重试节省)
- **删除/移动类重构是最大赢家**(95%)——重构场景应无条件走 hash 编辑

### 4.3 FUTURE INPUT 维度实测

- fs_outline 替代全量读取:**~17500 tok → ~117 tok(-99.3%)**;在 50 轮会话里这份读取会被重复计费 ~47 次,累计节省放大近 50 倍
- search_lean 对大量匹配的搜索:封顶在 25 条 × 200 字符,无论模型怎么请求都不会把 4MB 的 grep 输出灌进历史

---

## Part 5:tokenlean-gateway——INPUT 维度(已实现 + 测试)

### 5.1 架构位置

MCP 层管不到请求构造,但有一个对**任意 agent 都透明**的位置:agent 与 LLM API 之间的代理。

```
任意 Agent ──HTTP──▶ tokenlean-gateway ──▶ Anthropic API
(只改一个              │
 base_url)             ├─ ① 注入 cache_control:system 尾块 + 最后 2 条消息(不限 role,omp 式)
                       │    总断点 ≤4(Anthropic 上限),已有 cache_control 的请求原样放行
                       ├─ ② 强制 ttl: "1h"(防 2026-03 式 TTL 静默降级,Issue #46829)
                       ├─ ③ 前缀漂移检测:hash(system+tools) 逐请求比对,漂移计数暴露在 /stats
                       └─ ④ usage 聚合:JSON 与 SSE 流式响应均解析,hit/miss/write/output 累计
```

接入方式(每个 agent 只动一行):
- Claude Code:`export ANTHROPIC_BASE_URL=http://127.0.0.1:8788`
- OpenCode:provider baseURL
- 任意 SDK:baseURL/base_url 选项

### 5.2 测试结果:23/23 通过(本地 mock 上游,无需 API key)

```
[1] 裸请求整形      ✓ string system 规范化为块数组 ✓ system 尾块打点
                   ✓ TTL 强制 1h ✓ 最后两条消息打点(不限 role)
                   ✓ 更早消息不动 ✓ 总断点 ≤4 ✓ 鉴权头原样转发
[2] 尊重 agent 策略  ✓ 已带 cache_control 的请求不重复注入 ✓ agent 自设的 5m TTL 不被覆盖
[3] 前缀漂移        ✓ system 变化被检测并计数
[4] SSE 流式        ✓ 流原样透传 ✓ message_start/message_delta 中的 usage 正确累计
[5] 经济学统计      ✓ hit_rate 计算正确;模拟负载:hit 86.59%,成本 $0.0322 vs 无缓存 $0.1108(省 70.9%)
[6] 非 messages 端点 ✓ 原样透传不整形
[7] healthz         ✓
```

`/stats` 还内置一条诊断启发式:当 `prefix_changes / requests > 30%` 时给出提示——"有组件在请求间改动 system/tools,这正是杀死缓存的元凶"(对应 ToolSearch 事件与 CLAUDE.md 时间戳两类真实事故)。

### 5.3 诚实的边界

- 断点注入对 **Anthropic 协议**生效;指向 OpenAI/DeepSeek 时退化为透传 + 统计模式(这两家是自动缓存,无断点概念,统计仍有价值)
- gateway 能保证"断点正确 + TTL 正确 + 漂移可见",但**不能**把一个本身天天重排消息的 harness 救成 99.82%——append-only 不变量仍是 harness 的责任。这是通用方案的物理天花板

---

## Part 6:组合部署与预期收益

```
              ┌────────────────────────────────────────────┐
              │ 任意 Agent (Claude Code/Cursor/Codex/...)   │
              └───────┬───────────────────────┬────────────┘
       MCP (stdio/SSE)│                       │HTTP base_url
              ┌───────▼────────┐     ┌────────▼─────────┐
              │ tokenlean-mcp  │     │ tokenlean-gateway │
              │ OUTPUT -40~55% │     │ INPUT: 断点+TTL+   │
              │ FUTURE -50~80% │     │ 漂移检测+命中率仪表  │
              └────────────────┘     └──────────────────┘
```

| 部署层级 | 工作量 | 预期效果 |
|---|---|---|
| tokenlean-mcp + deny 原生 Edit | `bash install.sh claude-code . --deny-native`,1 分钟 | OUTPUT -40~55%(编辑场景),FUTURE INPUT -50~80%(读/搜场景) |
| + 规则文件引导(无权限系统的客户端) | install.sh 自动完成 | 调用率 ~50% → ~85% |
| + tokenlean-gateway | `node gateway.mjs` + 改 base_url,5 分钟 | 断点/TTL 正确化,命中率可见;前缀本就稳定的 agent 可达 70%+ |
| 三层全开 | <10 分钟 | 综合成本 **-60~80%**(对比裸用) |

仍然达不到 Reasonix 的 97.7%——那需要 harness 级 append-only 不变量。但 -60~80% 已经是"不换 agent、不 fork 源码、改动 <10 分钟"约束下的理论最优区间。

---

## Part 7:与上一版的关系总结

| | 上一版(skills) | 本版(tokenlean 全栈) |
|---|---|---|
| 载体 | SKILL.md + bash | 零依赖 MCP server + 零依赖 gateway |
| 通用性 | Claude 生态 | 所有 MCP 客户端 + 任意 agent(gateway)+ 包 SSE 后任意 chatbot |
| 强制力 | 模型自觉 | 工具契约 + 权限 deny + 代理层强制 |
| OUTPUT 节省 | 31%(单点实测) | 20-55% 曲线 + 删除 95% |
| FUTURE INPUT | 行为建议 | 硬预算强制(分页/搜索上限/响应封顶) |
| INPUT | 检测脚本 | gateway 已实现:断点注入+TTL 强制+漂移检测+命中率仪表 |
| 可观测 | 无 | token_report + /stats |
| 测试 | 6 个 bash 测试 | **58 个自动化断言**(35 MCP + 23 gateway),全部通过 |
| 安装 | 手动复制 | install.sh 一键注册 5 种 agent,合并不覆盖已有配置 |

上一版的 5 个 skill 不作废:compaction-discipline / scratch-hygiene 作为行为指南仍有边际价值(compaction 时机本质是决策问题,不是工具问题)。但**主力载体从 skill 切换到 MCP + gateway**。

---

## 附录:交付物清单

```
tokenlean-mcp/
├── server.mjs              # MCP server,零依赖单文件(~430 行)
├── gateway.mjs             # LLM 代理,零依赖单文件(~250 行)
├── install.sh              # 一键注册:claude-code|opencode|cursor|vscode|codex|gateway
├── README.md
├── test/
│   ├── test-client.mjs     # MCP 协议级测试(35 断言)
│   └── test-gateway.mjs    # gateway 测试,含 mock 上游(23 断言)
└── configs/                # 各 agent 手动配置参考
    ├── claude-code.md  ├── opencode.md  ├── codex-cli.md
    ├── cursor-vscode.md  └── chatbot.md(supergateway 包 SSE 暴露给 Claude.ai 等)

部署速查:
  MCP:     bash install.sh claude-code /path/to/project --deny-native
  Gateway: node gateway.mjs &  &&  export ANTHROPIC_BASE_URL=http://127.0.0.1:8788
  自测:    node test/test-client.mjs && node test/test-gateway.mjs
  观测:    curl http://127.0.0.1:8788/stats   # 命中率/漂移/成本
           会话内调用 token_report             # OUTPUT 节省
```
