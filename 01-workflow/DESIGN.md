# tokenlean-workflow 设计文档

> 一套 **不依赖 MCP**、在 Claude Code 与 OpenCode 中**开箱即用**的 token 优化工作流。
> 用各 agent **原生支持的机制**(skills / hooks / slash commands / plugin)系统性覆盖三个 token 维度:**INPUT、OUTPUT、FUTURE INPUT**。
>
> 版本 1.0 · Node ≥ 18 · 零依赖 · 35/35 测试通过。

---

## 1. 为什么是 hooks + skills 而不是 MCP

上一轮我们做了 MCP server。这轮的约束是**不碰 MCP、开箱即用**。关键区别:

| | MCP server | 本方案(workflow) |
|---|---|---|
| 形态 | 独立进程,需在配置里注册 server | 文件丢进 `.claude/` 或 `.opencode/` 即生效 |
| 新增工具 | 可以(fs_edit_hash 等) | 不行,只能约束/增强现有工具 |
| 强制力来源 | 工具契约 | **hooks(确定性拦截)** + 权限 + skills(行为) |
| 安装 | 注册 + 可能要 deny 原生工具 | 复制文件 + 合并 settings 片段 |

没有 MCP 就不能新增"省 token 的工具",所以本方案的策略是:**用 hooks 在确定性层面拦截浪费行为,用 skills 在行为层面引导,用 slash command 做观测和受控操作**。三者分工明确。

---

## 2. 三维度 × 三机制的映射

这是整个设计的核心矩阵。每个维度都用"确定性 hook(强) + 行为 skill(软) + 命令(观测/操作)"三层覆盖。

| 维度 | 确定性机制(hook) | 行为机制(skill) | 命令 |
|---|---|---|---|
| **INPUT**(前缀缓存命中) | `session-start` 启动时审计 CLAUDE.md,发现不稳定前缀就注入告警 | `prefix-stable`:无时间戳/UUID、静态在前、控制体量 | `/cache-report` 看命中率 |
| **OUTPUT**(模型生成) | `write-guard`:用 Write 覆写大文件时拦截,建议改 Edit | `surgical-edits`:用 Edit 不重写、不复述未改内容 | — |
| **FUTURE INPUT**(历史膨胀) | `bash-guard`:无界输出命令(cat/grep -r/find/log/test)拦截并给出有界改写;`precompact`:压缩时保留决策 | `lean-context`:分页读、按需读、读后即摘要 | `/lean-compact` 受控压缩 |
| 全维度 | — | — | `/token-audit` 三维快照 |

### 为什么这样分

- **hook 是地基**:hook 在 agent 循环里确定性触发,不靠模型记得。`bash-guard` 不管模型多健忘,只要它要跑 `cat huge.log`,hook 就会拦。这是 skill 做不到的"强制力"。
- **skill 是引导**:hook 只能拦已知模式,skill 教模型养成习惯(读前探大小、读后写摘要),覆盖 hook 抓不到的长尾。
- **command 是人控**:观测(命中率)和受控操作(有纪律地压缩)交给用户主动触发。

---

## 3. 各机制详解

### 3.1 INPUT — session-start hook + prefix-stable skill

**问题**:CLAUDE.md 每轮都被发送。只要里面有一个会变的字段(时间戳、session id),前缀就 byte 级不稳定,整段对话每轮都按全价 miss 重算。

**hook 做什么**:`SessionStart` 时读 CLAUDE.md/AGENTS.md,跑 `cache-doctor` 检测五类问题(时间戳、随机 ID、超大体量、动态占位符、动态段落在静态之前)。有问题就把诊断作为 `additionalContext` 注入,让模型和你都在烧掉整个 session 之前就知道前缀不稳。干净则**完全静默**(不增加任何 context 噪音)。

**skill 做什么**:当你让模型编辑 CLAUDE.md 时,引导它遵守"无时间戳/无 UUID/静态在前/控制体量",并在你抱怨成本高时优先检查 CLAUDE.md 稳定性。

**命令**:`/cache-report` 解析 `~/.claude/projects/` 的 transcript JSONL,算出真实命中率、各档 token、估算节省、5min/1h TTL 占比,命中率 < 50% 时给出最可能的原因。

**边界**:hook/skill 都改不了 harness 怎么放 cache 断点、改不了服务端 TTL。这部分的天花板需要网关代理(见第 6 节),不在本方案内。

### 3.2 OUTPUT — write-guard hook + surgical-edits skill

**问题**:输出 token 单价是输入的 4-5 倍。用 Write 覆写整个文件 = 把每一行未改的内容也当输出 token 重新吐一遍。

**hook 做什么**:`PreToolUse` 匹配 `Write`。若目标文件已存在且 ≥ 800 字节(可配),说明这是"覆写"而非"新建",拦下来(默认 `ask`)并提示改用 Edit;还会判断新旧内容体量是否相近(相近通常意味着只是小改装成了大重写)。新文件、小文件一律放行(静默)。

**skill 做什么**:引导"改存量文件用 Edit、Write 只用于新建、不复述未改内容、批量改一次过、删除用空替换"。

**实测节省曲线**(替换 N 行的真实重构,模型实际生成的 tool_use JSON 计量):3 行 ~40%、10 行 ~50%、20+ 行 ~53-55%、纯删除 30 行 ~95%。单行只有 ~20%,所以 skill 明确说单行别纠结、用原生 Edit 即可。

### 3.3 FUTURE INPUT — bash-guard + precompact hooks + lean-context skill

**问题**:工具输出会留在历史里,后续每一轮都被重发重计费。第 3 轮 `cat` 的 500 行日志,会在 4…N 轮被反复计费。

**bash-guard hook**:`PreToolUse` 匹配 `Bash`。用 `bash-lint` 识别无界输出命令(`cat` 大文件、`grep -r`、`find`、读 `.log`、`npm test`/`pytest`/`make`、`git log` 不带 `-n`、`ls -R`),且未带有界限定符(`| head`、`| tail`、`-n N`、`-m`、`sed -n` 等)。三种模式:
- `guard`(默认):返回 `ask`,理由里附上**具体的有界改写**(如 `cat server.log` → `sed -n "1,200p" server.log`)
- `auto`:直接用 `updatedInput` 把命令改成有界版(需较新的 Claude Code 支持 `updatedInput`,旧版会忽略,模型照原样跑,不会出错)
- `off`:停用

**precompact hook**:`PreCompact` 时注入压缩策略——保留决策+理由、活跃约束、未决任务、在用的文件/标识;丢弃原始工具输出、被推翻的推理、已解决的死路;保留最近几轮原文,不臆造。压缩是前缀唯一被重写的时刻,盲压会丢关键决策并让缓存变冷,这个 hook 把损失降到最低。

**skill 做什么**:`lean-context` 引导"读前探大小、按范围读、给每类问题选对工具(列目录用 ls 不用 cat *、找用法用 grep | head、看最新错误用 tail)、读完即写一行摘要、不重复读"。

**命令**:`/lean-compact` 让模型先产出结构化 handoff 摘要再压缩,而不是裸压。

---

## 4. 两个 agent 的落地差异

功能一致,机制载体不同(这点和 MCP 那版的"两种传输形态"是不同的轴——这里是两个**不同 agent 的原生扩展点**)。

| | Claude Code | OpenCode |
|---|---|---|
| 行为引导 | `.claude/skills/*/SKILL.md` | `.opencode/tokenlean-instructions.md`(经 `instructions` 引用)+ 兼容 skills |
| 确定性拦截 | `.claude/hooks/*.mjs`(JSON over stdin,SessionStart/PreToolUse/PreCompact) | `.opencode/plugin/tokenlean.ts`(`tool.execute.before` 钩子,可改写 args 或抛错) |
| 命令 | `.claude/commands/*.md`(`!` 前缀跑 bash 注入输出) | `.opencode/command/*.md` |
| 配置 | `.claude/settings.json`(hooks + env + permissions) | `opencode.json`(plugin 自动加载 + permission) |
| 强制 OUTPUT | `permissions.deny: ["Write(src/**)"]` | `permission.edit` / 插件抛错 |

OpenCode 的插件把 bash-lint 和 cache-doctor 逻辑**内联**进 `tokenlean.ts`(自包含,无外部依赖),逻辑与 Claude Code 的 lib 完全对齐(已做 parity 测试)。`tool.execute.before` 既能在 `auto` 模式直接改写命令 args,也能在 `guard` 模式抛错中断,等价于 Claude Code hook 的 `updatedInput` / `ask`。

---

## 5. 验证

`test/test-hooks.mjs` 用 mock 数据(完全复刻 Claude Code 传给 hook 的 stdin JSON 结构)驱动,不需要真实 agent 即可验证:

```
[1] cache-doctor  (INPUT)        5 断言:时间戳/UUID/超大→critical,干净→ok
[2] bash-lint     (FUTURE)      10 断言:各类无界命令识别 + 有界豁免
[3] hit-rate      (INPUT 观测)   3 断言:JSONL 解析、命中率、节省
[4] session-start hook           3 断言:坏文件注入告警、好文件静默
[5] bash-guard hook              7 断言:risky→ask、安全→静默、auto→改写、off、非Bash忽略
[6] write-guard hook             5 断言:覆写大文件→ask、新文件/小文件放行、warn 模式
[7] precompact hook              2 断言:注入保留/丢弃策略
                                ─────
                                35 passed, 0 failed
```

外加 OpenCode 插件逻辑 parity 检查(6/6)。安装器也做了端到端验证:装进 fake Claude / OpenCode 项目后,hook 从安装位置(相对 `../lib` 导入)能正确运行。

---

## 6. 本方案的边界(诚实说明)

- **INPUT 的天花板**:hook 能审计 CLAUDE.md、能监控命中率,但**改不了 harness 的 cache 断点放置和服务端 TTL**。要把命中率从"修好 CLAUDE.md 后的 ~55-65%"推到 Reasonix 级别的 99%+,需要 harness 级 append-only 不变量或一层 LLM 网关代理(改 base_url、注入 cache_control、强制 1h TTL)。那是另一个组件,不在"开箱即用 workflow"范围内。
- **OUTPUT 的天花板**:没有 MCP 自定义编辑工具,无法把 Edit 的 wire format 换成 hash 锚点。本方案靠 write-guard + skill 让你**选对工具、写紧 diff**,拿到 Edit 本身的节省;要拿 omp Hashline 那种协议级 -61%,得上 MCP(上一轮的 tokenlean-mcp)。
- **bash-guard 的 auto 改写**:依赖客户端是否尊重 `updatedInput`/插件 args 改写;`guard` 模式(ask + 建议)在所有版本都稳。

综合预期(开箱即用、不换 agent、不上 MCP):**INPUT -20~35%、OUTPUT 编辑场景 -40~55%、FUTURE INPUT -50~80%**,叠加后整体成本可降到原来的一半上下。要再进一步,路径是 + MCP(OUTPUT 协议级) + 网关(INPUT 命中率),本方案与那两者可叠加共存。

---

## 7. 文件清单

```
tokenlean-workflow/
├── install.sh                      # 检测 agent、安装、自测
├── DESIGN.md  README.md
├── claude-code/
│   ├── skills/{prefix-stable,surgical-edits,lean-context}/SKILL.md
│   ├── commands/{cache-report,lean-compact,token-audit}.md
│   ├── hooks/{session-start,bash-guard,write-guard,precompact}.mjs
│   ├── lib/{cache-doctor,bash-lint,hit-rate}.mjs
│   └── settings.snippet.json
├── opencode/
│   ├── plugin/tokenlean.ts          # 内联同款逻辑,tool.execute.before
│   ├── command/token-audit.md
│   ├── tokenlean-instructions.md
│   └── opencode.snippet.json
└── test/test-hooks.mjs              # 35 断言,mock 驱动
```
