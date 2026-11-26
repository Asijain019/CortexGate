// Load + quota awareness: per-provider concurrency slots, rolling 60s RPM / TPM
// budgets, and a short bounded FIFO wait for a free slot.
//
// Limits per provider (0 = unlimited):
//   <P>_RPM / <P>_TPM            requests / tokens per rolling 60s, counted per model (groq,
//                                gemini, cerebras enforce them per model; defaults from free tiers)
//   <P>_MAX_INFLIGHT             concurrent requests (default PROVIDER_MAX_INFLIGHT=8; ollama/lmstudio 2)
// Custom providers may carry rpm / tpm / maxInflight in their catalog entry.
//
// Wait queue: when every eligible provider is at capacity, dispatch() calls
// waitForSlot(names, ...). Each waiter is queued FIFO on every provider it can use
// (at most CAPACITY_QUEUE_MAX=20 waiters per provider); it is woken when a slot is
// released or when a time-based block (RPM/TPM window, short 429 cooldown) expires,
// and gives up after maxWaitMs (CAPACITY_WAIT_MS=2500, clipped to the request budget).
import * as stats from './providerStats.js';
import * as circuit from './circuitBreaker.js';
import { maxInflight as globalMaxInflight, customCatalog } from './router.js';

const intEnv = (name, def, min = 0) => {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= min ? v : def;
};
export const capacityWaitMs = () => intEnv('CAPACITY_WAIT_MS', 2500);
export const capacityQueueMax = () => intEnv('CAPACITY_QUEUE_MAX', 20);
const WINDOW_MS = 60000;

// Conservative free-tier defaults (requests / tokens per minute; 0 = no local cap).
export const DEFAULT_LIMITS = {
  groq: { rpm: 30, tpm: 8000 },
  gemini: { rpm: 10, tpm: 250000 },
  cerebras: { rpm: 30, tpm: 60000 },
  openrouter: { rpm: 20, tpm: 0 },
  nvidia: { rpm: 40, tpm: 0 },
  sambanova: { rpm: 20, tpm: 0 },
  mistral: { rpm: 60, tpm: 500000 },
  huggingface: { rpm: 30, tpm: 0 },
  github: { rpm: 15, tpm: 0 },
  cloudflare: { rpm: 300, tpm: 0 },
  cohere: { rpm: 20, tpm: 0 },
  together: { rpm: 60, tpm: 0 },
  ollama: { rpm: 0, tpm: 0, maxInflight: 2 },
  lmstudio: { rpm: 0, tpm: 0, maxInflight: 2 }
};

/** { rpm, tpm, maxInflight } for a provider (env read live). */
export function limitsFor(name) {
  const P = name.toUpperCase();
  const d = DEFAULT_LIMITS[name] || customCatalog()[name] || {};
  const num = (v, def) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : def);
  return {
    rpm: intEnv(`${P}_RPM`, num(d.rpm, 0)),
    tpm: intEnv(`${P}_TPM`, num(d.tpm, 0)),
    maxInflight: intEnv(`${P}_MAX_INFLIGHT`, num(d.maxInflight, globalMaxInflight()), 1)
  };
}

// ---------------------------------------------------------------- waiters

const waiters = []; // FIFO: { names: string[], est, resolve, timers }

export function queueDepth(name) {
  let n = 0;
  for (const w of waiters) if (w.names.includes(name)) n++;
  return n;
}

/** Live usage for the providers payload and for load-aware ranking. */
export function usage(name, now = Date.now(), model) {
  const lim = limitsFor(name);
  const r = stats.rateUsage(name, now, model);
  const inflight = stats.inflightCount(name);
  const ratios = [inflight / lim.maxInflight];
  if (lim.rpm) ratios.push(r.rpm / lim.rpm);
  if (lim.tpm) ratios.push(r.tpm / lim.tpm);
  return {
    inflight, maxInflight: lim.maxInflight,
    rpm: r.rpm, rpmLimit: lim.rpm || null,
    tpm: r.tpm, tpmLimit: lim.tpm || null,
    queueDepth: queueDepth(name),
    load: Math.min(1, Math.max(...ratios))
  };
}

/**
 * Why the provider cannot take a request of ~estTokens right now, or null.
 * { reason, readyInMs, hard }: readyInMs = ms until a time-based block clears
 * (null = wait for a slot release); hard = can never fit (do not wait).
 */
export function capacityBlock(name, estTokens = 0, now = Date.now(), model) {
  const lim = limitsFor(name);
  if (lim.tpm && estTokens > lim.tpm) {
    return { reason: `request ~${estTokens} tokens exceeds TPM limit ${lim.tpm}`, readyInMs: null, hard: true };
  }
  const inflight = stats.inflightCount(name);
  if (inflight >= lim.maxInflight) {
    return { reason: `at capacity: ${inflight}/${lim.maxInflight} in flight`, readyInMs: null, hard: false };
  }
  const r = stats.rateUsage(name, now, model);
  if (lim.rpm && r.rpm >= lim.rpm) {
    const readyInMs = Math.max(1, r.entries[r.rpm - lim.rpm].t + WINDOW_MS - now);
    return { reason: `rate budget: ${r.rpm}/${lim.rpm} requests in the last 60s`, readyInMs, hard: false };
  }
  if (lim.tpm && r.tpm + estTokens > lim.tpm) {
    let freed = 0;
    let readyInMs = WINDOW_MS;
    for (const e of r.entries) {
      freed += e.tokens;
      if (r.tpm - freed + estTokens <= lim.tpm) { readyInMs = Math.max(1, e.t + WINDOW_MS - now); break; }
    }
    return { reason: `token budget: ${r.tpm}+${estTokens}/${lim.tpm} tokens in the last 60s`, readyInMs, hard: false };
  }
  return null;
}

function healthAllows(name) {
  return circuit.canAttempt(name);
}

/**
 * Take a slot now if the provider has capacity and is healthy. Returns a slot
 * (pass it to release()) or null. `respectQueue` refuses when others are queued
 * on this provider, so waiters keep FIFO order.
 */
export function tryAcquire(name, estTokens = 0, { respectQueue = true, model } = {}) {
  if (respectQueue && queueDepth(name) > 0) return null;
  if (!healthAllows(name) || capacityBlock(name, estTokens, Date.now(), model)) return null;
  stats.begin(name);
  const entry = stats.recordStart(name, estTokens, Date.now(), model);
  return { name, entry, released: false };
}

/** Free the slot (always call in finally) and wake the next waiter. */
export function release(slot, actualTokens) {
  if (!slot || slot.released) return;
  slot.released = true;
  stats.end(slot.name);
  if (Number.isFinite(actualTokens)) stats.adjustTokens(slot.entry, actualTokens);
  wake();
}

function cleanup(w) {
  for (const t of w.timers) clearTimeout(t);
  w.timers = [];
  const i = waiters.indexOf(w);
  if (i >= 0) waiters.splice(i, 1);
}

/** Give queued requests, oldest first, any slot that is free now. */
export function wake() {
  for (const w of [...waiters]) {
    for (const name of w.names) {
      const slot = tryAcquire(name, w.est, { respectQueue: false, model: w.models[name] });
      if (slot) {
        cleanup(w);
        w.resolve({ slot, waitedMs: Date.now() - w.startedAt, reason: null });
        break;
      }
    }
  }
}

function scheduleRetry(w) {
  // Re-check when the earliest time-based block (RPM/TPM window, cooldown) clears.
  let soonest = Infinity;
  for (const n of w.names) {
    const b = capacityBlock(n, w.est, Date.now(), w.models[n]);
    if (b?.readyInMs) soonest = Math.min(soonest, b.readyInMs);
    const until = circuit.blockedUntil(n);
    if (until) soonest = Math.min(soonest, until - Date.now());
  }
  if (!Number.isFinite(soonest)) return;
  const t = setTimeout(() => {
    if (!waiters.includes(w)) return;
    wake();
    if (waiters.includes(w)) scheduleRetry(w);
  }, Math.max(5, soonest + 5));
  t.unref?.();
  w.timers.push(t);
}

/**
 * Wait up to maxWaitMs for a slot on any of `names` (in preference order).
 * Resolves { slot, waitedMs, reason } where reason is null on success,
 * 'queue_full' (every queue at CAPACITY_QUEUE_MAX) or 'timeout'.
 */
export function waitForSlot(names, estTokens = 0, { maxWaitMs = capacityWaitMs(), signal, models = {} } = {}) {
  const startedAt = Date.now();
  for (const n of names) {
    const slot = tryAcquire(n, estTokens, { model: models[n] });
    if (slot) return Promise.resolve({ slot, waitedMs: 0, reason: null });
  }
  const usable = names.filter(n => queueDepth(n) < capacityQueueMax());
  if (!usable.length) return Promise.resolve({ slot: null, waitedMs: 0, reason: 'queue_full' });
  if (maxWaitMs <= 0) return Promise.resolve({ slot: null, waitedMs: 0, reason: 'timeout' });
  return new Promise(resolve => {
    const w = { names: usable, est: estTokens, models, resolve, timers: [], startedAt };
    waiters.push(w);
    const done = reason => { cleanup(w); resolve({ slot: null, waitedMs: Date.now() - startedAt, reason }); };
    const t = setTimeout(() => done('timeout'), maxWaitMs);
    t.unref?.();
    w.timers.push(t);
    if (signal) signal.addEventListener('abort', () => { if (waiters.includes(w)) done('aborted'); }, { once: true });
    scheduleRetry(w);
  });
}

/** Earliest ms until any of `names` could take a request (for Retry-After), or null. */
export function earliestReadyMs(names, estTokens = 0, models = {}) {
  let soonest = Infinity;
  const now = Date.now();
  for (const n of names) {
    const until = circuit.blockedUntil(n, now);
    const b = capacityBlock(n, estTokens, now, models[n]);
    const t = Math.max(until ? until - now : 0, b?.hard ? Infinity : b ? (b.readyInMs ?? 1000) : 0);
    soonest = Math.min(soonest, t);
  }
  return Number.isFinite(soonest) ? soonest : null;
}

/** Test helper: drop all waiters. */
export function _resetWaiters() {
  for (const w of [...waiters]) { cleanup(w); w.resolve({ slot: null, waitedMs: 0, reason: 'reset' }); }
}
