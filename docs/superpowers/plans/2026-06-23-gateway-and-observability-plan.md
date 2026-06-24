# Gateway + Observability/CLI/Multi-Provider 补强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 05-gateway-design 从设计稿变成可运行的 LiteLLM 零代码代理 + CLI 工具，同时补强 01-04 的命中率观测、多 provider 配置、CLI 统一入口。

**Architecture:** 用 Node CLI 生成 LiteLLM YAML 配置并启动子进程；命中率解析与漂移检测封装为纯 Node 库；所有新增功能通过 `tl gateway` / `tl audit` / `tl plan` 暴露。

**Tech Stack:** Node.js >=18, ES modules, 仅内置依赖；LiteLLM 由用户通过 pip/Docker 自行安装，不作为 npm 依赖。

## Global Constraints

- Node.js >= 18
- 不引入新的 npm 运行时依赖
- LiteLLM 由用户本地安装，CLI 只生成配置和 spawn 子进程
- 不破坏现有 API：`hit-rate.mjs` 的 `analyze(path)` 与 `report(path)` 签名保持不变
- 所有退出码必须透传（参考 `tl-mcp.mjs` 模式）
- 新增代码必须带测试；回归 `npm test` exit 0
- 中文注释与文档保持一致（项目主要语言）

---

## File Structure

```
05-gateway-design/
├── config/
│   └── litellm-cache-proxy.yaml          # 零代码 LiteLLM 配置模板
├── lib/
│   ├── log-analyzer.mjs                  # 解析 LiteLLM 日志算命中率
│   └── drift-detector.mjs                # system 前缀漂移检测
├── bin/
│   └── http.mjs                          # 网关入口（包装 LiteLLM 或纯 Node fallback）
└── test/
    └── test-gateway.mjs                  # gateway  dry-run + log + drift 测试

bin/tl-gateway.mjs                        # start/status/logs/config CLI
bin/tl.mjs                                # 增加 gateway 分支

01-workflow/claude-code/lib/hit-rate.mjs  # 增加 analyzeGatewayLogs / provider helpers
bin/tl-audit.mjs                          # --format / --provider / --gateway-logs

04-prompt-assembler/cli.mjs               # plan --provider
02-mcp-server/configs/openai.md           # OpenAI provider 配置说明
02-mcp-server/configs/deepseek.md         # DeepSeek provider 配置说明
```

---

### Task 1: LiteLLM 配置模板

**Files:**
- Create: `05-gateway-design/config/litellm-cache-proxy.yaml`
- Test: `05-gateway-design/test/test-gateway.mjs`

**Interfaces:**
- Produces: YAML file consumed by `tl gateway start`

- [ ] **Step 1: Write the failing test**

```js
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const yamlPath = join(process.cwd(), '05-gateway-design/config/litellm-cache-proxy.yaml');
if (!existsSync(yamlPath)) throw new Error('gateway config yaml missing');
const yaml = readFileSync(yamlPath, 'utf8');
if (!yaml.includes('cache_control_injection_points')) throw new Error('missing injection points');
if (!yaml.includes('ttl: 3600') && !yaml.includes('ttl: "1h"')) throw new Error('missing ttl 1h');
console.log('✓ gateway yaml exists and contains required fields');
```

- [ ] **Step 2: Run test to verify it fails**

Run the Step 1 snippet.
Expected: FAIL `gateway config yaml missing`

- [ ] **Step 3: Create YAML configuration**

Create `05-gateway-design/config/litellm-cache-proxy.yaml` with Anthropic/OpenAI/DeepSeek router, `cache_control_injection_points`, and `ttl: 3600`.

- [ ] **Step 4: Run test to verify it passes**

Run the Step 1 snippet.
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add 05-gateway-design/config/litellm-cache-proxy.yaml
git commit -m "feat(gateway): add LiteLLM cache proxy config template"
```

---

### Task 2: Gateway Log Analyzer

**Files:**
- Create: `05-gateway-design/lib/log-analyzer.mjs`
- Create: `05-gateway-design/test/test-gateway.mjs`

**Interfaces:**
- Produces: `analyzeGatewayLogs(path)` → `{ files, calls, hit, write, miss, hitRate, byProvider }`

- [ ] **Step 1: Write the failing test**

```js
import { analyzeGatewayLogs } from '../lib/log-analyzer.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockLog = [
  JSON.stringify({
    model: 'claude-sonnet-4-6',
    response_cost: 0.001,
    usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
  }),
  JSON.stringify({
    model: 'gpt-4o',
    response_cost: 0.002,
    usage: { prompt_tokens: 200, cached_tokens: 800 },
  }),
].join('\n');

const dir = mkdtempSync(join(tmpdir(), 'tl-gateway-'));
writeFileSync(join(dir, 'success.log'), mockLog);

const r = analyzeGatewayLogs(dir);
if (r.calls !== 2) throw new Error('calls mismatch');
if (Math.abs(r.hitRate - 85.0) > 0.1) throw new Error('hitRate mismatch: ' + r.hitRate);
if (!r.byProvider['claude-sonnet-4-6']) throw new Error('missing anthropic provider');
if (!r.byProvider['gpt-4o']) throw new Error('missing openai provider');
console.log('✓ analyzeGatewayLogs');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node 05-gateway-design/test/test-gateway.mjs`
Expected: FAIL `Cannot find module`

- [ ] **Step 3: Write implementation**

Create `05-gateway-design/lib/log-analyzer.mjs`:
- `collectFiles(path)` returns `.log` / `.jsonl` files.
- `extractUsage(u)` maps Anthropic / OpenAI / DeepSeek usage fields.
- `analyzeGatewayLogs(path)` returns aggregated object with `byProvider`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node 05-gateway-design/test/test-gateway.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add 05-gateway-design/lib/log-analyzer.mjs 05-gateway-design/test/test-gateway.mjs
git commit -m "feat(gateway): add log analyzer and tests"
```

---

### Task 3: Drift Detector

**Files:**
- Create: `05-gateway-design/lib/drift-detector.mjs`
- Modify: `05-gateway-design/test/test-gateway.mjs`

**Interfaces:**
- Produces: `DriftDetector({ windowSize = 10 })` with `.record(systemText)` and `.check()`

- [ ] **Step 1: Write the failing test**

Append to `05-gateway-design/test/test-gateway.mjs`:

```js
import { DriftDetector } from '../lib/drift-detector.mjs';

const d = new DriftDetector({ windowSize: 3 });
d.record('system A');
d.record('system A');
if (d.check().drift) throw new Error('no drift expected');
d.record('system B');
if (!d.check().drift) throw new Error('drift expected');
if (!/system prefix changed/.test(d.check().message)) throw new Error('message missing');
console.log('✓ DriftDetector');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node 05-gateway-design/test/test-gateway.mjs`
Expected: FAIL `Cannot find module`

- [ ] **Step 3: Write implementation**

Create `05-gateway-design/lib/drift-detector.mjs`:
- SHA-256 fingerprint truncated to 16 hex chars.
- Sliding window of recent system texts.
- `check()` returns `{ drift: true, message }` if any fingerprint differs from the newest.

- [ ] **Step 4: Run test to verify it passes**

Run: `node 05-gateway-design/test/test-gateway.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add 05-gateway-design/lib/drift-detector.mjs 05-gateway-design/test/test-gateway.mjs
git commit -m "feat(gateway): add system prefix drift detector"
```

---

### Task 4: tl-gateway CLI

**Files:**
- Create: `bin/tl-gateway.mjs`
- Modify: `bin/tl.mjs`
- Test: `05-gateway-design/test/test-gateway.mjs`

**Interfaces:**
- Consumes: `analyzeGatewayLogs()` from Task 2
- Produces: CLI commands `config`, `start`, `status`, `logs`

- [ ] **Step 1: Write the failing test**

Append to `05-gateway-design/test/test-gateway.mjs`:

```js
import { execFileSync } from 'node:child_process';

const out = execFileSync('node', ['bin/tl-gateway.mjs', 'config', '--provider', 'anthropic'], { encoding: 'utf8' });
if (!out.includes('anthropic')) throw new Error('config missing anthropic model');
console.log('✓ tl-gateway config');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node 05-gateway-design/test/test-gateway.mjs`
Expected: FAIL `Cannot find module`

- [ ] **Step 3: Write implementation**

Create `bin/tl-gateway.mjs`:
- `config --provider anthropic|openai|deepseek [--port 8787]` prints YAML to stdout.
- `start --provider anthropic [--port 8787] [--config path]` spawns `litellm --config <tmpfile>`, passes exit code.
- `status --port 8787` fetches `/health/readiness` and prints OK/down.
- `logs --dir <logs> [--format text|json]` calls `analyzeGatewayLogs` and prints report.
- Unknown command / missing subcommand prints help and exits 1.

Modify `bin/tl.mjs`:
- Add `case 'gateway': run(BIN_TL('gateway')); break;` in switch.
- Add `tl gateway ...` to help text.

- [ ] **Step 4: Run test to verify it passes**

Run: `node 05-gateway-design/test/test-gateway.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bin/tl-gateway.mjs bin/tl.mjs 05-gateway-design/test/test-gateway.mjs
git commit -m "feat(gateway): add tl-gateway CLI and unified entry"
```

---

### Task 5: 01-workflow Multi-Provider Audit

**Files:**
- Modify: `01-workflow/claude-code/lib/hit-rate.mjs`
- Modify: `bin/tl-audit.mjs`
- Test: `01-workflow/test/test-hooks.mjs` 或新增 `01-workflow/test/test-hit-rate.mjs`

**Interfaces:**
- Produces: `analyzeGatewayLogs(path)`, `analyzeProvider(usage, provider)`, `formatReport(r, format)`

- [ ] **Step 1: Write the failing test**

Create `01-workflow/test/test-hit-rate.mjs`:

```js
import { analyzeGatewayLogs, analyzeProvider, formatReport } from '../claude-code/lib/hit-rate.mjs';

const u = { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 };
const r = analyzeProvider(u, 'anthropic');
if (r.hit !== 900 || r.miss !== 100) throw new Error('anthropic mapping wrong');

const text = formatReport({ files: 1, calls: 1, hitRate: 90, hit: 900, miss: 100, write: 0, out: 0, totalIn: 1000 }, 'text');
if (!/90.0%/.test(text)) throw new Error('text format wrong');

const json = formatReport({ files: 1, calls: 1, hitRate: 90, hit: 900, miss: 100, write: 0, out: 0, totalIn: 1000 }, 'json');
JSON.parse(json);
console.log('✓ hit-rate helpers');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node 01-workflow/test/test-hit-rate.mjs`
Expected: FAIL `analyzeGatewayLogs is not a function`

- [ ] **Step 3: Write implementation**

Modify `01-workflow/claude-code/lib/hit-rate.mjs`:
- Export `analyzeProvider(usage, provider)` mapping Anthropic/OpenAI/DeepSeek fields.
- Export `analyzeGatewayLogs(path)` reusing the 05-gateway-design analyzer.
- Export `formatReport(r, format)` returning `text|json|csv|html`.
- Keep `analyze(path)` and `report(path)` signatures unchanged.

Modify `bin/tl-audit.mjs`:
- Parse `--provider`, `--format`, `--gateway-logs`.
- If `--gateway-logs` given, call `analyzeGatewayLogs`; otherwise call existing `analyze`.
- Print via `formatReport(..., format)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node 01-workflow/test/test-hit-rate.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add 01-workflow/claude-code/lib/hit-rate.mjs bin/tl-audit.mjs 01-workflow/test/test-hit-rate.mjs
git commit -m "feat(audit): multi-provider and gateway log support"
```

---

### Task 6: 02-mcp-server Provider 配置文档

**Files:**
- Create: `02-mcp-server/configs/openai.md`
- Create: `02-mcp-server/configs/deepseek.md`

**Interfaces:**
- Produces: Markdown docs

- [ ] **Step 1: Create `02-mcp-server/configs/openai.md`**

Content: how to register tokenlean MCP with Claude Code when routing OpenAI through gateway, including permissions and base_url.

- [ ] **Step 2: Create `02-mcp-server/configs/deepseek.md`**

Same structure for DeepSeek.

- [ ] **Step 3: Commit**

```bash
git add 02-mcp-server/configs/openai.md 02-mcp-server/configs/deepseek.md
git commit -m "docs(mcp): add OpenAI and DeepSeek setup guides"
```

---

### Task 7: 04-prompt-assembler Provider-Aware Plan

**Files:**
- Modify: `04-prompt-assembler/cli.mjs`
- Test: `04-prompt-assembler/test/test-assembler.mjs` 或新增 provider 测试

**Interfaces:**
- Consumes: `assemble(segments, { provider })`

- [ ] **Step 1: Write the failing test**

Append to `04-prompt-assembler/test/test-assembler.mjs`:

```js
const pOpenAI = assemble([
  { id: 'sys', role: 'system', stability: STABILITY.STATIC, text: 'sys' },
  { id: 'q', role: 'user', stability: STABILITY.VOLATILE, text: 'hi' },
], { provider: 'openai' });
if (!pOpenAI.breakpoints.some(b => b.cache_control?.type === 'temporary')) throw new Error('openai breakpoint format missing');
console.log('✓ provider-aware plan');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node 04-prompt-assembler/test/test-assembler.mjs`
Expected: FAIL `openai breakpoint format missing`

- [ ] **Step 3: Write implementation**

Modify `04-prompt-assembler/lib/assembler.mjs`:
- `assemble(segments, opts = {})` reads `opts.provider`.
- For `provider === 'openai'`, breakpoint `cache_control` uses `{ type: 'temporary' }`.
- For `provider === 'deepseek'`, use DeepSeek documented structure.
- Default remains Anthropic-style `{ type: 'ephemeral' }`.

Modify `04-prompt-assembler/cli.mjs`:
- `plan` command accepts `--provider anthropic|openai|deepseek` and passes it to `assemble`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node 04-prompt-assembler/test/test-assembler.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add 04-prompt-assembler/lib/assembler.mjs 04-prompt-assembler/cli.mjs 04-prompt-assembler/test/test-assembler.mjs
git commit -m "feat(assembler): provider-aware cache_control breakpoints"
```

---

### Task 8: Gateway 入口占位与文档更新

**Files:**
- Create: `05-gateway-design/bin/http.mjs`
- Modify: `05-gateway-design/README.md`
- Modify: `README.md` (top-level)
- Modify: `INDEX.md`

**Interfaces:**
- Produces: `05-gateway-design/bin/http.mjs` (thin wrapper or helpful error message if LiteLLM missing)

- [ ] **Step 1: Create `05-gateway-design/bin/http.mjs`**

```js
#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = process.argv.includes('--config')
  ? process.argv[process.argv.indexOf('--config') + 1]
  : join(here, '../config/litellm-cache-proxy.yaml');

if (!existsSync(configPath)) {
  console.error(`[gateway] config not found: ${configPath}`);
  process.exit(2);
}

const args = ['--config', configPath];
const p = spawn('litellm', args, { stdio: 'inherit' });
p.on('exit', (c) => process.exit(c ?? 0));
```

- [ ] **Step 2: Update `05-gateway-design/README.md`**

Rewrite from "设计阶段" to actionable guide:
- Quick start: install LiteLLM, run `tl gateway start`, point agent base_url.
- Explain `cache_control_injection_points` and TTL.
- Explain `tl gateway logs` and drift warning.

- [ ] **Step 3: Update top-level `README.md`**

Change "网关为设计阶段" / "设计完成，待实现" to "05 gateway 已实现（LiteLLM 零代码代理 + CLI）".

- [ ] **Step 4: Update `INDEX.md`**

Change `05-gateway-design/ 网关代理,L1,INPUT 主战场。设计完成,待实现。` to `05-gateway-design/ 网关代理,L1,INPUT 主战场。已实现 LiteLLM 代理 + CLI + 命中率看板。`

- [ ] **Step 5: Commit**

```bash
git add 05-gateway-design/bin/http.mjs 05-gateway-design/README.md README.md INDEX.md
git commit -m "feat(gateway): executable entry and documentation"
```

---

### Task 9: Regression Test Suite

**Files:**
- Modify: `package.json` scripts (if needed)
- All existing tests

- [ ] **Step 1: Run `npm test`**

Run: `npm test`
Expected: 338 original assertions + ~25 new gateway/audit/assembler assertions all pass, exit 0.

- [ ] **Step 2: Run new tests individually**

Run:
- `node 05-gateway-design/test/test-gateway.mjs`
- `node 01-workflow/test/test-hit-rate.mjs`
- `node 04-prompt-assembler/test/test-assembler.mjs`

Expected: all exit 0.

- [ ] **Step 3: Run CLI smoke tests**

Run:
- `node bin/tl-gateway.mjs config --provider anthropic | head -5`
- `node bin/tl.mjs gateway config --provider openai | head -5`
- `node bin/tl-audit.mjs --help`

Expected: commands produce output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(tests): include gateway and observability tests"
```

---

## Spec Coverage Check

| Spec Section | Implementing Task |
| --- | --- |
| LiteLLM 零代码代理配置 | Task 1, Task 4, Task 8 |
| 命中率解析（按 provider） | Task 2, Task 5 |
| system 前缀漂移检测 | Task 3 |
| CLI `tl gateway start/status/logs/config` | Task 4, Task 8 |
| 01 workflow 多 provider / 多格式 audit | Task 5 |
| 02 MCP provider 配置文档 | Task 6 |
| 04 assembler provider-aware breakpoints | Task 7 |
| 顶层文档同步 | Task 8 |
| 回归测试 | Task 9 |

## Placeholder Scan

- No "TBD", "TODO", "implement later", "fill in details".
- No "add appropriate error handling" without concrete code.
- No "Similar to Task N".
- Each task contains exact file paths and commands.

## Type Consistency Check

- `analyzeGatewayLogs(path)` used consistently across Task 2, Task 4, Task 5.
- `DriftDetector` constructor signature `{ windowSize }` consistent.
- CLI flag names `--provider`, `--format`, `--gateway-logs`, `--port` consistent.

---

**Plan complete and saved to `docs/superpowers/plans/2026-06-23-gateway-and-observability-plan.md`.**

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — I execute tasks in this session using `executing-plans`, batch execution with checkpoints for review.

Which approach would you like?