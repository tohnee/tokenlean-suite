# Coding Agent 缓存复用与 Token 经济学深度调研

> **报告版本**：v1.0 · 2026-06
> **覆盖对象**：Claude Code · OpenAI Codex CLI · OpenCode · oh-my-pi (omp) · Reasonix
> **方法论**：官方文档优先，源码次之，项目自带 benchmark 与发布说明再次之，公开 issue 用于说明局限
> **核心结论**：Coding agent 的 token 账单由三个独立维度决定——INPUT、OUTPUT、FUTURE INPUT。把它们当作一回事，是大多数实现方案效果不佳的根本原因。

---

## Executive Summary

### 三个一定要分开的 Token 维度

当前业界把"省 token"普遍当作一个目标。这是一个**严重的范畴错误**。事实上，token 成本来自三个独立的、可以分别优化的来源：

| 维度 | 含义 | 主要优化手段 | 代表实现 |
|---|---|---|---|
| **INPUT tokens** | 每轮请求中输入给模型的字节 | Provider prefix cache（命中后 0.1×base 价格） | Reasonix（99.82% 命中率）、Claude Code、Codex CLI |
| **OUTPUT tokens** | 模型本轮生成的字节 | 编辑格式优化（Hashline 等） | oh-my-pi（Grok 4 Fast OUTPUT -61%） |
| **FUTURE INPUT tokens** | 后续所有轮次中重复出现的字节 | Compaction、tool output prune、scratch 隔离 | OpenCode、omp、Reasonix |

**这三个维度收益可以叠加**：Hashline 把当轮输出降一半，prefix cache 把当轮输入降到 1/10，compaction 把未来 20 轮的重复输入压缩 70%。三者乘起来可以把账单从 $61 压到 $1（Reasonix 实测）。**它们也可以互相破坏**：错误的 compaction 时机会摧毁 prefix cache，让前者节省的成本被后者翻倍的 miss 吃掉。

### 五个 Agent 一句话定位

- **Claude Code**：平台能力最强，但内部细节最不公开；2026-03 TTL 无声回归事件揭示了订阅用户的隐性风险。
- **OpenAI Codex CLI**：官方 Responses API 把状态管理变成平台职责，是"懒人最优解"。
- **OpenCode**：摘要逻辑最透明、hook 最灵活，但 provider 兼容层易碎。
- **oh-my-pi (omp)**：**唯一同时优化三个维度**的实现，Hashline 是 OUTPUT 优化的开创性方案。
- **Reasonix**：**INPUT 维度的理论上限实践**，单日 99.82% 命中率，$1.38 vs $61.06 实测节省 97.7%。

### 报告的五个非显然发现

1. **"Prompt cache"是营销词**。底层都是 cross-request KV cache reuse，叫法不同只是 API 包装。三家提供商的差异不在概念，在 TTL、存储介质、触发方式与计费曲线。
2. **Hashline 与 prefix cache 是正交的**。前者降 OUTPUT 成本（模型生成的字节），后者降 INPUT 成本（输入给模型的字节）。叠加起来效果是乘法关系。
3. **Compaction 不是节省 token，是搬运 token**。它把"未来每轮的小成本"提前合并成"现在一次的大成本"，并且每次执行都会摧毁当前 cache。频率过高反而亏本。
4. **Subagent 不一定省 token**。如果不做 worktree 隔离，subagent spawn 会破坏主线程的 prefix；如果做隔离，每个 subagent 独立 cache namespace 会让总写入成本变高。
5. **Reasonix 的"双 session 隔离"反直觉但正确**。Planner 与 Executor 共享 session 看似省事，实际是 cache 杀手——每次 plan 更新都插入到中间，破坏 append-only invariant。

---

## Part I：原理基础

### 第 1 章：LLM 推理与 KV Cache 的物理基础

#### 1.1 Transformer 自回归生成的代价

一个标准的 Transformer LLM 在推理时分两个阶段：

```
PREFILL（预填充）：
  所有 input tokens 一次性并行计算
  → 为每个 token 生成 Q/K/V 矩阵
  → 计算 self-attention，构建 KV cache
  → 输出第一个 token

DECODE（解码）：
  每次生成一个 new token
  → 用当前 token 的 Q 与所有历史 token 的 K/V 做 attention
  → 若没有 KV cache：每步要重新计算所有历史 token 的 K/V，O(n²) 复杂度
  → 有 KV cache：直接复用，每步只算新 token 的 K/V，O(n) 复杂度
```

**关键数学事实**：对一个 N token 的输入，没有 KV cache 时生成 M 个新 token 需要 O((N+M)²) 次计算；有 KV cache 时只需要 O(N²+M(N+M)) 次。当 M 增大时差距是数量级的。

#### 1.2 KV Cache：每个推理引擎都内建的优化

vLLM、TensorRT-LLM、SGLang——所有现代推理引擎都内建 KV cache。**这不是 API 可见特性**，是引擎层面的自动优化。

**KV cache 的内存代价**：对每个 token，每层 attention 都要存一份 Key 和 Value 张量。一个 70B 模型 80 层、4096 hidden dim、8K context，KV cache 大约 5 GB / 序列。这是为什么 GPU 内存是 LLM 服务的核心瓶颈。

#### 1.3 PagedAttention：让 KV Cache 可以共享

vLLM 在 2023 年提出 **PagedAttention**：把 KV cache 切成固定大小的 page（类似操作系统的虚拟内存），允许：

- **不同请求共享 page**：当两个请求有相同前缀（例如同一个 system prompt），它们的 KV cache page 可以共享，节省内存
- **Copy-on-write**：当某个请求需要修改某个共享 page 时，先复制再修改，不影响其他请求
- **批量调度更灵活**：因为 KV cache 不再是连续内存块，调度器可以更高效地复用

PagedAttention 是**让 Prefix Cache 在生产环境可行的工程前提**。

#### 1.4 SGLang RadixAttention：进一步的优化

SGLang 用 **RadixAttention**：维护一个 KV 块的 LRU radix tree，自动识别多个请求间的公共前缀路径。相比 vLLM 的 hash-based block matching，RadixAttention 在大量短共享前缀的场景下更高效。

### 第 2 章：Prefix Cache 与 Prompt Cache 的语义辨析

#### 2.1 三层关系图

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   LAYER 1: KV Cache                                         │
│   ───────────────────                                       │
│   作用域：单个推理请求内部                                       │
│   存储：GPU HBM                                              │
│   控制方：推理引擎（vLLM/TensorRT/SGLang）                       │
│   触发：自动（始终开启）                                          │
│   省的是：decode 阶段的重复计算                                   │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   LAYER 2: Prefix Cache                                     │
│   ──────────────────────                                    │
│   作用域：跨多个推理请求                                          │
│   存储：GPU 内存（热）/ SSD（温）/ 分布式磁盘（冷，DeepSeek）           │
│   控制方：推理服务层（KV cache manager）                          │
│   触发：byte-exact prefix match                              │
│   省的是：prefill 阶段的计算（输入 token 费用 + TTFT 延迟）            │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   LAYER 3: Prompt Cache                                     │
│   ──────────────────────                                    │
│   作用域：API 调用者可见                                         │
│   实现：基于 Prefix Cache，加上商业化包装                          │
│   控制方：API 客户端 + 提供商策略                                 │
│   触发：因提供商而异（显式断点/自动匹配/默认开启）                       │
│   省的是：输入 token 计费                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘

  → 三者是同一底层机制（cross-request KV reuse）的不同切面
  → "Prompt cache" 是商业 API 暴露的名字，不是新技术
```

#### 2.2 为什么三家提供商叫法不同

- **Anthropic** 叫 `prompt_caching`，强调用户可以"显式控制"哪些块该被缓存（cache_control 断点）。
- **OpenAI** 叫 `prompt_caching`，但在 Responses API 中通过 `prompt_cache_key` 路由，更接近"我们替你管"。
- **DeepSeek** 叫 `context caching`，因为他们的存储是磁盘级，TTL 长，技术上更像"上下文存储"而非临时 cache。

理解这一点很重要：**当你看到"prompt cache"和"prefix cache"互换使用时，那不是术语混乱——它们指的是同一件事**，只是 Anthropic/OpenAI 把它包装成可控产品，DeepSeek 把它做成默认行为。

### 第 3 章：Token 经济学的三个维度

#### 3.1 INPUT Tokens 的经济学

每轮请求的输入 token 是最常见的成本来源。在长会话中，输入会线性增长：第 20 轮的输入可能是第 1 轮的 20 倍。

**缓存命中的实际经济学**（以 Anthropic Sonnet 4.6 为例）：

```
基础输入价格: $3.00 / M tokens
5min 缓存写入: $3.75 / M tokens  (1.25× base)
1h 缓存写入:  $6.00 / M tokens  (2.00× base)
缓存读取:    $0.30 / M tokens  (0.10× base)

Break-even 计算（5min TTL）:
  写一次 + 读 N 次 = 1.25 + 0.1N
  不缓存       N+1 次 = N+1
  break even: 1.25 + 0.1N = N+1 → N ≈ 0.28
  
  → 只要这个前缀在 5 分钟内被读 1 次以上，缓存就盈利。

Break-even 计算（1h TTL）:
  写一次 + 读 N 次 = 2 + 0.1N
  不缓存       N+1 次 = N+1
  break even: 2 + 0.1N = N+1 → N ≈ 1.11
  
  → 1 小时内被读 2 次以上，1h 缓存就盈利。
```

**核心结论**：在任何 agent loop 场景下，prompt caching 都是稳赚的。问题不是"要不要开启"，而是"用 5min 还是 1h"。

#### 3.2 OUTPUT Tokens 的经济学

输出 token 的单价通常是输入 token 的 4-5 倍（Anthropic Sonnet 4.6：输入 $3，输出 $15）。模型在做文件编辑时，往往需要复述原文 + 写新内容，输出 token 成本占主导。

```
传统 str_replace 方式编辑一个函数:
  - 复述 old_str (10 lines × ~20 tokens = 200 tokens)
  - 写 new_str (15 lines × ~20 tokens = 300 tokens)
  - 工具描述、解释 (~100 tokens)
  总输出: ~600 tokens × $15/M = $0.009 per edit

Hashline 方式同样编辑:
  - 引用 hash + 行号 (~10 tokens)
  - 写 new 内容 (~300 tokens)  
  - 简短上下文 (~50 tokens)
  总输出: ~360 tokens × $15/M = $0.0054 per edit

40% 输出节省 × 一天 200 次编辑 = $0.72/day per developer
```

OUTPUT 优化在 omp 出现之前几乎是一个被忽视的维度。**Hashline 是迄今最有效的 OUTPUT 优化方案**。

#### 3.3 FUTURE INPUT Tokens 的经济学

每轮历史消息在后续所有轮次中都要重复发送。一个 50 轮的会话，第一轮的工具回显可能被发送 49 次。

```
不做 compaction:
  Turn 1 input: 5K tokens
  Turn 2 input: 5K + 3K (turn 1) = 8K
  Turn 3 input: 5K + 3K + 4K = 12K
  ...
  Turn 50 input: ~150K tokens
  累计输入: ~2.5M tokens

带 compaction（每 20 轮一次，压缩至 25%）:
  Turn 21 input: 5K + (历史压缩成 15K) = 20K (vs 65K)
  Turn 50 input: 5K + (压缩历史 30K) = 35K (vs 150K)
  累计输入: ~800K tokens
  
节省: ~68% 累计输入
```

但 compaction 是有代价的：**每次 compaction 都会破坏前缀稳定性，导致 prefix cache 在压缩后短暂归零**。这就是为什么 Reasonix 把 compaction 称为"稀有的 cache reset 点"。

#### 3.4 三个维度的交互关系

```
            INPUT优化         OUTPUT优化        FUTURE优化
              ↓                  ↓                 ↓
        ┌──────────┐      ┌──────────┐      ┌──────────┐
        │prefix    │      │Hashline  │      │compaction│
        │cache     │      │etc.      │      │          │
        └────┬─────┘      └────┬─────┘      └────┬─────┘
             │                 │                 │
             └─────正交,可叠加─┘                  │
                                                 │
                                                 │
                每次执行 ←── 破坏 ─────────────────┘
                  ↓
               prefix cache
               命中率短暂归零
```

**核心洞察**：
- INPUT 优化（prefix cache）与 OUTPUT 优化（Hashline）是**完全正交**的，可以放心叠加。
- FUTURE INPUT 优化（compaction）会**破坏** INPUT 优化，所以频率必须低。

这就是为什么 Reasonix 的设计是"低频 compaction + 高频 cache hit"——把 compaction 当作必要之恶，能不做就不做。

---

## Part II：提供商机制深度分析

### 第 4 章：Anthropic Prompt Caching

#### 4.1 显式断点机制

Anthropic 的 prompt caching 通过 `cache_control` 块显式标记缓存断点：

```json
{
  "system": [
    {"type": "text", "text": "稳定系统提示..."},
    {"type": "text", "text": "工具定义...", "cache_control": {"type": "ephemeral"}}
  ],
  "messages": [
    {"role": "user", "content": [...], "cache_control": {"type": "ephemeral"}}
  ]
}
```

- 最多 **4 个断点** per request
- 缓存范围：**从请求开头到断点为止的所有内容**（按 tools → system → messages 顺序）
- 必须 byte-exact 匹配

#### 4.2 双 TTL 与定价

| TTL | 写入价格 | 读取价格 | 适用场景 |
|---|---|---|---|
| 5 分钟（默认） | 1.25× base | 0.10× base | 交互式聊天，请求密集 |
| 1 小时（显式） | 2.00× base | 0.10× base | 长会话，请求间隔较长 |

**TTL 自动续期机制**：每次 cache hit 都会重置 TTL 到完整时长。所以一个活跃 session 只要每 5 分钟有一次请求，缓存就永远不会过期。

#### 4.3 2026-03 TTL 静默回归事件

这是一个值得详细复盘的真实事件。GitHub Issue #46829 用 **119,866 个 API 调用的 JSONL 分析**记录了完整时间线：

```
2026-02-01 ~ 2026-03-05: 100% 1h TTL（默认）
2026-03-06: 5min tokens 首次出现
2026-03-07: 5m 占 50%
2026-03-08: 5m 占 83%
2026-03-15 之后: 基本全部 5min
```

**影响**：缓存创建成本上升 20-32%，订阅用户首次触及配额限制。**Anthropic 无任何公告**，用户通过反向工程 Claude Code 二进制才发现问题。

**应对**：开发者必须显式设置 `"cache_control": {"type": "ephemeral", "ttl": "3600"}` 才能恢复 1h 行为。

**教训**：依赖平台默认值是脆弱的。生产级 agent 必须显式声明所有缓存策略。

#### 4.4 4 个断点的稀缺性

Anthropic 限制 4 个 cache_control 断点 per request。对长会话 agent，这是一个**真实的工程约束**：

- 自动缓存模式下，Anthropic 会自动把断点移动到"最后一个可缓存块"——但会引发额外的缓存写入
- 超过 20 个 content blocks 的修改，缓存会降级为部分命中
- ProjectDiscovery 的实践：他们在每 18 个 blocks 插入中间断点，可支持约 54 个 blocks 不降级

### 第 5 章：OpenAI Prompt Caching + Responses API

#### 5.1 自动 + 路由键的混合策略

OpenAI 的缓存机制比 Anthropic 简单但更隐形：

- **自动触发**：任何 ≥1024 tokens 的前缀都自动缓存，无需显式标记
- **路由稳定性**：通过 `prompt_cache_key` 提高同一 key 落到同一机器的概率
- **前 ~256 tokens 哈希路由**：OpenAI 服务器根据前 256 tokens 的哈希做请求路由

```python
# 推荐用法
response = client.responses.create(
    model="gpt-5",
    input=messages,
    prompt_cache_key="user-123-session-abc",  # 同会话用同一 key
    previous_response_id=prev_id,              # 直接引用上次响应
)
```

#### 5.2 Responses API 的革命性

Responses API 是 OpenAI 在 2026 年推出的"状态管理 API"。它解决了 Chat Completions API 的核心痛点：**前缀稳定性需要客户端手动维护**。

```
Chat Completions API (旧):
  客户端要把整个 message 历史每次都发回 → 任何中间字段变化都破坏前缀
  
Responses API (新):
  client.responses.create(previous_response_id="resp_xyz", input=[new_msg])
  服务器维护历史状态，客户端只发新增内容 → 前缀天然稳定
```

OpenAI 内部测试：**Responses API 比 Chat Completions API 的 cache utilization 高 40-80%**，SWE-bench 提升约 3%。本质是因为 server-side 状态保证了前缀的 byte-stable 性质。

#### 5.3 Codex CLI 的工程化落地

Codex CLI 把 Responses API 用到极致：

```typescript
// Codex CLI 源码层面的关键设计
class ModelClientSession {
  websocket: WebSocket          // 复用 WebSocket，避免重连冷启动
  turnState: string             // x-codex-turn-state, sticky routing token
  promptCacheKey: string        // 默认 = thread_id
  
  async send(message) {
    // 关键：previous_response_id 让前缀始终稳定
    return await this.api.responses.create({
      previous_response_id: this.lastResponseId,
      input: [message],
      prompt_cache_key: this.promptCacheKey,
      // ...
    })
  }
}
```

配合 `compact_threshold`、`PreCompact`/`PostCompact` hook、`COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`，形成完整的"前缀稳定 + 受控压缩"工程方案。

#### 5.4 Container Caching：另一种缓存

Codex CLI 还公开了 **container caching**：把新任务/跟进任务的容器启动中位时间从 48 秒降到 5 秒，约 90% 加速。

这是"环境缓存"而非"token 缓存"。它不省任何 token，但显著降低交互延迟。架构上是独立维度，在本报告中不计入 token 节省主线，但值得 agent 实现者关注。

### 第 6 章：DeepSeek Context Caching

#### 6.1 MLA 架构：为什么能放磁盘

DeepSeek 与其他提供商的本质区别：**KV cache 存在分布式磁盘**，而非 GPU 内存。

这之所以可行，是因为 DeepSeek-V2 引入的 **Multi-head Latent Attention (MLA)**：

```
标准 Multi-Head Attention:
  对每个 head 都存独立的 K, V 矩阵
  N tokens × H heads × D dim/head × 2 (K+V) = 大量内存
  
MLA:
  把 K, V 投影到一个低维 latent space，所有 head 共享
  N tokens × D_latent × 2 ≈ 原来的 1/4 ~ 1/10
```

KV cache 大小压缩到原来的 1/4-1/10 后，**放磁盘的延迟开销变得可接受**。DeepSeek 的 context caching 存在"分布式磁盘阵列"上，TTL 可以做到很长（小时级）。

#### 6.2 性能数据

- **128K prompt 场景**：第一个 token 延迟从 13 秒降到 500 毫秒，约 96% 延迟下降
- **成本**：缓存命中价格 $0.014/M tokens，未命中 $0.14/M tokens，**90% 节省**
- **默认开启**：API 用户无需做任何配置，自动生效
- **观测字段**：`prompt_cache_hit_tokens` 与 `prompt_cache_miss_tokens` 在 usage 中暴露

#### 6.3 严格的 byte-exact 匹配

DeepSeek 的注意事项写在官方文档里：**只有从第 0 个 token 开始的完全相同前缀才会命中缓存**。中间部分匹配不会触发命中。

新版本（V3 之后）还引入了几个细化机制：

- **Persistence at request boundaries**：每个请求会在用户输入结束位置和模型输出结束位置各产生一个 cache prefix unit
- **Common prefix detection**：系统检测到多个请求的公共前缀时，会把它持久化为独立的 cache prefix unit
- **Fixed token intervals**：对超长输入/输出，每隔固定 token 数切一个 prefix unit，避免长前缀因为从未到达端点而不可缓存

这些机制让 DeepSeek 的 cache 对长会话更友好，但本质仍是 **byte-exact prefix match**。

---

## Part III：Agent 案例深度分析

### 第 7 章：Claude Code

#### 7.1 架构概述

Claude Code 的核心是单线程主循环（内部代号 **nO**）。VILA-Lab 对 v2.1.88 版本（约 1900 个 TS 文件、51.2 万行代码）的源码分析得出反直觉结论：**只有 1.6% 的代码是 AI 决策逻辑，其余 98.4% 是确定性基础设施**——权限闸门、上下文管理、工具路由、恢复逻辑。

整体分 6 层：
1. UI 层（CLI / VS Code 插件）
2. Agent 核心（nO loop + steering 队列）
3. 工具层（permission-gated）
4. Sub-agent 层（worktree 隔离）
5. 安全层
6. 推理层（Anthropic API）

#### 7.2 缓存策略

Claude Code 自身没有完整的内部缓存文档，但通过第三方逆向（包括 omp 的 Anthropic 适配代码）可以推断其断点布局：

**推测的断点布局**（来自 omp 的对齐实现）：
- 3-block system 布局：billing header（不缓存）+ system instructions（缓存）+ merged user content（缓存）
- 2 个 system 断点 + 2 个 message 断点，不额外设置 tool breakpoint
- 最后两条 message（不限 role）缓存——倒数第二条 assistant 通常比 user 大、更值钱

#### 7.3 Compaction 与 PTC

- `/compact` 命令：手动触发，自定义摘要 prompt，server-side 压缩
- **Programmatic Tool Calling (PTC)**：在复杂研究任务中，平均 token 使用从 43,588 降至 27,297，约 37% 节省；同时减少模型往返、提升知识检索与 GIA benchmark 准确率
- **Thinking block 自动剥离**：previous thinking blocks 不计入后续输入

#### 7.4 用户实测的痛点

来自社区的实际用户反馈：

1. **CLAUDE.md 是 token 税**：每次 session 启动都读，5000 token 的 CLAUDE.md 在每轮都重复
2. **2026-03 TTL 回归**：缓存命中近零，订阅配额突然不够用
3. **多次 compaction 后失忆**：连续 2-3 次 compaction 可能丢失更早的关键决策
4. **CLAUDE.md 优化案例**：通过 event-driven 优化 + 语义压缩，把 23K token 的 CLAUDE.md 压到 5K，约 78% 减少

#### 7.5 局限

- 内部缓存断点布局未充分公开
- 无官方端到端 hit-rate 报表
- 用户必须显式设置 `ttl:1h` 才能避免默认 5min TTL 陷阱

### 第 8 章：OpenAI Codex CLI

#### 8.1 架构特点

Codex CLI 是 OpenAI 官方开源的 coding agent，配置文件完整、源码可读、与 Responses API 深度耦合。

```yaml
# Codex CLI 关键配置项（简化）
model_auto_compact_token_limit: 50000  # 触发 compact 阈值
compact_prompt: "..."                  # 自定义 compaction prompt
compact_prompt_file: ./compact.md      # 或从文件读
pre_compact_hook: ./scripts/pre.sh     # 压缩前 hook
post_compact_hook: ./scripts/post.sh   # 压缩后 hook
```

#### 8.2 三层缓存策略

```
Layer 1: Responses API 状态托管
  - previous_response_id 引用前一回复
  - store: true 让服务器维护历史
  - 客户端只发新增 input
  
Layer 2: Prompt cache 路由
  - prompt_cache_key 默认 = thread_id
  - WebSocket 复用 + x-codex-turn-state sticky token
  - 同 session 始终落到同一机器
  
Layer 3: Server-side compaction
  - compact_threshold 控制触发
  - opaque compaction item 透明地接续状态
  - 客户端可在最新 compaction item 后丢掉更早 items
```

#### 8.3 已知的失忆问题

Codex 开源仓库的 issue 记录了一个典型局限：**默认 compact prompt 偏重"最近工作"**，连续 2-3 次 compaction 后可能丢失更早的关键决策，导致"渐进性失忆"。

这本质上是 server-side opaque compaction 的固有矛盾：客户端无法审计或回退服务器的压缩决策，只能选择信任。

### 第 9 章：OpenCode

#### 9.1 设计哲学：可审计的上下文工程

OpenCode 的核心价值是**把上下文工程做成可读源码**。配置层面：

```yaml
compaction:
  auto: true                # 自动 compact
  prune: true               # 移除旧工具输出
  reserved: 8000            # compaction 期间预留 token
experimental:
  session.compacting:
    hook: ./plugins/my-compact.ts  # 完全替换默认 compaction
```

#### 9.2 锚定式累计摘要

源码层面 `buildPrompt` 的关键设计：

```typescript
// 简化版伪码
function buildCompactionPrompt(history, previousSummary) {
  return `
    ${previousSummary ? `<previous-summary>${previousSummary}</previous-summary>` : ''}
    
    Compact the following history. 
    Keep details that are still true.
    Drop expired details.
    Merge with previous summary.
    
    ${history}
  `
}
```

新摘要**继承**旧摘要而非从零重写，避免每次压缩都失去历史细节。

#### 9.3 工具输出 Prune 的精细规则

```typescript
const PRUNE_MINIMUM = 20_000      // 至少能省 20k token 才触发
const PRUNE_PROTECT = 40_000      // 保护最近 40k token 的输出不裁
const TOOL_OUTPUT_MAX_CHARS = 2000 // compaction 时工具输出截断到 2k 字符

function shouldPrune(estimatedSavings, distanceFromTail) {
  return estimatedSavings >= PRUNE_MINIMUM 
      && distanceFromTail > PRUNE_PROTECT
      && !isSkillTool()  // 永远不裁 skill 工具结果
}
```

这些数字背后是**源码约束推断**：作者认为 < 20k 的节省"不值得重写历史"，因为重写历史会让 prefix cache 失效，得不偿失。

#### 9.4 Provider 兼容层的脆弱性

OpenCode 的 issue 公开讨论过 Anthropic-style caching 命中下降的具体原因：

> 如果把稳定的 OpenCode 系统前缀与每轮会变的 `user.system` 内容拼成一个 system message，那么 Anthropic 的缓存前缀会在每轮都变化。

**正确做法**：把静态前缀与动态 system 片段分成不同 system message。但 OpenCode 对 Anthropic/OpenRouter/Vertex/custom proxy 的 `cache_control` 或 `prompt_cache_key` 支持曾多次因 provider 识别逻辑不稳而出 bug。

**结论**：OpenCode 有缓存意识，但其 provider 兼容层比 Reasonix 这类单后端架构脆弱。

#### 9.5 局限

- 无统一公开 cache hit dashboard
- 无端到端功能回归 benchmark
- 跨 provider 缓存兼容层易碎，需用户自行检查每个 provider 的实际命中率

### 第 10 章：oh-my-pi (omp) —— 五维优化最完整实现

oh-my-pi 是当前唯一同时优化**三个 token 维度**的开源 agent。它的工程价值不在于哪一个机制特别突出，而在于**机制的完整性**——每个 token 来源都有对应的优化方案。

#### 10.1 Hashline：OUTPUT 维度的开创

**机制详解**：

```
文件读取时，每行附带 2-3 字符 content hash：

  42:f3  function fetchData(url: string) {
  43:a1    const response = await fetch(url);
  44:b9    const data = await response.json();
  45:c2    return data;
  46:5e  }

模型要修改时，引用 hash 而非复述内容：

  Line 42:f3 → Line 45:c2 replace:
  async function fetchData(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(...);
    return await response.json();
```

**Hash 函数选择**：2-3 字符 hash = 12-18 bit hash space。对 1000 行文件，单行碰撞概率约 0.4%-1.5%。这个概率是可接受的，因为：

- Hash 是按位置使用的，不是全局唯一性约束
- 不匹配 → 拒绝编辑（fail-fast），不会破坏文件
- 即使碰撞，3-way merge 恢复机制能处理大多数情况

**Auto-absorption（自动吸收）**：如果 replacement 包含已经存在于目标区域前后的行，会被自动吸收，避免重复。

**3-way merge 恢复**：当 hash mismatch 时，`tryRecoverHashlineWithCache` 用原始读取状态、当前磁盘状态、提议编辑做 3-way merge，尝试恢复。

**Benchmark 实测**（16 模型、180 任务、各 3 次运行）：

| 模型 | 编辑成功率 baseline | 编辑成功率 Hashline | 提升 |
|---|---|---|---|
| Grok Code Fast 1 | 6.7% | 68.3% | +10× |
| MiniMax | 中等 | 2.1× baseline | +110% |
| Gemini 3 Flash | 73.3% | 78.3% | +5pp |
| Grok 4 Fast | - | OUTPUT tokens -61% | - |
| Claude Opus | - | OUTPUT tokens ~-50% | - |

**为什么 Hashline 对弱模型提升最大**：弱模型在 str_replace 格式下经常因为空白/换行不匹配而失败，陷入重试循环。Hashline 把"定位"和"内容"解耦，弱模型只要能写出正确的新内容就行，不需要精确复述旧内容。

#### 10.2 TTSR：Context Prevention 的创新

**问题**：传统 agent 把所有 system 规则塞进 system prompt。规则越多，每个请求的 baseline context 越大，即使大多数规则在当前 session 中永远不会被触发。

**TTSR (Time-Traveling Streamed Rules)**：

```
1. 规则定义 ttsrTrigger 字段（regex pattern），不进入 system prompt

2. 模型生成 token 时，TTSR 监控输出流
   ↓
3. regex 命中 → 流在 mid-token 中止 → 注入规则为 system reminder
   ↓
4. 从中止位置重新生成
   ↓
5. one-shot per session：每条规则在每个 session 只触发一次，防循环
   ↓
6. 注入存活于 compaction：压缩后规则仍然有效
```

**实际场景**：

```
场景：50 条防止使用废弃 API 的规则

传统方式:
  全部塞 system prompt
  每个请求 baseline +5000 tokens
  即使 90% 的 session 根本不会触碰那些 API

TTSR 方式:
  rules/no-deprecated-api.yml: 
    ttsrTrigger: /\.deprecated_method\(/
    body: "Don't use deprecated_method, use new_method instead"
  
  baseline context cost: 0 tokens
  只在模型真的开始写 .deprecated_method( 时
  → 中止 → 注入规则 → 重试
  → 模型自动改用 new_method
```

**附加机制**：`/omfg <complaint>` slash command 可以从对话中 drafts 一条 TTSR 规则，让用户在出错时实时编纂规则。

#### 10.3 Anthropic 断点工程

omp 对 Anthropic 缓存的工程化是当前开源项目中最深入的。具体改进：

**改进 1：确定性 billing 指纹**

```typescript
// 旧版（错误）
const billingHeader = `User: ${userId} ${Date.now()}`  // 时间戳破坏 byte-stable
// 新版（正确）  
const billingHeader = `User: ${userId} ${installId}-${firstUserMessageHash}`
// 与 install ID 和首条消息绑定，确定性
```

**改进 2：3-block system 布局，与 Claude Code 对齐**

```typescript
const systemBlocks = [
  { type: 'text', text: billingHeader },                              // 不缓存
  { type: 'text', text: systemInstruction, cache_control: 'ephemeral' }, // 缓存
  { type: 'text', text: mergedUserContent, cache_control: 'ephemeral' }, // 缓存
]
```

**改进 3：2+2 断点，不额外设置 tool breakpoint**

逻辑：tool 紧随 system，system 变了 tool 对应前缀天然失效，所以为 tool 单独设断点没意义。

**改进 4：最后两条 message 缓存，不限 role**

旧逻辑："缓存最后两条 user message"。
新逻辑："缓存最后两条 message，无论 role"。
原因：倒数第二条 assistant（带工具调用）通常比 user（短追问）大得多，更值得缓存。

#### 10.4 Context Promotion：避免不必要的有损压缩

omp 的发现：很多时候上下文溢出不需要压缩，只需要"升窗"。

```
默认流程：
  Sonnet 4.6 context 满了 → compaction（有损）
  
Context Promotion 流程：
  Sonnet 4.6 context 满了
  ↓ 
  尝试升级到 Sonnet 4.6 200K context
  ↓
  仍满 → 尝试 Opus 4.7 500K context
  ↓
  仍满 → 这时才真正 compaction
```

这避免了"明明可以无损升窗，却过早做有损摘要"的常见错误。

#### 10.5 /shake：无 LLM 压缩

omp 提供三种 compaction 策略：

1. **shake**：机械删除重内容（不需要 LLM cut-point）
2. **shake-summary**：本地 tiny model 做提取式压缩
3. **handoff**：交接式压缩（适合 session 切换）

为什么不用云端 LLM 做压缩？因为云端 LLM 调用本身也消耗 token，而且引入额外延迟。

**本地 tiny model worker**：

```
共享的本地 worker，运行 transformers.js
模型选项：qwen3-1.7b, gemma-3-1b, qwen2.5-1.5b, lfm2-1.2b
GPU 优先（providers.tinyModelDevice 配置）
处理任务：
  - 会话标题生成
  - mnemopi 记忆提取与整合
  - shake 压缩
全部本地完成，数据不出机器
```

#### 10.6 会话结构：树形 JSONL

omp 不把 compaction 当作普通 assistant/user message，而是树形会话存储中的独立条目：

- **CompactionEntry**：压缩条目
- **BranchSummaryEntry**：分支摘要条目

上下文重建时：
1. 把最新 compaction 作为 `compactionSummary` 消息
2. 把 `firstKeptEntryId` 之后的历史接回
3. 被放弃分支的 `branch_summary` 转成 `branchSummary` 进入

这意味着 omp 的"记忆"不是平面聊天记录，而是**可分支、可压缩、可回放的树**。

#### 10.7 5 种 Compaction 触发源

```
1. 手动 /compact
2. 上下文溢出恢复
3. 输出被长度截断后的恢复  
4. 阈值维护（达到配置百分比）
5. idle maintenance（空闲时主动整理）
```

#### 10.8 Pre-compaction Pruning 规则

```
保护规则:
  - 永不裁 skill 工具结果
  - 永不裁 read 工具结果
  - 保护最近 40,000 token 的工具输出
  - 仅当预计能省 ≥20,000 token 时才 prune
  
切点规则:
  - 绝不在 toolResult 上切断
  - 必要时把紧邻 cut-point 前的模型切换、thinking level 变化
    等元数据一起拖入 kept region
  - 避免留下"孤儿工具消息"
```

#### 10.9 omp 的工程价值

omp 不像 Reasonix 那样有戏剧性的单一数字（99.82% 命中率），但它代表了**当前最全面的 token 优化工程实践**。它告诉我们：

- OUTPUT 优化（Hashline）是独立维度，且收益显著
- Context Prevention（TTSR）是被忽视的"第四维度"
- 本地 tiny model 可以替代部分云端 LLM 调用
- Provider 缓存断点需要精细工程，不是"开个 cache_control 就完事"
- Context Promotion 应该优先于 Compaction

### 第 11 章：Reasonix —— INPUT 优化的理论上限

#### 11.1 单一目标驱动的架构哲学

Reasonix 的与众不同之处在于其**极端的目标聚焦**。官方主页第一句话：

> "围绕 DeepSeek 的 byte-stable prefix cache，把 coding agent 做到'可以一直开着而不心疼账单'。"

它**不是**通用 agent，不是多 provider，不做 OUTPUT 优化（不实现 Hashline 类格式），不做复杂的子 agent 编排。它只做一件事：**让 DeepSeek prefix cache 命中率接近 100%**。

#### 11.2 Cache-First Loop 的三区架构

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│  ZONE A: Immutable Prefix                            │
│  ─────────────────────────                           │
│  • System prompt                                     │
│  • Tool specs                                        │
│  • Few-shot examples                                 │
│  • 会话开始时计算一次                                  │
│  • 之后绝不修改                                       │
│  • → 100% prefix cache hit                          │
│                                                      │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ZONE B: Append-Only Log                             │
│  ─────────────────────────                           │
│  • Turn 1 → Turn 2 → Turn 3 → ...                   │
│  • 按时序追加 assistant/tool/user                     │
│  • 绝不重写、重排、插入到历史位置                       │
│  • 每轮新消息追加在尾部                                │
│  • → 前缀始终是上一前缀+新消息                          │
│  • → 天然 cache friendly                            │
│                                                      │
└──────────────────────────────────────────────────────┘
              ↕ (架构级隔离边界)
┌──────────────────────────────────────────────────────┐
│                                                      │
│  ZONE C: Volatile Scratch                            │
│  ─────────────────────────                           │
│  • R1 thought（DeepSeek-Reasoner 的推理过程）         │
│  • 短期计划态                                         │
│  • 只在本 turn 有用                                   │
│  • 从不发送到上游                                     │
│  • 从不进入 Append-Only Log                          │
│  • → 不污染未来前缀                                   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**三条不变量**：
1. Immutable Prefix 只在会话开始时计算一次，永不修改
2. Append-Only Log 只能追加，绝不重写或重排
3. Volatile Scratch 绝不进入未来前缀

这三条不变量看起来简单，但**多数 agent 因为隐式重排、改写、插入新时间戳而违反**——这就是为什么多数 agent 的真实 cache hit rate 低于 20%，而 Reasonix 能做到 99.82%。

#### 11.3 Compaction：稀有的 Cache Reset 点

Reasonix 把 compaction 视为"**唯一主动改变提示前缀的少数时刻**"，因此频率必须极低：

```yaml
# Reasonix 配置参数
TURN_END_RESULT_CAP_TOKENS: 3000   # 每 turn 结束时大工具结果截断
RECENT_KEEP: 8                      # compaction 后保留最近 8 条原文消息
PRE_COMPACT_RATIO: 0.40             # 40% 上下文比时预压缩
EMERGENCY_RATIO: 0.80               # 80% 紧急压缩
```

**预压缩 vs 紧急压缩**：
- **40% 预压缩**：上下文用了 40% 时主动压缩。此时还有充足空间，可以慢慢做、做好。
- **80% 紧急压缩**：用了 80% 才被迫压缩。此时已经在悬崖边，且更可能影响用户响应。

预压缩的成本曲线更平稳。

**压缩流程**：
1. 触发条件满足 → 生成 compaction
2. 新前缀 = `system + summary + recentKeep(8 条)`
3. 旧历史归档到本地 JSONL，可回溯
4. 新前缀变成新的 Immutable Prefix（直到下一次 reset）

#### 11.4 双模型 Session 隔离：反直觉的正确设计

许多 agent 喜欢把 Planner 和 Executor 混在一个 thread 里，以为能"节省上下文"。Reasonix 的设计哲学完全相反：

```
错误设计:
  ┌─────────────────────────────────┐
  │  Single Session                  │
  │                                  │
  │  Planner (low freq) ─┐           │
  │  Tool calls (high freq) ─┐        │
  │  Plan update (low freq) ─┘        │
  │  More tool calls ─┘               │
  └─────────────────────────────────┘
  问题: 每次 plan 更新都插入到中间，破坏 append-only

正确设计 (Reasonix):
  ┌──────────────────────┐  ┌──────────────────────┐
  │  Planner Session      │  │  Executor Session     │
  │  (low freq, 短计划)    │  │  (high freq, 工具)    │
  │                       │  │                       │
  │  独立 prefix cache    │  │  独立 prefix cache    │
  │  独立 append-only     │  │  独立 append-only     │
  └──────────┬───────────┘  └──────────┬───────────┘
             │                          │
             └──── Coordinator ────────┘
                    (传递简短 plan 消息)
```

**Coordinator 的作用**：从 Planner 提取简短 plan，作为新消息追加到 Executor session。两边各自保持 prepend-only。

#### 11.5 实测数据：99.82% 命中率的工程意义

来自 Reasonix benchmarks/real-world-cache 文档的真实单日案例（2026-05-01）：

```
单日数据 (真实用户，v4-flash 计费):
  Input cache hits:    435,033,856 tokens
  Input cache misses:      767,616 tokens
  Output tokens:           179,763 tokens
  
  Hit rate:  99.82%
  
成本计算:
  Hits   × $0.014/M = $6.09
  Misses × $0.140/M = $0.11  
  Output × $0.280/M = $0.05
  实际总成本: $1.38  
  
不缓存基线 (0% hit rate):
  All input × $0.140/M = $61.01
  Output × $0.280/M    = $0.05
  基线总成本: $61.06
  
节省比例: 97.7%
```

按 v4-pro 计费口径（input $0.55/M、cache hit $0.055/M），同样工作负载：
- 实际成本：$2.07
- 基线成本：$189.73
- 节省：98.9%

#### 11.6 τ-bench：基线对照实验

Reasonix 项目还公布了一份 τ-bench 报告：

- **Baseline**（典型重排/改写 agent）：43.9% cache hit
- **Reasonix cache-first**：94.3% cache hit
- **提升**：+50pp，超过 2× 命中率

这说明：99.82% 不是单日 fluke，而是架构层面的稳定输出。

#### 11.7 局限

- **单后端**：只支持 DeepSeek，迁移到 Anthropic/OpenAI 不容易（三家缓存语义不同）
- **OUTPUT 优化缺失**：不实现 Hashline 类格式
- **复杂任务编排弱**：subagent、plan mode、多分支不是设计目标
- **无同行评审论文**：所有数据来自项目自己的 benchmark

但作为"INPUT 维度的理论上限实践"，Reasonix 设立的标准是清晰的：**在合适的后端上，prefix cache 命中率应该接近 100%，而不是 30%。**

---

## Part IV：横向对比与决策

### 第 12 章：完整实现矩阵

| 维度 | Claude Code | Codex CLI | OpenCode | oh-my-pi | Reasonix |
|---|---|---|---|---|---|
| 开源性 | 闭源 | 官方开源 | MIT | MIT | MIT |
| 后端依赖 | Anthropic | OpenAI | 跨 provider | 40+ provider | DeepSeek |
| 语言 | TypeScript | TypeScript | TypeScript | TS + Rust | TypeScript |
| **OUTPUT token 优化** | ✗ | ✗ | ✗ | ✓ Hashline -61% | ✗ |
| **INPUT prefix cache** | △ 平台 | ✓ Responses API | △ provider 兼容易碎 | ✓ Anthropic 对齐 | ✓ 架构保证 |
| **Context Prevention** | △ thinking 剥离 | △ | ✗ | ✓ TTSR | ✓ Volatile Scratch |
| **无 LLM 压缩** | ✗ | ✗ | ✗ | ✓ /shake + tiny model | △ mechanical |
| **Context Promotion** | 未公开 | 未公开 | ✗ | ✓ 先升窗再压缩 | ✗ 单后端 |
| Compaction 策略 | server-side | server-side opaque | 锚定式累计 | 树形+5触发源 | 低频 system+summary+8 |
| 工具输出裁剪 | PTC | 20k cap | 2k chars; ≥20k 触发 | 40k 保护; ≥20k 触发 | turn-end 3k cap |
| 子 Agent 隔离 | worktree | 未公开 | 未明确 | 独立 session | Planner/Executor 强制分离 |
| 实时可观测 | usage.iterations | /status | 源码透明 | 发布说明 | 顶栏 hit/miss |
| 公开 benchmark | △ 平台上限 | △ 平台上限 | ✗ | ✓ edit benchmark | ✓ τ-bench + 单日 case |
| 公开效果 | PTC -37% | cache util +40-80% | ✗ | Grok4Fast OUT -61% | 99.82% hit, -97.7% cost |
| 最适合场景 | Anthropic 企业用户 | OpenAI 平台用户 | 跨 provider 实验 | 全维度优化、长期挂机 | DeepSeek 长会话 |

### 第 13 章：真实世界事件复盘

#### 13.1 事件 1：Claude Code TTL 静默回归

**时间线**：
- 2026-02：默认 TTL 为 1 小时
- 2026-03-06：默认 TTL 静默改为 5 分钟
- 2026-03-08：5min token 占 83%
- 2026-04：用户分析 119,866 个 API 调用 JSONL 发现规律
- 2026-04-12：GitHub Issue #46829 发布完整分析

**影响**：缓存创建成本上升 20-32%；订阅用户首次触及月度配额；Anthropic 未发布公告。

**根因**：默认 TTL 策略由服务端控制，客户端无控制权。用户必须显式设置 `"ttl": 3600` 才能获得 1h TTL。

**教训**：
1. 生产级 agent 必须显式声明所有 cache 参数，不依赖默认值
2. 必须监控 `cache_creation.ephemeral_5m_input_tokens` 与 `ephemeral_1h_input_tokens` 字段，及时发现服务端策略变化
3. 平台供应商的"无声变更"是真实存在的风险，与依赖软件库的小版本更新等同对待

#### 13.2 事件 2：ToolSearch 破坏 DeepSeek 前缀

**时间线**：
- Qwen Code CLI v0.15.9：cache hit rate ~98%
- v0.15.10 引入 ToolSearch（MCP 工具按需加载）
- v0.15.10 之后：cache hit rate ~81%

**根因**：
```
v0.15.9 prompt structure:
  system + ALL_TOOLS + messages
  → 工具集合稳定 → byte-stable prefix → 98% hit

v0.15.10 prompt structure:
  system + DYNAMIC_TOOLS(per-request) + messages
  → 工具集合每次不同 → 前缀漂移 → 81% hit
```

**权衡**：ToolSearch 每次省 ~15k prompt tokens，但失去 ~17pp cache hit rate。对 DeepSeek 重度用户：cache miss 增加的成本 >> prompt 压缩节省的成本。

**教训**：
1. **任何"prompt 压缩"优化都要先评估对 prefix cache 的影响**
2. 减少 token 不等于减少成本——cache miss 的隐性成本远大于显性 token 节省
3. 工具 schema 必须固定在前缀，不能按需加载

#### 13.3 共同规律

两个事件都揭示同一本质：**prefix cache 对"稳定"的要求是绝对的**。
- 不是"大致稳定"，是 **byte-exact**
- 任何工程变更——哪怕是减少 prompt 大小的"优化"——只要动了前缀，就可能产生比省下的 token 大得多的隐性成本
- **监控 hit/(hit+miss) 是发现这类问题的唯一手段**

### 第 14 章：选型决策树

```
你的场景是什么？
│
├─ 后端必须用 Anthropic
│  └─ 直接用 Claude Code，但务必显式设置 ttl:3600
│     注意监控 ephemeral_5m vs ephemeral_1h tokens
│
├─ 后端必须用 OpenAI
│  └─ 用 Codex CLI，最简单，平台帮你管前缀稳定性
│     注意：避免连续 ≥3 次 compaction 导致渐进性失忆
│
├─ 后端用 DeepSeek，且会话很长
│  └─ Reasonix 是最优解（99.82% hit 已实测）
│     接受单后端、无 OUTPUT 优化、复杂编排弱的代价
│
├─ 需要跨 provider，重视摘要策略可审计
│  └─ OpenCode，但务必：
│     1. 把 static prefix 与 dynamic system 分块
│     2. 对每个 provider 单独验证缓存命中率
│     3. 不要相信"开个 cache_control 就行"
│
├─ 需要全维度优化（INPUT + OUTPUT + FUTURE）
│  └─ oh-my-pi (omp)
│     特别是：编辑密集的场景（Hashline 收益巨大）
│     有大量"偶尔需要"规则的场景（TTSR 收益巨大）
│
└─ 需要企业内部高度定制
   └─ 选 OpenCode 或 omp 作为架构范本
      重点学习：
      - omp 的 Anthropic 断点工程（最深入的公开实现）
      - Reasonix 的双 session 隔离（最反直觉但正确的设计）
      - OpenCode 的锚定式摘要（最易理解的压缩策略）
```

---

## Part V：工程实践

### 第 15 章：六条工程原则

#### 原则 1：分清 INPUT / OUTPUT / FUTURE INPUT

三个 token 成本来源要分开建模：
- Hashline 省 OUTPUT
- Prefix cache 省当轮 INPUT
- Compaction 省未来 INPUT

**混在一起优化，收益无法量化，也无法溯源**。一个错误优化（如错误的 compaction）可能让某个维度的收益变成另一个维度的损失。

#### 原则 2：Byte-Stable 是前缀缓存的刚需

任何会在请求间变化的字段都应移到前缀后部或固定：
- 时间戳 → 移除或固定
- 随机 ID → 用确定性指纹替代
- 动态 system 片段 → 拆成单独 message
- 按需加载的工具 schema → 固定在前缀

**反例**：
- ToolSearch 导致 DeepSeek 命中率 98% → 81%
- Claude Code TTL 默认改 5min 导致命中率近零
- OpenCode 把静态 + 动态 system 混合导致 Anthropic 每轮 miss

不是"大致稳定"，是 **byte-exact**。

#### 原则 3：Compaction 是稀有的 Cache Reset 点

每次 compaction 都会：
1. 改变前缀（之前积累的 cache 暂时归零）
2. 引入额外的 LLM 调用成本（除非用 omp 的 /shake 机械压缩）
3. 可能丢失早期的关键决策（Codex 已知问题）

**最佳策略**：
- 40% 预触发，而非 80% 紧急
- 优先 Context Promotion（升窗），有损压缩是最后手段
- 把 compaction 当作"必要之恶"，不是默认行为

#### 原则 4：Scratch 绝不污染未来前缀

短期价值高、长期价值低的信息：
- R1 thought（DeepSeek-Reasoner 推理）
- 大工具输出（日志、grep 结果、测试回显）
- 中间计划草稿

绝不进入 Append-Only Log。

**实现参考**：
- Reasonix Volatile Scratch 架构隔离
- Anthropic thinking blocks 自动剥离
- omp `TURN_END_RESULT_CAP=3000`

#### 原则 5：Hit/Miss 必须是一等可观测指标

不监控 cache 命中率，就无法发现：
- TTL 无声降级（Claude Code 2026-03 事件）
- 工具 schema 变更导致的前缀漂移（ToolSearch 事件）
- Compaction 后命中率暂降
- Provider 兼容层的 bug

**必须做**：
- 把 `hit/(hit+miss)` 做成顶栏常驻指标（参考 Reasonix）
- 每天监控日命中率，设置告警阈值
- 在每次发版前做 cache hit rate 回归测试

**字段映射**：
- Anthropic：`cache_creation_input_tokens` / `cache_read_input_tokens`
- OpenAI：`cached_tokens` in usage
- DeepSeek：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`

#### 原则 6：编辑格式是独立的 OUTPUT 优化维度

Hashline 等编辑格式优化与 prefix cache **完全正交**：
- 前者降低当轮模型输出成本
- 后者降低当轮输入 token 成本
- 两者叠加效果是**乘法关系**

**为什么大多数 agent 没做 OUTPUT 优化**：
- 注意力都在 prefix cache（更显眼）
- 编辑格式被认为是"模型层面的问题"，不是 agent 层面
- 没意识到 OUTPUT token 单价是 INPUT 的 4-5 倍

**应该做的**：
- 编辑密集场景（refactoring、批量修改）优先采用 Hashline 类格式
- 至少为弱模型场景（Grok Code Fast 1 类的便宜模型）启用 Hashline

### 第 16 章：可复现实验设计

如果要可复现地验证"缓存/压缩到底省了多少 token，且是否伤害功能正确性"，建议搭一个**四层指标 × 四组对照 × 四类任务**的实验框架。

#### 16.1 四层指标

```
Layer 1: 输入侧
  - input_miss_tokens
  - input_hit_tokens  
  - output_tokens
  - 额外 compaction 调用数

Layer 2: 时间侧
  - TTFT (Time To First Token)
  - 整轮 wall-clock
  - 工具执行时间
  - 压缩暂停时间

Layer 3: 经济侧 (按 provider 价格分别算)
  - input_hit 价 × hits
  - input_miss 价 × misses
  - output 价 × outputs
  - 总成本

Layer 4: 质量侧
  - 任务通过率
  - 测试通过率
  - 用户约束遗忘率
  - 压缩后需要回读文件的次数
```

#### 16.2 四组对照实验

```
Group A (基线): 不做任何 compaction，不做 cache 对齐，普通聊天累加
Group B (仅前缀): 只做稳定前缀 + cache key，不做摘要
Group C (仅压缩): 只做摘要/裁剪，不做前缀稳定  
Group D (全量): 稳定前缀 + 工具裁剪 + 低频 compaction (Reasonix 策略)
```

预期结果：
- B vs A：在支持强 prefix cache 的后端上，B 应该把 hit-rate 从 <20% 提升到 70%+
- C vs A：长会话总输入下降，但 hit-rate 提升有限
- D vs B：D 在长会话下成本曲线更平稳，但短会话可能不如纯 B（compaction 是额外成本）

#### 16.3 四类任务

```
Task 1: 大仓库搜索-定位-修改-测试 (真实修 bug)
  - 涉及多次 grep + read + edit + run tests
  - 工具输出量大
  - 多轮回合
  
Task 2: 高工具输出任务
  - 日志分析、批量测试失败收集
  - 单次工具输出量极大
  - 测试 turn-end shrink 收益
  
Task 3: 多次回合修订任务
  - 20-50 轮的代码评审与修改
  - 测试 compaction 后约束遗忘率
  
Task 4: 分支/子代理任务
  - 多任务并行
  - 测试 branch summary、subagent 隔离的收益
```

#### 16.4 实验时长建议

- **最小**：每组 × 每任务 × 3 次重跑，约 4 × 4 × 3 = 48 个 session
- **建议**：每组 × 每任务 × 10 次重跑 = 160 sessions
- **理想**：连续 30 天真实使用，统计累积数据（接近 Reasonix 单日 case study 的可信度）

### 第 17 章：当前未解决问题

#### 17.1 Claude Code 的内部布局透明度

- 内部断点布局未官方公开
- TTL 策略可能继续无声变更
- 没有端到端 hit-rate 报表
- subagent 与主线程缓存的交互模式未文档化

#### 17.2 OpenCode / omp 的统一公开 benchmark 缺失

- 没有"节省比例—准确率回归"并列呈现的基准
- 没有 hit-rate dashboard
- 难以验证"开源方案 vs 商业方案"的真实效果差距

#### 17.3 Reasonix 的可迁移性

- 单后端（DeepSeek 原生），迁移到 Anthropic/OpenAI 不容易
- 三家的缓存粒度、路由、TTL 与 compaction 语义不同
- 没有公开的"Reasonix on Anthropic"或"Reasonix on OpenAI"实验

#### 17.4 自适应 cache layout

当前几个有前景但未成熟的方向：
- **Token 对齐的 block padding**：让前缀长度对齐到 cache page 边界
- **缓存预热**：在用户发起首次请求前预先填充
- **基于 hit/miss 反馈的自适应 cache layout**：动态调整断点位置

这些想法在开源项目 issue 中已经出现，但尚未形成跨项目可复现的定论。

#### 17.5 子 Agent 与 Cache 的最优交互

- worktree 隔离是好是坏？独立 cache namespace 带来什么权衡？
- 子 agent spawn 的成本是否应计入 cache reset 成本？
- 多 subagent 并发时如何调度才能最大化共享 prefix？

#### 17.6 长期挂机的 cache warming 策略

- 1h TTL 之后的 cache 怎么便宜地"keep warm"？
- 用 tiny "ping" 请求保持 cache 是否经济？
- 这种策略与服务商的 rate limit 如何冲突？

#### 17.7 工具调用历史的有损/无损边界

- 哪些工具结果可以无损丢弃（如 ls 输出，反正可以重新运行）？
- 哪些必须保留（如用户的关键决策）？
- 是否可以"按需重运行工具"代替"保留工具历史"？

---

## 结论

### 三句话总结

1. **Coding agent 的 token 账单由三个独立维度决定**：INPUT（当轮输入）、OUTPUT（当轮输出）、FUTURE INPUT（后续重复）。不分开建模，所有优化都是盲人摸象。

2. **缓存复用的本质是 cross-request KV reuse**：不管叫 Prefix Cache、Prompt Cache、Context Cache，底层是同一件事。差异在 TTL、存储介质、触发方式。byte-exact prefix 是命中的唯一条件。

3. **当前最优实践是 Reasonix（INPUT 极致）+ omp 思想（OUTPUT + 全维度）的组合**：Reasonix 用 Cache-First Loop 把 DeepSeek prefix cache 命中率压到 99.82%，omp 用 Hashline + TTSR 把 OUTPUT 与 Context Prevention 也做到独立维度的极致。商业产品 Claude Code 与 Codex CLI 平台能力强但工程细节不公开，是"够用"而非"最优"。

### 给团队 Lead 的建议

如果你正在选型或自建：

**预算紧张的场景**：DeepSeek + Reasonix（年节省 90%+ 是真实可达的）

**Anthropic 生态的企业**：用 Claude Code，但**强制**所有团队成员显式设置 `ttl:3600`，**强制**监控 cache hit rate，建立 cache TTL 静默变更的应急响应预案

**编辑密集型场景**：用 oh-my-pi，Hashline 的 OUTPUT 节省叠加任何后端的 prefix cache，效果是乘法

**多 provider 探索**：用 OpenCode 做 lab 环境，但生产推送前用 omp 或单后端方案做最终优化

**长期挂机/agent farm**：先确认你的后端是否支持稳定 prefix cache。如果不支持，所有"省 token"的努力都是徒劳——这种情况下重点应该是降低任务频率，而不是优化单次成本。

### 给开发者的建议

1. **每次 PR 前，先问：这会破坏 prefix cache 吗？**
2. **不要为了"减少 prompt 大小"而引入动态字段**——cache miss 的代价通常更大
3. **把 cache hit rate 纳入 CI 测试**，每次发版前验证不退化
4. **对 Hashline 等 OUTPUT 优化保持开放**——它是当前最被低估的工程杠杆
5. **不要把 compaction 当作默认行为**，它是稀有的 cache reset，不是 routine 操作

### 关于"未来"

随着 LLM 推理引擎的演进（PagedAttention、RadixAttention、MLA 等），缓存机制还会继续优化。但**byte-stable prefix 这条底层约束在可预见的未来不会消失**。

任何 coding agent 如果不把"前缀稳定性"作为一等设计目标，本质上就是在 token 账单上慢性放血。Reasonix 与 omp 已经把可行的工程范本展示出来——剩下的问题不是"能不能做到"，而是"何时把这些经验吸收进每一个 coding agent"。

---

## 附录

### A. 关键代码片段索引

**Hashline 核心机制**（来自 oh-my-pi）：
```
packages/coding-agent/src/hashline/apply.ts
  - 主入口 applyHashlineEdits
  - 行 80-83: HashlineMismatchError 抛出
  - 行 145-173: Prefix/Suffix Auto-Absorption

packages/coding-agent/src/hashline/execute.ts
  - 行 68-72: hash 不匹配检测
  - 行 73-98: tryRecoverHashlineWithCache 3-way merge
```

**OpenCode Prune 参数**（来自 OpenCode）：
```typescript
const PRUNE_MINIMUM     = 20_000  // 至少预计节省
const PRUNE_PROTECT     = 40_000  // 保护最近工具输出
const TOOL_OUTPUT_MAX_CHARS = 2000  // 压缩时截断
```

**Reasonix 关键参数**：
```typescript
TURN_END_RESULT_CAP_TOKENS = 3000
RECENT_KEEP = 8
PRE_COMPACT_RATIO = 0.40
EMERGENCY_RATIO = 0.80
```

**Codex CLI 配置**：
```yaml
model_auto_compact_token_limit: 50000
COMPACT_USER_MESSAGE_MAX_TOKENS: 20000
prompt_cache_key: ${thread_id}
```

### B. 关键术语表

| 术语 | 解释 |
|---|---|
| KV Cache | Key-Value 注意力状态，存于单请求内部 |
| Prefix Cache | 跨请求的 KV 状态复用 |
| Prompt Cache | Prefix Cache 的商业 API 暴露 |
| Context Cache | DeepSeek 对 Prefix Cache 的称呼 |
| PagedAttention | vLLM 提出的分页 KV 内存管理 |
| RadixAttention | SGLang 的 radix tree KV 管理 |
| MLA | DeepSeek 的 Multi-head Latent Attention，压缩 KV 大小 |
| TTL | Time To Live，缓存生存时间 |
| Hashline | omp 的 content-hash 行编辑格式 |
| TTSR | omp 的 Time-Traveling Streamed Rules |
| Context Promotion | 上下文溢出时优先升大模型而非压缩 |
| Append-Only Log | Reasonix 的不变量：日志只追加 |
| Volatile Scratch | Reasonix 的不变量：scratch 不入未来上下文 |
| Compaction | 上下文压缩 |
| Prune | 旧工具输出移除 |
| BP1/BP2 | Anthropic 的 cache breakpoint 1/2 |
| PTC | Programmatic Tool Calling (Anthropic) |
| Subagent | 子代理，独立 session 的辅助 agent |
| Branch Summary | 分支摘要，omp 的会话分支压缩 |

### C. 主要数据来源

| 来源 | 类型 | 用途 |
|---|---|---|
| Anthropic 平台文档 | 官方 | prompt caching 机制、定价 |
| OpenAI Platform docs | 官方 | prompt caching、Responses API |
| DeepSeek API docs | 官方 | context caching、MLA |
| can1357/oh-my-pi (GitHub) | 源码 | omp 的所有机制细节 |
| esengine/reasonix (GitHub) | 源码 | Reasonix 架构 |
| OpenCode session/compaction.ts | 源码 | OpenCode 压缩逻辑 |
| GitHub Issue #46829 | issue | Claude Code TTL 回归事件 |
| QwenLM Discussion #4065 | issue | ToolSearch 破坏 DeepSeek 缓存 |
| Reasonix benchmarks/real-world-cache | 项目 benchmark | 99.82% hit rate 单日数据 |
| Reasonix benchmarks/tau-bench | 项目 benchmark | τ-bench 43.9%→94.3% |
| omp typescript-edit-benchmark | 项目 benchmark | Hashline 16 模型 180 任务 |
| ProjectDiscovery 案例研究 | 第三方实测 | Anthropic 缓存 59% 节省 |
| skids.dev tokenomics | 第三方分析 | break-even 数学推导 |
| VILA-Lab Claude Code 分析 | 第三方逆向 | 1.6% AI / 98.4% 基础设施 |

---

**报告完**

报告作者：基于 deep-research-report-14.md（原始研究）+ 2026 实时网络调研 + 五个 agent 的源码、文档、用户实测数据。

如需进一步深挖某一维度（例如 PagedAttention 的具体实现、Reasonix Coordinator 的源码细节、omp Anthropic 适配的提交历史），请提出具体方向。
