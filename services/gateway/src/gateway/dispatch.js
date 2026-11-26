// Sends a request down the router's ranked candidate list with fast failover.
//
// - Each attempt gets a fixed timeout (PROVIDER_TIMEOUT_MS, default 10000; Ollama
//   uses OLLAMA_TIMEOUT_MS) passed to the adapter as options.signal and also
//   enforced here, so a hung adapter can never stall the request.
// - The whole request is capped by REQUEST_BUDGET_MS (default 30000).
// - Any failure (timeout, 429, 5xx, network, 401/402/403, 400-404...) moves straight
//   to the next candidate. Same-provider retries: PROVIDER_MAX_RETRIES (default 0),
//   only for 5xx/network errors.
// - 429 -> provider cooldown (Retry-After or RATE_LIMIT_COOLDOWN_MS),
//   401/402/403 -> disabled for AUTH_COOLDOWN_MS, other failures feed the breaker.
// - Providers at PROVIDER_MAX_INFLIGHT (default 8) concurrent requests are skipped.
import { providers } from '../providers/index.js';
import * as circuit from './circuitBreaker.js';
import * as stats from './providerStats.js';
import { route, timeoutFor, maxInflight } from './router.js';

const intEnv = (name, def, min = 0) => {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= min ? v : def;
};
export const requestBudgetMs = () => intEnv('REQUEST_BUDGET_MS', 30000, 1);
const maxRetries = () => intEnv('PROVIDER_MAX_RETRIES', 0);
const verifyMaxAttempts = () => intEnv('VERIFY_MAX_ATTEMPTS', 2, 1);
const MIN_ATTEMPT_MS = 250;

/** Kept for compatibility: every provider error is worth failing over on. */
export function isRetryableError(error) {
  return Boolean(error);
}

export function outcomeOf(err) {
  if (err?.code === 'PROVIDER_TIMEOUT' || err?.status === 504 || err?.status === 408) return 'timeout';
  if (err?.status === 429) return 'rate_limited';
  return 'error';
}

function isSameProviderRetryable(err) {
  if (!err || err.transient === false) return false;
  const s = err.status;
  return err.code === 'NETWORK_ERROR' || (s >= 500 && s < 600 && s !== 504);
}

function timeoutError(name, ms) {
  return Object.assign(new Error(`${name} timed out after ${ms}ms`), { status: 504, code: 'PROVIDER_TIMEOUT' });
}

/** Resolve with the adapter promise, or reject as soon as the signal aborts. */
function withSignal(promise, signal, name, ms) {
  if (signal.aborted) return Promise.reject(timeoutError(name, ms));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(timeoutError(name, ms));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); }
    );
  });
}

function normalizeError(err, signal, name, ms) {
  const e = err instanceof Error ? err : new Error(String(err));
  if (signal.aborted || e.name === 'AbortError' || e.name === 'TimeoutError') {
    if (e.code !== 'PROVIDER_TIMEOUT') return timeoutError(name, ms);
  }
  return e;
}

function applyHealth(name, err, outcome) {
  if (err?.code === 'NOT_CONFIGURED') { circuit.releaseProbe(name); return; }
  if (outcome === 'rate_limited') circuit.recordRateLimit(name, err.retryAfterMs, err);
  else if ([401, 402, 403].includes(err?.status)) circuit.recordAuthFailure(name, err);
  else if (err?.code === 'BAD_RESPONSE') circuit.recordBadResponse(name, err);
  else circuit.recordFailure(name, err);
}

/**
 * @param {object} p
 *   messages, model?, provider? (alias providerParam), policy?, tier? ('light'|'standard'|'heavy'),
 *   purpose? ('verify' calls are not counted in routing stats), signal? (caller abort)
 * @returns {Promise<{result, provider, model, cost, attempts, failedProviders, skipped,
 *   skippedProviders, providerErrors, routing, error, lastError}>}
 */
export async function dispatch({ messages, model, provider, providerParam, policy, tier, purpose, signal } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + requestBudgetMs();
  const plan = route({ messages, policy, model, provider: provider || providerParam, tier, purpose });
  const routing = {
    tier: plan.tier, task: plan.task, reason: plan.reason, policy: plan.policy,
    estTokens: plan.estTokens, score: plan.score, override: plan.override
  };
  if (purpose !== 'verify') stats.recordRoute(plan);

  const attempts = [];
  const failedProviders = [];
  const providerErrors = [];
  const skippedProviders = plan.skipped.map(s => s.provider);
  let lastError = null;
  let budgetExceeded = false;
  const attemptCap = purpose === 'verify' ? verifyMaxAttempts() : Infinity;
  const skippedList = () => {
    // Degraded candidates never reached also count as skipped.
    for (const c of plan.candidates) {
      if (c.state !== 'healthy' && !attempts.some(a => a.provider === c.provider)) skippedProviders.push(c.provider);
    }
    return [...new Set(skippedProviders)];
  };

  for (const cand of plan.candidates) {
    const name = cand.provider;
    const adapter = providers[name];
    if (!adapter) continue;
    if (signal?.aborted) break;
    if (attempts.length >= attemptCap) break;

    // Re-check health: another request may have tripped this provider meanwhile.
    const state = circuit.getState(name);
    const isLead = Boolean(cand.override);
    if ((state === 'cooldown' || state === 'disabled') ||
        (state === 'probing' && !circuit.canAttempt(name)) ||
        (state === 'open' && !isLead && cand.state !== 'open')) {
      skippedProviders.push(name);
      continue;
    }
    if (stats.inflightCount(name) >= maxInflight()) {
      stats.recordSaturated(name);
      skippedProviders.push(name);
      console.warn(`[Gateway] Skipping '${name}': ${stats.inflightCount(name)} requests in flight (max ${maxInflight()})`);
      continue;
    }

    let finalErr = null;
    for (let retry = 0; retry <= maxRetries(); retry++) {
      const remaining = deadline - Date.now();
      if (remaining < MIN_ATTEMPT_MS) { budgetExceeded = true; break; }
      const attemptMs = Math.min(timeoutFor(name), remaining);
      const timeoutSignal = AbortSignal.timeout(attemptMs);
      const attemptSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

      circuit.beginAttempt(name);
      stats.begin(name);
      const t0 = Date.now();
      console.log(`[Gateway] -> ${name}/${cand.model}${retry ? ` (retry ${retry})` : ''} [${plan.tier}, timeout ${attemptMs}ms]`);
      try {
        const result = await withSignal(
          Promise.resolve().then(() => adapter.sendChatCompletion({ messages, model: cand.model }, { signal: attemptSignal })),
          attemptSignal, name, attemptMs
        );
        const latencyMs = Date.now() - t0;
        circuit.recordSuccess(name);
        stats.recordSuccess(name, latencyMs, result?.model || cand.model);
        attempts.push({ provider: name, model: result?.model || cand.model, outcome: 'ok', httpStatus: 200, latencyMs, error: null });
        let cost = 0;
        try { cost = Number(adapter.calculateCost?.(result?.usage, result?.model || cand.model)) || 0; } catch { cost = 0; }
        console.log(`[Gateway] <- served by '${name}' in ${latencyMs}ms`);
        return {
          result, provider: name, model: result?.model || cand.model, cost,
          attempts, failedProviders, skipped: skippedList(),
          skippedProviders: skippedList(), providerErrors, routing,
          error: null, lastError: null
        };
      } catch (rawErr) {
        const latencyMs = Date.now() - t0;
        const err = normalizeError(rawErr, attemptSignal, name, attemptMs);
        const outcome = outcomeOf(err);
        finalErr = err;
        stats.recordFailure(name, outcome, err);
        applyHealth(name, err, outcome);
        attempts.push({
          provider: name, model: cand.model, outcome,
          httpStatus: err.status || null, latencyMs, error: String(err.message || 'error').slice(0, 300)
        });
        console.warn(`[Gateway] x ${name} ${outcome} (${err.status || 'n/a'}) after ${latencyMs}ms: ${String(err.message).slice(0, 160)}`);
        if (signal?.aborted) break;
        if (retry < maxRetries() && isSameProviderRetryable(err) && circuit.canAttempt(name)) continue;
        break;
      } finally {
        stats.end(name);
      }
    }
    if (budgetExceeded) break;
    if (finalErr) {
      lastError = finalErr;
      failedProviders.push(name);
      providerErrors.push({ provider: name, message: finalErr.message || 'Unknown provider error' });
    }
  }


  let error;
  if (budgetExceeded) {
    error = { status: 504, code: 'REQUEST_BUDGET_EXCEEDED', message: `Request budget of ${requestBudgetMs()}ms exhausted after ${attempts.length} attempt(s)` };
  } else if (!attempts.length) {
    error = { status: 503, code: 'NO_PROVIDERS_AVAILABLE', message: plan.candidates.length ? 'All candidate providers are saturated or cooling down' : 'No configured provider is available (check API keys, cooldowns and breakers)' };
  } else if (attempts.every(a => a.outcome === 'timeout')) {
    error = { status: 504, code: 'PROVIDER_TIMEOUT', message: 'All attempted providers timed out' };
  } else if (attempts.every(a => a.outcome === 'rate_limited')) {
    error = { status: 429, code: 'ALL_PROVIDERS_RATE_LIMITED', message: 'All attempted providers are rate limited' };
  } else {
    error = { status: 502, code: 'ALL_PROVIDERS_FAILED', message: 'All attempted providers failed' };
  }
  const summary = providerErrors.map(p => `${p.provider}: ${p.message}`).join('; ');
  if (summary) error.message += `. ${summary}`;

  return {
    result: null, provider: null, model: null, cost: 0,
    attempts, failedProviders,
    skipped: skippedList(), skippedProviders: skippedList(),
    providerErrors, routing, error,
    lastError: lastError || Object.assign(new Error(error.message), { status: error.status, code: error.code })
  };
}
