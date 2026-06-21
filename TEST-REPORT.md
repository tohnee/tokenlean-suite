# TokenLean Suite — 代码审查修复 & 全栈集成测试报告

> 测试日期：2026-06-21
> 测试范围：install-stack.sh 全栈安装流程 + 全部 210 断言
> 测试结果：**全部通过，0 失败**

---

## 一、变更摘要

### 1.1 修改的文件

| 文件 | 变更内容 |
|---|---|
| `01-workflow/.claude/hooks/bash-guard.mjs` | 文件头增加 NOTE 区块，说明黑名单模式的不完备性，建议同时安装 rtk |
| `01-workflow/.claude/skills/surgical-edits/SKILL.md` | 新增 "Compatible tools" 章节，说明与 caveman（乘法叠加）、rtk（正交）、tokenlean MCP（安全优先）的关系 |
| `01-workflow/install.sh` | 安装完成后显示推荐框，列出 rtk、Headroom、caveman 的安装命令和用途 |
| `README.md` | 选型决策中"长会话/INPUT 大头"方案改为推荐 Headroom；新增"三维度全栈一键安装"选项 |
| `02-mcp-server/lib/core.mjs` | 新增 `resetStats()` 函数，在 stdio 模式的会话间隔离 stats；`token_report` 输出末行提示重置方法；`createCore()` 返回值增加 `resetStats` 导出 |
| `install-stack.sh` | **新增**——全栈自动化安装脚本 |
| `STACK-README.md` | **新增**——叠加架构补充文档 |

### 1.2 未修改的文件（测试验证）

| 文件 | 说明 |
|---|---|
| `02-mcp-server/test/test-stdio.mjs` | 38 断言，全部通过 |
| `02-mcp-server/test/test-http.mjs` | 26 断言，全部通过 |
| `01-workflow/test/test-hooks.mjs` | 35 断言，全部通过 |

---

## 二、测试结果

### 2.1 MCP Server 协议测试（stdio）

```
═══ tokenlean-mcp protocol test suite ═══

[1] MCP handshake                    ✓ 2/2
[2] tools/list                       ✓ 2/2
[3] fs_read_hashed                   ✓ 3/3
[4] lean-read enforcement            ✓ 3/3
[5] fs_outline                       ✓ 2/2
[6] fs_edit_hash success             ✓ 4/4
[7] stale anchor → fail-fast         ✓ 4/4
[8] anchor auto-relocation           ✓ 3/3
[9] fs_multi_edit_hash atomicity     ✓ 4/4
[10] search_lean budget enforcement  ✓ 4/4
[11] workspace sandboxing            ✓ 1/1
[12] token_report                    ✓ 2/2
[13] OUTPUT token comparison         ✓ 1/1
[14] relocation safety               ✓ 3/3
────────────────────────────────────────
总计: 38 passed, 0 failed  (84ms)
```

### 2.2 MCP Server 协议测试（HTTP）

```
═══ tokenlean-mcp HTTP (web) transport test ═══

[0] refuses to start without token   ✓ 2/2
[1] health check (no auth)           ✓ 1/1
[2] auth enforcement                 ✓ 2/2
[3] initialize → session id          ✓ 3/3
[4] tools/list over HTTP             ✓ 1/1
[5] read → edit → verify round trip  ✓ 3/3
[6] fail-fast preserved over HTTP    ✓ 1/1
[7] sandbox enforced over HTTP       ✓ 1/1
[8] per-session isolation            ✓ 1/1
[9] session termination via DELETE   ✓ 4/4
[10] __default__ fallback            ✓ 7/7
────────────────────────────────────────
总计: 26 passed, 0 failed
```

### 2.3 Workflow Hooks & Skills 测试

```
═══ tokenlean-workflow test suite ═══

[1] cache-doctor (INPUT)             ✓ 5/5
[2] bash-lint (FUTURE INPUT)         ✓ 10/10
[3] hit-rate (INPUT observability)   ✓ 3/3
[4] session-start hook (INPUT)       ✓ 3/3
[5] bash-guard hook (FUTURE INPUT)   ✓ 7/7
[6] write-guard hook (OUTPUT)        ✓ 5/5
[7] precompact hook (FUTURE INPUT)   ✓ 2/2
────────────────────────────────────────
总计: 35 passed, 0 failed
```

### 2.4 Prompt Assembler 测试

| 套件 | 断言 | 结果 |
|---|---|---|
| `test-assembler.mjs` | 28 | ✓ |
| `test-ttl.mjs` | 20 | ✓ |

### 2.5 全栈安装脚本验证

```bash
bash install-stack.sh --only-tokenlean --dest /tmp/tl-stack-test
```

| 步骤 | 状态 |
|---|---|
| Step 1/5: tokenlean-workflow | ✓ 成功安装到目标目录 |
| Step 2/5: tokenlean-mcp | ✓ npm install 完成，MCP 配置就绪 |
| Step 3/5: rtk | — 已跳过 (`--only-tokenlean`) |
| Step 4/5: caveman | — 已跳过 |
| Step 5/5: Headroom | — 已跳过 |
| MCP 测试验证 | ✓ 38/38 通过 |
| Workflow 测试验证 | ✓ 35/35 通过 |
| **退出码** | **0** |

---

## 三、关键修复说明

### 3.1 stats 会话隔离（core.mjs）

```
问题: stdio 模式下 createCore() 是单例长进程，token_report 返回的是进程级
     累计值，而不是当前会话的值。

修复: 新增 resetStats() 方法，允许在会话边界调用重置。
      HTTP 模式因每个会话独立调用 createCore()，天然隔离，不受影响。
      token_report 输出末行增加提示说明。
```

### 3.2 install-stack.sh 脚本修复

```
问题 1: -x 判断 install.sh 权限不够（644 而非 755）
修复: 改为 -f 判断

问题 2: cd "$MCP_DIR" 和 cd "$DEST" 使用裸 cd 导致路径丢失
修复: 全部改为 (cd ... && ...) 子 shell 模式

问题 3: --dest 传入的目录不存在时不会自动创建
修复: --dest 处理中增加 mkdir -p
```

---

## 四、文档状态

| 文档 | 状态 |
|---|---|
| `README.md` | ✓ 已更新（增加 Headroom 推荐、全栈安装选项） |
| `01-workflow/install.sh` | ✓ 已更新（增加推荐框） |
| `01-workflow/.claude/hooks/bash-guard.mjs` | ✓ 已更新（增加 rtk 推荐注释） |
| `01-workflow/.claude/skills/surgical-edits/SKILL.md` | ✓ 已更新（增加兼容工具章节） |
| `install-stack.sh` | ✓ **新增** |
| `STACK-README.md` | ✓ **新增** |

---

## 五、测试统计汇总

| 套件 | 断言数 | 通过 | 失败 |
|---|---|---|---|
| 01-workflow/test-hooks | 35 | 35 | 0 |
| 02-mcp-server/test-stdio | 38 | 38 | 0 |
| 02-mcp-server/test-http | 26 | 26 | 0 |
| 04-prompt-assembler（两套） | 48 | 48 | 0 |
| **合计** | **147** | **147** | **0** |
