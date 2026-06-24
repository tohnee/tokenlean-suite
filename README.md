# Token 节省统一系统设计方案
## TokenLean:从行为到协议到网关的三层可叠加架构

> **目标**:在不牺牲任务质量的前提下,系统性地降低 coding agent / copilot 的 token 账单。
> **范围**:整合本系列对话的全部调研与实现——skills/workflow、MCP server、网关代理(设计),论证三者**正交可叠加**,给出统一架构、部署路径与预期收益。
> **现状**:workflow(35 测试通过)与 MCP server(38 测试通过,含数据安全回归测试)已实现可交付;网关为设计阶段。

---

## ⚠️ 修订说明(v2,基于真实 tokenizer 实测)

本文档先前版本的 OUTPUT 节省数字基于注水基线(假设 str_replace 复述整块)和 chars/4 估算。经 `test/bench-output.mjs` 用真实 BPE tokenizer + 公平基线(最小唯一 old_str)重测后,核心数字修正如下:

| 对比对象 | 先前宣称 | **实测修正** | 说明 |
|---|---|---|---|
| hash 锚点 vs 全文件 Write | — | **-86%** | 真实大节省,但前提是模型本会重写整文件(坏习惯/弱模型) |
| hash 锚点 vs 称职 native Edit | -40~55% | **≈ -6%(基本持平,小改动甚至略差)** | 称职模型本就写紧 old_str |
| hash 锚点 vs 弱模型 Edit + 重试 | — | **-50~71%(随重试次数放大)** | omp -61% 的真实来源,不能套用到 Claude |

**最重要的认知修正**:对 Claude 这类称职模型,hash 锚点编辑的 **OUTPUT token 节省 ≈ 0**;它的真实价值是**可靠性**(fail-fast 防止改错、无空白匹配失败),而非 token。OUTPUT 维度的真实杠杆是"避免全文件重写"(主要让弱模型和 Write-happy 行为受益),不是 hash 格式本身。

下文保留原始结构,但所有 OUTPUT 与综合节省数字以本框为准。INPUT/FUTURE 维度已补充**确定性会计基准**(`tl bench`):它量化 token/layout 机制本身,但仍不是实模型账单,标注见各处。

---

## 更新日志(2026-06-20 代码审查修复)

本次更新基于一次完整的代码审查,按优先级 S1→M4 系统性修复了文档对齐、跨平台 parity、设计文档同步、HTTP 会话隔离与性能问题。**全部 210 断言测试通过,0 回归。**

### 文档与交付物对齐(S1)
- 重写 `02-mcp-server/README.md`,删除所有过时引用(不存在的 gateway.mjs、错误端口 8788、错误断言数),对齐实际交付的双传输架构(stdio + http)、正确端口 8765、端点与环境变量。

### OpenCode 插件 parity(S2)
- `01-workflow/opencode/plugin/tokenlean.ts` 补齐与 Claude Code hooks 的 parity gap:新增 `ls-R` bash-lint 规则、增强时间戳/UUID 正则、新增占位符与排序检查。
- 新增 `01-workflow/test/test-opencode-plugin.mjs`(63 断言):双层测试(功能测试 + 结构 parity 测试),捕获未来漂移。

### 设计文档与依赖(M1-M2)
- 同步 `DESIGN.md` 与 `core.mjs` 中 hash 长度描述(2→4 字符)。
- 修正 `package.json`:`gpt-tokenizer` 移至 devDependencies(核心零依赖),修正 `main`/`scripts`/`keywords`。

### HTTP 会话与性能(M3-M4)
- **会话隔离**:`__default__` fallback 会话现参与 TTL 清理(此前永久驻留),首次 fallback 打印 stderr 警告,新增 7 个测试。
- **性能**:`search_lean` 的 `SEARCH_MAX_FILES` 支持环境变量覆盖(`TOKENLEAN_SEARCH_MAX_FILES`),HTTP 传输在 dispatch 前让出事件循环,避免长同步搜索阻塞其他会话。

### 测试断言数变化
| 套件 | 修复前 | 修复后 |
|---|---|---|
| 01-workflow/test-hooks | 35 | 35 |
| 01-workflow/test-opencode-plugin | — | 63(新增) |
| 02-mcp-server/test-stdio | 38 | 38 |
| 02-mcp-server/test-http | 19 | 26(+7) |
| 04-prompt-assembler(两套) | 48 | 48 |
| **合计** | **140** | **210** |

详见 `CHANGELOG.md`。

---

## 第一部分:问题模型

### 1.1 唯一正确的成本分解 —— 三个 Token 维度

所有后续设计都建立在一个基础认识上:**coding agent 的 token 账单不是一个数,而是三个独立的数**。把它们混为一谈,是绝大多数"省 token"努力失败的根因。

| 维度 | 定义 | 计价特征 | 优化杠杆 | 标杆实现 |
|---|---|---|---|---|
| **INPUT** | 每轮请求中输入给模型的字节 | prefix cache 命中后按 0.1× 基价 | 稳定前缀 + 缓存断点 + 命中监控 | Reasonix 单日命中率 99.82% |
| **OUTPUT** | 模型本轮生成的字节 | 单价是 INPUT 的 4-5 倍 | 编辑格式优化(少复述) | omp Hashline,Grok4Fast OUTPUT -61% |
| **FUTURE INPUT** | 大工具输出进入历史后,在后续每轮被重复计费 | 一次产生,N 轮重复付费 | 输出预算 + 压缩 + scratch 隔离 | OpenCode prune / Reasonix scratch zone |

### 1.2 三维度的交互规律(决定架构的关键)

```
        INPUT 优化          OUTPUT 优化         FUTURE 优化
       (prefix cache)       (Hashline)         (compaction)
            │                   │                   │
            └──── 正交,乘法叠加 ──┘                   │
                                                     │
            每次 compaction 执行 ◀──── 破坏 ──────────┘
                    │
                  prefix cache 命中率短暂归零
```

两条铁律,直接塑造了本方案的分层:

1. **INPUT 与 OUTPUT 完全正交** —— prefix cache 降的是"输入字节单价",Hashline 降的是"输出字节数量",两者叠加是乘法关系,可以放心同时上。
2. **FUTURE 优化会破坏 INPUT 优化** —— compaction 重写前缀会让缓存归零,所以 compaction 必须低频、有纪律。这意味着"压缩"不能当默认操作,而要当稀有的 cache reset 点。

### 1.3 实测的收益上限(来自历史调研)

- 三维度乘起来:Reasonix 把真实单日账单从 **$61.06 压到 $1.38(-97.7%)**,靠的就是 INPUT 命中率 99.82% + scratch 隔离 + 低频压缩。
- 单维度标杆:omp Hashline 让 Grok Code Fast 1 的编辑成功率从 **6.7% → 68.3%(+10×)**,Grok 4 Fast 的 OUTPUT token **-61%**。
- 但这些数字依赖**改 harness**(append-only 不变量、自定义编辑协议)。在"不改 harness"的约束下,天花板要低得多——这正是分层设计要回答的问题:**每一层能拿到多少,代价是什么。**

---

## 第二部分:为什么必须分层 —— 能力边界决定架构

### 2.1 一个 agent 的四个可干预层

```
┌─────────────────────────────────────────────────────────┐
│ L4 用户/Prompt 层    CLAUDE.md / AGENTS.md / 规则文件      │ ← 谁都能改
├─────────────────────────────────────────────────────────┤
│ L3 行为/工具调用层   模型选哪个工具、读多少、写多紧         │ ← skills/hooks 可干预
├─────────────────────────────────────────────────────────┤
│ L2 工具 I/O 协议层   工具的输入输出格式(可加自定义工具)    │ ← MCP 可干预
├─────────────────────────────────────────────────────────┤
│ L1 Harness 循环层    请求构造、消息排序、cache_control、流  │ ← 只有 fork / 网关能干预
└─────────────────────────────────────────────────────────┘
```

历史调研的核心结论:**omp / Reasonix 的创新 75-85% 在 L1(harness 层)**——Cache-First Loop、TTSR、断点工程、双 session 隔离,全部需要控制请求构造。这解释了为什么:

- **纯 skills 只能拿到 15-25%**(只够到 L3-L4)
- **MCP 能多拿一块**(够到 L2,把 Hashline 做成工具)
- **INPUT 维度(L1)谁都绕不过去**——除非 fork harness,或者插一层网关

### 2.2 三个组件各自的射程

| 组件 | 干预层 | 能覆盖的维度 | 强制力 | 通用性 |
|---|---|---|---|---|
| **workflow(skills+hooks)** | L3-L4 | FUTURE(强)、OUTPUT(中)、INPUT(仅监控) | hook 确定性 / skill 靠引导 | Claude Code, OpenCode |
| **MCP server** | L2 | OUTPUT(可靠性强,token 节省视模型而定)、FUTURE(工具预算强) | 工具契约 + 权限 deny | 所有 MCP 客户端 |
| **网关代理** | L1 | INPUT(唯一能真正解决的层) | 对 agent 透明、强制 | 任意改 base_url 的 agent |

**结论:三个组件不是三选一,而是三个维度各自的最优解,射程互补,叠加无冲突。**

---

## 第三部分:统一架构

### 3.1 全景图

```
                          ┌──────────────────────────────────────┐
                          │   Coding Agent / Copilot              │
                          │ (Claude Code / OpenCode / Cursor /     │
                          │  Codex / Copilot / Claude.ai)          │
                          └───┬──────────────┬─────────────┬───────┘
                              │              │             │
              ┌───────────────┘              │             └──────────────┐
              │ L3-L4                         │ L2                          │ L1
   ┌──────────▼───────────┐    ┌─────────────▼──────────┐    ┌────────────▼─────────────┐
   │ ① WORKFLOW           │    │ ② MCP SERVER           │    │ ③ GATEWAY (设计)          │
   │ skills + hooks       │    │ tokenlean-mcp          │    │ tokenlean-gateway         │
   │                      │    │                        │    │                           │
   │ FUTURE: bash-guard   │    │ OUTPUT: fs_edit_hash    │    │ INPUT: 注入 cache_control │
   │   有界化命令          │    │   hash 锚点(可靠性)   │    │   断点                     │
   │ OUTPUT: write-guard  │    │ FUTURE: 读/搜硬预算      │    │ INPUT: 强制 ttl=1h         │
   │   防全文件重写        │    │ 观测: token_report      │    │ INPUT: 前缀漂移告警        │
   │ INPUT: cache 审计监控 │    │                        │    │ 观测: hit/miss 仪表盘      │
   │ + compaction 纪律     │    │ 两种形态:               │    │                           │
   │                      │    │  stdio(本地CLI)        │    │ agent 改 base_url 即接入   │
   │ 开箱即用,无依赖       │    │  http(网页copilot)     │    │ 对 agent 完全透明          │
   └──────────────────────┘    └────────────────────────┘    └───────────────────────────┘
        已实现 35测试通过           已实现 50测试通过                 设计完成,待实现

   ════════════════════════ 三者正交,可单独或组合部署 ════════════════════════
```

### 3.2 维度 × 组件覆盖矩阵(谁主谁辅)

| | workflow | MCP server | gateway |
|---|---|---|---|
| **INPUT** | 辅(审计+监控,改不了断点) | — | **主(注入断点+TTL+监控)** |
| **OUTPUT** | 辅(write-guard 引导用 Edit) | **主(hash 锚点协议)** | — |
| **FUTURE INPUT** | **主(bash-guard+compaction)** | 辅(工具自带预算) | — |

每个维度都有一个"主"组件把它做到该层的最优,其余组件提供辅助和兜底。**没有任何两个组件在同一维度上冲突**——这是"可叠加"的技术保证。

### 3.3 为什么三者不冲突(正交性证明)

- **workflow vs MCP**:workflow 的 hook 在工具调用前后拦截/引导;MCP 提供新工具。两者操作对象不同。MCP 的 `fs_edit_hash` 反而让 workflow 的 write-guard 更少触发(因为不再用原生 Write)。
- **MCP vs gateway**:MCP 改的是工具 I/O(请求体里 messages 的内容);gateway 改的是请求的 cache_control 标记和 TTL(请求体的元数据)。一个管"发什么",一个管"怎么缓存",互不重叠。
- **workflow vs gateway**:workflow 的 cache 审计是"提醒你 CLAUDE.md 不稳定";gateway 是"真正注入断点并监控命中"。前者预防,后者执行+观测,正好接力。

---

## 第四部分:三个组件详解

### 4.1 ① Workflow(skills + hooks)—— L3-L4,已交付

**形态**:文件丢进 `.claude/` 或 `.opencode/` 即生效,零依赖(Node ≥18)。

**三维度覆盖**:

| 维度 | 确定性 hook | 行为 skill | 命令 |
|---|---|---|---|
| INPUT | session-start 审计 CLAUDE.md | prefix-stable | /cache-report |
| OUTPUT | write-guard(覆写大文件→建议 Edit) | surgical-edits | — |
| FUTURE | bash-guard(无界命令→有界改写)+ precompact | lean-context | /lean-compact |

**关键设计**:hook 是地基(确定性触发,不靠模型自觉),skill 是引导(覆盖 hook 抓不到的长尾),command 是人控观测。bash-guard 三种模式(guard/auto/off),write-guard 三种模式(guard/warn/off)。

**射程与天花板**:FUTURE 维度做得最实(hook 能真正拦住无界输出);OUTPUT 只能引导选对工具,拿不到协议级节省;INPUT 只能审计监控,改不了断点。

**两个 agent 的差异**:Claude Code 用 `hooks/*.mjs`(stdin JSON),OpenCode 用 `plugin/tokenlean.ts`(`tool.execute.before`),逻辑内联对齐。

**验证**:35 断言 mock 驱动测试通过,安装器端到端验证过。

### 4.2 ② MCP Server(tokenlean-mcp)—— L2,已交付

**形态**:零依赖单文件 MCP server,六个工具。

**三维度覆盖**:
- **OUTPUT(主战场)**:`fs_edit_hash` / `fs_multi_edit_hash` 用 `line:hash` 锚点替代 old_str,模型不复述未改内容。实测节省曲线:3 行 40%、10 行 50%、20+ 行 53-55%、纯删除 95%。配合 mismatch fail-fast + 自动重定位。
- **FUTURE**:`fs_read_hashed`(分页硬上限)、`fs_outline`(~100 token 替代全量读)、`search_lean`(结果硬预算)——工具契约强制,不靠模型自觉。
- **观测**:`token_report` 会话级节省统计。

**两种使用形态**(对应不同客户端):
- **stdio**:本地 CLI agent(Claude Code/Cursor/OpenCode/Codex)spawn 子进程,文件本地,无需鉴权。
- **http**:网页端 copilot(Claude.ai 连接器/chatbot)远程连接,强制 Bearer token + 会话隔离 + 沙箱,可选 read-only。

**关键设计**:三层架构分离(`lib/core.mjs` 纯逻辑 + `bin/stdio.mjs` + `bin/http.mjs`),传输无关。让 hash 编辑调用率达 100% 的诀窍:权限 deny 原生 Edit。

**验证**:50 断言(stdio 35 + http 15)通过。

### 4.3 ③ Gateway(tokenlean-gateway)—— L1,待实现

**为什么必须是网关**:INPUT 维度(prefix cache 命中)的本质是 harness 怎么构造请求——消息排序、cache_control 断点位置、TTL。这些 skills/MCP 都够不到。唯一对**任意 agent 透明**的干预点,是 agent 与 LLM API 之间的代理。

**形态**:agent 改一个 `base_url` 指向网关,网关转发到真实 API,中途做四件事:

```
任意 Agent ──base_url──▶ tokenlean-gateway ──▶ Anthropic / OpenAI / DeepSeek
                            │
                            ├─ 注入 cache_control 断点
                            │    (Anthropic: system 尾 + 倒数第二条消息,2+2 布局)
                            ├─ 强制 ttl="1h"(防 2026-03 式静默降级到 5min)
                            ├─ 前缀漂移检测(对比相邻请求 system 前缀,变化即告警)
                            └─ hit/miss 统计 → 命中率仪表盘
```

**实现路径**:LiteLLM 原生支持 `cache_control_injection_points`,可直接配置;或自建约 200 行中间件(已有设计,reads usage 字段:Anthropic `cache_creation/read_input_tokens`、OpenAI `cached_tokens`、DeepSeek `prompt_cache_hit/miss_tokens`)。

**接入方式**:
- Claude Code:`ANTHROPIC_BASE_URL=http://gateway`
- Codex:config 里改 `base_url`
- OpenCode:provider 配置改 endpoint

**射程**:这是把 INPUT 命中率从"修好 CLAUDE.md 后的 ~55-65%"推向"70%+"的唯一通用手段。要到 Reasonix 的 99% 仍需 harness 级 append-only,但网关能拿到通用方案的 INPUT 上限。

---

## 第五部分:渐进式部署路径

按 ROI 和工作量排序,每一步独立见效,可随时停在任一层。

```
阶段 0  现状基线
        先测:跑 workflow 的 /cache-report 或 hit-rate.mjs,记录当前命中率与成本
        ──这是后续所有优化的对照基准

阶段 1  装 workflow(10 分钟,开箱即用)        ROI 最高
        ├─ FUTURE: bash-guard 拦无界命令       立刻 -50~80% 工具输出膨胀
        ├─ OUTPUT: write-guard 引导用 Edit
        └─ INPUT:  session-start 审计 CLAUDE.md  发现隐性浪费
        预期:综合成本下降(FUTURE 维度为主;未经真实模型实测)

阶段 2  装 MCP server(30 分钟)               OUTPUT 协议级
        ├─ deny 原生 Edit,强制走 fs_edit_hash
        └─ 编辑密集 / 弱模型场景收益最大
        预期:OUTPUT 弱模型/重写场景 -50~86%;称职模型 token 持平,得可靠性

阶段 3  上 gateway(1-2 天)                   INPUT 维度补齐
        ├─ LiteLLM 配 cache_control 注入,或自建中间件
        ├─ 强制 1h TTL,前缀漂移告警
        └─ 接命中率仪表盘
        预期:INPUT 命中率 30% → 70%+

阶段 4(可选)harness fork                     逼近理论上限
        若上述仍不够,fork OpenCode 实现 append-only 不变量
        预期:命中率 → 90%+,接近 Reasonix
```

### 各阶段预期收益叠加

**重要**:下表区分"确定性会计基准"与"真实模型账单"。`tl bench` 现可一次性复现 OUTPUT / FUTURE INPUT / CODING AGENT / INPUT(RAG) 四类 accounting benchmark;它证明工具/布局在 token 会计上能省多少,但不证明真实 agent 一定会选择这些路径,也不替代 provider usage 账单。

`tl bench` 做四件事:
1. **OUTPUT**:比较全文件 Write、称职 native Edit、hash-anchor edit 的编辑工具调用输出 token。
2. **FUTURE INPUT**:比较 coding agent 在 repo orientation/search/inspection 时,lean MCP 输出与 naive 全量输出进入历史后被后续轮次重复计费的 context-token-turn 成本。
3. **CODING AGENT**:把 FUTURE INPUT 的重计费输入成本和编辑 OUTPUT 成本合并成 coding-agent 使用场景,分别对比 full-rewrite agent 与 native-Edit agent。
4. **INPUT/RAG**:比较 chatbot+RAG 的 naive volatile-first prompt 与 stable-prefix cache-aware prompt。

| 部署到 | INPUT | OUTPUT | FUTURE | 综合 |
|---|---|---|---|---|
| 阶段 1(workflow) | 仅审计监控(0 实际控制) | 弱模型/重写场景受益 | 会计基准:工具输出重计费可省约 73% context-token-turns | 下降主要来自 FUTURE,实际取决于危险命令命中率 |
| +阶段 2(MCP) | 仅审计监控 | **实测**:vs Write -86%、vs 称职 Edit ≈0、弱模型重试 -50~71% | 工具预算强制;`bench-future` 可复现 | coding-agent 合并成本基准:约 74% vs full-rewrite agent / 73% vs native-Edit agent |
| +阶段 3(gateway) | RAG 本地基准约 70% billed-input savings;真实 provider 用 live runner 验证 | 同上 | 同上 | INPUT 大头需 provider usage 证实 |
| +阶段 4(fork) | 命中率→90%+ | 同上 | 同上 | 逼近 Reasonix |

复现命令:

```bash
tl bench
tl bench --out SAVINGS-REPORT.md
node 02-mcp-server/test/bench-future.mjs
```

FUTURE 的数字来自"避免大输出进历史后被 N 轮重复计费"的会计模型:第 i 次工具输出会在后续 `(T-i+1)` 轮里重复进入输入账单。当前基准用真实仓库文件和真实 MCP core 比较 `fs_outline`/`fs_read_hashed`/`search_lean` 与全量读/递归搜索的输出大小,但 bash-guard 仍是黑名单式 best-effort 检测(python/jq/dd 等读取方式不覆盖),真实拦截率取决于命令分布。

**诚实结论(修订)**:
- OUTPUT 经真实 tokenizer 测量,结论是"对称职模型 token 持平、价值在可靠性;对弱模型和全文件重写场景有真实大节省"。
- FUTURE 与 INPUT/RAG 现在有本地会计基准,但需要真实会话数据、provider usage 或网关命中率仪表盘才能转化为账单结论。
- 此前 "-60~80% 综合节省" 的说法**撤回**——它从未被端到端测量,且把 OUTPUT 的注水数字计入了。诚实的表述是:三层架构在结构上覆盖三个维度,每个维度已有可复现 benchmark,但综合收益取决于工作负载,需实测确认。

---

## 第六部分:选型决策

```
你的优化目标 / 约束是?
│
├─ 想零成本快速见效,不想动任何配置以外的东西
│   └─ 只装 workflow(阶段1)。10分钟,主要拿 FUTURE 维度;收益需自测。
│
├─ 编辑密集(重构多 / 用弱模型省钱)
│   └─ workflow + MCP server。OUTPUT 维度吃满。
│
├─ 长会话 / agent 挂机 / 账单大头在 INPUT
│   └─ 推荐:Headroom (https://github.com/nicholasgriffintn/headroom)
│       作为 L1 网关代理,注入缓存断点 + TTL,无需自建 gateway。
│       Headroom 同时提供 SmartCrusher(FUTURE 压缩)和 CCR(可逆压缩)能力。
│       或者 LiteLLM 的 cache_control_injection_points 也是成熟方案。
│
├─ 网页端 copilot(Claude.ai / chatbot)
│   └─ MCP server 用 http 形态(带鉴权)。workflow 不适用(无 hook 机制)。
│
├─ 企业内部自建 agent
│   └─ 全栈:fork OpenCode + 内置 workflow 逻辑 + Headroom 作为 gateway。一次工程,长期生效。
│
├─ 想要三维度都覆盖,用一套脚本快速搭建
│   └─ 运行 tokenlean-suite 根目录下的 install-stack.sh,一键安装:
│       workflow + MCP + rtk(CLI压缩) + Headroom(gateway) + caveman(叙述压缩)
│       详见同目录 STACK-README.md 和 DEPLOYMENT-GUIDE.md。
│
├─ Chatbot + RAG 场景(Claude.ai / ChatGPT / 自建)
│   └─ bash install-stack.sh --rag --start
│       自动构建 + 启动 tokenlean-rag(cache-aware RAG MCP),生成开机自启服务单元。
│       详见 DEPLOYMENT-GUIDE.md 第三章。
│
└─ 就是想要理论最优、愿意投入工程
    └─ 阶段1-4 全上,或直接采用 Reasonix(DeepSeek)/ omp 架构。
```

---

## 第七部分:已交付物清单

| 组件 | 包 | 状态 | 测试 |
|---|---|---|---|
| Workflow(skills+hooks) | `tokenlean-workflow.tar.gz` | ✅ 可部署 | 35/35 |
| MCP server | `tokenlean-mcp.tar.gz` | ✅ 可部署 | 50/50 |
| RAG server(chatbot) | `03-rag-server/` | ✅ 可部署 | 36+12+35 |
| Prompt assembler(共享库) | `04-prompt-assembler/` | ✅ | — |
| Gateway | — | 📐 设计完成 | 待实现 |
| 三维度原理调研 | `cache-research-report.md` | ✅ | — |
| Skills 可行性分析 | `skills-feasibility-analysis.md` | ✅ | — |
| 通用化方案 | `universal-token-optimization.md` | ✅ | — |
| 部署指南 | `DEPLOYMENT-GUIDE.md` | ✅ | — |
| 接入指南 | `INTEGRATION-GUIDE.md` | ✅ | — |
| 架构对比 | `COMPARISON-REPORT.md` | ✅ | — |
| 重构计划 | `REFACTOR-PLAN.md` | ✅ | — |
| 本统一设计 | `MASTER-DESIGN.md` | ✅ | — |

---

## 附录:核心数据速查

| 指标 | 数值 | 来源 |
|---|---|---|
| Reasonix 单日命中率 | 99.82% | 真实用户单日,2026-05-01 |
| Reasonix 成本节省 | $61.06→$1.38(-97.7%) | 同上 |
| omp Hashline OUTPUT(Grok4Fast) | -61% | omp benchmark 16模型180任务 |
| omp 弱模型编辑成功率 | 6.7%→68.3%(+10×) | Grok Code Fast 1 |
| Anthropic 缓存计价 | 写1.25×(5m)/2×(1h),读0.1× | Anthropic 文档 |
| 缓存 break-even | 5m:0.28次读 / 1h:1.11次读 | 计价推导 |
| MCP OUTPUT(vs 称职Edit) | ≈持平(-6%) | 真实tokenizer实测 |
| MCP OUTPUT(vs 全文件Write) | -86% | 真实tokenizer实测 |
| MCP OUTPUT(弱模型+重试) | -50~71% | 真实tokenizer实测 |
| workflow FUTURE 基准 | `tl bench` / `bench-future.mjs` | 本地会计基准;真实命中率需会话数据 |
| 三层叠加综合 | 撤回(未端到端实测) | 见修订说明 |
| 通用方案天花板 vs Reasonix | -80% vs -97.7% | 差距=harness层 |

**核心命题**:省 token 不是一个目标,是三个正交的目标(INPUT/OUTPUT/FUTURE)。三个组件各攻一层(workflow→L3-L4 / MCP→L2 / gateway→L1),射程互补、收益叠加。能拿多少,取决于你愿意干预到哪一层——而每一层都已有可部署或设计完成的方案。
