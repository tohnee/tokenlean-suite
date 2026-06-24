# Changelog

本文件记录 tokenlean-suite 的变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased] — 2026-06-24

### Benchmarks — 三维度量化补强

- 新增 `02-mcp-server/test/bench-future.mjs`：用真实仓库文件和真实 MCP core 量化 FUTURE INPUT（工具输出进入历史后被后续轮次重复计费）的 context-token-turn 成本。
- 新增 `02-mcp-server/test/test-bench-future.mjs`：覆盖 FUTURE benchmark 的操作数、lean/naive token、累积重计费收益和报告输出。
- 新增 `02-mcp-server/test/bench-coding-agent.mjs` 与 `test-bench-coding-agent.mjs`：把 FUTURE INPUT 重计费成本和编辑 OUTPUT 成本合并成 coding-agent 使用场景,计算 TokenLean vs full-rewrite / native-Edit agent 的总成本节省。
- 重构 `02-mcp-server/test/bench-output.mjs`：导出 `runOutputBench()` / `renderOutputReport()`，保留 CLI 行为，便于统一聚合。
- 新增 `bin/tl-bench.mjs` 与 `tl bench`：一条命令输出 OUTPUT、FUTURE INPUT、CODING AGENT、INPUT/RAG 四类 savings report。
- 新增 `test-bench.mjs` 和 `SAVINGS-REPORT.md`：把统一 benchmark 接入测试与发布文件。

## [Earlier Unreleased] — 2026-06-20

代码审查后的系统性修复：S1（文档对齐）→ S2（parity + 测试）→ M1-M2（设计文档与依赖）→ M3-M4（HTTP 会话与性能）。

### S1 — 文档与实际交付对齐

#### `02-mcp-server/README.md`（重写）
- **删除**：引用不存在的 `gateway.mjs`、`test/test-client.mjs`、`test/test-gateway.mjs`、`/stats` 端点、端口 8788、58 断言等过时信息。
- **新增**：正确的双传输架构说明（stdio + http，无 gateway 层）。
- **修正**：端口 8765、端点（POST/DELETE `/mcp`、GET `/healthz`）、环境变量表、文件清单。
- **修正**：测试断言数（38 stdio + 19 http = 57，后随 M3 增至 64）。
- **修正**：hash 长度标注为 4 字符。

### S2 — OpenCode 插件 parity gap 修复 + 单元测试

#### `01-workflow/opencode/plugin/tokenlean.ts`（parity 修复）
- **新增 `ls-R` 规则**：bash-lint 从 6→7 条规则，与 Claude Code 的 `bash-lint.mjs` 对齐。
- **增强 `TIMESTAMP_RE`**：补齐 `{{timestamp}}`、`` `date` ``、`new Date()`、`Date.now` 检测。
- **增强 `UUID_RE`**：补齐 `{{uuid}}`、`{{nanoid}}`、`{{session_id}}`、`{{sessionId}}`、`{{random}}` 模板变量检测。
- **新增 `PLACEHOLDER_RE` + `KNOWN_DYNAMIC`**：检测未知动态占位符（warning）。
- **新增 ordering 检查**：动态标题在静态标题之前时告警（warning）。
- **新增 size >3000 警告层级**：与 cache-doctor 的双层级（>5000 critical / >3000 warning）对齐。
- **修复 TypeScript 类型**：为 `forEach` 回调参数添加 `string`/`number` 类型标注。

#### `01-workflow/test/test-opencode-plugin.mjs`（新建，63 断言）
- **Layer 1 — 功能测试**（30 断言）：直接测试 Claude Code 的 `bash-lint.mjs` + `cache-doctor.mjs`（source of truth），验证 7 条规则和 5 项检查的正确行为。
- **Layer 2 — 结构 parity 测试**（28 断言）：读取 `tokenlean.ts` 文本，验证所有规则、正则、检查都存在，捕获 parity 漂移。
- **Layer 3 — 插件结构完整性**（5 断言）：验证 `TokenLeanPlugin` 导出、`tool.execute.before` 钩子、环境变量、write guard。

### M1 — 同步 DESIGN.md 的 hash 长度描述

#### `02-mcp-server/DESIGN.md`
- **修正**：`fs_read_hashed` 工具表 "每行 2 字符 hash" → "每行 4 字符 hash"。
- **修正**：测试断言数 35+15=50 → 38+19=57（后随 M3 增至 64）。

#### `02-mcp-server/lib/core.mjs`
- **修正**：`fs_read_hashed` 工具描述 "2-char content hash" → "4-char content hash"。

### M2 — 调整 package.json 依赖声明

#### `02-mcp-server/package.json`
- **移动**：`gpt-tokenizer` 从 `dependencies` → `devDependencies`（仅 `bench-output.mjs` 可选使用，有 chars/4 降级）。
- **修正**：`main` 从不存在的 `index.js` → `tokenlean.mjs`。
- **修正**：`scripts.test` 从报错占位符 → 实际测试命令（`node test/test-stdio.mjs && node test/test-http.mjs`）。
- **新增**：`scripts.bench`、`type: "module"`、`keywords`、`description` 明确标注核心零依赖。

### M3 — 修复 HTTP `__default__` 会话共享状态问题

#### `02-mcp-server/bin/http.mjs`
- **新增文档注释**：说明 `__default__` 的语义和限制（只读 Q&A 可接受，并发编辑必须发 `mcp-session-id`）。
- **修复 TTL**：`__default__` 现在参与 TTL 清理（此前被 `sweepSessions` 跳过，永久驻留）。
- **新增 warn 日志**：首次 fallback 时打印 stderr WARNING（每个 TTL 窗口只警告一次，避免日志噪音）。
- **修复 hard cap**：`__default__` 也参与 `SESSION_MAX` 驱逐。

#### `02-mcp-server/test/test-http.mjs`（+7 断言，19→26）
- 新增 `[10] __default__ fallback for sessionless clients` 测试组：
  - sessionless 请求成功 via fallback
  - fallback warning 写入 stderr
  - `__default__` session 计数正确
  - 第二次 sessionless 请求复用 `__default__`
  - sessionless edit 被正确处理（stale 拒绝）
  - DELETE `__default__` 返回 ok
  - `__default__` 被 DELETE 后 session 计数减少

### M4 — 修复 search_lean 同步 I/O 阻塞事件循环

#### `02-mcp-server/lib/core.mjs`
- **新增环境变量**：`SEARCH_MAX_FILES` 现在可通过 `TOKENLEAN_SEARCH_MAX_FILES` 覆盖（默认 4000），用于大仓库调优。

#### `02-mcp-server/bin/http.mjs`
- **新增事件循环让出**：在 `core.dispatch(msg)` 前用 `await new Promise(r => setImmediate(r))`，让排队请求能在长同步搜索开始前被处理。
- **新增启动 banner 提示**：说明 search_lean 同步 I/O 特性和 `TOKENLEAN_SEARCH_MAX_FILES` 调优方式。
- **导入 `LIMITS`**：用于 banner 中显示当前 `SEARCH_MAX_FILES` 值。

#### `02-mcp-server/README.md`
- **新增环境变量条目**：`TOKENLEAN_SEARCH_MAX_FILES`（默认 4000，说明同步 I/O 特性）。

### 注释与文档同步

#### `02-mcp-server/lib/core.mjs`（文件头注释）
- 新增 "Design constants" 段，与 DESIGN.md 保持同步：
  - Hash anchor length: 4 hex chars（16-bit 空间，比旧 2-char hash 降低 ~256x 误重定位风险）。
  - Test suite: 64 assertions total（38 stdio + 26 http）。

#### 断言数同步（因 M3 新增 7 个 http 测试，19→26，57→64）
- `02-mcp-server/lib/core.mjs`：注释 57→64。
- `02-mcp-server/README.md`：3 处（57→64, 19→26）。
- `02-mcp-server/DESIGN.md`：4 处（57→64, 19→26）。

### 测试验证

完整测试套件回归验证，0 失败：

| 套件 | 断言数 | 结果 |
|---|---|---|
| `01-workflow/test/test-hooks.mjs` | 35 | ✓ |
| `01-workflow/test/test-opencode-plugin.mjs` | 63 | ✓（新增） |
| `02-mcp-server/test/test-stdio.mjs` | 38 | ✓ |
| `02-mcp-server/test/test-http.mjs` | 26 | ✓（+7） |
| `04-prompt-assembler/test/test-assembler.mjs` | 28 | ✓ |
| `04-prompt-assembler/test/test-ttl.mjs` | 20 | ✓ |
| **合计** | **210** | **0 failed** |

`02-mcp-server/install.sh` 自测也正常通过。

### 修改文件清单

| 文件 | 变更类型 | 关联任务 |
|---|---|---|
| `02-mcp-server/README.md` | 重写 + 多次更新 | S1, M4, sync |
| `01-workflow/opencode/plugin/tokenlean.ts` | 修改 | S2 |
| `01-workflow/test/test-opencode-plugin.mjs` | 新建 | S2 |
| `02-mcp-server/DESIGN.md` | 修改 | M1, sync |
| `02-mcp-server/lib/core.mjs` | 修改 | M1, M4, sync |
| `02-mcp-server/package.json` | 重写 | M2 |
| `02-mcp-server/bin/http.mjs` | 修改 | M3, M4 |
| `02-mcp-server/test/test-http.mjs` | 修改 | M3 |
| `CHANGELOG.md` | 新建 | 本文件 |
