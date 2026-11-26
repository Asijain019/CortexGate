import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAICompatAdapter, parseRetryAfter } from '../src/providers/openaiCompat.js';

function res(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
    async text() { return text; }
  };
}

const adapter = createOpenAICompatAdapter({
  name: 'testp', label: 'TestP', url: 'https://example.invalid/v1/chat/completions',
  keyEnv: ['TESTP_API_KEY'], defaultModel: 'm1',
  pricing: { m1: { prompt: 1e-6, completion: 2e-6 } }
});

test('parseRetryAfter handles seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('7'), 7000);
  assert.equal(parseRetryAfter(null), undefined);
  const ms = parseRetryAfter(new Date(Date.now() + 10_000).toUTCString());
  assert.ok(ms > 8000 && ms <= 10_000);
});

test('OpenAI-compatible adapter: success, 429 Retry-After, non-JSON 502, abort -> 504', async () => {
  process.env.TESTP_API_KEY = 'k';
  try {
    const okOut = await adapter.sendChatCompletion({ messages: [{ role: 'user', content: 'hi' }] }, {
      fetch: async (url, init) => {
        assert.equal(JSON.parse(init.body).model, 'm1');
        return res(200, { model: 'm1', choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
      }
    });
    assert.equal(okOut.content, 'hello');
    assert.equal(okOut.usage.total_tokens, 3);
    assert.ok(Math.abs(adapter.calculateCost(okOut.usage, 'm1') - 5e-6) < 1e-12);

    await assert.rejects(
      adapter.sendChatCompletion({ messages: [] }, { fetch: async () => res(429, { error: { message: 'too many' } }, { 'retry-after': '12' }) }),
      e => e.status === 429 && e.retryAfterMs === 12000 && /too many/.test(e.message)
    );

    await assert.rejects(
      adapter.sendChatCompletion({ messages: [] }, { fetch: async () => res(200, 'OK') }),
      e => e.status === 502 && /non-JSON/.test(e.message)
    );

    const ac = new AbortController();
    const p = adapter.sendChatCompletion({ messages: [] }, {
      signal: ac.signal,
      fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' }))))
    });
    ac.abort();
    await assert.rejects(p, e => e.status === 504 && e.code === 'PROVIDER_TIMEOUT');
  } finally {
    delete process.env.TESTP_API_KEY;
  }
});

test('adapter without its key reports unconfigured and throws NOT_CONFIGURED', async () => {
  delete process.env.TESTP_API_KEY;
  assert.equal(adapter.isConfigured(), false);
  await assert.rejects(adapter.sendChatCompletion({ messages: [] }), e => e.code === 'NOT_CONFIGURED');
});
