# TokenLean Stack — 完整 Token 节省方案

## 概述

本栈将 **tokenlean-suite** 的三层架构与最佳开源工具组合在一起，覆盖编码助手的全部三个 Token 维度。每个维度只选一个最强工具，避免在同一个优化维度上重复投资造成递减。

## 架构速览

```
INPUT (缓存命中)   → Headroom CacheAligner / workflow cache-doctor
OUTPUT (编辑格式)   → tokenlean MCP fs_edit_hash
OUTPUT (叙述文本)   → caveman
FUTURE (CLI 输出)   → rtk
FUTURE (其余输出)   → Headroom SmartCrusher / workflow bash-guard
FUTURE (代码发现)   → tokenlean MCP fs_outline / fs_read_hashed
全局纪律            → tokenlean workflow precompact + skills
```

## 安装

### 快速安装（全栈）

```bash
cd /your/project
bash /path/to/tokenlean-suite/install-stack.sh
```

### 分步安装（按需选取）

#### 第一步：tokenlean-workflow（L3-L4，零依赖）

```bash
bash tokenlean-suite/01-workflow/install.sh
```

安装后：`bash-guard`、`write-guard`、`precompact`、`session-start` 四个 hook 和三个 skill 自动生效。详见 [01-workflow/README.md](01-workflow/README.md)。

#### 第二步：tokenlean-mcp（L2，OUTPUT 安全 + 有界工具）

将以下配置加入 Claude Code 的 MCP 配置：

```json
{
  "mcpServers": {
    "tokenlean": {
      "command": "node",
      "args": ["/abs/path/tokenlean-suite/02-mcp-server/tokenlean.mjs", "stdio", "--root", "."]
    }
  }
}
```

同时阻止原生 Write 工具以确保 MCP 编辑的采用率：

```json
{
  "permissions": {
    "deny": ["Write(src/**)"]
  }
}
```

#### 第三步：rtk — Rust Token Killer（L3，CLI 输出压缩）

```bash
git clone https://github.com/azat-io/rtk.git
cd rtk && cargo install --path .
```

使用（替代 bash-guard 的建议 + 真正压缩输出）：

```bash
rtk -- claude
# or
rtk -- opencode
```

rtk 拦截每个命令输出并用 Rust 实时压缩，典型会话的 CLI 输出从 ~118K token 降到 ~24K（~80% 削减）。

#### 第四步：caveman — 输出叙述压缩（L4，OUTPUT）

```bash
npm install -g caveman
```

然后在 CLAUDE.md 中添加：

```
You communicate in compressed telegraphic style (caveman mode).
Strip filler words, polite preamble, articles, and unnecessary grammar.
Preserve every byte of technical accuracy. Be terse but complete.
```

caveman 与 tokenlean 的编辑优化正交——caveman 压缩自然语言叙述，tokenlean MCP 压缩编辑格式。两者乘法叠加。

#### 第五步：Headroom — API 代理 / 缓存断点 + CCR（L1 + L2，可选但推荐）

```bash
npm install -g headroom
headroom --provider anthropic --api-key $ANTHROPIC_API_KEY --port 8080
```

然后将 agent 的 `base_url` 改为 `http://localhost:8080`。

Headroom 提供：
- **CacheAligner**：检测并剔除 system prompt 中的时间戳/UUID，稳定前缀使 KV 缓存命中
- **SmartCrusher**：JSON 智能压缩（保留异常值/关键字段，其余本地缓存）
- **CCR（Compress-Cache-Retrieve）**：压缩 → 本地 SQLite 存储 → 按 hash 按需取回。**这是最独特的创新**——相当于给所有工具输出加了一个无损回退机制

## 交互与冲突排查

| 组合 | 关系 | 说明 |
|---|---|---|
| tokenlean bash-guard + rtk | **rtk 更强，建议替换** | bash-guard 只建议改写命令，rtk 实际压缩输出。两者启用 rtk 后 bash-guard 仍保留作为轻量备选 |
| tokenlean MCP + caveman | **完全正交，乘法叠加** | MCP 管编辑格式安全，caveman 管叙述文本，作用于 OUTPUT 的不同子集 |
| tokenlean cache-doctor + Headroom CacheAligner | **互补** | cache-doctor 预防性审计 CLAUDE.md，CacheAligner 在代理层修复 system prompt。一个在 session 启动前，一个在请求经过时 |
| Headroom + rtk | **部分重叠 + 可共存** | Headroom 的 SmartCrusher 也压缩工具输出（JSON/prose），rtk 压缩 CLI shell 输出。按输出类型分工 |
| Headroom + tokenlean precompact | **互补** | Headroom 在代理层自动压缩，precompact 在知识侧告诉模型"保留什么、丢弃什么"。两者互不冲突 |

## 每维度成本收益参考

| 维度 | 工具 | Token 节省 | 主要价值 |
|---|---|---|---|
| INPUT | Headroom CacheAligner | 命中率从 ~30% 提升到 ~80%+ | 缓存命中后单价降至 0.1× |
| INPUT | cache-doctor（预防） | N/A | 避免因不稳定前缀导致的冷 miss |
| OUTPUT | tokenlean MCP hash edits | vs Write -86%，vs Edit ≈ 持平 | fail-fast 安全 + 弱模型可靠性 |
| OUTPUT | caveman | 叙述输出 -65% 峰值 87% | 砍废话不砍技术内容 |
| FUTURE | rtk | CLI 输出 -80% | 命令输出压缩 |
| FUTURE | Headroom SmartCrusher | JSON/日志 -60~95% | 各种工具输出 |
| FUTURE | MCP 有界工具 | 代码发现 -90%+ | 预防胜于治疗 |

## 使用建议

### 新手（10 分钟见效）

只装 tokenlean-workflow（步骤一），然后执行 `/lean-compact` 命令。

### 日常开发（30 分钟配置）

workflow + rtk + caveman。编辑行为被引导 + 命令输出被压缩 + 叙述输出被精简。

### 重度用户（1 小时配置）

全栈：workflow + MCP + rtk + caveman + Headroom。
三个维度各有一个主工具，加上安全/预防/纪律辅助，覆盖最完整。

### 需要注意的约束

- **同一维度不同层可以叠加，同一层只能择一**：例如 bash-guard(L3) + rtk(L3) 不冲突但 rtk 更强，建议禁用 bash-guard 的 auto 模式
- **压缩类工具会互相吃掉边际收益**：先安装的压缩帮你省了 80%，第二个在同一维度上的压缩只能省剩下 20% 的一部分
- **FUTURE 压缩可能破坏 INPUT 缓存**：Headroom 的 SmartCrusher 改写历史输出 = 改写前缀前缀 = 破坏 prefix cache。它的 CacheAligner 必须与压缩同时启用
