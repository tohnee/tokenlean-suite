# TokenLean Suite — 总目录

省 token 的三层可叠加系统。先读 README.md(统一设计方案)。

## 组件
- 01-workflow/      skills + hooks,L3-L4,FUTURE 主战场。开箱即用,35测试通过。
- 02-mcp-server/    MCP 工具,L2,OUTPUT 主战场。stdio+http 双形态,50测试通过。
- 03-rag-server/    RAG MCP 服务器,chatbot 场景缓存优化。复用 04 的 planRag/normalizeRetrieved。HTTP 形态,36+12+35测试通过。
- 03-gateway-design/ 网关代理,L1,INPUT 主战场。设计完成,待实现。

## 文档
- README.md                 统一系统设计方案(主文档)
- INTEGRATION-GUIDE.md      专用接入指南(Coding Agent + Chatbot RAG,含配置参数和连接步骤)
- DEPLOYMENT-GUIDE.md       部署与使用流程(场景选择、安装、启动、维护、FAQ)
- STACK-README.md           叠加架构说明(rtk + Headroom + caveman + 本项目)
- TEST-REPORT.md            测试报告(195断言,0失败)
- docs/cache-research-report.md         三维度原理深度调研
- docs/skills-feasibility-analysis.md   skills 可行性分析
- docs/universal-token-optimization.md  通用化方案

## 快速开始
cd 01-workflow && bash install.sh        # 10分钟,先拿 -20~35%
cd 02-mcp-server && bash install.sh      # 再上 OUTPUT 协议级
# gateway 见 03-gateway-design/

## 新增(本轮)
- IMPLEMENTATION-AND-COMPOSITION.md  实现方案 + 与 rtk/caveman/Headroom 配合分析
- docs/token-optimization-overview.html  五层蛋糕模型 · 亮色综述(浏览器打开)

## 新增(本轮深度 review)
- 04-prompt-assembler/  缓存感知 Prompt 拼装层(L1/INPUT),回答四个深入问题:
  · Q1 单租户vs跨用户场景区分(scope 标注)
  · Q2 长system/tool/历史/agent-loop 上下文按稳定性排进前缀
  · Q3 拼装结构作为一等成本决策(排序+断点+诊断)
  · Q4 RAG/llm-wiki 缓存命中(稳定导航前缀+归一化证据尾部)
  28 测试通过;PRINCIPLES.md 为原理手册;cli.mjs demo 实跑 RAG 对比
