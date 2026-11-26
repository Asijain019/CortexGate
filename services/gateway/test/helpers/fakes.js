// Shared fakes for gateway tests (no network). This file has no tests itself.
import { providers } from '../../src/providers/index.js';
import * as circuit from '../../src/gateway/circuitBreaker.js';
import * as providerStats from '../../src/gateway/providerStats.js';
import { resetRoundRobin } from '../../src/gateway/router.js';

const ENV_KEYS = [
  'PROVIDER_ORDER', 'ROUTING_POLICY', 'PROVIDER_TIMEOUT_MS', 'REQUEST_BUDGET_MS', 'PROVIDER_MAX_RETRIES',
  'PROVIDER_MAX_INFLIGHT', 'RATE_LIMIT_COOLDOWN_MS', 'AUTH_COOLDOWN_MS', 'BREAKER_THRESHOLD',
  'BREAKER_COOLDOWN_MS', 'RR_BUCKET_DELTA', 'GROQ_RR_WEIGHT'
];

/** A fake adapter. `impl(req, options, n)` decides each call; calls are recorded. */
export function fake(impl = () => ({ content: 'ok' }), extra = {}) {
  const calls = [];
  return {
    calls,
    async sendChatCompletion(req, options = {}) {
      calls.push({ model: req.model, signal: options.signal });
      const r = await impl(req, options, calls.length);
      return { usage: { total_tokens: 3 }, model: req.model, ...r };
    },
    calculateCost: () => 0,
    isConfigured: () => true,
    ...extra
  };
}

export const ok = (content = 'ok') => () => ({ content });
export const fail = (status, message = `status ${status}`, extra = {}) => () => {
  throw Object.assign(new Error(message), { status, ...extra });
};
/** Never resolves on its own; rejects when the signal aborts (like a real fetch). */
export const hang = () => (req, options) => new Promise((_, reject) => {
  options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
});

/**
 * Replace every provider with an unconfigured stub, then install `fakes`.
 * Returns a restore() function.
 */
export function install(fakes, env = {}) {
  const savedProviders = { ...providers };
  const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of Object.keys(providers)) {
    if (k === 'openai') continue;
    providers[k] = {
      isConfigured: () => false,
      calculateCost: () => 0,
      sendChatCompletion: async () => { throw new Error(`unconfigured provider ${k} was called`); }
    };
  }
  Object.assign(providers, fakes);
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { PROVIDER_ORDER: Object.keys(fakes).join(','), ...env });
  circuit.resetAll();
  providerStats.clear();
  resetRoundRobin();
  return function restore() {
    for (const k of Object.keys(providers)) delete providers[k];
    Object.assign(providers, savedProviders);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    circuit.resetAll();
    providerStats.clear();
    resetRoundRobin();
  };
}

export const msg = content => [{ role: 'user', content }];
