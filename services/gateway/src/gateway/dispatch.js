// Sends a request down the provider chain with failover and circuit breaking.
import { providers, getProviderChain } from '../providers/index.js';
import * as circuit from './circuitBreaker.js';

export function isRetryableError(error) {
  if (!error) return false;
  const status = error.status;
  if (!status) return true;                          // network error, timeout
  if (status === 429) return true;                   // rate limit
  if (status === 401 || status === 403) return true; // bad or missing key: try the next provider
  if (status >= 500 && status < 600) return true;    // provider server error
  return false;
}

export async function dispatch({ messages, model, providerParam }) {
  const chain = getProviderChain(providerParam);
  const forced = providerParam ? providerParam.toLowerCase() : null;

  // Skip providers whose circuit is open, unless that would leave nothing to try.
  const usable = chain.filter(n => n === forced || circuit.canAttempt(n));
  const order = usable.length ? usable : chain;
  const skipped = usable.length ? chain.filter(n => !usable.includes(n)) : [];

  const failedProviders = [];
  let lastError = null;

  for (let i = 0; i < order.length; i++) {
    const name = order[i];
    const adapter = providers[name];
    console.log(`[Gateway] Attempting completion with provider: '${name}'`);
    try {
      const result = await adapter.sendChatCompletion({ messages, model });
      circuit.recordSuccess(name);
      console.log(`[Gateway] Request successfully served by provider: '${name}'`);
      return {
        result,
        provider: name,
        cost: adapter.calculateCost(result.usage, result.model),
        failedProviders,
        skipped,
        lastError: null
      };
    } catch (err) {
      lastError = err;
      failedProviders.push(name);
      const statusStr = err.status ? `(status ${err.status})` : '(network/timeout error)';
      console.warn(`[Gateway] Provider '${name}' failed ${statusStr}: ${err.message}`);
      const retryable = isRetryableError(err);
      if (retryable) circuit.recordFailure(name, err);
      if (retryable && i < order.length - 1) {
        console.log('[Gateway] Failover triggered: retrying with next provider in chain...');
        continue;
      }
      break;
    }
  }
  return { result: null, provider: null, cost: 0, failedProviders, skipped, lastError };
}
