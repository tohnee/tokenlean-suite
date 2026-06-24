#!/usr/bin/env node
/**
 * test-live-provider-compare.mjs — validates the OpenAI-compatible live A/B harness
 * with a local mock provider. No network or real API key required.
 */
import http from 'node:http';
import { runLiveComparison } from '../bench/live-provider-compare.mjs';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${d}`)); };

console.log('═══ live provider comparison harness test ═══\n');

const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    const prompt = JSON.parse(body).messages?.[0]?.content || '';
    const promptTokens = Math.ceil(prompt.length / 4);
    const cachedTokens = prompt.includes('CACHE BREAKPOINT') ? 100 : 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `mock-${seen.length}`,
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: 3,
        total_tokens: promptTokens + 3,
        prompt_tokens_details: { cached_tokens: cachedTokens },
      },
    }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

try {
  const result = await runLiveComparison({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'test-key',
    model: 'mock-model',
    turns: 2,
  });

  check('sends naive and cache-aware requests for each turn', seen.length === 4, `requests=${seen.length}`);
  check('uses OpenAI-compatible chat completions endpoint', seen.every((r) => r.url === '/v1/chat/completions'), seen.map((r) => r.url).join(','));
  check('passes bearer API key', seen.every((r) => r.auth === 'Bearer test-key'));
  check('uses configured model', seen.every((r) => r.body.model === 'mock-model'));
  check('aggregates both variants', result.naive.requests === 2 && result.cacheAware.requests === 2, JSON.stringify(result));
  check('captures cached token usage when provider reports it', result.cacheAware.cachedTokens > 0, `cached=${result.cacheAware.cachedTokens}`);
  check('keeps local benchmark conclusion attached', /local estimate/i.test(result.localConclusion));
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
