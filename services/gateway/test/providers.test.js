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

// ---------------------------------------------------------------- key store / custom / new adapters

import { normalizeBaseUrl, slugify } from '../src/providers/customProvider.js';
import * as keyStore from '../src/providers/keyStore.js';
import { providers as registry, isBuiltin, registerProvider, unregisterProvider, getCustomCatalog, getBuiltinCatalogHints } from '../src/providers/index.js';

test('normalizeBaseUrl accepts /v1 variations and full endpoints, rejects non-http', () => {
  assert.equal(normalizeBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1');
  assert.equal(normalizeBaseUrl('http://localhost:11434/v1/'), 'http://localhost:11434/v1');
  assert.equal(normalizeBaseUrl('http://localhost:11434'), 'http://localhost:11434/v1');
  assert.equal(normalizeBaseUrl('https://api.x.ai/v1/chat/completions'), 'https://api.x.ai/v1');
  assert.equal(normalizeBaseUrl('https://api.deepinfra.com/v1/openai'), 'https://api.deepinfra.com/v1/openai');
  assert.throws(() => normalizeBaseUrl('file:///etc/passwd'), /http or https/);
  assert.throws(() => normalizeBaseUrl('localhost:1234'), /http or https|valid/);
  assert.throws(() => normalizeBaseUrl('https://a.b/v1?x=1'), /query/);
});

test('slugify and builtin name protection', () => {
  assert.equal(slugify('  My Ollama! '), 'my-ollama');
  assert.equal(slugify('Ünïcode Név'), 'unicode-nev');
  assert.equal(slugify('!!!'), '');
  assert.ok(isBuiltin('groq') && isBuiltin('openai') && isBuiltin('cache') && isBuiltin('together'));
  assert.throws(() => registerProvider('groq', { sendChatCompletion() {} }, {}), /reserved/);
  registerProvider('tmp-x', { sendChatCompletion: async () => ({}) }, { models: { light: 'a', standard: 'a', heavy: 'a' }, quality: {}, price: {} });
  assert.equal(getCustomCatalog()['tmp-x'].custom, true);
  assert.equal(unregisterProvider('groq'), false);
  assert.equal(unregisterProvider('tmp-x'), true);
  assert.equal(registry['tmp-x'], undefined);
});

test('dashboard key (in-memory store under test) overrides env for OpenAI-compatible adapters', async () => {
  process.env.GROQ_API_KEY = 'env-value-0000';
  try {
    const seen = [];
    const fetchSpy = async (url, init) => {
      seen.push(init.headers.Authorization);
      return res(200, { choices: [{ message: { content: 'x' } }] });
    };
    await registry.groq.sendChatCompletion({ messages: [], max_tokens: 5 }, { fetch: async (u, i) => { assert.equal(JSON.parse(i.body).max_tokens, 5); return fetchSpy(u, i); } });
    keyStore.setBuiltinKey('groq', { apiKey: 'dash-value-1111' });
    await registry.groq.sendChatCompletion({ messages: [] }, { fetch: fetchSpy });
    keyStore.clearBuiltinKey('groq');
    await registry.groq.sendChatCompletion({ messages: [] }, { fetch: fetchSpy });
    assert.deepEqual(seen, ['Bearer env-value-0000', 'Bearer dash-value-1111', 'Bearer env-value-0000']);
  } finally {
    delete process.env.GROQ_API_KEY;
  }
});

test('gemini and cloudflare resolve dashboard credentials', async () => {
  delete process.env.GEMINI_API_KEY;
  assert.equal(registry.gemini.isConfigured(), false);
  keyStore.setBuiltinKey('gemini', { apiKey: 'AIza-dash-key-123' });
  assert.equal(registry.gemini.isConfigured(), true);
  keyStore.clearBuiltinKey('gemini');

  delete process.env.CLOUDFLARE_API_TOKEN; delete process.env.CLOUDFLARE_ACCOUNT_ID;
  assert.equal(registry.cloudflare.isConfigured(), false);
  keyStore.setBuiltinKey('cloudflare', { apiKey: 'cf-token-123456', accountId: 'acct789' });
  assert.equal(registry.cloudflare.isConfigured(), true);
  let url;
  await registry.cloudflare.sendChatCompletion({ messages: [] }, { fetch: async u => { url = u; return res(200, { choices: [{ message: { content: 'x' } }] }); } });
  assert.match(url, /accounts\/acct789\/ai\/v1\/chat\/completions$/);
  keyStore.clearBuiltinKey('cloudflare');
});

test('together and lmstudio stay unconfigured without key / opt-in', () => {
  const saved = { t: process.env.TOGETHER_API_KEY, l: process.env.LMSTUDIO_BASE_URL, e: process.env.LMSTUDIO_ENABLED };
  delete process.env.TOGETHER_API_KEY; delete process.env.LMSTUDIO_BASE_URL; delete process.env.LMSTUDIO_ENABLED;
  try {
    assert.equal(registry.together.isConfigured(), false);
    assert.equal(registry.lmstudio.isConfigured(), false);
    process.env.LMSTUDIO_ENABLED = 'true';
    assert.equal(registry.lmstudio.isConfigured(), true);
    assert.equal(registry.together.calculateCost({ prompt_tokens: 1000, completion_tokens: 1000 }), 0, 'free model costs 0');
    const hints = getBuiltinCatalogHints();
    assert.ok(hints.together.models.standard && hints.lmstudio.models.standard);
  } finally {
    for (const [k, v] of [['TOGETHER_API_KEY', saved.t], ['LMSTUDIO_BASE_URL', saved.l], ['LMSTUDIO_ENABLED', saved.e]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
