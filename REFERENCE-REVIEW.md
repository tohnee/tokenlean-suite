# 碧桂园实践复盘：tokenlean 可借鉴的优化点

> 源自：CSDN《企业大规模AI Coding落地：如何控制大模型成本？》+ 腾讯云《AI Code 企业落地》
> 聚焦范围：不涉及工程记忆持久化架构（`.ai-memory/`），仅提取可融入 tokenlean 现有分层架构（L1-L4 干预层）的优化点。
> 分析方式：每个借鉴点 → 做什么 → 为什么 → 放到 tokenlean 哪一层 → 直接修改哪些文件 → 预期收益

---

## 一、总览：碧桂园做了什么，tokenlean 缺什么

| 碧桂园做法 | tokenlean 已覆盖 | tokenlean 缺失 | 可落地 | 优先级 |
|---|---|---|---|---|
| ① 提示词压缩（用结构化格式替代自然语言） | ❌ | ✅ | 新增 l4-skill / 修改 l4-skill | **P0** |
| ② Rules 持久化（CLAUDE.md + 缓存命中 96%） | ✅ `session-start hook` 审计 + `prefix-stable skill` 引导 | — | 不修改 | — |
| ③ Skill 封装（一键触发替代 1500 Token） | ✅ 已有 3 个 skill | 缺少**压缩模板** | 见① | — |
| ④ MCP 按需获取 | ✅ `fs_outline`/`fs_read_hashed`/`search_lean` | — | 不修改 | — |
| ⑤ 模型智能路由（Haiku→Sonnet→Opus） | ❌ | ✅ | **不落地**（tokenlean 是集成层，不替代 LLM 路由） | — |
| ⑥ 输出约束（max_tokens + JSON + 批处理） | ❌ | ✅ | 新增 skill / 修改 `surgical-edits skill` | **P0** |
| ⑦ 提示词缓存（5min 内 0.1x 计价） | ✅ `04-prompt-assembler` 核心设计 | — | 不修改 | — |
| ⑧ 上下文压缩（摘要+近 N 轮，非全历史） | ✅ `precompact hook` + `lean-context skill` | — | 不修改 | — |
| ⑨ 工程记忆持久化 | ❌ | ✅ | **排除**（用户已确认） | — |

**可落地的只有 3 项**，其中 P0 两项（提示词压缩、输出约束），编号为①⑥。其余碧桂园做法 tokenlean 已覆盖或不在范围。

---

## 二、改进项①：提示词压缩 Skill（P0）

### 碧桂园的做法

将自然语言段落改为结构化格式（YAML/kv），删除填充词，合并冗余指令：

```
优化前（286 Token）：
你是一个专业的客服人员。当用户向你提问时，你需要仔细分析用户的
问题，然后提供详细、全面且准确的回答。请确保你的回答包含足够的
细节……

优化后（97 Token）：
角色：客服人员
规则：准确简洁 | 不确定时如实说明 | 超出范围建议寻求专业帮助
格式：直接回答 + 后续建议
```

效果：3,500 Token 系统提示词 → 1,200 Token（↓66%）。

### 在 tokenlean 中的位置

**L4（用户提示层）** → `01-workflow/claude-code/skills/` 新增一个 `prompts-compressor` skill。

当前已有的 3 个 skill：
- `prefix-stable` — 避免 CLAUDE.md 破坏缓存前缀（INPUT 维度）
- `surgical-edits` — 引导使用 Edit 而非 Write（OUTPUT 维度）
- `lean-context` — 引导有界读写（FUTURE INPUT 维度）

缺失的是：**引导用户压缩输入 prompt 本身的 skill**。碧桂园的核心技巧——用 YAML/key-value 替代自然语言、删除填充词——可以打包成一个独立的 skill。

### 修改文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `01-workflow/claude-code/skills/prompts-compressor/SKILL.md` | **新建** | 4 条压缩规则 + 模板示例 |
| `01-workflow/opencode/tokenlean-instructions.md` | **修改** | 追加压缩规则 |
| `01-workflow/install.sh` | **不修改** | 自动包含新目录 |
| `01-workflow/test/test-hooks.mjs` | **不修改** | skill 无测试（skill 是 markdown，不可测） |

### Skill 内容设计

```markdown
---
name: prompts-compressor
description: Use when the user asks you to write system prompts, agent instructions,
  role definitions, or any structured instruction text. Compresses verbose natural-language
  prompts into compact structured formats, cutting token count by 40-70% with zero
  information loss.
---

# Prompt Compression (INPUT)

## Why
Every token in your prompt costs the same as a token of reasoning — don't waste
the budget on filler words. Structured formats (YAML, key-value, tables) carry
the same meaning in 30-60% fewer tokens than prose paragraphs. On a 3,500-token
system prompt, compression saves ~2,000 tokens per request — and with prompt
caching (0.1x after first write), those savings compound across every session.

## The rules
1. **Kill filler words.** Delete "请你", "你需要", "请确保", "务必", "务必注意",
   "Please make sure to", "you need to", "it is important to". Say it once,
   don't beg.
2. **Structure over prose.** Replace natural-language paragraphs with
   YAML-like key-value, pipe-separated lists, or compact tables.
   - BAD: "You are a helpful assistant that carefully analyzes user questions
     and provides detailed, comprehensive answers."
   - GOOD: `role: assistant | rule: analyze + detailed answer | style: concise`
3. **Merge redundant instructions.** Two rules that say "be accurate" → one.
   A role description and a "you are a" preamble → merge them.
4. **Use abbreviations and symbols.** `→` for "leads to/becomes", `↓` for
   "decrease", `↑` for "increase", `✗`/`✓` for bad/good. These are universally
   understood by every modern LLM.

## Templates

### Role definition
```
✗ VERBOSE (286 tok)
You are a professional customer service agent. When a user asks you a question,
you need to carefully analyze the user's problem, then provide a detailed,
comprehensive, and accurate answer. Please make sure your answer contains
enough detail and practical suggestions.

✓ COMPRESSED (97 tok)
role: customer-service
rules: accurate+concise | admit uncertainty | suggest pro help if out of scope
format: direct answer + follow-up advice
```

### Code review instruction
```
✗ VERBOSE (~400 tok)
When reviewing code, please check for correct error handling, ensure all
edge cases are covered, verify that the code follows our team's established
coding conventions, look for performance issues, and check security
vulnerabilities. Also pay attention to clean code principles...

✓ COMPRESSED (~180 tok)
review checklist:
  - errors: handle + propagate | no silent catch
  - edge cases: empty/null/zero/overflow/unexpected input
  - style: project conventions (see CLAUDE.md)
  - perf: N+1 queries? hot loops? unnecessary allocations?
  - security: injection? auth bypass? secret leak?
  - clean code: dead code? over-abstraction? magic numbers?
```

### Agent instruction
```
✗ VERBOSE (~520 tok)
You are an AI coding agent with access to tools. When working on a task,
first understand the requirements by reading the relevant files. Then plan
your approach. Then implement the changes. After implementing, run the
tests to verify everything works correctly...

✓ COMPRESSED (~220 tok)
workflow:
  1. understand → read files + ask clarifying questions
  2. plan → outline approach before coding (share plan with user)
  3. implement → surgical edits, no full rewrites
  4. verify → run tests, fix failures
rules: ask before destructive ops | commit per task |
       log key decisions (arch, why, rejected options)
```

## Savings shape
```
  Prose role definition     →  YAML format     ~50-70% fewer tokens
  Verbose agent instruction →  rule list        ~40-60% fewer tokens
  Paragraph constraints     →  pipe-separated   ~30-50% fewer tokens
  Mixed prose+examples      →  table            ~40-60% fewer tokens
```

## Related
- `prefix-stable` skill: keeps the compressed prompt from being undone by
  timestamps/UUIDs.
- `surgical-edits` skill: OUTPUT-side complement — compress what the model emits
  *in response*, not just what you send.
```

---

## 三、改进项⑥：输出约束 Skill（P0）

### 碧桂园的做法

- `max_tokens` 参数设置上限（分类任务 10-50，常规 300-800）
- 要求 JSON 格式输出（比自然语言短 40-60%）
- 非实时任务用 Message Batches API（50% 折扣）

### 在 tokenlean 中的位置

**L4（用户提示层）** → 修改 `surgical-edits` skill，补充输出约束模板。

当前 `surgical-edits` 只覆盖了"Edit 不 Write"这一个 OUTPUT 优化。碧桂园的做法在 OUTPUT 维度上更丰富——JSON 格式、max_tokens 上限、批处理。这些不存在冲突，可以补充到同一个 skill 中。

### 修改文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `01-workflow/claude-code/skills/surgical-edits/SKILL.md` | **修改** | 追加"输出格式约束"和"批处理建议"节 |
| `01-workflow/opencode/tokenlean-instructions.md` | **修改** | 同步追加 |
| `03-rag-server/README.md` | **修改** | RAG 场景追加输出约束建议 |

### 补充内容

追加节到 `surgical-edits/SKILL.md` 末尾：

```markdown
## Output budget (beyond editing)

### Set a token budget for every response
Output tokens cost 4-5× input. Cap generation with `max_tokens`:
- Classification, formatting: 10-50 tokens (you don't need paragraphs for a label)
- Code review, brief summary: 200-400 tokens
- Full implementation: 600-1200 tokens (break into multiple turns if larger)
- If no explicit limit, default to 400 tokens — ask before exceeding.

### Prefer structured output
JSON / YAML output carries the same information in 40-60% fewer tokens than
prose:
```
# Instead of:
"The user registration endpoint has three parameters: username which is
required and must be 3-20 characters, email which is required and must be
a valid email format, and password which is required and must be at least
8 characters."

# Use:
{ "register": {
    "username": "required, 3-20 chars",
    "email": "required, valid format",
    "password": "required, min 8 chars"
}}
```
When the user asks for structured data (configs, specs, test cases), default
to JSON unless they ask for prose. This is not laziness — it's 3× token
efficiency for the same information.

### Batch non-urgent work
Tests, documentation generation, bulk format conversions — these don't need
real-time responses. Queue them for the Batch API (50% discount). If you're
generating >10 test cases, suggest: "Shall I batch these at half price?"
```

---

## 四、其他借鉴点（不落地，仅记录）

### 模型智能路由 — 不落地

**原因**：tokenlean 的设计定位是"集成到 coding agent 和 chatbot 中的 token 优化层"，不是"替代 LLM API 网关"。模型路由是一个独立的基础设施决策（哪个请求 → 哪个模型），不在 tokenlean 的干预范围内。

**如未来要做**：在 `03-gateway-design/` 中补充路由设计，用 Haiku 4.5 作为轻量级分类器（每次 ~$0.0003），分析请求复杂度后将路由到 Opus/Sonnet/Haiku。

### 批处理 API — 落地但不在代码中

**原因**：批处理是客户端侧的行为——用户在自己的调用代码中选择用实时 API 还是 Batch API。tokenlean 能给的是在文档和 skill 中建议"非实时任务请用 Batch API"。

**当前状态**：已在 `surgical-edits skill` 的补充内容中包含此建议。

---

## 五、实施清单

### 准备实施（高优先级）

| # | 文件 | 操作 | 工作量 | 预期收益 |
|---|---|---|---|---|
| ① | `01-workflow/claude-code/skills/prompts-compressor/SKILL.md` | **新建** | 1 文件 ~80 行 | INPUT 维度 -40~70% |
| ① | `01-workflow/opencode/tokenlean-instructions.md` | **追加** | 追加一段 | OpenCode 同步 |
| ⑥ | `01-workflow/claude-code/skills/surgical-edits/SKILL.md` | **追加 3 节** | ~60 行 | OUTPUT 维度 -30~60% |
| ⑥ | `01-workflow/opencode/tokenlean-instructions.md` | **追加** | 追加一段 | OpenCode 同步 |
| ⑥ | `03-rag-server/README.md` | **追加** | 追加一段 | RAG 场景同步 |

### 已确认不实施的

| # | 原因 |
|---|---|
| 模型智能路由 | tokenlean 不替代 LLM API 网关 |
| 工程记忆持久化 | 用户已排除 |
| CLAUDE.md Rules 缓存 | 已由 `session-start hook` + `prefix-stable skill` 覆盖 |
| MCP 按需获取 | 已由 `fs_read_hashed` / `fs_outline` / `search_lean` 覆盖 |

---

## 六、与现有 3 个 skill 的关系矩阵

| | 现有 skill | 新增/改造 skill | 维度 |
|---|---|---|---|
| INPUT 前缀缓存 | `prefix-stable` — 避免 CLAUDE.md 破坏缓存 | **`prompts-compressor`** — 压缩输入 prompt 本身 | 互补：前者保命中率，后者减大小 |
| OUTPUT 模型生成 | `surgical-edits` — Edit 不 Write | **`surgical-edits` 补充输出约束** | 增强：以前只管"用什么工具"，现在加"用多少 token" |
| FUTURE INPUT 历史膨胀 | `lean-context` — 有界读写 + 摘要 | 无变化 | 已覆盖 |

**注意**：`prompts-compressor` 主要是 INPUT 维度的优化，但它的收益也影响 OUTPUT 维度——更短的输入通常会让模型的输出也更短。所以它跨越两个维度。

---

## 七、预期收益（叠加到现有 tokenlean 之上）

| 维度 | 现有节省（来自文档估算） | 追加后节省 | 变化 |
|---|---|---|---|
| INPUT（前缀缓存） | 命中率 ~55-65% | 命中率 ~60-70%（prompt 更短） | +5% |
| INPUT（网络字节） | — | -40~70%（prompts-compressor） | 新增 |
| OUTPUT（编辑） | -40~55%（surgical-edits） | -50~70%（加输出约束） | +10-15% |
| FUTURE INPUT | -50~80%（lean-context） | 无变化 | — |
| **综合** | ~一半 | ~1/3 | ↓ |

**注意**：这些仍然是未经真实模型在环验证的工程估算。碧桂园的真实数据（三项目汇总 $1,400→$166，↓88%）来自多层策略叠加 + 模型降级，tokenlean 缺少模型路由层，所以不会达到 88%，但可在现有基础上再降 20-30 个百分点。
