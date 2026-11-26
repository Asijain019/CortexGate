import assert from 'node:assert/strict';
import test from 'node:test';
import * as circuit from '../src/gateway/circuitBreaker.js';
import { checkProvider, runHealthChecks, getHealth, clearHealth, startHealthChecks, PROBES } from '../src/gateway/healthCheck.js';
import { install, fake, ok, fail } from './helpers/fakes.js';

/** Fake fetch: `impl(url, init)` returns { status, body } (body string) or throws. */
function fakeFetch(impl) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = await impl(url, init);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => r.body ?? '' };
  };
  fn.calls = calls;
  return fn;
}
const json200 = () => ({ status: 200, body: '{"data":[]}' });

function setup(fakes, env = {}) {
  const restore = install(fakes, { BREAKER_THRESHOLD: '1', BREAKER_COOLDOWN_MS: '60000', ...env });
  clearHealth();
  return () => { clearHealth(); restore(); };
}

test('healthy provider: free metadata GET only, no chat probe, health filled', async () => {
  const groq = fake(ok());
  const restore = setup({ groq });
  try {
    const f = fakeFetch(json200);
    const h = await checkProvider('groq', { fetch: f });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, PROBES.groq.url);
    assert.equal(f.calls[0].init.method, 'GET');
    assert.equal(groq.calls.length, 0, 'healthy providers never get a (paid) chat probe');
    assert.equal(h.ok, true);
    assert.ok(h.lastCheckAt);
    assert.ok(Number.isFinite(h.latencyMs));
    assert.equal(h.error, null);
  } finally {
    restore();
  }
});

test('probe success closes an open breaker early (metadata ok + tiny chat ok)', async () => {
  const groq = fake(ok('OK'));
  const restore = setup({ groq });
  try {
    circuit.recordFailure('groq', new Error('timeout'));
    assert.equal(circuit.getState('groq'), 'open');
    const h = await checkProvider('groq', { fetch: fakeFetch(json200) });
    assert.equal(groq.calls.length, 1);
    assert.equal(circuit.getState('groq'), 'healthy');
    assert.equal(h.ok, true);
  } finally {
    restore();
  }
});

test('open breaker + chat probe failure keeps it open', async () => {
  const groq = fake(fail(503, 'overloaded'));
  const restore = setup({ groq });
  try {
    circuit.recordFailure('groq', new Error('x'));
    const h = await checkProvider('groq', { fetch: fakeFetch(json200) });
    assert.equal(circuit.getState('groq'), 'open');
    assert.equal(h.ok, false);
    assert.match(h.error, /chat probe/);
  } finally {
    restore();
  }
});

test('probe failure (5xx / network / timeout) opens the breaker before users hit it', async () => {
  for (const impl of [() => ({ status: 503, body: 'down' }), () => { throw new TypeError('fetch failed'); }]) {
    const groq = fake(ok());
    const restore = setup({ groq }, { BREAKER_THRESHOLD: '3' });
    try {
      assert.equal(circuit.getState('groq'), 'healthy');
      const h = await checkProvider('groq', { fetch: fakeFetch(impl) });
      assert.equal(circuit.getState('groq'), 'open');
      assert.equal(h.ok, false);
      assert.ok(h.error);
      assert.equal(groq.calls.length, 0);
    } finally {
      restore();
    }
  }
});

test('probe 401 -> disabled (auth), 402 -> billing, non-JSON -> bad_response, 429 inconclusive', async () => {
  const cases = [
    [{ status: 401, body: '{}' }, 'disabled', 'auth', false],
    [{ status: 402, body: '{}' }, 'disabled', 'billing', false],
    [{ status: 200, body: 'OK' }, 'disabled', 'bad_response', false],
    [{ status: 429, body: '{}' }, 'healthy', null, null]
  ];
  for (const [resp, state, reason, okVal] of cases) {
    const restore = setup({ groq: fake() });
    try {
      const h = await checkProvider('groq', { fetch: fakeFetch(() => resp) });
      assert.equal(circuit.getState('groq'), state, JSON.stringify(resp));
      assert.equal(circuit.getStatus(['groq']).groq.disabledReason, reason);
      assert.equal(h.ok, okVal);
    } finally {
      restore();
    }
  }
});

test('disabled / cooling-down providers are not probed; runHealthChecks covers configured ones', async () => {
  const restore = setup({ groq: fake(), gemini: fake(), nvidia: fake() });
  try {
    circuit.recordAuthFailure('gemini', { status: 401 });
    circuit.recordRateLimit('nvidia', 60000);
    const f = fakeFetch(json200);
    const out = await runHealthChecks({ fetch: f });
    assert.deepEqual(f.calls.map(c => c.url), [PROBES.groq.url]);
    assert.equal(out.groq.ok, true);
    assert.equal(out.gemini.lastCheckAt, null);
  } finally {
    restore();
  }
});

test('gemini key goes in a header, never the URL', async () => {
  const prev = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'secret-test-value';
  const restore = setup({ gemini: fake() });
  try {
    const f = fakeFetch(json200);
    await checkProvider('gemini', { fetch: f });
    assert.ok(!f.calls[0].url.includes('secret-test-value'));
    assert.ok(Object.values(f.calls[0].init.headers).includes('secret-test-value') ||
      f.calls[0].init.headers['x-goog-api-key']);
  } finally {
    restore();
    if (prev === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prev;
  }
});

test('startHealthChecks is a no-op under node --test', () => {
  const stop = startHealthChecks({ intervalMs: 10 });
  assert.equal(typeof stop, 'function');
  stop();
});
