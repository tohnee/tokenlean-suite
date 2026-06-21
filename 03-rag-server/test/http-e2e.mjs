#!/usr/bin/env node
/**
 * http-e2e.mjs — HTTP 端到端测试：模拟真实 chatbot 通过 HTTP MCP 协议调用 rag_search。
 *
 * 与 simulate-chatbot.mjs 的区别：
 *   - simulate-chatbot.mjs 在进程内直接调用 createRagCore()（库级别测试）
 *   - 本脚本通过真正的 HTTP 请求调用 RAG 服务器（端到端测试）
 *
 * 测试流程：
 *   1. 自动启动 RAG 服务器（子进程），或连接已运行的服务器
 *   2. MCP initialize 握手（获取 session-id）
 *   3. 模拟 5 轮 chatbot 对话，每轮调用 rag_search
 *   4. 验证缓存命中逻辑：
 *      - 归一化后 chunk 内容字节稳定（id 排序，无元数据）
 *      - 相同 chunk 集合触发 re-ask cache hit 检测
 *      - 不同 chunk 集合不触发误报
 *   5. 测试 kb_pin、headroom_retrieve、token_report
 *   6. 验证 session 隔离（两个 session 状态独立）
 *
 * 用法：
 *   # 自动启动服务器并测试（默认端口 8770）
 *   node test/http-e2e.mjs
 *
 *   # 连接已运行的服务器
 *   TOKENLEAN_RAG_TOKEN=secret node test/http-e2e.mjs --port 8766
 */

import { spawn, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAG_SERVER = join(__dirname, '..', 'bin', 'http.mjs');

// ── 测试框架 ──
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}  ${detail}`); }
};
const section = (t) => console.log(`\n${'═'.repeat(60)}\n  ${t}\n${'═'.repeat(60)}`);

// ── HTTP MCP 客户端 ──
class McpHttpClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.sessionId = null;
    this.reqId = 0;
  }

  async call(method, params = {}) {
    const headers = {
      'content-type': 'application/json',
      'authorization': `Bearer ${this.token}`,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const body = JSON.stringify({ jsonrpc: '2.0', id: ++this.reqId, method, params });
    const res = await fetch(`${this.baseUrl}/mcp`, { method: 'POST', headers, body });

    if (res.status === 202) return null; // notification acknowledged
    const json = await res.json();

    // initialize 响应里带 session-id
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    return json;
  }

  async initialize() {
    const res = await this.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'http-e2e-test', version: '1.0.0' },
    });
    return res;
  }

  async toolsList() {
    return this.call('tools/list', {});
  }

  async toolCall(name, args = {}) {
    return this.call('tools/call', { name, arguments: args });
  }

  async ping() {
    return this.call('ping', {});
  }
}

// ── 从工具响应中提取文本 ──
function extractText(response) {
  if (response?.result?.content?.[0]?.text) {
    return response.result.content[0].text;
  }
  return '';
}

// ── 从 rag_search 输出中提取 chunk 文本行 ──
function extractChunkLines(text) {
  const lines = text.split('\n');
  const chunkSection = lines.findIndex(l => l.includes('--- chunk text ---'));
  if (chunkSection === -1) return [];
  return lines.slice(chunkSection + 1)
    .filter(l => /^\[\d+\]/.test(l))
    .map(l => l.replace(/^\[\d+\]\s*/, ''));
}

// ── 从 rag_search 输出中提取 chunk id ──
function extractChunkIds(text) {
  const lines = text.split('\n');
  const idSection = lines.findIndex(l => l.includes('--- normalized chunks'));
  if (idSection === -1) return [];
  return lines.slice(idSection + 1)
    .filter(l => /^\[\d+\]/.test(l))
    .map(l => {
      const m = l.match(/id:(\S+)/);
      return m ? m[1] : '';
    })
    .filter(Boolean);
}

// ════════════════════════════════════════════════════════════
// 主测试流程
// ════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 8770;
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

// 外部传入 token = 连接已运行的服务器；否则自动启动
const EXTERNAL_TOKEN = process.env.TOKENLEAN_RAG_TOKEN;
let serverProc = null;
const TOKEN = EXTERNAL_TOKEN || randomBytes(16).toString('hex');

// ── 模拟知识库数据 ──
const KB_CHUNKS = [
  { id: 'd42', text: 'Refunds are processed in 5-7 business days. Contact support@example.com for refund requests.' },
  { id: 'd17', text: 'Premium plan includes: priority support, unlimited API calls, custom integrations, SLA guarantee.' },
  { id: 'd99', text: 'API rate limits: 1000 req/min for free tier, 10000 req/min for premium. Exceeding limits returns 429.' },
  { id: 'd33', text: 'Two-factor authentication (2FA) can be enabled in Account > Security settings. Requires SMS or authenticator app.' },
  { id: 'd55', text: 'Data retention policy: logs stored for 90 days, backups for 30 days. Deleted data recoverable within 7 days.' },
  { id: 'd88', text: 'Payment methods: credit card, PayPal, wire transfer. Invoices generated monthly for premium plans.' },
];

// 模拟向量数据库检索（确定性评分，每次返回不同的 score/rank/timestamp，但 chunk 内容相同）
function mockRetrieve(query, topK = 3) {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 2);
  // 确定性评分：基于关键词匹配数量
  const scored = KB_CHUNKS.map(c => {
    let score = 0.5;
    const text = c.text.toLowerCase();
    for (const w of words) {
      if (text.includes(w)) score += 0.1;
    }
    return {
      ...c,
      score: Math.round(score * 100) / 100,  // 确定性 score
      rank: 0,
      timestamp: new Date().toISOString(),
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((c, i) => ({ ...c, rank: i + 1 }));
}

// ── 启动服务器（如果没有外部 token）──
async function ensureServer() {
  if (EXTERNAL_TOKEN) {
    console.log(`  连接已运行的服务器: ${BASE_URL} (token 来自环境变量)`);
    // 健康检查
    try {
      const res = await fetch(`${BASE_URL}/healthz`);
      const j = await res.json();
      console.log(`  健康检查: ${JSON.stringify(j)}`);
      return;
    } catch {
      console.error(`  ✗ 无法连接到 ${BASE_URL}/healthz — 请确认服务器正在运行`);
      process.exit(1);
    }
  }

  console.log(`  自动启动 RAG 服务器 (端口 ${PORT})...`);
  serverProc = spawn('node', [
    RAG_SERVER,
    '--port', String(PORT),
    '--host', HOST,
    '--token', TOKEN,
    '--kb-index', 'KB INDEX: products, support, billing, API reference, security.',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  serverProc.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s.includes('ERROR') || s.includes('REFUSING')) {
      console.error(`  [server] ${s}`);
    }
  });

  // 等待服务器就绪
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${BASE_URL}/healthz`);
      if (res.ok) {
        const j = await res.json();
        console.log(`  服务器就绪: ${j.server} v${j.version}`);
        return;
      }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 200));
  }
  console.error('  ✗ 服务器启动超时');
  process.exit(1);
}

// ── 清理 ──
function cleanup() {
  if (serverProc) {
    serverProc.kill('SIGTERM');
    console.log('\n  服务器已关闭');
  }
}

// ════════════════════════════════════════════════════════════
// 测试用例
// ════════════════════════════════════════════════════════════

async function runTests() {
  await ensureServer();

  const client = new McpHttpClient(BASE_URL, TOKEN);

  // ── Part 1: MCP 握手 ──
  section('Part 1: MCP initialize 握手');

  const init = await client.initialize();
  check('initialize 返回 protocolVersion', !!init?.result?.protocolVersion);
  check('initialize 返回 serverInfo', !!init?.result?.serverInfo);
  check('initialize 返回 instructions', typeof init?.result?.instructions === 'string');
  check('获取到 session-id', !!client.sessionId, `sessionId=${client.sessionId}`);

  // ── Part 2: tools/list ──
  section('Part 2: tools/list — 4 个工具');

  const tl = await client.toolsList();
  const toolNames = (tl?.result?.tools || []).map(t => t.name);
  check('返回 4 个工具', toolNames.length === 4, `got ${toolNames.length}: ${toolNames.join(', ')}`);
  check('包含 rag_search', toolNames.includes('rag_search'));
  check('包含 kb_pin', toolNames.includes('kb_pin'));
  check('包含 headroom_retrieve', toolNames.includes('headroom_retrieve'));
  check('包含 token_report', toolNames.includes('token_report'));

  // ── Part 3: rag_search 缓存命中验证 ──
  section('Part 3: rag_search 缓存命中验证');

  // Q1: 用户问退款问题
  const q1Results = mockRetrieve('refund policy');
  const r1 = await client.toolCall('rag_search', {
    query: 'What is the refund policy?',
    top_k: 3,
    results: q1Results,
  });
  const t1 = extractText(r1);
  const ids1 = extractChunkIds(t1);
  const chunks1 = extractChunkLines(t1);
  check('Q1 返回 chunk 列表', chunks1.length > 0, `chunks=${chunks1.length}`);
  check('Q1 chunk id 已排序', ids1.every((id, i) => i === 0 || ids1[i - 1] <= id), `ids=${ids1.join(',')}`);

  // Q2: 用户换种方式问退款（相同 chunk，不同 score/rank/timestamp）
  // 直接复用 Q1 的 chunk，仅改变 score/rank/timestamp 来模拟不同检索结果
  const q2Results = q1Results.map((r, i) => ({
    id: r.id,
    text: r.text,
    score: Math.round((0.5 + (q1Results.length - i) * 0.1) * 100) / 100,  // 反转 score 顺序
    rank: q1Results.length - i,  // 反转 rank
    timestamp: new Date(Date.now() + 60000).toISOString(),  // 不同的 timestamp
  }));
  const r2 = await client.toolCall('rag_search', {
    query: 'How do refunds work?',
    top_k: 3,
    results: q2Results,
  });
  const t2 = extractText(r2);
  const chunks2 = extractChunkLines(t2);
  const ids2 = extractChunkIds(t2);

  check('Q2 返回相同 chunk 集合', JSON.stringify(ids2.sort()) === JSON.stringify(ids1.sort()),
    `ids1=${ids1.join(',')}, ids2=${ids2.join(',')}`);
  check('Q2 chunk 内容与 Q1 字节相同', JSON.stringify(chunks2) === JSON.stringify(chunks1),
    'normalized chunks should be byte-identical');

  // 检查 re-ask cache hit 标记
  check('Q2 触发 re-ask cache hit 标记',
    t2.includes('same chunk set') || t2.includes('cache hit'),
    'should mention cache hit for same chunk set');

  // Q3: 完全不同的查询（不同 chunk 集合）
  const q3Results = mockRetrieve('API rate limits');
  const r3 = await client.toolCall('rag_search', {
    query: 'What are the API rate limits?',
    top_k: 3,
    results: q3Results,
  });
  const t3 = extractText(r3);
  const ids3 = extractChunkIds(t3);
  const chunks3 = extractChunkLines(t3);

  check('Q3 返回不同 chunk 集合', JSON.stringify(ids3.sort()) !== JSON.stringify(ids1.sort()),
    'different query should return different chunks');
  check('Q3 chunk 内容与 Q1 不同', JSON.stringify(chunks3) !== JSON.stringify(chunks1),
    'different chunks should have different content');

  // ── Part 4: 归一化验证 — 无元数据泄漏 ──
  section('Part 4: 归一化验证 — 无 score/rank/timestamp 泄漏');

  // Q4: 带 score/rank/timestamp 的原始检索结果
  const q4Results = [
    { id: 'd42', text: 'Test chunk A', score: 0.99, rank: 1, timestamp: '2026-06-21T10:00:00Z' },
    { id: 'd17', text: 'Test chunk B', score: 0.85, rank: 2, timestamp: '2026-06-21T10:00:00Z' },
  ];
  const r4 = await client.toolCall('rag_search', {
    query: 'test normalization',
    top_k: 5,
    results: q4Results,
  });
  const t4 = extractText(r4);

  check('输出中无 score 字段', !t4.includes('0.99') && !t4.includes('0.85'), 'scores should be stripped');
  check('输出中无 rank 字段', !/\brank\b/i.test(t4.replace('rag_search', '')), 'ranks should be stripped');
  check('输出中无 timestamp 字段', !t4.includes('2026-06-21'), 'timestamps should be stripped');
  check('chunk 文本保留', t4.includes('Test chunk A') && t4.includes('Test chunk B'));

  // ── Part 5: kb_pin 测试 ──
  section('Part 5: kb_pin — 钉住热点文档');

  const pinRes = await client.toolCall('kb_pin', { doc_ids: ['d42', 'd17'] });
  const pinText = extractText(pinRes);
  check('kb_pin 返回成功', pinText.includes('pinned'), `got: ${pinText.substring(0, 100)}`);
  check('kb_pin 显示 pinned 数量', /pinned:\s+\d+/.test(pinText));

  // ── Part 6: headroom_retrieve 测试 ──
  section('Part 6: headroom_retrieve — CCR 按需取回');

  // 服务器 KB 没有预加载 docs（仅有 index），所以 headroom_retrieve
  // 对于不在 KB 中的 chunk_id 返回 "not found"（正确行为）
  const retrRes = await client.toolCall('headroom_retrieve', { chunk_id: 'd42' });
  const retrText = extractText(retrRes);
  check('headroom_retrieve 返回响应', retrText.includes('headroom_retrieve'), `got: ${retrText.substring(0, 100)}`);
  check('headroom_retrieve 对不在 KB 的 chunk 返回 not found',
    retrText.includes('not found'), 'server KB has no preloaded docs, so "not found" is correct');

  // 测试不存在的 chunk_id
  const retrBad = await client.toolCall('headroom_retrieve', { chunk_id: 'nonexistent' });
  const retrBadText = extractText(retrBad);
  check('headroom_retrieve 对不存在的 chunk 返回 not found', retrBadText.includes('not found'));

  // ── Part 7: token_report 统计验证 ──
  section('Part 7: token_report — 统计验证');

  const reportRes = await client.toolCall('token_report', {});
  const reportText = extractText(reportRes);
  check('token_report 显示搜索次数', /rag_search calls:\s+\d+/.test(reportText), reportText.substring(0, 200));
  check('token_report 显示 re-ask hits', /re-ask cache hits:\s+\d+/.test(reportText));

  // 解析搜索次数
  const searchMatch = reportText.match(/rag_search calls:\s+(\d+)/);
  const searchCount = searchMatch ? parseInt(searchMatch[1]) : 0;
  check('搜索次数 = 4（Q1-Q4）', searchCount === 4, `got ${searchCount}`);

  // re-ask hits 应 >= 1（Q2 与 Q1 相同 chunk 集合）
  const reaskMatch = reportText.match(/re-ask cache hits:\s+(\d+)/);
  const reaskCount = reaskMatch ? parseInt(reaskMatch[1]) : 0;
  check('re-ask cache hits >= 1', reaskCount >= 1, `got ${reaskCount}`);

  // ── Part 8: session 隔离验证 ──
  section('Part 8: session 隔离 — 两个 session 状态独立');

  const client2 = new McpHttpClient(BASE_URL, TOKEN);
  await client2.initialize();
  check('client2 获取独立 session-id', !!client2.sessionId && client2.sessionId !== client.sessionId,
    `c1=${client.sessionId}, c2=${client2.sessionId}`);

  // client2 的 token_report 应该是空的（新 session）
  const report2 = await client2.toolCall('token_report', {});
  const report2Text = extractText(report2);
  const search2Match = report2Text.match(/rag_search calls:\s+(\d+)/);
  const search2Count = search2Match ? parseInt(search2Match[1]) : -1;
  check('client2 搜索次数 = 0（新 session）', search2Count === 0, `got ${search2Count}`);

  // ── Part 9: ping 和错误处理 ──
  section('Part 9: ping 和错误处理');

  const pingRes = await client.ping();
  check('ping 返回空结果', pingRes?.result && Object.keys(pingRes.result).length === 0);

  // 调用不存在的工具
  const badTool = await client.toolCall('nonexistent_tool', {});
  check('未知工具返回 error', !!badTool?.error || (badTool?.result?.isError),
    JSON.stringify(badTool).substring(0, 200));

  // ── Part 10: 无 token 访问被拒 ──
  section('Part 10: 鉴权验证');

  const noAuthRes = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  check('无 token 返回 401', noAuthRes.status === 401);

  const wrongTokenRes = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer wrong-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  check('错误 token 返回 401', wrongTokenRes.status === 401);

  // ── 结果汇总 ──
  section('测试结果汇总');
  console.log(`  \x1b[32m通过: ${pass}\x1b[0m  \x1b[31m失败: ${fail}\x1b[0m  总计: ${pass + fail}`);
  console.log('');

  if (fail > 0) {
    console.log('  \x1b[31m存在失败用例，请检查上方输出\x1b[0m');
  } else {
    console.log('  \x1b[32m全部通过！HTTP 端到端 RAG 缓存命中逻辑验证成功。\x1b[0m');
  }

  cleanup();
  process.exit(fail > 0 ? 1 : 0);
}

// ── 运行 ──
runTests().catch((e) => {
  console.error(`\n  \x1b[31m致命错误: ${e.message}\x1b[0m`);
  console.error(e.stack);
  cleanup();
  process.exit(1);
});
