# tokenlean-gateway (设计阶段)

INPUT 维度的通用解。agent 改 base_url 指向本网关,网关注入 cache_control 断点、
强制 1h TTL、检测前缀漂移、统计命中率,然后转发到真实 LLM API。

完整设计见 ../README.md 第四部分 4.3 与第五部分阶段3。

## 两条实现路径
1. LiteLLM 配置 cache_control_injection_points(零代码)
2. 自建 ~200 行中间件(读 usage 字段做命中率统计)

## 接入
- Claude Code:  ANTHROPIC_BASE_URL=http://gateway
- Codex CLI:    config base_url
- OpenCode:     provider endpoint

待实现。本目录预留。
