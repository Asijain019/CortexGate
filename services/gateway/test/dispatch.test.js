import assert from 'node:assert/strict';
import test from 'node:test';
import { providers } from '../src/providers/index.js';
import * as circuit from '../src/gateway/circuitBreaker.js';
import { dispatch } from '../src/gateway/dispatch.js';

test('failover switches providers and uses the fallback provider model', async () => {
  const previousOrder = process.env.PROVIDER_ORDER;
  const previousGroq = providers.groq;
  const previousGemini = providers.gemini;
  const calls = [];

  try {
    process.env.PROVIDER_ORDER = 'groq,gemini';
    circuit.resetAll();
    providers.groq = {
      async sendChatCompletion({ model }) {
        calls.push({ provider: 'groq', model });
        throw Object.assign(new Error('Model not found'), { status: 404 });
      },
      calculateCost: () => 0
    };
    providers.gemini = {
      async sendChatCompletion({ model }) {
        calls.push({ provider: 'gemini', model });
        return { content: 'fallback response', usage: {}, model: 'gemini-default' };
      },
      calculateCost: () => 0
    };

    const result = await dispatch({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'groq-only-model'
    });

    assert.equal(result.provider, 'gemini');
    assert.deepEqual(result.failedProviders, ['groq']);
    assert.deepEqual(calls, [
      { provider: 'groq', model: 'groq-only-model' },
      { provider: 'gemini', model: undefined }
    ]);
  } finally {
    providers.groq = previousGroq;
    providers.gemini = previousGemini;
    if (previousOrder === undefined) delete process.env.PROVIDER_ORDER;
    else process.env.PROVIDER_ORDER = previousOrder;
    circuit.resetAll();
  }
});

test('a provider timeout skips same-provider retries and fails over immediately', async () => {
  const previousOrder = process.env.PROVIDER_ORDER;
  const previousGroq = providers.groq;
  const previousGemini = providers.gemini;
  const calls = [];

  try {
    process.env.PROVIDER_ORDER = 'groq,gemini';
    circuit.resetAll();
    providers.groq = {
      async sendChatCompletion() {
        calls.push('groq');
        throw Object.assign(new Error('Request timed out'), {
          status: 504
        });
      },
      calculateCost: () => 0
    };
    providers.gemini = {
      async sendChatCompletion() {
        calls.push('gemini');
        return { content: 'fallback response', usage: {}, model: 'gemini-default' };
      },
      calculateCost: () => 0
    };

    const result = await dispatch({ messages: [{ role: 'user', content: 'hello' }] });

    assert.equal(result.provider, 'gemini');
    assert.deepEqual(calls, ['groq', 'gemini']);
  } finally {
    providers.groq = previousGroq;
    providers.gemini = previousGemini;
    if (previousOrder === undefined) delete process.env.PROVIDER_ORDER;
    else process.env.PROVIDER_ORDER = previousOrder;
    circuit.resetAll();
  }
});

test('a skipped primary provider does not pass its model to Gemini', async () => {
  const previousOrder = process.env.PROVIDER_ORDER;
  const previousThreshold = process.env.BREAKER_THRESHOLD;
  const previousGroq = providers.groq;
  const previousGemini = providers.gemini;
  const calls = [];

  try {
    process.env.PROVIDER_ORDER = 'groq,gemini';
    process.env.BREAKER_THRESHOLD = '1';
    circuit.resetAll();
    circuit.recordFailure('groq', new Error('Groq unavailable'));
    providers.gemini = {
      async sendChatCompletion({ model }) {
        calls.push(model);
        return { content: 'fallback response', usage: {}, model: 'gemini-default' };
      },
      calculateCost: () => 0
    };

    const result = await dispatch({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'groq-only-model'
    });

    assert.equal(result.provider, 'gemini');
    assert.deepEqual(result.skipped, ['groq']);
    assert.deepEqual(calls, [undefined]);
  } finally {
    providers.groq = previousGroq;
    providers.gemini = previousGemini;
    if (previousOrder === undefined) delete process.env.PROVIDER_ORDER;
    else process.env.PROVIDER_ORDER = previousOrder;
    if (previousThreshold === undefined) delete process.env.BREAKER_THRESHOLD;
    else process.env.BREAKER_THRESHOLD = previousThreshold;
    circuit.resetAll();
  }
});
