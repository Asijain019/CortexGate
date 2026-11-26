// Per-provider health state machine.
//
//   healthy  --BREAKER_THRESHOLD consecutive failures-->  open (skipped for BREAKER_COOLDOWN_MS)
//   open     --cooldown elapsed-->                        probing (one request at a time allowed)
//   probing  --success--> healthy      --failure--> open again
//
// Independent of the breaker:
//   cooldown: after a 429, honour Retry-After or RATE_LIMIT_COOLDOWN_MS (default 30000)
//   disabled: after 401/402/403, skip for AUTH_COOLDOWN_MS (default 600000)
//
// State precedence for reporting: disabled > cooldown > open > probing > healthy.
const states = new Map();

const intEnv = (name, def) => {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
};
export const threshold = () => Math.max(1, intEnv('BREAKER_THRESHOLD', 3));
export const cooldownMs = () => intEnv('BREAKER_COOLDOWN_MS', 20000);
export const rateLimitCooldownMs = () => intEnv('RATE_LIMIT_COOLDOWN_MS', 30000);
export const authCooldownMs = () => intEnv('AUTH_COOLDOWN_MS', 600000);
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

function get(name) {
  if (!states.has(name)) {
    states.set(name, {
      failures: 0, openUntil: 0, cooldownUntil: 0, disabledUntil: 0,
      probeInFlight: false, lastError: null, reason: null
    });
  }
  return states.get(name);
}

export function getState(name, now = Date.now()) {
  const s = get(name);
  if (s.disabledUntil > now) return 'disabled';
  if (s.cooldownUntil > now) return 'cooldown';
  if (s.openUntil > now) return 'open';
  if (s.failures >= threshold()) return 'probing';
  return 'healthy';
}

/** When the provider becomes usable again (ms epoch) or 0. */
export function blockedUntil(name, now = Date.now()) {
  const s = get(name);
  const until = Math.max(s.disabledUntil, s.cooldownUntil, s.openUntil);
  return until > now ? until : 0;
}

/** True when a request may be sent now (healthy, or probing with no probe in flight). */
export function canAttempt(name) {
  const state = getState(name);
  if (state === 'healthy') return true;
  if (state === 'probing') return !get(name).probeInFlight;
  return false;
}

/** Call right before sending; returns true if this request is the half-open probe. */
export function beginAttempt(name) {
  if (getState(name) === 'probing') {
    get(name).probeInFlight = true;
    return true;
  }
  return false;
}

export function recordSuccess(name) {
  const s = get(name);
  s.failures = 0;
  s.openUntil = 0;
  s.probeInFlight = false;
  s.lastError = null;
  s.reason = null;
}

/** Counts toward the breaker (timeouts, 5xx, network, 400/404...). */
export function recordFailure(name, err) {
  const s = get(name);
  const wasProbe = s.probeInFlight;
  s.probeInFlight = false;
  s.failures++;
  s.lastError = (err?.message || 'error').slice(0, 160);
  if (wasProbe || s.failures >= threshold()) {
    s.openUntil = Date.now() + cooldownMs();
    s.reason = 'breaker';
    console.warn(`[Breaker] '${name}' open for ${cooldownMs() / 1000}s after ${s.failures} consecutive failures`);
  }
}

/** 429: skip the provider until Retry-After (or RATE_LIMIT_COOLDOWN_MS). */
export function recordRateLimit(name, retryAfterMs, err) {
  const s = get(name);
  s.probeInFlight = false;
  const ms = Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)
    : rateLimitCooldownMs();
  s.cooldownUntil = Date.now() + ms;
  s.lastError = (err?.message || 'rate limited').slice(0, 160);
  s.reason = 'rate_limited';
  console.warn(`[Breaker] '${name}' rate limited; cooling down for ${Math.round(ms / 1000)}s`);
  return ms;
}

/** 401/402/403: the key/billing is broken; disable for AUTH_COOLDOWN_MS. */
export function recordAuthFailure(name, err) {
  const s = get(name);
  s.probeInFlight = false;
  s.disabledUntil = Date.now() + authCooldownMs();
  s.lastError = (err?.message || 'auth failure').slice(0, 160);
  s.reason = 'auth';
  console.warn(`[Breaker] '${name}' disabled for ${authCooldownMs() / 1000}s (status ${err?.status})`);
}

/** 200 with a non-JSON / malformed body (e.g. GitHub Models answering plain "OK"):
 *  the service is broken, not busy; disable for BAD_RESPONSE_COOLDOWN_MS (default 300000). */
export function recordBadResponse(name, err) {
  const s = get(name);
  s.probeInFlight = false;
  const ms = intEnv('BAD_RESPONSE_COOLDOWN_MS', 300000);
  s.disabledUntil = Date.now() + ms;
  s.lastError = (err?.message || 'bad response').slice(0, 160);
  s.reason = 'bad_response';
  console.warn(`[Breaker] '${name}' disabled for ${ms / 1000}s (malformed response)`);
}

/** Release a probe slot without recording an outcome (e.g. request skipped). */
export function releaseProbe(name) {
  get(name).probeInFlight = false;
}

export function resetAll() {
  states.clear();
}

export function getStatus(names = []) {
  const out = {};
  const now = Date.now();
  for (const n of new Set([...names, ...states.keys()])) {
    const s = get(n);
    const until = blockedUntil(n, now);
    out[n] = {
      state: getState(n, now),
      failures: s.failures,
      retryInMs: until ? until - now : 0,
      cooldownUntil: until ? new Date(until).toISOString() : null,
      reason: s.reason,
      lastError: s.lastError
    };
  }
  return out;
}
