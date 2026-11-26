import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatch } from '../src/gateway/dispatch.js';
import * as circuit from '../src/gateway/circuitBreaker.js';
import * as providerStats from '../src/gateway/providerStats.js';
import { catalogModels } from '../src/gateway/router.js';
import { install, fake, ok, fail, msg } from './helpers/fakes.js';

test('failover switches providers and the fallback uses its own model', async () => {
  const groq = fake(fail(404, 'Model not found'));
  const gemini = fake(ok('fallback response'));
  const restore = install({ groq, gemini });
  try {
    const out = await dispatch({ messages: msg('hello'), model: 'groq/groq-only-model' });
    assert.equal(out.provider, 'gemini');
    assert.equal(out.result.content, 'fallback response');
    assert.deepEqual(out.failedProviders, ['groq']);
    assert.equal(groq.calls[0].model, 'groq-only-model');
    assert.notEqual(gemini.calls[0].model, 'groq-only-model');
    assert.equal(gemini.calls[0].model, catalogModels('gemini')[out.routing.tier]);
    assert.deepEqual(out.attempts.map(a => [a.provider, a.outcome, a.httpStatus]), [
      ['groq', 'error', 404],
      ['gemini', 'ok', 200]
    ]);
    assert.equal(out.routing.override, 'model');
  } finally {
    restore();
  }
});

test('a provider timeout error skips same-provider retries and fails over immediately', async () => {
  const groq = fake(fail(504, 'Request timed out'));
  const gemini = fake(ok());
  const restore = install({ groq, gemini }, { PROVIDER_MAX_RETRIES: '2' });
  try {
    const out = await dispatch({ messages: msg('hello'), provider: 'groq' });
    assert.equal(out.provider, 'gemini');
    assert.equal(groq.calls.length, 1);
    assert.equal(out.attempts[0].outcome, 'timeout');
  } finally {
    restore();
  }
});

test('a provider with an open breaker is tried last and reported as skipped', async () => {
  const groq = fake(ok('groq'));
  const gemini = fake(ok('gemini'));
  const restore = install({ groq, gemini }, { BREAKER_THRESHOLD: '1' });
  try {
    circuit.recordFailure('groq', new Error('Groq unavailable'));
    assert.equal(circuit.getState('groq'), 'open');
    const out = await dispatch({ messages: msg('hello') });
    assert.equal(out.provider, 'gemini');
    assert.equal(groq.calls.length, 0);
    assert.ok(out.skippedProviders.includes('groq'));
    assert.deepEqual(out.skipped, out.skippedProviders);
  } finally {
    restore();
  }
});

test('verifier call signature: dispatch({ messages, tier, purpose }) uses the light tier and is not counted', async () => {
  const groq = fake(ok('YES'));
  const restore = install({ groq });
  try {
    const before = providerStats.getRouting();
    const long = 'Analyze and prove step by step, then compare the trade-offs. '.repeat(20);
    const out = await dispatch({ messages: msg(long), tier: 'light', purpose: 'verify' });
    assert.equal(out.result.content, 'YES');
    assert.equal(out.routing.tier, 'light');
    assert.equal(groq.calls[0].model, catalogModels('groq').light);
    assert.deepEqual(providerStats.getRouting(), before);

    // Plain legacy call still works.
    const legacy = await dispatch({ messages: msg('hi') });
    assert.equal(legacy.provider, 'groq');
  } finally {
    restore();
  }
});

test('no configured providers -> 503 NO_PROVIDERS_AVAILABLE', async () => {
  const restore = install({});
  try {
    const out = await dispatch({ messages: msg('hello') });
    assert.equal(out.result, null);
    assert.equal(out.error.status, 503);
    assert.equal(out.error.code, 'NO_PROVIDERS_AVAILABLE');
    assert.deepEqual(out.attempts, []);
  } finally {
    restore();
  }
});
