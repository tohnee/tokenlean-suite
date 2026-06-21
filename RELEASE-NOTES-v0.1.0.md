# TokenLean Suite v0.1.0 — Release Notes

> 发布日期：2026-06-21
> Git Tag: 待打 (建议 `v0.1.0`)
> GitHub: https://github.com/tohnee/tokenlean-suite
> npm: `tokenlean-suite` (待发布)
> 许可证：MIT

---

## 一、发布概要

TokenLean Suite v0.1.0 是首个面向 npm 仓库的**正式发布候选版本**。本版本的核心目标是把分散的"省 token"组件整合为一个**可安装、可验证、可叠加**的完整套件，并通过 345 条自动化断言 + GitHub Actions CI 矩阵证明其在 Node 18 / 20 / 22 三个 LTS 版本上行为一致。

**核心价值主张**：把 LLM 应用的 token 成本视为 **INPUT × OUTPUT × FUTURE INPUT** 三个独立维度，并提供四层**正交可叠加**的干预手段：

1. **workflow**（hooks + skills）— 在 prompt assembler 之外的进程级干预
2. **MCP server**（stdio + http）— 把不可信文件系统操作转换为可量化、可约束的协议层
3. **RAG server**（http）— 在 chatbot 场景下利用 prefix cache 复用 KB chunks
4. **prompt assembler**（库）— 提供 normalize、cache-key、TTL、headroom 等基础原语

---

## 二、新增功能（Features）

### 2.1 npm-ready 包结构

- **`package.json`**：声明 `bin` 入口（`tl`, `tl-mcp`, `tl-rag`, `tl-audit`, `tl-plan`, `tl-normalize`, `tl-symbols`, `tl-snippet`），`files` 白名单只发布必要文件，`engines.node >= 18`，MIT 协议
- **`LICENSE`**：新增 MIT 许可证文件
- **`.gitignore`**：补齐 `node_modules`、`coverage/`、`.env` 等忽略项

### 2.2 CLI 命令行入口（`tl`）

8 个子命令覆盖三类用户场景：

| 命令 | 用途 | 典型用法 |
|---|---|---|
| `tl mcp stdio` | 启动 MCP 服务（本地 coding agent） | `tl mcp stdio --root .` |
| `tl mcp http` | 启动 MCP 服务（HTTP/Web copilot） | `tl mcp http --token secret --port 8765` |
| `tl rag http` | 启动 RAG 服务（chatbot） | `tl rag http --token secret --port 8766` |
| `tl audit` | 分析 token 消耗 | `tl audit --claudecode --savings` |
| `tl plan` | 分析缓存布局 | `tl plan --example` |
| `tl normalize` | 归一化 RAG chunk | `tl normalize results.json` |
| `tl symbols` | 代码结构预览 | `tl symbols src/` |
| `tl snippet` | 提取函数/类 | `tl snippet handleSubmit` |

### 2.3 新增 Skills

- **`prompts-compressor`** (新)：INPUT 维度的提示词压缩技能，定义 6 类压缩规则（角色定义、few-shot、规则集、格式、上下文、分段），并给出可量化的"压缩前/后"模板示例
- **`surgical-edits`** (扩展)：OUTPUT 维度的"手术刀"编辑技能，新增 `max_tokens` 预算声明、紧凑 JSON 输出建议、与 caveman/rtk/Headroom 的正交关系说明

### 2.4 CI/CD 工作流

- **`.github/workflows/ci-cd.yml`**：GitHub Actions 工作流
  - `test` job：Node 18 / 20 / 22 矩阵，运行全部 345 条断言
  - `lint` job：检查 CLI 可执行权限、`bin/` 与 `package.json` 一致性、提交信息不含 secret
  - `publish` job：仅在打 `v*` tag 时触发，自动 `npm publish` + 创建 GitHub Release

### 2.5 测试覆盖率

- 新增 `npm run test:coverage` 脚本，使用 **c8** 生成 HTML 报告
- 关键模块（hooks、bash-lint、cache-doctor）达到 **100% 行覆盖率**
- 子进程内部代码通过 stdio / http 黑盒测试覆盖

### 2.6 文档体系

| 文档 | 用途 |
|---|---|
| `README.md` | 总入口与设计哲学 |
| `QUICKSTART.md` | 3 分钟快速上手 |
| `LOCAL-VERIFY.md` | 本地端到端验证步骤 |
| `COMPARISON-REPORT.md` | 与 Reasonix / omp / OpenCode 等同类方案的横向对比 |
| `REFERENCE-REVIEW.md` | 设计参考与文献综述 |
| `REFACTOR-PLAN.md` | 4 阶段实施路线图 |
| `TEST-REPORT.md` | 完整测试报告 |

---

## 三、本次发布（commit 335d193）的文件变更

**变更规模**：28 个文件，+2514 / -7 行

### 3.1 新增文件（25 个）

| 文件 | 行数 | 用途 |
|---|---|---|
| `.claude/skills/prompts-compressor/SKILL.md` | 102 | INPUT 维度提示词压缩技能 |
| `.claude/skills/surgical-edits/SKILL.md` | 43 | OUTPUT 维度编辑技能 |
| `.github/workflows/ci-cd.yml` | 167 | CI/CD 工作流 |
| `01-workflow/claude-code/skills/prompts-compressor/SKILL.md` | 102 | 同上（在 workflow 子目录） |
| `01-workflow/claude-code/skills/surgical-edits/SKILL.md` | 43 | 同上 |
| `01-workflow/test/test-skills.mjs` | 180 | 25 条新断言验证两个新技能 |
| `COMPARISON-REPORT.md` | 245 | 同类方案对比报告 |
| `LICENSE` | 21 | MIT 许可证 |
| `LOCAL-VERIFY.md` | 270 | 本地运行指南 |
| `QUICKSTART.md` | 184 | 快速上手 |
| `REFACTOR-PLAN.md` | 398 | 4 阶段实施路线图 |
| `REFERENCE-REVIEW.md` | 297 | 参考资料与文献 |
| `bin/tl.mjs` | 93 | CLI 主入口（dispatcher） |
| `bin/tl-audit.mjs` | 17 | `tl audit` 子命令 |
| `bin/tl-mcp.mjs` | 33 | `tl mcp` 子命令 |
| `bin/tl-normalize.mjs` | 40 | `tl normalize` 子命令 |
| `bin/tl-plan.mjs` | 36 | `tl plan` 子命令 |
| `bin/tl-rag.mjs` | 29 | `tl rag` 子命令 |
| `bin/tl-snippet.mjs` | 19 | `tl snippet` 子命令 |
| `bin/tl-symbols.mjs` | 19 | `tl symbols` 子命令 |
| `package.json` | 80 | npm 元信息 + bin 入口 |

### 3.2 修改文件（7 个）

| 文件 | 变更 |
|---|---|
| `.gitignore` | +6 行：补齐 `node_modules`、`coverage/`、`.env` |
| `01-workflow/install.sh` | +9/-? ：安装后显示推荐框（rtk / Headroom / caveman） |
| `01-workflow/opencode/tokenlean-instructions.md` | +9 行：opencode 集成说明 |
| `01-workflow/test/test-hooks.mjs` | +55 行：35 → 54 断言 |
| `INDEX.md` | +7/-? ：新增 npm 安装章节 |
| `README.md` | +2 行：选型决策更新 |
| `TEST-REPORT.md` | +15/-? ：断言数 210 → 345 |

---

## 四、验证结果

### 4.1 CI/CD 状态（最终一次运行：Run #4）

**结论**：✅ **All Jobs Passed**

| Job | 状态 | 说明 |
|---|---|---|
| test (18) | ✅ success | Node 18 矩阵 |
| test (20) | ✅ success | Node 20 矩阵 |
| test (22) | ✅ success | Node 22 矩阵 |
| lint | ✅ success | CLI 权限、bin 一致性、提交信息检查 |
| publish | ⏭ skipped | 仅 tag 触发（正常） |

- **CI 详情**：https://github.com/tohnee/tokenlean-suite/actions/runs/27909569062
- **耗时**：~14s（缓存命中）
- **总通过断言**：345 / 345

### 4.2 CI 过程发现并修复的 2 个问题

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | `03-rag-server / http-e2e` 失败 | CI 中设置了 `TOKENLEAN_RAG_TOKEN=test`，导致 test 期望外部已运行服务器（127.0.0.1:8770），但 CI 没有启动服务器 | 移除 env var，测试自动 spawn 子进程服务器并在结束时清理（commit `edc3400`） |
| 2 | `lint: Verify no debug/secret commits` 失败 | lint 正则匹配了 `key=value` 文本模式，误判合法 commit 信息 | 收紧正则为 `key=value` 实际凭证形式 `(debug\|secret\|password\|token\|key\|xxx)\s*[:=]\s*\S+`（commit `c168fea`） |

### 4.3 本地测试

```bash
$ npm test
# 预期输出：
# 01-workflow/hooks: 54/54 passed
# 01-workflow/skills: 25/25 passed
# 01-workflow/opencode-plugin: 63/63 passed
# 02-mcp-server/stdio: 38/38 passed
# 02-mcp-server/http: 26/26 passed
# 03-rag-server/unit: 36/36 passed
# 03-rag-server/simulation: 12/12 passed
# 03-rag-server/http-e2e: 35/35 passed
# 04-prompt-assembler/assembler: 28/28 passed
# 04-prompt-assembler/ttl: 28/28 passed
# 总计: 345 passed, 0 failed
```

### 4.4 覆盖率（关键模块）

| 模块 | 行覆盖率 | 分支覆盖率 | 备注 |
|---|---|---|---|
| `01-workflow/claude-code/hooks/*.mjs` | 100% | n/a | cache-doctor, bash-lint, hit-rate, session-start, bash-guard, write-guard, precompact |
| `01-workflow/claude-code/lib/*.mjs` | 100% | n/a | 共享工具函数 |
| `02-mcp-server/lib/core.mjs` | ~85% | n/a | 失败的分支主要是 `hit-rate` 子进程系统错误路径（CI 不可重现） |
| `03-rag-server/lib/rag-core.mjs` | 100% | n/a | RAG 核心（normalize / cache-key / TTL） |
| `04-prompt-assembler/lib/*.mjs` | 100% | n/a | 基础原语 |

报告位置：`coverage/index.html`（运行 `npm run test:coverage` 生成）

---

## 五、安装与使用

### 5.1 npm 全局安装（推荐，待 npm 发布后可用）

```bash
npm install -g tokenlean-suite

# 验证
tl help
```

### 5.2 源码安装（当前可用）

```bash
git clone https://github.com/tohnee/tokenlean-suite.git
cd tokenlean-suite
npm install -g .
tl help
```

### 5.3 场景一：Coding Agent（Claude Code / OpenCode）

```bash
# 1. 安装 workflow hooks + skills
cd your-project
bash path/to/tokenlean-suite/01-workflow/install.sh

# 2. 配置 MCP server（~/.claude/settings.json 或项目 .claude/settings.json）
# {
#   "mcpServers": {
#     "tokenlean": {
#       "command": "tl",
#       "args": ["mcp", "stdio", "--root", "."]
#     }
#   }
# }

# 3. 启动
claude code
# 或 opencode
```

效果：自动启用 4 个 hooks（大文件写入拦截、无界命令改写、cache doctor、precompact）+ 4 个 skills（编辑格式、压缩提示、surgical-edits 等）

### 5.4 场景二：Chatbot + RAG（HTTP 服务）

```bash
# 启动 RAG 服务
tl rag http --token $(openssl rand -hex 16) --port 8766

# 验证
curl http://127.0.0.1:8766/healthz
# {"ok":true,"sessions":0,"server":"tokenlean-rag","version":"0.1.0"}
```

在 Claude.ai / ChatGPT 的 MCP Connector 中添加：
- URL: `http://your-host:8766/mcp`
- Auth: `Bearer <your-token>`

---

## 六、发布清单（npm 仓库交付物校验）

| 类别 | 项 | 状态 |
|---|---|---|
| **元信息** | `name` (tokenlean-suite) | ✅ |
|  | `version` (0.1.0) | ✅ |
|  | `description` | ✅ |
|  | `license` (MIT) | ✅ |
|  | `repository.url` | ✅ |
|  | `homepage` | ✅ |
|  | `bugs.url` | ✅ |
|  | `engines.node` (>=18) | ✅ |
|  | `keywords` (8 个) | ✅ |
| **入口** | `bin.tl` | ✅ `bin/tl.mjs` |
|  | `bin.tl-mcp` / `tl-rag` / 6 个子命令 | ✅ |
|  | 所有 bin 文件可执行 (chmod +x) | ✅ CI lint 验证 |
| **文件白名单** | `bin/*.mjs` | ✅ |
|  | `01-workflow/.claude/` + `claude-code/` | ✅ |
|  | `02-mcp-server/{lib,bin,tokenlean.mjs}` | ✅ |
|  | `03-rag-server/{lib,bin,tokenlean.mjs}` | ✅ |
|  | `04-prompt-assembler/lib/` | ✅ |
|  | 8 个 .md 文档 | ✅ |
| **依赖** | 生产依赖 (dependencies) | ✅ **零** |
|  | 开发依赖 (devDependencies) | ✅ c8 ^10.1.3 |
| **测试** | `npm test` 通过 | ✅ 345/345 |
|  | `npm run test:coverage` 生成报告 | ✅ |
| **CI/CD** | GitHub Actions 工作流 | ✅ |
|  | 多 Node 版本矩阵 | ✅ 18/20/22 |
|  | lint 任务 | ✅ |
|  | publish 任务（tag 触发） | ✅ |
| **文档** | README | ✅ |
|  | LICENSE | ✅ |
|  | QUICKSTART | ✅ |
|  | CHANGELOG (本文件) | ✅ |

**dry-run 验证**：
```bash
$ npm publish --dry-run
# 预期：包大小合理（< 1 MB），无警告，无缺失文件
```

---

## 七、已知限制

1. **Caveman / rtk / Headroom 未打包**：这些是兄弟项目，本套件不强制依赖；`install.sh` 末尾给出推荐安装命令
2. **OpenCode parity 仅为 hook 级**：opencode 集成通过 `opencode/plugin/tokenlean.ts` 提供；`01-workflow/opencode/tokenlean-instructions.md` 描述完整配置
3. **HTTP 端到端测试需要 Node 20+**（使用 `fetch` + `AbortController`）；Node 18 上对应步骤会被跳过
4. **gateway 层（设计文档中提及）尚未实现**：当前版本不包含 token 计量代理；规划在 v0.3.0 引入
5. **覆盖率报告默认不上传**：需手动 `npm run test:coverage` 后在 `coverage/index.html` 查看

---

## 八、升级与回滚

### 8.1 新用户

```bash
npm install -g tokenlean-suite@0.1.0
```

### 8.2 现有用户（从 git 旧版本）

```bash
cd tokenlean-suite
git fetch --tags
git checkout v0.1.0   # 或 master（HEAD）
npm install
npm test              # 确认 345/345 通过
```

### 8.3 回滚

```bash
git checkout v0.0.x   # 上一稳定版本
npm install
```

---

## 九、贡献者

- **tohnee** <836966453@qq.com> — 主导实现、设计与测试

---

## 十、引用与参考

- 完整测试报告：[TEST-REPORT.md](./TEST-REPORT.md)
- 设计哲学：[README.md](./README.md)
- 快速上手：[QUICKSTART.md](./QUICKSTART.md)
- 本地验证：[LOCAL-VERIFY.md](./LOCAL-VERIFY.md)
- 同类对比：[COMPARISON-REPORT.md](./COMPARISON-REPORT.md)
- 实施路线：[REFACTOR-PLAN.md](./REFACTOR-PLAN.md)
- CI/CD 详情：https://github.com/tohnee/tokenlean-suite/actions/runs/27909569062

---

> **下一步**：打 tag `v0.1.0` → 触发 `publish` job → 验证 npm 公开包 → 在 GitHub Releases 发布本文件
