# TokenLean 实现方案 + 与生态 Skills 的配合分析

> 本文分两部分:(1) 基于现有代码的系统实现方案;(2) 与 rtk / caveman / Headroom 等生态工具的配合与叠加分析。
> 所有"本项目"的数字均来自仓库内可复现的测试/基准,生态工具数字来自其官方/作者公开材料(已标注来源性质)。

---

# 第一部分:系统实现方案(基于现状代码)

## 1. 总览:三组件 × 四干预层

TokenLean 不是单个工具,而是按"能干预 agent 的哪一层"划分的三个组件。理解这点是理解一切的关键:

```
L4 用户/Prompt层   CLAUDE.md/AGENTS.md         ← 谁都能改
L3 行为/工具调用层  模型选哪个工具、读多少、写多紧  ← 组件① workflow
L2 工具 I/O 协议层  工具的输入输出格式(可加新工具) ← 组件② MCP server
L1 Harness 循环层   请求构造、消息排序、cache_control ← 组件③ gateway(设计)
```

| 组件 | 干预层 | 形态 | 状态 | 测试 |
|---|---|---|---|---|
| ① workflow | L3-L4 | skills + hooks,零依赖 | 已实现 | 35 通过 |
| ② MCP server | L2 | 单文件 MCP,stdio+http 双传输 | 已实现 | 38+19 通过 |
| ③ gateway | L1 | LLM 代理(注入缓存断点) | 设计稿 | — |

## 2. 组件① Workflow:skills + hooks(L3-L4)

### 2.1 模块清单与职责

| 模块 | 类型 | 维度 | 做什么 |
|---|---|---|---|
| `session-start.mjs` | Claude Code hook | INPUT | 会话启动时审计 CLAUDE.md,发现时间戳/UUID/超大/动态在前就注入告警 |
| `bash-guard.mjs` | hook(PreToolUse Bash) | FUTURE | 无界输出命令(cat/grep -r/find/log/test)拦截,给有界改写建议 |
| `write-guard.mjs` | hook(PreToolUse Write) | OUTPUT | 用 Write 覆写大文件时拦截,建议改 Edit |
| `precompact.mjs` | hook(PreCompact) | FUTURE | 压缩时注入"保留决策/约束/未决任务,丢弃原始输出"策略 |
| `cache-doctor.mjs` | lib | INPUT | 五类前缀不稳定模式检测(被 session-start 与 /cache-report 复用) |
| `bash-lint.mjs` | lib | FUTURE | 命令风险识别 + 有界改写(被 bash-guard 复用) |
| `hit-rate.mjs` | lib | INPUT | 解析会话 JSONL,算命中率/各档 token/估算节省 |
| `prefix-stable` / `surgical-edits` / `lean-context` | skills | 三维 | 行为引导:稳定前缀 / 紧凑编辑 / 精简上下文 |
| `/cache-report` `/lean-compact` `/token-audit` | commands | 观测+操作 | 命中率报告 / 受控压缩 / 三维快照 |
| `tokenlean.ts` | OpenCode plugin | 三维 | 把上述 hook 逻辑内联进 `tool.execute.before`,逻辑对齐 |

### 2.2 原理细节

**为什么 hook 是地基**:hook 在 agent 循环里确定性触发,不靠模型"记得"。`bash-guard` 不管模型多健忘,只要它要跑 `cat huge.log`,PreToolUse 就会拦下。这是 skill(只能建议)做不到的强制力。三种模式:`guard`(默认,ask+建议)、`auto`(直接改写命令)、`off`。

**诚实边界**:bash-guard 本质是**命令名黑名单**,天然不完备——`python -c open().read()`、`xxd`、`dd`、`jq`、`less`、`bat` 等读取方式会绕过。所以它是"尽力而为的提醒",不是"确定性强制有界"。

**INPUT 维度的真相**:workflow 对 INPUT **没有实际控制力**——cache-doctor 只能检测+告警,改不了 harness 怎么放缓存断点。真正动 INPUT 的是组件③。

### 2.3 部署

```bash
cd 01-workflow
bash install.sh                # 自动探测 Claude Code / OpenCode
bash install.sh --target claude --global   # 或全局装
```
最后一步:把 `settings.snippet.json` 合并进 `.claude/settings.json`(接上 hooks)。

### 2.4 预期效果(诚实区间)

FUTURE INPUT 维度最实(hook 真能拦无界输出):工具输出膨胀 -50~80%。OUTPUT 只能引导选对工具。INPUT 仅审计监控。综合 **-20~35%**。

## 3. 组件② MCP Server:hash 锚点编辑 + 有界工具(L2)

### 3.1 模块清单

| 文件 | 职责 |
|---|---|
| `lib/core.mjs` | 纯逻辑:6 工具 + MCP dispatch,传输无关 |
| `bin/stdio.mjs` | 本地 CLI 传输(NDJSON over stdin) |
| `bin/http.mjs` | 网页端传输 + Bearer 鉴权 + 会话管理 + DELETE 终止 |
| `tokenlean.mjs` | 统一启动器 `tokenlean stdio|http|test` |
| `test/bench-output.mjs` | 真实 BPE tokenizer 的 OUTPUT 基准(诚实公平基线) |

### 3.2 六个工具

| 工具 | 维度 | 机制 |
|---|---|---|
| `fs_outline` | FUTURE | 结构化目录 + 行锚点,~100 token 替代全量读 |
| `fs_read_hashed` | FUTURE | 分页读(默认200/上限600行),每行 4 字符 hash 锚点 |
| `fs_edit_hash` | OUTPUT | 按 `行:hash` 锚点替换,mismatch fail-fast,行号漂移自动重定位 |
| `fs_multi_edit_hash` | OUTPUT | 多处编辑,先全校验后原子应用 |
| `search_lean` | FUTURE | 正则搜索,硬预算(25/上限80条,行截200字符) |
| `token_report` | 观测 | 会话级 OUTPUT 计量(明确标注"vs全量重写为上界") |

### 3.3 关键原理 + 一个重要的诚实修正

**hash 锚点的真实价值**:经审查用真实 BPE tokenizer + 公平基线(称职模型写的最小唯一 old_str)实测——

| 被替换行数 | vs 全量重写 Write | vs 称职 native Edit |
|---|---|---|
| 单行 | 87% | ~0% |
| 3-9 行 | 82-84% | **-6~-11%(略差)** |
| 删除 | 91% | 视情况 |

**结论:hash 锚点编辑相对称职模型几乎不省 OUTPUT token,唯一大胜是 vs 全量文件重写(86%)。** 它的真实价值是:① fail-fast 安全(过期内容不会被静默改错)② 弱模型可靠性(避免 old_str 不匹配的重试循环,这正是 omp Hashline 在弱模型上 6.7%→68.3% 成功率的来源)③ 配套的有界读/搜真正省 FUTURE INPUT。早期"-40~55%"是拿稻草人基线(复述整块)算的,已更正。

**安全修复(审查发现)**:旧版 2 字符 hash + 重定位窗口,单行编辑锚点过期时有 27% 概率被静默改到错误行。已修为 4 字符 hash + 单行拒绝重定位 + 多匹配拒绝,蒙特卡洛验证误改率 27%→0%。

### 3.4 两种部署形态(对应不同客户端)

**本地 CLI(stdio)**——agent spawn 子进程,文件本地,无需鉴权:
```bash
# .mcp.json
{"mcpServers":{"tokenlean":{"command":"node","args":["/abs/tokenlean.mjs","stdio","--root","."]}}}
# 关键:settings.json permissions.deny ["Edit"] 强制走 hash 编辑(否则采用率不保证)
```

**网页端 copilot(http)**——远程连接,强制鉴权+会话隔离+沙箱:
```bash
TOKENLEAN_TOKEN=$(openssl rand -hex 16) node tokenlean.mjs http --root /srv/repo --read-only
# 经 cloudflared 隧道暴露给 Claude.ai 连接器
```

### 3.5 预期效果

OUTPUT:vs 全量重写 -86%,vs 称职 Edit ≈ 0(主要是安全/可靠性收益)。FUTURE INPUT:有界工具真实 -50~80%。

## 4. 组件③ Gateway:缓存断点注入(L1,设计稿)

### 4.1 为什么必须是网关

INPUT 维度(prefix cache 命中)的本质是 harness 怎么构造请求——消息排序、cache_control 断点位置、TTL。skills/MCP 都够不到。唯一对任意 agent 透明的干预点,是 agent 与 LLM API 之间的代理(改 base_url)。

### 4.2 设计的四件事

```
任意 Agent ──base_url──▶ gateway ──▶ Anthropic/OpenAI/DeepSeek
                          ├─ 注入 cache_control 断点(system尾+倒数第二条消息)
                          ├─ 强制 ttl="1h"(防 5min 静默降级)
                          ├─ 前缀漂移检测(相邻请求 system 前缀变化即告警)
                          └─ hit/miss 统计 → 命中率仪表盘
```

### 4.3 一个重要发现:这一层已有成熟开源实现

调研发现 **Headroom 的 `CacheAligner` 正是这一层**——"stabilizes dynamic content so caches actually hit"。LiteLLM 也原生支持 `cache_control_injection_points`。**所以组件③ 不必从零造,可直接用 Headroom 或 LiteLLM 充当,把精力集中在 ①② 的差异化上。** 这是务实的结论:gateway 层是红海,不重复造轮子。

---

# 第二部分:与生态 Skills 的配合与叠加分析

## 5. 生态工具速览(基于公开资料)

| 工具 | 干预层 | 维度 | 机制 | 公开宣称 |
|---|---|---|---|---|
| **rtk** (Rust Token Killer) | L3(PreToolUse hook) | FUTURE | 拦 Bash,把 git/test/docker/find 等输出压缩重写 | 60-90% CLI 输出削减(2900+命令实测) |
| **caveman** | L4/L3(输出风格) | OUTPUT | 让模型"像原始人说话",砍叙述性废话,保留代码/技术准确 | 输出 token -65%(峰值87%) |
| **Headroom** | L1(API 代理) | INPUT+FUTURE | 代理压缩 tool 输出/日志/RAG;CacheAligner 稳定前缀 | 60-95% token,95%+准确率保持 |
| **Codebase Memory / CodeGraph** | L2-L3 | FUTURE | 用知识图谱替代文件读 | 代码发现 -99% |
| **claude-code-router** | L1(路由) | 难易路由 | 简单任务路由到便宜/本地模型 | 视配置 |

## 6. 与本项目的关系:互补还是重叠?

关键判断标准:**是否作用在同一维度的同一层**。同维同层 = 竞争(择一);不同维或不同层 = 叠加。

| 生态工具 vs 本项目组件 | 关系 | 说明 |
|---|---|---|
| **rtk** vs workflow 的 bash-guard | **重叠且 rtk 更强** | 都拦 Bash 输出。rtk 用 Rust 真正压缩重写输出内容,bash-guard 只是黑名单+建议改写。**建议:用 rtk 替代 bash-guard**,保留 workflow 的其余 hook |
| **caveman** vs 本项目 | **完全正交,强叠加** | caveman 砍的是模型生成的**叙述文本**(OUTPUT 的自然语言部分);本项目 OUTPUT 优化针对**编辑格式**。两者作用于 OUTPUT 的不同子集,可乘法叠加 |
| **Headroom** vs 组件③ gateway | **Headroom 即组件③** | 直接用 Headroom 充当 gateway 层,本项目不再自造 |
| **Headroom** vs MCP server | **部分重叠 + 互补** | Headroom 压缩 tool 输出(FUTURE);MCP 的有界读/搜也做 FUTURE。但 MCP 的 hash 编辑(OUTPUT 安全)Headroom 没有。**建议:MCP 管编辑安全,Headroom 管输出压缩** |
| **CodeGraph** vs MCP 的 fs_outline | **CodeGraph 更彻底** | fs_outline 每次现算大纲;CodeGraph 预建知识图谱跨会话复用。大项目用 CodeGraph,小项目 fs_outline 够 |
| **claude-code-router** vs 本项目 | **完全正交,新维度** | 路由是本项目完全没覆盖的"难易问题路由"维度,纯叠加 |

## 7. 叠加是否真能成立?——三条铁律

**铁律1:同维同层只能择一。** bash-guard 和 rtk 都在 L3 拦 Bash,装两个会冲突(都改同一条命令)。择 rtk。

**铁律2:不同维度乘法叠加。** caveman(OUTPUT叙述)× MCP(OUTPUT编辑安全)× Headroom(FUTURE压缩)× gateway(INPUT命中)作用于不同 token 子集,理论上收益相乘。但——

**铁律3:压缩类工具会互相吃掉边际收益,且可能破坏缓存。** 这是最容易被忽视的。Headroom 压缩历史 = 改写前缀 = **破坏 prefix cache**(INPUT 维度受损)。所以 Headroom 的 CacheAligner 必须和它的压缩协同;若你在 Headroom 之外又叠一层压缩,第二层几乎没有边际收益,还可能二次破坏缓存。**压缩层只应有一个。**

## 8. 推荐的叠加配置(务实版)

按"每维度一个最强工具、避免同层冲突"原则:

```
INPUT  (缓存命中)  → Headroom CacheAligner / LiteLLM 断点注入   [选1]
                     + 本项目 cache-doctor 做 CLAUDE.md 预防性审计(不冲突,纯预防)
OUTPUT (编辑)      → 本项目 MCP fs_edit_hash(安全+弱模型可靠)
OUTPUT (叙述)      → caveman(砍废话)
FUTURE (工具输出)  → rtk(CLI压缩) + Headroom(其余输出压缩)   [分工:rtk管shell,Headroom管其余]
FUTURE (代码发现)  → CodeGraph(大项目) / 本项目 fs_outline(小项目)
路由   (难易)      → claude-code-router
纪律   (全局)      → 本项目 workflow 的 precompact/skills(行为引导,不与任何工具冲突)
```

**本项目在这套组合里的独特位置**:① MCP 的 hash 编辑是唯一带"过期内容 fail-fast 安全"的编辑层(其他工具都不管编辑安全)② workflow 的 cache-doctor 是唯一做 CLAUDE.md **预防性**审计的(其他都是事后压缩)③ precompact 纪律与任何工具都不冲突。**本项目的差异化不在"压得最狠",而在"安全 + 预防 + 可观测"。**

## 9. 综合预期(诚实)

单独本项目:-20~35%。叠加生态最优组合:各家宣称相乘理论可达 -85~92%(与那篇 Medium "5 工具堆叠 90%+"一致),但实际受铁律3 限制,压缩类边际递减,真实落地通常 -70~85%。

**最大的不确定性仍是:模型是否真的采用这些工具(采用率),以及压缩对任务质量的真实影响。** 这两点需要真实 agent 长期实测,本系列尚未覆盖。
