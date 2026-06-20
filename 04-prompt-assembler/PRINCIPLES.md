# 缓存感知的 Prompt 拼装:四个问题的系统回答

> 本文回答四个深入问题,每个都对应 `04-prompt-assembler` 里**可运行、已测试**的实现(28/28 通过)。
> 核心 provider 模型:Anthropic 式 prefix cache(tools → system → messages 层级;cache_control 断点;最长匹配前缀;**按组织/workspace 隔离**)。结论可平移到 OpenAI / DeepSeek 的自动前缀缓存。

---

## Q1. 先分清场景:单用户(单租户)还是跨用户共享?

这是最该先问的问题,因为它决定了"哪些缓存收益是你能拿到的"。

### 原理事实(已联网核实 Anthropic 官方文档)

> "Cache entries are isolated between organizations and … between workspaces within an organization."

也就是说,**商业 prompt cache 不跨组织/租户共享**。你无法靠"别的用户也发过同样的 system prompt"来蹭命中。两种"省钱的缓存"必须分清:

| 类型 | 谁受益 | 你能否控制 | 本项目立场 |
|---|---|---|---|
| **跨用户共享缓存** | 同一推理集群上不同租户的公共前缀(引擎层 PagedAttention/RadixAttention 的 KV page 共享) | ❌ 你控制不了,且商业 API 出于隔离**不暴露**给你 | 不在优化范围,知道它存在即可 |
| **单租户内前缀复用** | 你自己的请求流:同一 system/tool/KB 前缀在你**successive 的请求**间复用 | ✅ 完全由你的拼装结构决定 | **这才是本项目优化的对象** |

### 代码映射

`assembler.mjs` 给每个 segment 标注 `scope`:
- `tenant` —— 你租户内所有请求都能复用(tools、system)
- `session` —— 本会话内复用(项目上下文、pinned KB)
- `request` —— 只属于这一次请求,不可复用(检索结果、用户问题)

测试 [6] 验证:pinned KB 标为 `session`(可在你的连续请求间复用),检索 chunk 标为 `request`(不可复用)。**把"可复用范围"显式建模,你才不会把不可复用的东西误放进前缀。**

---

## Q2. 长 system prompt、tool 定义、多轮历史、agent loop 反复带的上下文

这些都在你自己的请求流/租户内,正是单租户前缀复用的主战场。关键是按"稳定性"分层,让可缓存前缀尽可能长。

### 原理:四级稳定性 + provider 失效层级

provider 的失效是**层级传染**的:`tools → system → messages`,改了某层会让该层及之后全部失效。所以越稳定的内容必须越靠前。本项目用四级:

| 稳定性 | 含义 | 典型内容 | 归宿 |
|---|---|---|---|
| `STATIC` | 会话内永不变 | system 角色、tool 定义 | 前缀最前,租户级复用 |
| `SESSION` | 本会话固定 | 项目上下文、pinned KB | 前缀,会话级复用 |
| `ROLLING` | append-only 增长 | 对话历史、agent loop 日志 | 断点之后,追加 |
| `VOLATILE` | 每次都变 | 检索结果、用户问题、时间戳 | 最后,绝不进前缀 |

**关键洞察 ——「append-only 是历史能被缓存的前提」**:多轮历史本身可以是稳定前缀的一部分,**前提是只追加、不重排、不改写**。一旦你往历史中间插一条"系统更新"或改写了前几轮,断点之前的前缀就碎了。这就是为什么 agent loop 必须 append-only(Reasonix 的核心不变量)。

**tool 定义是隐形杀手**:官方明确"Adding a new tool invalidates the cache for every prompt that uses tools"。所以 tool 定义要么固定不动,要么变更安排在低流量窗口。ToolSearch 这类"按需加载工具"的优化会让 tool 集合每次不同,反而把 DeepSeek 命中率从 98% 打到 81%——省了 prompt 大小,亏了缓存,得不偿失。

### 代码映射

`assemble(segments)` 做三件事(测试 [1] 验证):
1. **排序**:先按 `tools→system→messages`,同层内按稳定性升序 → 最稳的在最前。
2. **找接缝**:从前往后取连续的 STATIC/SESSION 段作为可缓存前缀,ROLLING/VOLATILE 落到接缝后。
3. **放断点**:主断点在稳定前缀末尾;若 tools+system 与 pinned KB 都大,再加一个断点在它们之间,让"每日变化的 KB"失效时不连累"租户级不变的 tools/system"。

还检测两个常见坑:前缀里混入时间戳/UUID(测试 [2]),前缀短于 provider 最小可缓存长度 ~1024 token(测试 [3])——后者是个隐形坑:再稳定也缓存不了。

---

## Q3. 拼装结构本身就是一个同时影响性能和成本的选择

由用户输入、工具输出、上下文动态拼装时,**拼到哪个位置、按什么顺序、用什么字节**,直接决定缓存命中,进而决定成本和首 token 延迟。这不是实现细节,是一等设计决策。

### 原理:三个拼装反模式

1. **可变内容前置**:把用户问题/检索结果拼在 system 之前。后果:前缀从第 0 字节就变,全程零命中。(open-webui 的 `RAG_SYSTEM_CONTEXT=True` 正是踩了这个坑——把变动移到了 index 0。)
2. **前缀内嵌可变字段**:system 里写 `Today is {date}`。一个 team 实测:开了缓存,生产首日只省了 1%,就因为 system 开头一个日期 token,全天零命中。
3. **非确定性序列化**:JSON 的 key 顺序每次不同、浮点 score 拼进文本 → 字节不稳 → 命中归零。

### 代码映射

本项目把"拼装结构"做成 `assemble()` 的**显式输出**:给定一组 segment,产出 (a) provider-ready 的顺序、(b) 断点位置、(c) 一份诊断(什么会破坏前缀、为什么)。`reportAssembly()` 直接打印出"断点在哪、前缀是否可缓存、哪个 segment 在泄漏"(测试 [7])。**结构不再是隐式副产物,而是可检视、可测试的产物。**

---

## Q4. RAG / llm-wiki 场景:如何在原理上增强缓存命中

这是四个问题里最尖锐的。多用户问答场景下,RAG 的 top-k 检索结果**每次查询都不同**,naive 做法把它们拼在前面,导致前缀每次都变、**完全无法命中**。

### 原理:稳定前缀 + 归一化尾部,两手都要

**第一手:固定一个稳定前缀层(pinned)。** 不要让"会变的检索结果"主导前缀。把**不怎么变的部分**钉在前缀里、放在断点之后:
- 通用 RAG:KB 的**索引/目录** + 热点/canonical 文档(确定性 id 排序)。
- llm-wiki:**导航层**(index、entity graph、wiki 页面)是 SESSION 稳定的,钉进前缀;某个问题拉取的**原始证据 span** 才是 volatile 尾部。

官方推荐的双断点正是为此:"system instructions (rarely change) and RAG context (changes daily) → two breakpoints to cache them separately"——让每日变化的 KB 在自己的断点失效,不连累 system。

**第二手:归一化 volatile 尾部,让"同一组 chunk"产生字节一致的文本。** 检索结果放断点之后(本来就该这样),但还要进一步处理,这样**同一会话内重复问到相似问题、召回同一组 chunk 时,尾部也能命中**:
- **按 id 稳定排序,不按 score 排序** —— score 有抖动,排序按 score 会让字节每次不同;按 id 则同一组 chunk 永远同序。
- **剥离 volatile 元数据** —— score、rank、timestamp、distance 不要拼进文本。
- **按 id 去重** —— 重叠召回常返回重复 chunk。

### llm-wiki 专门优化:索引和 raw 如何组织

针对你提到的"llm-wiki 返回索引和 raw 如何更好组织":

```
拼装结构(从前到后):
┌─ [STATIC]  system:你只能依据下方知识回答          ┐ 租户级,断点1
├─ [SESSION] wiki 导航层:index + entity graph + 页面 ┤ 会话级,断点2 ← 跨问题复用
│            (确定性序列化,按实体 id 排序)            │  这一大块每次命中
└─ ────────────────── breakpoint ──────────────────┘
   [VOLATILE] 本问题召回的 raw span(按 span id 排序,  ← 只有这部分每次重算
              剥离 score,去重)
   [VOLATILE] 用户问题
```

要点:**导航层(索引)钉进缓存前缀,raw span 作为归一化尾部追加。** 同一语料上问 10 个问题,导航层这一大块(往往是 token 大头)命中 9 次;只有每问不同的少量 raw span 走全价。这把 llm-wiki "navigation-first" 的设计天然对齐到缓存友好结构——索引既是检索的导航层,也是缓存的稳定前缀,一举两得。

### 代码映射 + 实测

`planRag(kb, retrieved)` 产出 pinned 层(index + 热点文档,id 排序)和归一化的 retrievedTail。`normalizeRetrieved()` 做 id 排序 + 去重 + 剥离元数据。

- 测试 [4]:index 钉为 SESSION 稳定进前缀,检索 chunk 进 VOLATILE 尾部,整体可缓存。
- 测试 [5](**核心**):同一组 chunk 以**不同 score、不同顺序**返回两次,归一化后尾部**字节一致** → 可命中。
- `cli.mjs demo` 实跑对比:naive(检索结果前置带 score)前缀**每次都变、零命中**;cache-aware 前缀**字节稳定**,~1814 token 的 KB 前缀在重复查询时**便宜 ~90%**(0.1× 价)。

**这里的关键认知:Q4 的修复不是压缩,是「顺序 + 归一化」。** 发给模型的字节没少(信息没损失),但成本降到一折。这和"压缩类工具"是不同维度——压缩减少字节但可能伤缓存,拼装优化不减字节却让缓存生效,两者甚至可能冲突(压缩改写了本可稳定的前缀)。

---

## 与其余组件的关系

`04-prompt-assembler` 落在 **L1(输入缓存层)**,补上了之前只有设计稿的 INPUT 维度:

- 它**不是** gateway。gateway 是运行时代理(改 base_url 拦请求);assembler 是**构造期的库**,供你在自己拼 prompt 时调用,或供 gateway 内部调用。
- 与 cache-doctor 的区别:cache-doctor 只检测单个 CLAUDE.md 文件;assembler 理解**整个请求的多段拼装结构**,做排序、断点、RAG 布局。cache-doctor 是子集。
- 与 Headroom CacheAligner 的关系:CacheAligner 在代理层做类似的前缀稳定;assembler 是可在**任何自建 agent / RAG 服务**里直接 import 的纯库,不需要起代理。两者择一或互补(assembler 管你自己的 RAG 服务拼装,CacheAligner 管你过 proxy 的 agent 流量)。

---

## 一句话总结

省 INPUT token 的本质,是**让你自己请求流里那个又长又稳的前缀,在连续请求间字节不变地复用**。四个问题其实是同一件事的四个侧面:① 认清只有单租户内能复用;② 按稳定性把长 system/tool/历史排进前缀;③ 把拼装结构当一等设计决策;④ RAG/wiki 用"稳定导航前缀 + 归一化证据尾部"对齐这个结构。代码把这套原理做成了可运行、可测试的库。
