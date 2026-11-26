import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatch } from '../src/gateway/dispatch.js';
import * as circuit from '../src/gateway/circuitBreaker.js';
import * as providerStats from '../src/gateway/providerStats.js';
import { route } from '../src/gateway/router.js';
import { install, fake, ok, fail, hang, msg } from './helpers/fakes.js';

const wait = ms => new Promise(r => setTimeout(r, ms));

/** Set extra env vars not covered by install()'s restore; returns a combined restore. */
function withEnv(restore, env) {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  return () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    restore();
  };
}

test('with the load penalty on, a busy provider is ranked lower so concurrent requests spread', async () => {
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
    assert.ok(!b.attempts.some(x => x.provider === top), 'busy provider is not attempted');
  } finally {
    restore();
  }
});

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

test('per-provider in-flight cap skips a saturated provider (load penalty off)', async () => {
  const slow = content => fake(async () => { await wait(80); return { content }; });
  const groq = slow('groq');
  const gemini = slow('gemini');
  const restore = withEnv(install({ groq, gemini }, { PROVIDER_MAX_INFLIGHT: '1', RR_BUCKET_DELTA: '0' }), { ROUTER_LOAD_PENALTY: '0' });
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

// ---------------------------------------------------------------- bounded failover + persistence

test('MAX_FAILOVER_ATTEMPTS caps the chain (default 3, including the first attempt)', async () => {
  const names = ['groq', 'gemini', 'nvidia', 'cerebras', 'cohere'];
  const fakes = Object.fromEntries(names.map(n => [n, fake(fail(500, `${n} down`))]));
  const restore = install(fakes);
  try {
    const out = await dispatch({ messages: msg('hello') });
    assert.equal(out.attempts.length, 3);
    assert.equal(out.error.status, 502);
    assert.equal(out.error.code, 'FAILOVER_LIMIT_REACHED');
    assert.equal(out.error.attemptsExhausted, true);
    assert.equal(names.reduce((n, k) => n + fakes[k].calls.length, 0), 3);
  } finally {
    restore();
  }
  const fakes2 = Object.fromEntries(names.map(n => [n, fake(fail(500))]));
  const restore2 = withEnv(install(fakes2), { MAX_FAILOVER_ATTEMPTS: '2' });
  try {
    const out = await dispatch({ messages: msg('hello') });
    assert.equal(out.attempts.length, 2);
  } finally {
    restore2();
  }
});

test('the 3rd attempt can still succeed; same-provider retries count toward the cap', async () => {
  const restore = withEnv(install({ groq: fake(fail(500)), gemini: fake(fail(500)), nvidia: fake(ok('third')) }),
    { RR_BUCKET_DELTA: '0' });
  try {
    const out = await dispatch({ messages: msg('hello'), provider: 'groq' });
    assert.equal(out.attempts.length, 3);
    assert.equal(out.attempts[2].outcome, 'ok');
  } finally {
    restore();
  }
  const groq = fake(fail(500));
  const gemini = fake(ok());
  const restore2 = withEnv(install({ groq, gemini }, { PROVIDER_MAX_RETRIES: '5' }), { MAX_FAILOVER_ATTEMPTS: '2' });
  try {
    const out = await dispatch({ messages: msg('hello'), provider: 'groq' });
    assert.equal(out.attempts.length, 2);
    assert.equal(groq.calls.length, 2);
    assert.equal(gemini.calls.length, 0);
    assert.equal(out.error.code, 'FAILOVER_LIMIT_REACHED');
  } finally {
    restore2();
  }
});

test('REQUEST_BUDGET_MS defaults to 25000 and MAX_FAILOVER_ATTEMPTS to 3', async () => {
  const { requestBudgetMs, maxFailoverAttempts } = await import('../src/gateway/dispatch.js');
  const saved = [process.env.REQUEST_BUDGET_MS, process.env.MAX_FAILOVER_ATTEMPTS];
  delete process.env.REQUEST_BUDGET_MS;
  delete process.env.MAX_FAILOVER_ATTEMPTS;
  try {
    assert.equal(requestBudgetMs(), 25000);
    assert.equal(maxFailoverAttempts(), 3);
  } finally {
    if (saved[0] !== undefined) process.env.REQUEST_BUDGET_MS = saved[0];
    if (saved[1] !== undefined) process.env.MAX_FAILOVER_ATTEMPTS = saved[1];
  }
});

test('402 -> disabledReason billing, 401 -> auth, non-JSON -> bad_response', () => {
  const restore = install({ groq: fake() });
  try {
    circuit.recordAuthFailure('sambanova', { status: 402, message: 'no credits' });
    circuit.recordAuthFailure('mistral', { status: 401, message: 'bad key' });
    circuit.recordBadResponse('github', { message: 'plain OK' });
    circuit.recordRateLimit('openrouter', 5000);
    const st = circuit.getStatus();
    assert.equal(st.sambanova.disabledReason, 'billing');
    assert.equal(st.mistral.disabledReason, 'auth');
    assert.equal(st.github.disabledReason, 'bad_response');
    assert.equal(st.openrouter.disabledReason, null);
    assert.equal(st.openrouter.state, 'cooldown');
  } finally {
    restore();
  }
});

test('restored (persisted) disabled state is skipped; resetProvider re-enables', async () => {
  const groq = fake(ok('groq'));
  const gemini = fake(ok('gemini'));
  const restore = install({ groq, gemini });
  try {
    circuit.recordAuthFailure('groq', { status: 401, message: 'bad key' });
    const snap = circuit.exportState();
    circuit.resetAll(); // "restart"
    assert.equal(circuit.getState('groq'), 'healthy');
    assert.deepEqual(circuit.importState(snap), ['groq']);
    assert.equal(circuit.getState('groq'), 'disabled');

    const out = await dispatch({ messages: msg('hello'), provider: 'groq' });
    assert.equal(out.provider, 'gemini');
    assert.equal(groq.calls.length, 0, 'known-broken provider must not be retried after restart');
    assert.ok(out.skippedProviders.includes('groq'));

    circuit.resetProvider('groq');
    assert.equal(circuit.getState('groq'), 'healthy');
    const again = await dispatch({ messages: msg('hello'), provider: 'groq' });
    assert.equal(again.provider, 'groq');
  } finally {
    restore();
  }
});

test('provider health survives a real process restart via DATA_DIR; a changed key drops the entry', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-health-'));
  const mod = pathToFileURL(path.resolve('src/gateway/circuitBreaker.js')).href;
  const baseEnv = { ...process.env, DATA_DIR: dir, MISTRAL_API_KEY: 'test-key-1', SAMBANOVA_API_KEY: 'test-key-2' };
  delete baseEnv.NODE_TEST_CONTEXT;
  delete baseEnv.NODE_ENV;
  const run = (code, env = baseEnv) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().split('\n').pop();
  };
  try {
    run(`const c = await import(${JSON.stringify(mod)});
      c.recordAuthFailure('mistral', { status: 401, message: 'bad key' });
      c.recordAuthFailure('sambanova', { status: 402, message: 'no credits' });
      c.recordBadResponse('github', { message: 'plain OK' });
      console.log('saved');`);
    assert.ok(fs.existsSync(path.join(dir, 'provider-health.json')));

    const after = JSON.parse(run(`const c = await import(${JSON.stringify(mod)});
      console.log(JSON.stringify(c.getStatus(['mistral','sambanova','github','groq'])));`));
    assert.equal(after.mistral.state, 'disabled');
    assert.equal(after.mistral.disabledReason, 'auth');
    assert.equal(after.sambanova.disabledReason, 'billing');
    assert.equal(after.github.disabledReason, 'bad_response');
    assert.equal(after.groq.state, 'healthy');

    const rekeyed = JSON.parse(run(`const c = await import(${JSON.stringify(mod)});
      console.log(JSON.stringify(c.getStatus(['mistral','sambanova'])));`, { ...baseEnv, MISTRAL_API_KEY: 'new-key' }));
    assert.equal(rekeyed.mistral.state, 'healthy', 'new key -> re-enabled');
    assert.equal(rekeyed.sambanova.state, 'disabled');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- capacity wait / downgrade / floor

const heavyMsg = msg('Prove step by step that the square root of 2 is irrational, and analyze why the proof by contradiction works.');
const slowOk = (ms, content = 'ok') => fake(async () => { await wait(ms); return { content }; });

test('capacity wait: all eligible providers busy -> queue, served when a slot frees within CAPACITY_WAIT_MS', async () => {
  const groq = slowOk(120, 'groq');
  const restore = withEnv(install({ groq }), { GROQ_MAX_INFLIGHT: '1' });
  try {
    const [a, b] = await Promise.all([dispatch({ messages: msg('hi') }), dispatch({ messages: msg('hi') })]);
    assert.equal(a.provider, 'groq');
    assert.equal(b.provider, 'groq');
    assert.equal(groq.calls.length, 2);
    const queued = Math.max(a.routing.queuedMs, b.routing.queuedMs);
    assert.ok(queued >= 80 && queued < 1000, `queuedMs ${queued}`);
    assert.equal(providerStats.inflightCount('groq'), 0, 'slots released');
    assert.ok(providerStats.getRouting().avgQueuedMs > 0);
  } finally {
    restore();
  }
});

test('wait expiry -> downgrade one tier when allowed (balanced), logged as route.downgrade', async () => {
  const groq = slowOk(400, 'groq');
  const nvidia = fake(ok('nvidia'));
  const restore = withEnv(install({ groq, nvidia }), { GROQ_MAX_INFLIGHT: '1', CAPACITY_WAIT_MS: '60' });
  try {
    const first = dispatch({ messages: heavyMsg });
    await wait(10);
    const b = await dispatch({ messages: heavyMsg });
    assert.equal(b.provider, 'nvidia');
    assert.equal(b.routing.tier, 'standard');
    assert.deepEqual({ from: b.routing.downgrade.from, to: b.routing.downgrade.to }, { from: 'heavy', to: 'standard' });
    assert.match(b.routing.downgrade.reason, /no free slot within 60ms/);
    assert.ok(b.routing.queuedMs >= 50);
    assert.equal(b.routing.allowDowngrade, true);
    assert.equal(providerStats.getRouting().downgrades, 1);
    assert.equal((await first).provider, 'groq');
  } finally {
    restore();
  }
});

test('wait expiry with downgrade not allowed (quality policy / header false) -> 503 CAPACITY_EXHAUSTED + retryAfterSec', async () => {
  for (const args of [{ policy: 'quality' }, { policy: 'balanced', allowDowngrade: 'false' }]) {
    const groq = slowOk(300, 'groq');
    const nvidia = fake(ok('nvidia'));
    const restore = withEnv(install({ groq, nvidia }), { GROQ_MAX_INFLIGHT: '1', CAPACITY_WAIT_MS: '50' });
    try {
      const first = dispatch({ messages: heavyMsg, ...args });
      await wait(10);
      const b = await dispatch({ messages: heavyMsg, ...args });
      assert.equal(b.result, null);
      assert.equal(b.error.status, 503);
      assert.equal(b.error.code, 'CAPACITY_EXHAUSTED');
      assert.ok(b.error.retryAfterSec >= 1);
      assert.match(b.error.message, /groq: at capacity/);
      assert.match(b.error.message, /downgrade not allowed/);
      assert.equal(b.routing.downgrade, null);
      assert.equal(b.routing.allowDowngrade, false);
      assert.equal(nvidia.calls.length, 0, 'never silently sent to a weaker model');
      assert.equal(providerStats.getRouting().capacityRejections, 1);
      await first;
    } finally {
      restore();
    }
  }
});

test('queue full (CAPACITY_QUEUE_MAX) does not wait', async () => {
  const groq = slowOk(200, 'groq');
  const restore = withEnv(install({ groq }), { GROQ_MAX_INFLIGHT: '1', CAPACITY_QUEUE_MAX: '0' });
  try {
    const first = dispatch({ messages: msg('hi') });
    await wait(10);
    const t0 = Date.now();
    const b = await dispatch({ messages: msg('hi') });
    assert.ok(Date.now() - t0 < 100);
    assert.equal(b.error.code, 'CAPACITY_EXHAUSTED');
    assert.match(b.error.message, /queue is full/);
    await first;
  } finally {
    restore();
  }
});

test('failover respects the quality floor; downgrade only when allowed', async () => {
  // Both heavy-capable providers fail; nvidia (quality 0.66) is below the heavy floor.
  const mk = () => ({ groq: fake(fail(500, 'groq down')), sambanova: fake(fail(500, 'samba down')), nvidia: fake(ok('nvidia')) });
  let f = mk();
  let restore = install(f);
  try {
    const out = await dispatch({ messages: heavyMsg, policy: 'quality' });
    assert.equal(out.result, null);
    assert.equal(f.nvidia.calls.length, 0);
    assert.deepEqual(out.attempts.map(a => a.provider).sort(), ['groq', 'sambanova']);
    assert.match(out.routing.excluded.nvidia, /quality/);
  } finally {
    restore();
  }
  f = mk();
  restore = install(f);
  try {
    const out = await dispatch({ messages: heavyMsg, policy: 'balanced' });
    assert.equal(out.provider, 'nvidia');
    assert.equal(out.attempts.length, 3);
    assert.deepEqual(out.routing.downgrade, { from: 'heavy', to: 'standard', reason: 'eligible heavy providers failed' });
  } finally {
    restore();
  }
});

test('routing payload carries the new contract fields', async () => {
  const restore = install({ groq: fake(ok()), nvidia: fake(ok()) });
  try {
    const out = await dispatch({ messages: msg('What is the capital of France?') });
    const r = out.routing;
    for (const k of ['estInputTokens', 'estOutputTokens', 'requiredQuality', 'estCost', 'eligible', 'excluded', 'downgrade', 'queuedMs', 'allowDowngrade', 'candidates']) {
      assert.ok(k in r, k);
    }
    assert.equal(r.requiredQuality, 0.4);
    assert.equal(r.eligible, 2);
    assert.ok(r.candidates.length <= 5 && r.candidates.length === 2);
  } finally {
    restore();
  }
});
