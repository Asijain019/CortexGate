import assert from 'node:assert/strict';
import test from 'node:test';
import { sendChatCompletion } from '../src/providers/gemini.js';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}

test('Gemini retries a busy model with the configured fallback model', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousModel = process.env.GEMINI_MODEL;
  const previousFallback = process.env.GEMINI_FALLBACK_MODEL;
  const calls = [];

  try {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_MODEL = 'gemini-primary';
    process.env.GEMINI_FALLBACK_MODEL = 'gemini-fallback';

    const result = await sendChatCompletion({
      messages: [{ role: 'user', content: 'hello' }]
    }, {
      fetch: async url => {
        calls.push(url);
        if (calls.length === 1) {
          return response(503, { error: { message: 'Model is busy' } });
        }
        return response(200, {
          modelVersion: 'gemini-fallback',
          candidates: [{ content: { parts: [{ text: 'fallback response' }] } }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 }
        });
      }
    });

    assert.match(calls[0], /models\/gemini-primary:generateContent/);
    assert.match(calls[1], /models\/gemini-fallback:generateContent/);
    assert.equal(result.model, 'gemini-fallback');
    assert.equal(result.content, 'fallback response');
    assert.equal(result.usage.total_tokens, 4);
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = previousModel;
    if (previousFallback === undefined) delete process.env.GEMINI_FALLBACK_MODEL;
    else process.env.GEMINI_FALLBACK_MODEL = previousFallback;
  }
});

test('Gemini does not retry after its fallback model is also rate limited', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousModel = process.env.GEMINI_MODEL;
  const previousFallback = process.env.GEMINI_FALLBACK_MODEL;
  const calls = [];

  try {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_MODEL = 'gemini-primary';
    process.env.GEMINI_FALLBACK_MODEL = 'gemini-fallback';

    await assert.rejects(
      sendChatCompletion({
        messages: [{ role: 'user', content: 'hello' }]
      }, {
        fetch: async url => {
          calls.push(url);
          return response(429, { error: { message: 'Rate limited' } });
        }
      }),
      error => error.status === 429 && error.transient === false
    );
    assert.equal(calls.length, 2);
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = previousModel;
    if (previousFallback === undefined) delete process.env.GEMINI_FALLBACK_MODEL;
    else process.env.GEMINI_FALLBACK_MODEL = previousFallback;
  }
});

test('Gemini walks a comma-separated fallback list and parses RetryInfo', async () => {
  const saved = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_FALLBACK_MODEL'].map(k => [k, process.env[k]]);
  const calls = [];
  try {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_MODEL = 'g-a';
    process.env.GEMINI_FALLBACK_MODEL = 'g-b, g-c';
    await assert.rejects(
      sendChatCompletion({ messages: [{ role: 'user', content: 'hi' }] }, {
        fetch: async url => {
          calls.push(url);
          return response(429, { error: { message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17s' }] } });
        }
      }),
      e => e.status === 429 && e.retryAfterMs === 17000
    );
    assert.deepEqual(calls.map(u => u.match(/models\/([^:]+):/)[1]), ['g-a', 'g-b', 'g-c']);
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('Gemini maps an aborted signal to 504 PROVIDER_TIMEOUT', async () => {
  const prev = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = 'test-key';
    const ac = new AbortController();
    const p = sendChatCompletion({ messages: [{ role: 'user', content: 'hi' }] }, {
      signal: ac.signal,
      fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' }))))
    });
    ac.abort();
    await assert.rejects(p, e => e.status === 504 && e.code === 'PROVIDER_TIMEOUT');
  } finally {
    if (prev === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prev;
  }
});
