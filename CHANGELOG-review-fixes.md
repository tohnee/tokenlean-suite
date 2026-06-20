# 审查修复记录(1-5 项)

针对上一轮系统审查发现的问题逐项修复,每项都有测试或实测验证。

## 项1 ✅ 单锚点编辑静默数据损坏(严重)
- 问题:2字符hash(256空间)+ ±40重定位窗口,单行编辑锚点过期时有 **27%** 概率被静默改到错误行。
- 修复:HASH_LEN 提升到 4(16-bit,65536空间);span=0 单行编辑**拒绝重定位**;多匹配**拒绝(不猜)**。
- 验证:蒙特卡洛 20000 次,单行误改 27%→**0%**,多行 0.16%→**0%**。回归测试 test-stdio [14]。

## 项2 ✅ 缺真实测量
- 问题:所有节省数字是字符串计算/蒙特卡洛,无真实 tokenizer。
- 修复:bench-output.mjs 用真实 BPE tokenizer(gpt-tokenizer),自包含(缺失时显式降级标注),公平基线(称职最小 old_str)。
- 关键发现:**vs 称职 native Edit,hash 编辑整体 ≈ -6~-8%(基本持平/小改动略差),唯一大胜是 vs 全量重写 86%**。推翻了之前"-40~55%"的说法。
- 仍未覆盖(已注明):真实模型是否选择这些token、延迟、采用率。

## 项3 ✅ token_report 基线高估
- 问题:基线假设 str_replace 复述整块,系统性高估节省。
- 修复:token_report 改为只报"vs 全量重写(上界)",并明确标注"vs 称职 str_replace 基本持平";去掉误导性单一节省%;工具描述据实改写。同步修正 MASTER-DESIGN 数字。

## 项4 ✅ HTTP 会话内存泄漏 + 协议不完整
- 问题:sessions Map 永不清理;无 DELETE;注释称 SSE 实际没有。
- 修复:加 lastSeen + 30min TTL 定时清理 + 会话上限(默认1000,超限逐最旧);实现 spec 的 `DELETE /mcp` 会话终止;修正注释如实说明"仅 JSON 响应,不支持 GET SSE 流"。
- 验证:test-http 新增 4 断言(DELETE ok / 会话数下降 / 未知404 / 需鉴权),15→19。

## 项5 ✅ 交付物混乱
- 问题:顶层散落6个tar包,含被弃用的 token-lens(Python)早期实现,suite内副本已漂移。
- 修复:suite 为唯一权威源,修复版同步进 suite 并在 suite 内重跑全部测试(38+19+35=92通过);删除所有散落陈旧包;只产出一个 tokenlean-suite.tar.gz。

## 修复后测试总览
- MCP stdio: 38 passed
- MCP http:  19 passed
- workflow:  35 passed
- bench-output: 真实BPE,诚实公平基线
- 合计 92 断言通过
