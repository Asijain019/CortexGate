// Sends a request down the provider chain with failover and circuit breaking.
import { providers, getProviderChain } from '../providers/index.js';
import * as circuit from './circuitBreaker.js';

const MAX_PROVIDER_RETRIES = 2;

export function isRetryableError(error) {
  if (!error) return false;
  const status = error.status;
  if (!status) return true;                          // network error, timeout
  if (status === 408) return true;                   // request timeout
  if (status === 429) return true;                   // rate limit
  if (status === 400 || status === 404) return true; // provider-specific request/model rejection
  if (status === 401 || status === 403) return true; // bad or missing key: try the next provider
  if (status >= 500 && status < 600) return true;    // provider server error
  return false;
}

function isTransientProviderError(error) {
  if (!error || error.transient === false) return false;
  if (error.code === 'PROVIDER_TIMEOUT' || error.status === 504) return false;
  const status = error.status;
  return !status || status === 408 || status === 429 || (status >= 500 && status < 600);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function dispatch({ messages, model, providerParam }) {
  const chain = getProviderChain(providerParam);
  const forced = providerParam ? providerParam.toLowerCase() : null;

  // Skip providers whose circuit is open, unless that would leave nothing to try.
  const usable = chain.filter(n => n === forced || circuit.canAttempt(n));
  const order = usable.length ? usable : chain;
  const skipped = usable.length ? chain.filter(n => !usable.includes(n)) : [];

  const failedProviders = [];
  const providerErrors = [];
  let lastError = null;

  for (let i = 0; i < order.length; i++) {
    const name = order[i];
    const adapter = providers[name];
    let providerError = null;

    for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt++) {
      const retryLabel = attempt ? ` (retry ${attempt}/${MAX_PROVIDER_RETRIES})` : '';
      console.log(`[Gateway] Attempting completion with provider: '${name}'${retryLabel}`);
      try {
        // A model name for the primary provider may not exist on the fallback.
        const attemptModel = name === chain[0] ? model : undefined;
        const result = await adapter.sendChatCompletion({ messages, model: attemptModel });
        circuit.recordSuccess(name);
        console.log(`[Gateway] Request successfully served by provider: '${name}'`);
        return {
          result,
          provider: name,
          cost: adapter.calculateCost(result.usage, result.model),
          failedProviders,
          providerErrors,
          skipped,
          lastError: null
        };
      } catch (err) {
        providerError = err;
        if (isTransientProviderError(err) && attempt < MAX_PROVIDER_RETRIES) {
          const backoffMs = Math.min(8000, 1000 * (2 ** attempt));
          const jitterMs = Math.floor(Math.random() * 250);
          const delayMs = Math.max(err.retryAfterMs || 0, backoffMs) + jitterMs;
          console.warn(`[Gateway] Provider '${name}' returned a transient error; retrying in ${delayMs}ms: ${err.message}`);
          await wait(delayMs);
          continue;
        }
        break;
      }
    }

    lastError = providerError;
    failedProviders.push(name);
    providerErrors.push({ provider: name, message: providerError?.message || 'Unknown provider error' });
    const statusStr = providerError?.status ? `(status ${providerError.status})` : '(network/timeout error)';
    console.warn(`[Gateway] Provider '${name}' failed ${statusStr}: ${providerError?.message || 'Unknown provider error'}`);

    const retryable = isRetryableError(providerError);
    if (retryable) circuit.recordFailure(name, providerError);
    if (retryable && i < order.length - 1) {
      console.log('[Gateway] Failover triggered: retrying with next provider in chain...');
      continue;
    }
    break;
  }
  return { result: null, provider: null, cost: 0, failedProviders, providerErrors, skipped, lastError };
}
