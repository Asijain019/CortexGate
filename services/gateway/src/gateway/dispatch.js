// Sends a request down the router's ranked candidate list: quality + cost + token
// aware, load/quota aware, with a short bounded capacity wait, explicit downgrade
// rules and bounded failover.
//
// ============================================================================
// Algorithm (router.js documents the scoring formulas in detail)
//
// 1. Estimate (router.classify): tier + task, estInputTokens = chars/4,
//    estOutputTokens by task, requiredQuality = ROUTER_QUALITY_FLOOR_<TIER>
//    (light 0.40, standard 0.60, heavy 0.80).
//
// 2. Eligible set: per provider its tier model (or next stronger one) with
//    quality >= floor and contextWindow >= estIn + estOut. estCost per request =
//    estIn * pricePrompt + estOut * priceCompletion.
//
// 3. Pre-dispatch filtering (route.excluded = { provider: reason }):
//    disabled (401/403 auth, 402 billing, non-JSON bad_response; persisted across
//    restarts), open breaker, 429 cooldown longer than the wait budget, request larger
//    than the TPM limit -> dropped. In-flight >= <P>_MAX_INFLIGHT (PROVIDER_MAX_INFLIGHT=8,
//    ollama 2), rolling 60s <P>_RPM / <P>_TPM budget used, or a cooldown that ends
//    within CAPACITY_WAIT_MS -> "at capacity" (waitable).
//
// 4. Selection: policy score (cost -> cheapest eligible; quality -> best quality;
//    balanced -> 0.40 quality + 0.25 (1 - normCost) + 0.35 speed, speed from measured
//    p50 latency x reliability) x load factor (1 - ROUTER_LOAD_PENALTY 0.5 x load).
//    Top bucket = within RR_BUCKET_DELTA (0.12) of the best; inside it the least loaded
//    and fastest goes first; round robin only among near-ties (RR_TIE_DELTA 0.1).
//
// 5. Capacity wait: if eligible providers exist but all are at capacity, wait in a
//    per-provider FIFO (CAPACITY_QUEUE_MAX 20 per provider) for up to CAPACITY_WAIT_MS
//    (2500, clipped to the request budget) for a slot / RPM window / short Retry-After.
//    Slots are released in finally{} and wake the next waiter immediately.
//
// 6. Downgrade: if the queue is full, the wait expires, or every eligible provider at
//    this tier failed / was excluded, drop ONE tier (heavy -> standard -> light) only if
//    allowed: allowDowngrade = request (x-allow-downgrade / allow_downgrade), else
//    ROUTER_ALLOW_DOWNGRADE, else true for cost & balanced, false for quality. Logged as
//    route.downgrade = { from, to, reason }. Not allowed -> 503 CAPACITY_EXHAUSTED with
//    retryAfterSec (seconds until the earliest slot / cooldown) when capacity was the
//    cause, or 503 NO_PROVIDERS_AVAILABLE when nothing eligible exists. A complex query
//    is never silently sent to a model below its quality floor.
//
// 7. Failover after an error: next eligible candidate of the required quality first,
//    then (if allowed) the downgrade above. Caps, whichever comes first:
//      MAX_FAILOVER_ATTEMPTS (3)   attempts in total incl. the first and same-provider retries
//                                  (VERIFY_MAX_ATTEMPTS (2) for cache verification; no waits/downgrades)
//      PROVIDER_TIMEOUT_MS (10000) fixed per-attempt timeout (Ollama: OLLAMA_TIMEOUT_MS), passed to
//                                  the adapter as options.signal and enforced here as well
//      REQUEST_BUDGET_MS (25000)   wall clock for the whole request incl. queue time
//    Health feedback: 429 -> cooldown (Retry-After or RATE_LIMIT_COOLDOWN_MS), 401/402/403 ->
//    disabled for AUTH_COOLDOWN_MS, non-JSON -> BAD_RESPONSE_COOLDOWN_MS, other failures feed the
//    breaker (BREAKER_THRESHOLD -> open for BREAKER_COOLDOWN_MS). Active health checks
//    (healthCheck.js) close open breakers early / open them before users hit a dead provider.
//    Same-provider retries: PROVIDER_MAX_RETRIES (0), only for 5xx/network errors.
// ============================================================================
import { providers } from '../providers/index.js';
import * as circuit from './circuitBreaker.js';
import * as stats from './providerStats.js';
import * as capacity from './capacity.js';
import { route, timeoutFor, lowerTier } from './router.js';

const intEnv = (name, def, min = 0) => {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= min ? v : def;
};
export const requestBudgetMs = () => intEnv('REQUEST_BUDGET_MS', 25000, 1);
export const maxFailoverAttempts = () => intEnv('MAX_FAILOVER_ATTEMPTS', 3, 1);
const maxRetries = () => intEnv('PROVIDER_MAX_RETRIES', 0);
export const verifyMaxAttempts = () => intEnv('VERIFY_MAX_ATTEMPTS', 2, 1);
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

const uniq = list => [...new Set(list)];

function describeExcluded(excluded, names) {
  const parts = (names || Object.keys(excluded)).filter(n => excluded[n]).map(n => `${n}: ${excluded[n]}`);
  return parts.length ? parts.join('; ') : '';
}

/**
 * @param {object} p
 *   messages, model?, provider? (alias providerParam), policy?, tier? ('light'|'standard'|'heavy'),
 *   purpose? ('verify' calls are not counted, never wait and never downgrade), signal? (caller abort),
 *   allowDowngrade? (true|false|'true'|'false'; default by policy)
 * @returns {Promise<{result, provider, model, cost, attempts, failedProviders, skipped,
 *   skippedProviders, providerErrors, routing, error, lastError}>}
 */
export async function dispatch({ messages, model, provider, providerParam, policy, tier, purpose, signal, allowDowngrade } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + requestBudgetMs();
  const isVerify = purpose === 'verify';
  const routeArgs = { messages, policy, model, provider: provider || providerParam, purpose, allowDowngrade };
  let plan = route({ ...routeArgs, tier });
  const firstPlan = plan;
  if (!isVerify) stats.recordRoute(plan);

  const attempts = [];
  const failedProviders = [];
  const providerErrors = [];
  const skippedProviders = plan.skipped.map(s => s.provider);
  const tried = new Set();
  let excluded = { ...plan.excluded };
  let lastError = null;
  let budgetExceeded = false;
  let attemptsExhausted = false;
  let downgrade = null;
  let queuedMs = 0;
  let capacityFailure = null;
  let servedCand = null;
  const attemptCap = isVerify ? Math.min(verifyMaxAttempts(), maxFailoverAttempts()) : maxFailoverAttempts();
  const estTokens = () => plan.estInputTokens + plan.estOutputTokens;
  const options = () => uniq([...plan.candidates, ...plan.waitable].map(c => c.provider))
    .filter(n => !tried.has(n) && providers[n]);
  const findCand = name => [...plan.candidates, ...plan.waitable].find(c => c.provider === name);
  const modelMap = () => Object.fromEntries([...plan.waitable, ...plan.candidates].reverse().map(c => [c.provider, c.model]));

  const skippedList = () => {
    // Waitable / excluded-for-health providers never attempted also count as skipped.
    for (const c of [...plan.waitable, ...firstPlan.waitable]) {
      if (!attempts.some(a => a.provider === c.provider)) skippedProviders.push(c.provider);
    }
    return uniq(skippedProviders).filter(n => !attempts.some(a => a.provider === n));
  };

  const buildRouting = () => ({
    tier: plan.tier,
    task: plan.task,
    reason: plan.reason + (downgrade ? `; downgraded ${downgrade.from} -> ${downgrade.to} (${downgrade.reason})` : ''),
    policy: plan.policy,
    estTokens: plan.estTokens,
    score: plan.score,
    override: plan.override,
    estInputTokens: plan.estInputTokens,
    estOutputTokens: plan.estOutputTokens,
    requiredQuality: plan.requiredQuality,
    estCost: servedCand ? servedCand.estCost : plan.estCost,
    eligible: firstPlan.eligible,
    excluded,
    downgrade,
    queuedMs,
    allowDowngrade: firstPlan.allowDowngrade,
    candidates: firstPlan.top
  });

  /** First ready candidate that can take a slot right now. */
  const acquireReady = () => {
    for (const cand of plan.candidates) {
      const name = cand.provider;
      if (tried.has(name) || !providers[name]) continue;
      const slot = capacity.tryAcquire(name, estTokens(), { model: cand.model });
      if (slot) return { cand, slot };
      const block = capacity.capacityBlock(name, estTokens(), Date.now(), cand.model);
      if (block?.reason?.startsWith('at capacity')) {
        stats.recordSaturated(name);
        console.warn(`[Gateway] '${name}' ${block.reason}`);
      }
      if (block) excluded[name] = block.reason;
      skippedProviders.push(name);
    }
    return null;
  };

  while (true) {
    if (signal?.aborted) break;
    if (attempts.length >= attemptCap) {
      if (options().length || (plan.allowDowngrade && !downgrade && lowerTier(plan.tier))) attemptsExhausted = true;
      break;
    }
    if (deadline - Date.now() < MIN_ATTEMPT_MS) { if (attempts.length) budgetExceeded = true; break; }

    let pick = acquireReady();
    if (!pick) {
      const names = options();
      const remaining = deadline - Date.now() - MIN_ATTEMPT_MS;
      if (names.length && !isVerify && remaining > 0) {
        const maxWaitMs = Math.min(capacity.capacityWaitMs(), remaining);
        console.log(`[Gateway] all eligible providers at capacity; queueing up to ${maxWaitMs}ms for ${names.join(', ')}`);
        const r = await capacity.waitForSlot(names, estTokens(), { maxWaitMs, signal, models: modelMap() });
        queuedMs += r.waitedMs;
        if (r.slot) pick = { cand: findCand(r.slot.name), slot: r.slot };
        else capacityFailure = { reason: r.reason, providers: names };
      } else if (names.length) {
        capacityFailure = { reason: isVerify ? 'no_wait' : 'budget', providers: names };
      }
    }

    if (!pick) {
      const lower = lowerTier(plan.tier);
      if (plan.allowDowngrade && !downgrade && lower && deadline - Date.now() >= MIN_ATTEMPT_MS) {
        const why = capacityFailure
          ? (capacityFailure.reason === 'queue_full' ? 'capacity queue full' : `no free slot within ${capacity.capacityWaitMs()}ms`)
          : attempts.length ? `eligible ${plan.tier} providers failed` : `no eligible ${plan.tier} provider`;
        downgrade = { from: plan.tier, to: lower, reason: why };
        if (!isVerify) stats.recordDowngrade();
        console.warn(`[Gateway] downgrading ${plan.tier} -> ${lower}: ${why}`);
        plan = route({ ...routeArgs, tier: lower, exclude: tried });
        excluded = { ...excluded, ...plan.excluded };
        skippedProviders.push(...plan.skipped.map(s => s.provider));
        capacityFailure = null;
        continue;
      }
      break;
    }

    const { cand, slot } = pick;
    const name = cand.provider;
    const adapter = providers[name];
    tried.add(name);
    delete excluded[name];
    let finalErr = null;
    let actualTokens;
    try {
      for (let retry = 0; retry <= maxRetries(); retry++) {
        if (attempts.length >= attemptCap) { attemptsExhausted = true; break; }
        const remaining = deadline - Date.now();
        if (remaining < MIN_ATTEMPT_MS) { budgetExceeded = true; break; }
        const attemptMs = Math.min(timeoutFor(name), remaining);
        const timeoutSignal = AbortSignal.timeout(attemptMs);
        const attemptSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

        circuit.beginAttempt(name);
        const t0 = Date.now();
        console.log(`[Gateway] -> ${name}/${cand.model}${retry ? ` (retry ${retry})` : ''} [${plan.tier}, q>=${plan.requiredQuality}, timeout ${attemptMs}ms]`);
        try {
          const result = await withSignal(
            Promise.resolve().then(() => adapter.sendChatCompletion({ messages, model: cand.model }, { signal: attemptSignal })),
            attemptSignal, name, attemptMs
          );
          const latencyMs = Date.now() - t0;
          circuit.recordSuccess(name);
          stats.recordSuccess(name, latencyMs, result?.model || cand.model);
          actualTokens = Number(result?.usage?.total_tokens) || undefined;
          attempts.push({ provider: name, model: result?.model || cand.model, outcome: 'ok', httpStatus: 200, latencyMs, error: null });
          let cost = 0;
          try { cost = Number(adapter.calculateCost?.(result?.usage, result?.model || cand.model)) || 0; } catch { cost = 0; }
          console.log(`[Gateway] <- served by '${name}' in ${latencyMs}ms`);
          servedCand = cand;
          if (queuedMs && !isVerify) stats.recordQueued(queuedMs);
          return {
            result, provider: name, model: result?.model || cand.model, cost,
            attempts, failedProviders, skipped: skippedList(),
            skippedProviders: skippedList(), providerErrors, routing: buildRouting(),
            error: null, lastError: null
          };
        } catch (rawErr) {
          const latencyMs = Date.now() - t0;
          const err = normalizeError(rawErr, attemptSignal, name, attemptMs);
          const outcome = outcomeOf(err);
          finalErr = err;
          stats.recordFailure(name, outcome, err, latencyMs);
          applyHealth(name, err, outcome);
          attempts.push({
            provider: name, model: cand.model, outcome,
            httpStatus: err.status || null, latencyMs, error: String(err.message || 'error').slice(0, 300)
          });
          console.warn(`[Gateway] x ${name} ${outcome} (${err.status || 'n/a'}) after ${latencyMs}ms: ${String(err.message).slice(0, 160)}`);
          if (signal?.aborted) break;
          if (retry < maxRetries() && isSameProviderRetryable(err) && circuit.canAttempt(name)) continue;
          break;
        }
      }
    } finally {
      capacity.release(slot, actualTokens);
    }
    if (finalErr) {
      lastError = finalErr;
      failedProviders.push(name);
      providerErrors.push({ provider: name, message: finalErr.message || 'Unknown provider error' });
    }
    if (budgetExceeded) break;
  }

  if (queuedMs && !isVerify) stats.recordQueued(queuedMs);
  let error;
  if (budgetExceeded) {
    error = { status: 504, code: 'REQUEST_BUDGET_EXCEEDED', message: `Request budget of ${requestBudgetMs()}ms exhausted after ${attempts.length} attempt(s)` };
  } else if (!attempts.length && capacityFailure) {
    const ms = capacity.earliestReadyMs(capacityFailure.providers, estTokens(), modelMap());
    const retryAfterSec = Math.max(1, Math.ceil((ms ?? 1000) / 1000));
    const why = capacityFailure.reason === 'queue_full' ? 'capacity queue is full' : `no slot freed within ${queuedMs}ms`;
    error = {
      status: 503, code: 'CAPACITY_EXHAUSTED', retryAfterSec,
      message: `All eligible ${plan.tier}-tier providers (quality >= ${plan.requiredQuality}) are at capacity and ${why}` +
        `${firstPlan.allowDowngrade ? '' : '; downgrade not allowed for this request'}. ` +
        `${describeExcluded(excluded, capacityFailure.providers)}. Retry after ${retryAfterSec}s`
    };
    if (!isVerify) stats.recordCapacityRejection();
  } else if (!attempts.length) {
    const blocked = Object.keys(excluded).map(n => circuit.blockedUntil(n)).filter(Boolean);
    const detail = describeExcluded(excluded);
    error = {
      status: 503, code: 'NO_PROVIDERS_AVAILABLE',
      message: firstPlan.eligible || Object.keys(excluded).length
        ? `No eligible provider for the ${plan.tier} tier (quality >= ${plan.requiredQuality})${firstPlan.allowDowngrade ? '' : ', downgrade not allowed'}${detail ? `: ${detail}` : ''}`
        : 'No configured provider is available (check API keys, cooldowns and breakers)'
    };
    if (blocked.length) error.retryAfterSec = Math.max(1, Math.ceil((Math.min(...blocked) - Date.now()) / 1000));
  } else if (attempts.every(a => a.outcome === 'timeout')) {
    error = { status: 504, code: 'PROVIDER_TIMEOUT', message: 'All attempted providers timed out' };
  } else if (attempts.every(a => a.outcome === 'rate_limited')) {
    error = { status: 429, code: 'ALL_PROVIDERS_RATE_LIMITED', message: 'All attempted providers are rate limited' };
  } else if (attemptsExhausted) {
    error = { status: 502, code: 'FAILOVER_LIMIT_REACHED', message: `All ${attempts.length} attempted providers failed (failover limit ${attemptCap} reached)` };
  } else {
    error = { status: 502, code: 'ALL_PROVIDERS_FAILED', message: 'All attempted providers failed' };
  }
  if (attemptsExhausted) error.attemptsExhausted = true;
  const summary = providerErrors.map(p => `${p.provider}: ${p.message}`).join('; ');
  if (summary) error.message += `. ${summary}`;

  return {
    result: null, provider: null, model: null, cost: 0,
    attempts, failedProviders,
    skipped: skippedList(), skippedProviders: skippedList(),
    providerErrors, routing: buildRouting(), error,
    lastError: lastError || Object.assign(new Error(error.message), { status: error.status, code: error.code })
  }
}
