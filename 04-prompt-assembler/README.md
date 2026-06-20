# 04-prompt-assembler — 缓存感知的 Prompt 拼装层(L1 / INPUT)

回答四个深入问题的可运行实现(28/28 测试通过):
1. 单租户 vs 跨用户:商业缓存按组织隔离,只有你自己请求流的前缀可复用 → `scope` 标注
2. 长 system / tool 定义 / 历史 / agent-loop 上下文:按稳定性排进可缓存前缀 → `assemble()`
3. 拼装结构是一等成本决策:排序 + 断点 + 诊断作为显式产物 → `assemble()` + `reportAssembly()`
4. RAG / llm-wiki 命中:稳定导航前缀 + 归一化证据尾部 → `planRag()` + `normalizeRetrieved()`

## 用法

```bash
# 纯库,零依赖,Node >= 18
node test/test-assembler.mjs        # 28 断言
node cli.mjs demo                   # RAG naive vs cache-aware 实跑对比
node cli.mjs plan segments.json     # 为一组 segment 规划缓存友好布局
```

```js
import { assemble, planRag, normalizeRetrieved } from './lib/assembler.mjs';

// RAG / llm-wiki:索引钉进前缀,检索结果归一化追加
const { pinned, retrievedTail } = planRag(
  { index: wikiIndex, docs: hotDocs }, retrievedChunks, { hotCount: 5 }
);
const plan = assemble([systemSeg, ...pinned, ...retrievedTail, userQuestion]);
// plan.prefix = 可缓存前缀;plan.breakpoints = 断点;plan.leaks = 泄漏诊断
```

详见 PRINCIPLES.md(四个问题的原理 + 代码映射)。

## 缓存时长(Q2)与 Headroom 定位(Q1)

```bash
node test/test-ttl.mjs              # 20 断言:各家 TTL、break-even、三约束力
node cli.mjs ttl                    # 总览:为什么不能无限缓存历史
node cli.mjs ttl anthropic          # 单家完整报告
```

- `lib/cache-ttl.mjs` — 各家缓存时长的核实数据 + recommendTtl() + breakEvenReads()
- `HEADROOM-AND-TTL.md` — Headroom 跨层定位 + CCR 新机制 + 缓存时长三约束力
