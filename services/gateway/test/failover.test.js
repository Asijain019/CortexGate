import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatch } from '../src/gateway/dispatch.js';
import * as circuit from '../src/gateway/circuitBreaker.js';
import { route } from '../src/gateway/router.js';
import { install, fake, ok, fail, hang, msg } from './helpers/fakes.js';

const wait = ms => new Promise(r => setTimeout(r, ms));

test('timeout -> switch: a hanging provider is aborted via options.signal after PROVIDER_TIMEOUT_MS', async () => {
  const groq = fake(hang());
  const gemini = fake(ok('fast'));
  const restore = install({ groq, gemini }, { PROVIDER_TIMEOUT_MS: '100' });
  try {
    const t0 = Date.now();
    const out = await dispatch({ messages: msg('hello'), provider: 'groq' });
    assert.ok(Date.now() - t0 < 1500);
    assert.equal(out.provider, 'gemini');
    assert.equal(out.attempts[0].outcome, 'timeout');
    assert.equal(out.attempts[0].httpStatus, 504);
    assert.ok(groq.calls[0].signal.aborted, 'adapter signal should be aborted');
  } finally {
    restore();
  }
});

test('timeout is enforced even if an adapter ignores the signal', async () => {
  const groq = fake(() => new Promise(() => {}));
  const gemini = fake(ok());
  const restore = install({ groq, gemini }, { PROVIDER_TIMEOUT_MS: '80' });
  try {
    const out = await dispatch({ messages: msg('hello'), provider: 'groq' });
    assert.equal(out.provider, 'gemini');
    assert.equal(out.attempts[0].outcome, 'timeout');
  } finally {
    restore();
  }
});

test('429 puts the provider in cooldown (Retry-After honoured) and later requests skip it', async () => {
  const groq = fake(fail(429, 'slow down', { retryAfterMs: 5000 }));
  const gemini = fake(ok());
  const restore = install({ groq, gemini });
  try {
    const first = await dispatch({ messages: msg('hello'), provider: 'groq' });
    assert.equal(first.provider, 'gemini');
    assert.equal(first.attempts[0].outcome, 'rate_limited');
    assert.equal(circuit.getState('groq'), 'cooldown');
    const retryIn = circuit.getStatus(['groq']).groq.retryInMs;
    assert.ok(retryIn > 4000 && retryIn <= 5000, `retryInMs ${retryIn}`);

    const second = await dispatch({ messages: msg('hello'), provider: 'groq' });
    assert.equal(second.provider, 'gemini');
    assert.equal(groq.calls.length, 1, 'groq must not be called during cooldown');
    assert.ok(second.skippedProviders.includes('groq'));
  } finally {
    restore();
  }
});

test('429 without Retry-After uses RATE_LIMIT_COOLDOWN_MS', async () => {
  const groq = fake(fail(429));
  const gemini = fake(ok());
  const restore = install({ groq, gemini }, { RATE_LIMIT_COOLDOWN_MS: '1234' });
  try {
    await dispatch({ messages: msg('hello'), provider: 'groq' });
    const retryIn = circuit.getStatus(['groq']).groq.retryInMs;
    assert.ok(retryIn > 1000 && retryIn <= 1234, `retryInMs ${retryIn}`);
  } finally {
    restore();
  }
});

test('401/402/403 disable the provider for AUTH_COOLDOWN_MS', async () => {
  for (const status of [401, 402, 403]) {
    const groq = fake(fail(status, 'bad key'));
    const gemini = fake(ok());
    const restore = install({ groq, gemini }, { AUTH_COOLDOWN_MS: '60000' });
    try {
      const out = await dispatch({ messages: msg('hello'), provider: 'groq' });
      assert.equal(out.provider, 'gemini');
      assert.equal(circuit.getState('groq'), 'disabled');
      await dispatch({ messages: msg('hello'), provider: 'groq' });
      assert.equal(groq.calls.length, 1, `status ${status}: disabled provider must not be retried`);
    } finally {
      restore();
    }
  }
});

test('per-provider in-flight cap skips a saturated provider', async () => {
  const slow = content => fake(async () => { await wait(80); return { content }; });
  const groq = slow('groq');
  const gemini = slow('gemini');
  const restore = install({ groq, gemini }, { PROVIDER_MAX_INFLIGHT: '1', RR_BUCKET_DELTA: '0' });
  try {
    const top = route({ messages: msg('hello') }).candidates[0].provider;
    const [a, b] = await Promise.all([
      dispatch({ messages: msg('hello') }),
      dispatch({ messages: msg('hello') })
    ]);
    assert.equal(a.provider, top);
    assert.notEqual(b.provider, top);
    assert.ok(b.skippedProviders.includes(top));
  } finally {
    restore();
  }
});

test('all providers fail -> error shape with attempts', async () => {
  const groq = fake(fail(500, 'boom'));
  const gemini = fake(fail(503, 'overloaded'));
  const restore = install({ groq, gemini });
  try {
    const out = await dispatch({ messages: msg('hello') });
    assert.equal(out.result, null);
    assert.equal(out.provider, null);
    assert.equal(out.error.status, 502);
    assert.equal(out.error.code, 'ALL_PROVIDERS_FAILED');
    assert.match(out.error.message, /groq: boom/);
    assert.equal(out.attempts.length, 2);
    for (const a of out.attempts) {
      assert.deepEqual(Object.keys(a).sort(), ['error', 'httpStatus', 'latencyMs', 'model', 'outcome', 'provider']);
      assert.equal(a.outcome, 'error');
    }
    assert.deepEqual(out.failedProviders.sort(), ['gemini', 'groq']);
    assert.ok(out.routing.reason.length > 0);
    assert.ok(out.lastError instanceof Error);
  } finally {
    restore();
  }
});

test('all providers rate limited -> 429', async () => {
  const restore = install({ groq: fake(fail(429)), gemini: fake(fail(429)) });
  try {
    const out = await dispatch({ messages: msg('hello') });
    assert.equal(out.error.status, 429);
    assert.equal(out.error.code, 'ALL_PROVIDERS_RATE_LIMITED');
  } finally {
    restore();
  }
});

test('breaker opens after BREAKER_THRESHOLD failures, then half-open probe closes it', async () => {
  let failing = true;
  const groq = fake(() => { if (failing) throw Object.assign(new Error('down'), { status: 500 }); return { content: 'back' }; });
  const restore = install({ groq }, { BREAKER_THRESHOLD: '2', BREAKER_COOLDOWN_MS: '60' });
  try {
    await dispatch({ messages: msg('hi') });
    assert.equal(circuit.getState('groq'), 'healthy');
    await dispatch({ messages: msg('hi') });
    assert.equal(circuit.getState('groq'), 'open');
    await wait(80);
    assert.equal(circuit.getState('groq'), 'probing');
    failing = false;
    const out = await dispatch({ messages: msg('hi') });
    assert.equal(out.provider, 'groq');
    assert.equal(circuit.getState('groq'), 'healthy');
  } finally {
    restore();
  }
});

test('PROVIDER_MAX_RETRIES retries 5xx on the same provider before failing over', async () => {
  const groq = fake(fail(500));
  const gemini = fake(ok());
  const restore = install({ groq, gemini }, { PROVIDER_MAX_RETRIES: '1' });
  try {
    const out = await dispatch({ messages: msg('hello'), provider: 'groq' });
    assert.equal(groq.calls.length, 2);
    assert.equal(out.provider, 'gemini');
  } finally {
    restore();
  }
});

test('REQUEST_BUDGET_MS caps the total time across attempts', async () => {
  const restore = install({ groq: fake(hang()), gemini: fake(hang()), nvidia: fake(hang()) },
    { PROVIDER_TIMEOUT_MS: '200', REQUEST_BUDGET_MS: '300' });
  try {
    const t0 = Date.now();
    const out = await dispatch({ messages: msg('hello') });
    assert.ok(Date.now() - t0 < 700, `took ${Date.now() - t0}ms`);
    assert.equal(out.result, null);
    assert.equal(out.error.status, 504);
    assert.ok(out.attempts.length <= 2);
  } finally {
    restore();
  }
});

test('a malformed (non-JSON) 502 disables the provider after the first failure', async () => {
  const github = fake(fail(502, 'GitHub Models returned a non-JSON response: OK', { code: 'BAD_RESPONSE' }));
  const groq = fake(ok());
  const restore = install({ github, groq });
  try {
    await dispatch({ messages: msg('hi'), provider: 'github' });
    assert.equal(circuit.getState('github'), 'disabled');
    await dispatch({ messages: msg('hi'), provider: 'github' });
    assert.equal(github.calls.length, 1);
  } finally {
    restore();
  }
});

test("purpose 'verify' caps attempts at VERIFY_MAX_ATTEMPTS (default 2)", async () => {
  const fakes = { groq: fake(fail(500)), gemini: fake(fail(500)), nvidia: fake(fail(500)), cerebras: fake(fail(500)) };
  const restore = install(fakes);
  try {
    const out = await dispatch({ messages: msg('Reply YES or NO'), tier: 'light', purpose: 'verify' });
    assert.equal(out.attempts.length, 2);
    assert.equal(out.result, null);
  } finally {
    restore();
  }
});

test("purpose 'verify' prefers the fastest healthy cheap provider", async () => {
  const restore = install({ groq: fake(), nvidia: fake(), gemini: fake() }, { RR_BUCKET_DELTA: '0' });
  try {
    // Simulate measured latencies: nvidia slow, groq fast.
    for (let i = 0; i < 5; i++) {
      (await import('../src/gateway/providerStats.js')).recordSuccess('nvidia', 6000, 'x');
      (await import('../src/gateway/providerStats.js')).recordSuccess('groq', 400, 'x');
    }
    const plan = route({ messages: msg('Reply YES or NO'), tier: 'light', purpose: 'verify' });
    assert.equal(plan.candidates[0].provider, 'groq');
    assert.match(plan.reason, /cache verification/);
  } finally {
    restore();
  }
});
