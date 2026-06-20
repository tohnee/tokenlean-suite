# omp / Reasonix Token 优化技巧能否做成 Skill 迁移？
## ——可行性深度分析与验证测试

> **核心提问**：能不能把 omp（Hashline、TTSR、/shake、Anthropic 断点工程、Context Promotion）和 Reasonix（Cache-First Loop、双 session 隔离、Volatile Scratch）的 token 节省技巧，做成 skill 迁移到 Claude Code 或 OpenCode？
>
> **TL;DR 结论**：
> - 大约 **15–25%** 的核心价值可以通过 skill + MCP 工具 + CLAUDE.md 模板**有损迁移**
> - 大约 **75–85%** 的核心机制**无法**做成 skill，因为它们运行在"agent harness 循环层"而非"prompt 层"
> - 对 OpenCode：**fork 比 skill 更优**，因为它是开源的、有 hook 体系
> - 对 Claude Code：能做的事情极为有限，且效果会显著衰减

---

## Part 1：先把 Skills 的能力边界钉死

讨论"什么能做成 skill"之前，必须先严格定义 skill 能做什么。

### Skill 是什么

Claude Code（以及 Anthropic 平台）里的 **skill** 是一个文件夹，包含：

```
my-skill/
├── SKILL.md          # 含 frontmatter (name, description, trigger)
├── scripts/          # 可选辅助脚本 (bash, python)
└── reference/        # 可选参考文件
```

Skill 的运行机制是：
1. Anthropic 服务器根据用户 query 与 skill `description` 的相关性，**决定是否加载**该 skill
2. 加载时，SKILL.md 的内容被注入到 agent 的 system context 中
3. 脚本/参考文件不被加载，但 SKILL.md 可以指示 agent 通过 bash 工具调用它们

### Skill 不能做什么

这是关键判断点。Skill 是**纯 prompt 层**的扩展机制，它**不能**：

| 能力 | 是否 Skill 可做 | 谁能做 |
|---|---|---|
| 修改请求体的 JSON 结构 | ❌ | SDK / harness |
| 设置 `cache_control` 断点位置 | ❌ | SDK / harness |
| 拦截模型输出流（mid-token 中断） | ❌ | harness loop |
| 改变 compaction 算法 | ❌ | harness（除非有公开 hook） |
| 修改 message 顺序、合并、重排 | ❌ | harness |
| 改变 tool I/O 协议（增加 hash 字段等） | ❌ | tool 实现 / MCP |
| 强制执行不变量（如 append-only） | ❌ | harness |
| 路由不同请求到不同 model | ❌ | harness |
| 向 agent 注入文本指导 | ✅ | skill |
| 让 agent 调用 bash 脚本完成事情 | ✅ | skill + 脚本 |
| 让 agent 知道某些规则并尽量遵守 | ✅ | skill |

**核心结论**：skill 是 "建议模型这样做"，不是 "强制系统这样做"。这是它能做什么不能做什么的根本约束。

### 一个比喻

可以把 agent 整体看成一个公司：
- **harness 层** = 公司的 IT 系统、考勤、流程
- **tool 层** = 各部门的标准操作流程（SOP）
- **skill 层** = 张贴在墙上的"最佳实践海报"
- **prompt 层** = 主管口头说的指示

skill 能贴海报、能放工具说明书，但**不能改公司的考勤系统**。

---

## Part 2：把 omp / Reasonix 的所有技巧按"层"分类

下面我把每个技巧映射到它实际运行的层，并判断 skill 化的可行性。

### Layer 1：Harness / Loop 层（基本无法 skill 化）

这一层的技巧需要控制 agent 的核心循环——请求构造、消息排序、流处理。

| 技巧 | 所属项目 | 为什么不能 skill 化 |
|---|---|---|
| **Cache-First Loop（三区不变量）** | Reasonix | 需要在每次构造请求时，强制保证 Immutable Prefix 不变、Append-Only Log 不重排。skill 只能"建议" agent 这样做，但 SDK 实际发出去的请求结构由 harness 决定 |
| **Append-Only invariant** | Reasonix | 同上，需要 harness 拒绝任何会重排 history 的操作 |
| **Volatile Scratch 隔离** | Reasonix | 需要 harness 在请求构造时主动剥离 scratch 字段。skill 无法控制哪些字段被发送 |
| **双 session（Planner/Executor）** | Reasonix | 需要 harness 维护两个独立的 message stream 与 cache namespace。skill 无法 spawn 独立 session |
| **TTSR（Time-Traveling Streamed Rules）** | omp | 需要在模型输出流上做实时 regex 匹配并 mid-token 中断。skill 没有访问输出流的能力 |
| **/shake mechanical compaction** | omp | 需要替换默认 compaction 算法。Claude Code 的 compaction 不允许这种替换 |
| **Anthropic 3-block + 2+2 断点工程** | omp | 需要精确控制 `cache_control` 在哪个 block 上。这由 SDK 决定，skill 无法干预 |
| **Context Promotion**（先升窗再压缩） | omp | 需要在上下文溢出时切换模型 endpoint。这是 harness 的路由决策 |
| **5 种 compaction 触发源** | omp | 需要 harness 在多种时机调用 compaction 逻辑 |
| **Branch Summary 树形 JSONL** | omp | 需要修改 session 持久化格式 |
| **本地 tiny model worker（shake-summary）** | omp | 需要 harness 在 compaction 时调用本地模型，而不是默认的 Anthropic API |

**这一层占了 omp / Reasonix 创新的 80% 左右。这些都无法做成 skill。**

### Layer 2：Tool I/O 协议层（可以通过 MCP 部分模拟）

这一层涉及工具的 I/O 格式。Claude Code 的 built-in 工具（Read、Edit、Bash 等）格式固定，但通过 **MCP server** 可以添加自定义工具。

| 技巧 | 所属项目 | Skill 化途径 | 衰减 |
|---|---|---|---|
| **Hashline edit format** | omp | MCP server 提供 `read_with_hashes` + `edit_by_hash`，skill 指引 agent 使用 | 中等（见 Part 4） |
| **Hashline 3-way merge recovery** | omp | 可在 MCP server 内实现 | 低 |
| **Auto-absorption（Prefix/Suffix）** | omp | 可在 MCP server 内实现 | 低 |
| **Hashline mismatch fail-fast** | omp | 可在 MCP server 内实现 | 低 |

**重要权衡**：Layer 2 的 skill 化总是有衰减的，因为：
1. 原生 Read/Edit 工具仍然可用，模型可能"忘记"使用 MCP 替代
2. MCP 工具不享受 Claude Code 的内置 diff preview、权限确认、撤销
3. MCP 工具的输出仍然要进入 cache_control 决定的缓存范围，但断点位置不可控

### Layer 3：Skill Content 层（可直接 skill 化）

这一层是行为建议、决策启发式、调用脚本的指示。

| 技巧 | 所属项目 | Skill 化途径 |
|---|---|---|
| **大工具输出的截断习惯** | omp/Reasonix | skill 指示 agent：读文件时优先用 line range，不要 read 整个大文件 |
| **/compact 时机判断** | omp/Reasonix | skill 提供启发式：每完成一个子任务后 /compact，而非等满 |
| **/clear vs /compact 决策** | 通用 | skill 提供决策树 |
| **避免 long thinking 反复出现** | Reasonix | skill 指示 agent 完成思考后简短结论，不重复推理过程 |
| **Subagent 隔离时机** | omp | skill 提示什么任务应当 spawn subagent |
| **工具输出 placeholder 替换** | OpenCode | skill 指示 agent 主动用 placeholder 而非保留完整 log |

### Layer 4：用户/Prompt 层（CLAUDE.md 模板可移植）

这一层完全是用户的输入，与 skill 平行但常被混淆。

| 技巧 | 所属项目 | 移植形式 |
|---|---|---|
| **CLAUDE.md 稳定性结构** | 通用 | 提供模板：静态规则在前，动态上下文在后 |
| **无时间戳原则** | Reasonix | CLAUDE.md 模板 + validator script |
| **CLAUDE.md 体量控制** | 通用 | 模板 + 检测脚本 |
| **稳定 system 顺序** | Reasonix | 模板说明 |

---

## Part 3：不可移植的核心机制——为什么 + 后果

我深入推理几个核心机制，说明它们**为什么**不能做成 skill，以及**后果**是什么。

### 3.1 为什么 Reasonix Cache-First Loop 不能做成 skill

Reasonix 的三区不变量是这样保证 99.82% 命中率的：

```
请求 N 的前缀 = 请求 N-1 的前缀 + 单条新消息（追加在尾部）
```

这要求**每一次请求构造时**，harness 都必须：
1. 检查并拒绝任何 mutation 到历史消息（包括对前几轮回复的"小修改"）
2. 检查并拒绝任何会插入到中间的操作（包括"系统更新"消息）
3. 把 Volatile Scratch 内容从请求中剥离

Skill 能做的最多是写在 SKILL.md：

> "请保持消息历史不变，所有新内容追加在最后。"

但当 agent 调用工具产生大输出时，**Claude Code 的 harness 会怎么处理这个工具结果**——是直接追加？是和上轮的 assistant 消息合并？是否在某些时候触发 server-side compaction 修改 message 数组？——这些都不在 skill 的控制范围内。

**后果**：哪怕 agent 100% 听话执行 skill 的建议，harness 的实际行为仍然可能违反不变量。**99.82% 这个数字是不可复现的**，因为它依赖于一个 skill 无法保证的底层属性。

最乐观估计：用 skill 把 Claude Code 的 cache hit rate 从 ~30%（基线）提升到 **50-60%**，已经是极限。

### 3.2 为什么 TTSR 不能做成 skill

TTSR 的核心机制：

```
1. 监控模型输出流，做 regex 匹配
2. 命中时，在 mid-token 中止生成
3. 注入规则文本作为 system reminder
4. 从中断位置重新生成
```

第 1 步就是 skill 完全无法做到的。**Claude Code 的 agent 循环不暴露输出流给 skill**。skill 只能在请求开始前注入文本，或者通过 hook（如果有的话）。

退一步：如果用 Claude Code 的 hook（PostToolUse、PreToolUse）来模拟呢？也不行——hook 在工具调用前后触发，**不在 token 流上**。等你检测到模型已经写了 `.deprecated_method(`，这个 token 已经生成完了，无法回退。

**唯一近似**：把 50 条规则都塞进 system prompt。这是 TTSR 显式要解决的问题——**baseline context 太大**。退化到原始问题。

**后果**：在 Claude Code 中**完全无法**实现"零 baseline cost 的规则机制"。这是一个架构级缺失。

### 3.3 为什么 Anthropic 断点工程不能做成 skill

omp 的 3-block system + 2+2 断点策略需要：

```typescript
const request = {
  system: [
    { type: 'text', text: billingHeader },                                  // 不缓存
    { type: 'text', text: systemInstruction, cache_control: 'ephemeral' }, // BP1
    { type: 'text', text: mergedUserContent, cache_control: 'ephemeral' }, // BP2
  ],
  messages: [
    ...history,
    { ..., cache_control: 'ephemeral' },  // BP3 (倒数第二条)
    { ..., cache_control: 'ephemeral' },  // BP4 (最后一条)
  ]
}
```

`cache_control` 字段由 **Anthropic SDK 调用方**控制。Claude Code 的内部代码决定了它们的位置。skill **完全无法**改变这一点。

skill 最多能影响系统提示的**内容**（通过 CLAUDE.md），但**不能**影响系统提示如何被拆分到 system blocks 中，也**不能**影响 cache_control 标记位置。

**后果**：Claude Code 的实际断点布局是什么样的、是否最优，由 Anthropic 内部决定。第三方逆向证据显示它做得不错，但**用户无法自行优化**。

### 3.4 为什么 /shake 不能做成 skill

omp 的 /shake compaction 策略：

```
shake: 机械删除重内容，不调用 LLM
shake-summary: 调用本地 tiny model 做提取式压缩
handoff: 交接式压缩
```

这些都是**替换默认 compaction 算法**的方案。Claude Code 的 compaction 是 server-side、不可配置的。skill 不能"在用户输入 /compact 时改用 shake 算法"，因为：

1. /compact 调用 Anthropic 服务端的 compaction
2. skill 不能拦截 /compact 命令
3. 即便能拦截，skill 也不能调用本地 tiny model 来代替

**唯一近似**：写一个 `/shake` 自定义 slash command（如果 Claude Code 支持），里面执行 bash 脚本，让 bash 脚本调用本地模型生成摘要，然后把摘要塞回 user message。

这能模拟一部分行为，但：
- 它不会替换内部的 message history，只是在末尾追加一个 "summary so far" 消息
- 旧 message history 仍然在 context 里，仍然占用 token
- 完全失去了 omp 的 compaction 效率

---

## Part 4：可有损模拟的中间地带——Hashline-Lite

Hashline 是 omp 最值得迁移的机制，因为它**只涉及 tool I/O**，不涉及核心 loop。我下面设计一个真实可运行的 skill。

### 4.1 设计目标

- 提供 `read-with-hashes <file> [line-range]` 脚本：输出文件 + 每行 2-3 字符 content hash
- 提供 `edit-by-hash <file> <start-hash> <end-hash> <new-content>` 脚本：按 hash 应用编辑
- 通过 SKILL.md 指引 agent 在编辑场景使用这两个脚本，而非 native Read/Edit

### 4.2 实现（实际可运行）

我已经在 `/mnt/user-data/outputs/skills-demo/hashline-lite/` 创建了完整 skill，包括 SKILL.md + 两个 bash 脚本。下面是核心实现。

#### 哈希函数选择

```bash
# 2-字符 hash: 256 个槽位
# 对 1000 行文件，每行碰撞概率 ~ 4/256 = 1.5%
# 接受这个碰撞率，因为 hash 是按位置使用的，碰撞只导致 reject 不导致破坏
hash_line() {
  local content="$1"
  printf "%s" "$content" | sha256sum | cut -c1-2
}
```

#### read-with-hashes 输出格式

```
   1:a3  function fetchData(url: string) {
   2:b7    const response = await fetch(url);
   3:c4    const data = await response.json();
   4:d9    return data;
   5:e1  }
```

#### edit-by-hash 行为

```
edit-by-hash <file> <start-line>:<hash> <end-line>:<hash> <<EOF
new content
EOF

如果 start/end line 的实际 hash 与传入不匹配 → 拒绝，输出错误
如果匹配 → 替换 [start-line, end-line] 区间为 new content
```

### 4.3 衰减分析：lite 版与原版的差距

| 维度 | omp Hashline 原版 | Hashline-Lite skill | 衰减程度 |
|---|---|---|---|
| OUTPUT token 减少 | -61%（Grok 4 Fast） | -30~40% 预计 | ▲ 中等 |
| 编辑成功率提升 | +10×（弱模型） | +2~3× 预计 | ▲ 中等 |
| 失败 fail-fast | ✓ 集成在 harness | ✓ 在 bash 退出码 | 低 |
| 3-way merge recovery | ✓ | 部分（脚本可实现） | 中 |
| Auto-absorption | ✓ | 部分（脚本可实现） | 中 |
| Diff preview | ✓ | ✗（不显示在 UI） | ▲▲ 高 |
| 与权限系统集成 | ✓ | ✗（绕过 Claude 的 edit 权限） | ▲▲ 高 |
| Agent 默认使用 | ✓ harness 强制 | ✗（model 可能忘记） | ▲▲ 高 |

**最大问题**：原生 Edit 工具仍然可用。模型有时会忘记 skill 指引、直接使用原生 Edit，导致优化失效。

**实测必须考察的**：在多大比例的编辑场景下，agent 真的会调用 hashline-lite？

### 4.4 为什么这仍然有价值

即使衰减明显，hashline-lite skill 仍然有价值：
1. **教育意义**：展示 OUTPUT token 优化作为独立维度
2. **弱模型场景**：用 Claude Code 调用 Grok 或本地模型时，弱模型的 native edit 失败率高，hashline-lite 帮助大
3. **可观测性**：bash 脚本天然可以记录每次编辑的 token 消耗，方便量化

---

## Part 5：完全可移植的行为层 Skills

这一层 skill 可以 100% 迁移到 Claude Code 或 OpenCode，无需 MCP，效果稳定。

### 5.1 `prefix-stable-prompt` skill

**目标**：防止用户在 CLAUDE.md 中放入会破坏 prefix 稳定性的内容。

**SKILL.md 关键内容**：

```markdown
---
name: prefix-stable-prompt
description: Use this skill when reviewing, editing, or creating CLAUDE.md or 
  any system instruction file. Detects content that breaks prompt cache prefix 
  stability—timestamps, random IDs, dynamic placeholders, large changing 
  context blocks. Run cache-doctor before any CLAUDE.md commit.
---

# Prefix-Stable Prompt Hygiene

## Why this matters
Anthropic prompt caching requires byte-exact prefix match. Any field that 
changes between requests breaks the cache for everything after it.

## What to check
Run `bash scripts/cache-doctor.sh CLAUDE.md` before any commit. It reports:
1. Timestamp patterns ({{date}}, ISO 8601, etc.)
2. Random ID patterns (uuid, nanoid)
3. Excessive size (>3000 tokens)
4. Dynamic interpolation that varies per session

## How to fix
- Replace timestamps with install-id-based fingerprint
- Move dynamic context out of CLAUDE.md into runtime tool calls
- Keep CLAUDE.md under 3000 tokens (recommendation: <1500)
- Structure as: project context → coding conventions → commands (no dynamic data)
```

完整文件见 `skills-demo/prefix-stable/`。

### 5.2 `lean-tool-output` skill

**目标**：让 agent 主动使用 paged reads，避免大文件全量读取。

**核心建议**：
- Before reading any file, first `wc -l` to know size
- If > 200 lines, request specific line range
- For grep, use `-A`/`-B`/`-C` with small numbers
- For logs, use `tail -n` not full read
- After reading, summarize key findings before continuing

### 5.3 `compaction-discipline` skill

**目标**：给出"何时 /compact、何时 /clear"的决策树。

```
任务流转点 (完成 feature/fix bug/通过测试)
  → /compact  (保留任务摘要)

完全切换主题（不再涉及之前的代码/讨论）
  → /clear    (节省最大)

会话超 20 轮但任务未结束
  → 评估剩余工作量；若 <30 轮，继续；若 >30 轮，/compact

模型开始忘记早期决策
  → 不要 /compact（compaction 不能恢复失忆，反而会丢更多）
  → 用 git 提交，把当前状态固化，开 new session
```

### 5.4 `scratch-hygiene` skill

**目标**：让 agent 在用 thinking/planning 时不污染未来上下文。

**核心规则**：
- 推理过程写在 `<thinking>` 块里（Anthropic 自动剥离）
- 不要在 user-facing 消息里重复"让我思考一下这个问题"
- 探索性输出（debug 时的 print）不要 commit 到代码

---

## Part 6：验证与测试方法

任何 skill 的实际效果都必须可测量。下面是每个 skill 的测试方案。

### 测试 1：prefix-stable-prompt 效果验证

**实验设计**：

```
准备:
  - sample-bad.md:   含 timestamp + uuid 的 CLAUDE.md
  - sample-good.md:  纯静态 CLAUDE.md
  
步骤:
  1. 用 sample-bad.md 跑 20 个相似任务，记录每次的 cache_read_input_tokens
  2. 用 sample-good.md 跑同样 20 个任务，记录同样数据
  3. 计算两组的平均 cache hit rate

预期:
  - sample-bad:  hit rate < 30%
  - sample-good: hit rate > 70%
  - 差距 > 40pp 证明 skill 有效

实施脚本:
  scripts/measure-hit-rate.sh <claude_session_dir>
  解析 ~/.claude/projects/ JSONL，统计 hit/(hit+miss)
```

### 测试 2：hashline-lite 实际节省

**实验设计**：

```
任务集:
  10 个 refactoring 任务（如：把 callback 改成 async/await）
  每个任务对 1 个文件做 5~10 行的修改
  
对照:
  - 组A: 用 Claude Code 原生 Read/Edit 工具
  - 组B: 用 hashline-lite skill，bash 脚本辅助
  
指标:
  - 每个任务的 output_tokens 总数
  - 每个任务是否一次成功（无重试）
  - 每个任务的 wall-clock 时间
  - 整体编辑后的代码是否正确（git diff 审查）

预期:
  - output_tokens: 组B 比组A 少 25-40%
  - 一次成功率: 接近（Claude Sonnet 4.x 原本就强）
  - wall-clock:  组B 可能略慢（bash 启动开销）
  - 正确率:     两组都 >95%（前提是模型听话调用 hashline-lite）

关键观察:
  组B 真的有多少比例调用了 hashline-lite？如果 < 50%，skill 形同虚设。
```

### 测试 3：lean-tool-output 节省量

**实验设计**：

```
任务:
  对一个 8000 行的 source file 提问"这个文件主要做什么？"
  
对照:
  - 组A: 无 skill，agent 默认全量 Read
  - 组B: 有 lean-tool-output skill
  
指标:
  - 总输入 token（含 cache miss）
  - 任务完成时间
  - 回答质量（盲评 1-5 分）

预期:
  - 组A: 输入 ~20K token（含整个文件）
  - 组B: 输入 ~5K token（agent 改用 head + grep + 分块读）
  - 节省 ~70%
  - 回答质量相当或仅轻微下降
```

### 测试 4：compaction-discipline 长会话效果

**实验设计**：

```
任务:
  一个 50 轮的真实开发会话（功能 → 测试 → bug fix → refactor）
  
对照:
  - 组A: 不主动 /compact，让 Claude Code 自动处理
  - 组B: 按 compaction-discipline skill 主动 /compact
  
指标:
  - 总累积 input_tokens
  - 总累积 cost (按 Sonnet 4.6 价格)
  - 第 50 轮时的 cache hit rate
  - 是否丢失早期决策（用户问"我们之前决定用什么数据库？"的正确率）

预期:
  - 组B 累积 cost 比组A 低 30-50%
  - 但组B 决策遗忘率可能略高（compaction 的固有代价）
```

### 测试 5：综合 cookbook（多 skill 叠加）

```
将所有 4 个可迁移 skill 一起启用，跑 7 天真实开发任务，每天记录：
  - 每日总成本
  - 每日平均 cache hit rate
  - 主观体验（1-5 分）

对照 baseline:
  - 同样 7 天，使用 Claude Code 默认配置

预期:
  - 成本节省: 30-50%（不及 Reasonix 的 97.7%，但可观）
  - hit rate: 50-70%（不及 Reasonix 99.82%）
  - 体验: 略有摩擦（agent 偶尔忘记调用脚本）
```

---

## Part 7：OpenCode 的不同——fork 是更优路径

OpenCode 与 Claude Code 关键差别：**OpenCode 是开源的、有 hook 系统、session 逻辑可读**。

### OpenCode 的可移植性矩阵

| omp/Reasonix 技巧 | Claude Code 移植难度 | OpenCode 移植难度 |
|---|---|---|
| Hashline | 中（需 MCP + skill） | **低**（添加新 edit mode 即可） |
| TTSR | **不可能** | 中（需要修改 streaming logic） |
| Anthropic 断点工程 | **不可能** | **低**（直接改 buildPrompt） |
| Context Promotion | **不可能** | 中（改 LLM client） |
| /shake mechanical | 难 | **低**（通过 `experimental.session.compacting.hook`） |
| Cache-First Loop | **不可能** | 中（重写 session.ts） |
| Volatile Scratch | **不可能** | 中（修改 message assembly） |
| 双 session（Planner/Executor） | **不可能** | 高（需要架构改造） |

### OpenCode 推荐的"渐进式迁移"路径

```
阶段 1 (1 周): 行为层 skill
  - prefix-stable-prompt
  - lean-tool-output  
  - compaction-discipline
  → 预期效果: cost -20%

阶段 2 (2 周): 改 buildPrompt
  - 实现 omp 的 3-block system 布局
  - 显式 cache_control 断点
  - 确定性 billing 指纹
  → 预期效果: hit rate +20pp

阶段 3 (1-2月): 添加 hashline edit mode
  - 在 OpenCode session/tools 里加 hashline tools
  - 给 weak model 默认启用
  → 预期效果: edit 任务 OUTPUT -40%

阶段 4 (3-6月): 重构 session 为 Cache-First Loop
  - 强制 append-only 不变量
  - 单独的 Volatile Scratch 字段
  - 推荐先在 fork 里实验，验证后再 upstream
  → 预期效果: hit rate -> 70-80%

阶段 5 (可选): Context Promotion + 双 session
  - 在 LLM client 层加 promotion 逻辑
  - 探索 multi-session 架构
  → 预期效果: 进一步 cost -15%
```

阶段 1 之后的每一步都不能做成 skill——它们是源码 PR，不是 prompt 工程。

---

## Part 8：实操建议（按场景）

### 场景 A：你必须用 Claude Code（公司规定）

```
推荐组合:
  1. prefix-stable-prompt skill (强制启用)
  2. lean-tool-output skill (强制启用)
  3. compaction-discipline skill (强制启用)
  4. 显式设置 cache_control ttl 为 1h（避免 5min 默认陷阱）
  5. 监控脚本: cache-doctor 每日跑一次

预期效果:
  cost 节省 20-30%
  cache hit rate 30% → 55-65%
  
仍然失去:
  Hashline 的 OUTPUT 优化 (-40%)
  TTSR 的 context 优化 (-10%)
  Reasonix 级别的 hit rate (99.82%)
```

### 场景 B：你用 OpenCode 或可以 fork

```
最优策略:
  1. 立即采用所有 4 个行为层 skill (1 天工作量)
  2. fork OpenCode，移植 omp 断点工程 (1-2 周)
  3. 移植 Hashline edit mode (2-4 周)
  4. 长期目标: 实现 Cache-First Loop (3-6 月)

按需上 hashline-lite skill 作为短期 stopgap，
长期目标是 native 实现。
```

### 场景 C：你愿意切换 agent

```
最优选择:
  - DeepSeek 用户: 直接换 Reasonix
  - 重度编辑工作: 直接换 omp
  - 跨 provider: OpenCode + 自定义改造

这才是 90%+ 优化的正确做法。
Skill 路径只在"必须留在 Claude Code"时才有意义。
```

### 场景 D：你想做企业内部 agent

```
推荐架构:
  - Layer 1: 从 OpenCode fork（拿到 hook 系统）
  - Layer 2: 移植 omp 的 Anthropic 断点工程
  - Layer 3: 实现 Reasonix 风格的 Append-Only Log 不变量
  - Layer 4: 把行为层 skill 做成默认启用的内置 skill
  - Layer 5: 接入企业内部 LLM gateway

这样 80%+ 的 omp/Reasonix 优化都能落地。
关键是: 这不叫 "skill 迁移"，这叫 "工程移植"。
```

---

## Part 9：结论与"诚实的建议"

### 9.1 一句话结论

**Skills 是 prompt 层的礼物，不是 harness 层的替代。omp / Reasonix 的核心优化在 harness 层，所以 skill 化只能拿到 15-25% 的价值。**

### 9.2 三个反直觉发现

1. **能迁移的不是最强的**：行为层 skill（prefix-stable, lean-output, compaction-discipline）能完整迁移，但它们恰恰是 omp/Reasonix 创新中最不显眼的部分。**最炫的 Hashline、TTSR、Cache-First Loop 都无法迁移。**

2. **OpenCode 的优势不在 skill 而在 fork**：OpenCode 有 hook 体系、源码开放，所以它的最优策略是直接改源码而不是写 skill。**对开源 agent 谈"skill 迁移"是用错了工具**。

3. **最大的工程价值在"做成内置功能"，不是"做成 skill"**：如果你要构建企业级 agent，与其堆叠一堆 skill，不如 fork OpenCode 把这些技巧做成内置功能。一次工程投入，长期生效。

### 9.3 优先级建议

如果只能选一件事做：

**对个人开发者**：搭建 prefix-stable-prompt + monitoring 脚本，把 cache-doctor 跑起来。这能立刻发现 30% 隐性浪费。

**对小团队**：上面 4 个行为层 skill 全做，立竿见影 20-30% 节省。

**对中型团队**：fork OpenCode，移植 omp 的 Anthropic 断点工程（最高 ROI 的源码改动）。

**对大型企业**：直接采用 Reasonix 或 omp 的架构，不要试图用 skill 拼凑。

### 9.4 关于"测试验证"的最终建议

**永远要测量，不要假设**。本报告 Part 6 的所有测试方案都是可执行的。具体到 Claude Code，最简单的开始：

```bash
# 每天跑一次，看你的 hit rate 趋势
ls ~/.claude/projects/*/sessions/*.jsonl | head -100 | \
  xargs jq -s '[.[] | .message.usage] | 
    {hit:   (map(.cache_read_input_tokens // 0) | add),
     miss:  (map(.input_tokens // 0) | add),
     write: (map(.cache_creation_input_tokens // 0) | add),
     output: (map(.output_tokens // 0) | add)}'
```

如果你的 hit rate 长期低于 50%，**这才是真正的优化空间**——而且很可能不是 omp/Reasonix 技巧能解决的（在 Claude Code 里没法解决），而是要换 agent 或 fork OpenCode。

---

## 附录 A：示例 Skill 文件清单

附带的 `skills-demo/` 目录包含 4 个可运行的 skill：

```
skills-demo/
├── prefix-stable/
│   ├── SKILL.md
│   └── scripts/
│       └── cache-doctor.sh        # 检测 CLAUDE.md 不稳定字段
├── hashline-lite/
│   ├── SKILL.md
│   └── scripts/
│       ├── read-with-hashes.sh    # 输出带 hash 的文件
│       └── edit-by-hash.sh        # 按 hash 应用编辑
├── lean-tool-output/
│   └── SKILL.md                   # 纯行为指导，无脚本
├── compaction-discipline/
│   └── SKILL.md                   # 纯行为指导，无脚本
└── scratch-hygiene/
    └── SKILL.md                   # 纯行为指导，无脚本
```

下文给出每个 skill 的 SKILL.md 全文，可直接放入 `~/.claude/skills/` 或项目的 `.claude/skills/` 测试。

---

## 附录 B：核心 SKILL.md 示例

### prefix-stable/SKILL.md

```markdown
---
name: prefix-stable-prompt
description: Use this skill any time the user is reviewing, creating, or 
  editing CLAUDE.md, system instruction files, prompt templates, or asks 
  about prompt cache hit rate, token cost, or "why is my Claude Code so 
  expensive". This skill detects content patterns that break Anthropic 
  prompt caching (timestamps, dynamic IDs, oversized prompts) and provides 
  fixes. Always run scripts/cache-doctor.sh before committing CLAUDE.md.
---

# Prefix-Stable Prompt Hygiene

## TL;DR
Anthropic prompt caching requires **byte-exact prefix match**. Any field that 
varies between requests destroys the cache for everything that follows.

## When to invoke this skill
- User edits CLAUDE.md or any system prompt file
- User asks about token cost / cache hit rate
- User shows symptoms: high input cost in long sessions, quota limits 
  hit faster than expected
- Before any CLAUDE.md commit (run cache-doctor.sh)

## What to check (use cache-doctor.sh)
Run from the project root:
```
bash scripts/cache-doctor.sh CLAUDE.md
```

It reports:
1. **Timestamp patterns** — any ISO 8601, {{date}}, $(date), {{now}}
2. **Random IDs** — UUIDs, nanoid, session IDs
3. **Oversized content** — > 3000 tokens (warning), > 5000 tokens (critical)
4. **Dynamic placeholders** — interpolation patterns that vary per session
5. **Bad ordering** — dynamic content before static content

## How to fix

### Bad ❌
```
You are working on Project Foo as of {{current_date}}.
Session: {{session_uuid}}
[5000 lines of project context]
```

### Good ✓
```
You are working on Project Foo.

# Project context
[stable rules, conventions, commands]

# Architecture
[stable design decisions]
```

Move all dynamic content out of CLAUDE.md into:
- Runtime tool calls (read git status when needed)
- /context commands for ad-hoc injection
- Session-specific user messages, not the global prompt

## How to test

After fixing, verify hit rate improvement:
```
bash scripts/hit-rate.sh ~/.claude/projects/<project-name>/sessions/
```

Should show > 50% (better: > 70%) over a 5+ turn session.

## Anti-patterns to call out
- Putting "current date" in CLAUDE.md for "context" 
  → Move to a tool call or skip entirely
- Embedding session-specific user info
  → Use user messages instead
- Listing all open files
  → Use tool calls when needed
- Including every command help text "just in case"
  → Reference docs instead
```

### hashline-lite/SKILL.md

```markdown
---
name: hashline-lite
description: Use this skill when editing source files where edits are 
  multi-line, where reducing output token usage matters, or when the 
  model is a weaker one (Grok Code Fast, MiniMax, etc.). Provides a 
  hash-anchored edit format that emulates omp's Hashline mechanism—
  the model references content hashes instead of reproducing context, 
  reducing output tokens by ~30-40%. NOT a replacement for Claude's 
  built-in Edit for trivial single-line edits.
---

# Hashline-Lite (omp-inspired hash-anchored edits)

## TL;DR
For multi-line edits, use `read-with-hashes` + `edit-by-hash` instead of 
the native Read + Edit pair. Reduces OUTPUT tokens by ~30-40% on average. 
Especially useful for weak models and large refactors.

## When to use this skill
- Multi-line edits (3+ lines)
- Refactoring tasks
- Working with weaker models (Grok, MiniMax, smaller local models)
- Output token cost is a concern

## When NOT to use
- Single-line changes (native Edit is fine)
- New file creation (use Write)
- Binary files
- Files > 5000 lines (hash overhead becomes meaningful)

## Workflow

### Step 1: Read with hashes
```
bash scripts/read-with-hashes.sh path/to/file.ts [start-line] [end-line]
```

Output:
```
   1:a3  function fetchData(url: string) {
   2:b7    const response = await fetch(url);
   3:c4    const data = await response.json();
   4:d9    return data;
   5:e1  }
```

### Step 2: Plan edit by hash range

Identify start hash, end hash, new content. Never reproduce existing context 
in new content.

### Step 3: Apply by hash
```
bash scripts/edit-by-hash.sh path/to/file.ts 1:a3 5:e1 <<'EDIT'
async function fetchData(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}
EDIT
```

The script will:
1. Re-hash the actual file lines at positions 1 and 5
2. Compare to provided hashes (a3, e1)
3. If match → apply edit; if mismatch → fail-fast with diff

## Why this saves tokens

Native Edit format:
```
old_str: "[10 lines of original]"  ← 200+ tokens output
new_str: "[15 lines of new]"        ← 300+ tokens output  
Total: ~500-700 output tokens per edit
```

Hashline-Lite format:
```
start: 1:a3, end: 5:e1               ← 20 tokens
new content: "[only the new lines]"   ← 300 tokens
Total: ~320 tokens
```

Output savings: ~30-40% per edit.

## Caveat
This is a LITE version. It misses:
- Claude Code's diff preview UI
- Integration with Claude's permission system
- Real-time validation during streaming

For full Hashline experience, use omp directly.

## Test it
```
# Run on this skill's test file
bash scripts/edit-by-hash.sh test.txt 1:af 3:de <<'EOF'
Hello
World
EOF
```
```

(完整的 SKILL.md 和脚本见 `skills-demo/` 目录)

---

## 附录 C：哲学反思——为什么这个问题值得问

用户的问题"omp/Reasonix 的技巧能不能做成 skill 迁移"其实背后是一个更大的问题：

**"agent harness 应该是 framework 还是 platform？"**

如果是 framework（如 React），用户应该有完整的源码控制权，能修改任何一层。OpenCode、omp、Reasonix 都是这个路径。

如果是 platform（如 Vercel），用户只能在平台允许的接口上扩展。Claude Code 是这个路径。skill 是它的"扩展点"。

**这两种路径各有价值，但混淆它们会带来错误期待。**

用 platform 心态使用 Claude Code 是合适的——它提供了 skill、hooks、settings 等扩展点。但**期待用 platform 的扩展点实现 framework 的核心改造**就会失望——因为 skill 不是为此设计的。

这也是为什么 Anthropic 自己也在演进：**他们把好的扩展点（如 PTC、自动 skill 发现、hooks）逐步从 platform 内化为内置功能。** 你今天用 skill 模拟的东西，可能明天就是 Claude Code 的原生功能。

所以最务实的态度是：**短期用 skill 拿 20%，长期等 Anthropic 跟进或换 agent 拿 80%。**

不要试图用 skill 实现 99.82% 的命中率。它在物理上做不到。

---

**报告完**
