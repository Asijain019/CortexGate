// Per-provider health state machine.
//
//   healthy  --BREAKER_THRESHOLD consecutive failures-->  open (skipped for BREAKER_COOLDOWN_MS)
//   open     --cooldown elapsed-->                        probing (one request at a time allowed)
//   probing  --success--> healthy      --failure--> open again
//   open/probing --successful active health probe--> healthy (see healthCheck.js)
//
// Independent of the breaker:
//   cooldown: after a 429, honour Retry-After or RATE_LIMIT_COOLDOWN_MS (default 30000)
//   disabled: 401/403 -> reason 'auth', 402 -> 'billing' (AUTH_COOLDOWN_MS, default 3600000);
//             200 with a non-JSON body -> 'bad_response' (BAD_RESPONSE_COOLDOWN_MS, default 1800000)
//
// State precedence for reporting: disabled > cooldown > open > probing > healthy.
//
// Persistence: every block (disabled / cooldown / open breaker) is saved to
// data/provider-health.json, so a restart does not re-try providers already known
// to be broken. Each saved entry carries a one-way fingerprint of the provider's
// key (env vars + dashboard-saved key); if it changed while the gateway was down, the
// entry is dropped. resetProvider(name) (dashboard key saved/tested) and resetAll()
// (.env reload) re-enable providers. Nothing is written under `node --test`.
import crypto from 'crypto';
import * as persist from '../stats/persist.js';
import * as keyStore from '../providers/keyStore.js';

const states = new Map();
const PERSIST_NAME = 'provider-health';
const inTest = () => Boolean(process.env.NODE_TEST_CONTEXT) || process.env.NODE_ENV === 'test';

const intEnv = (name, def) => {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
};
export const threshold = () => Math.max(1, intEnv('BREAKER_THRESHOLD', 3));
export const cooldownMs = () => intEnv('BREAKER_COOLDOWN_MS', 20000);
export const rateLimitCooldownMs = () => intEnv('RATE_LIMIT_COOLDOWN_MS', 30000);
export const authCooldownMs = () => intEnv('AUTH_COOLDOWN_MS', 3600000);
export const badResponseCooldownMs = () => intEnv('BAD_RESPONSE_COOLDOWN_MS', 1800000);
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;
const DISABLED_REASONS = ['auth', 'billing', 'bad_response'];

function blank() {
  return {
    failures: 0, openUntil: 0, cooldownUntil: 0, disabledUntil: 0,
    probeInFlight: false, lastError: null, reason: null
  };
}

function get(name) {
  if (!states.has(name)) states.set(name, blank());
  return states.get(name);
}

// ---------------------------------------------------------------- persistence

// Env vars that hold a provider's credentials (beyond the generic <P>_*KEY/TOKEN/ACCOUNT_ID).
const EXTRA_KEY_ENVS = { huggingface: ['HF_TOKEN'], openrouter: ['OPENAI_API_KEY'], nvidia: ['NVDIA_API_KEY'] };

/** One-way, non-reversible fingerprint of the provider's credential env vars. */
export function keyFingerprint(name) {
  const P = `${name.toUpperCase()}_`;
  const keys = Object.keys(process.env)
    .filter(k => (k.startsWith(P) && /(KEY|TOKEN|ACCOUNT_ID|BASE_URL)$/.test(k)) || (EXTRA_KEY_ENVS[name] || []).includes(k))
    .sort();
  const h = crypto.createHash('sha256');
  for (const k of keys) h.update(`${k}=${process.env[k] || ''}\n`);
  // Dashboard-saved keys (keyStore) override env, so they are part of the fingerprint too.
  try {
    const def = keyStore.BUILTIN_KEYS?.[name];
    if (def && typeof keyStore.getProviderKey === 'function') {
      h.update(`store.key=${keyStore.getProviderKey(def.keyEnv, name) || ''}\n`);
      if (def.accountEnv && typeof keyStore.getProviderAccountId === 'function') {
        h.update(`store.account=${keyStore.getProviderAccountId(name) || ''}\n`);
      }
    }
  } catch { /* key store unavailable: env-only fingerprint */ }
  return h.digest('hex').slice(0, 16);
}

export function exportState(now = Date.now()) {
  const out = {};
  for (const [name, s] of states) {
    if (Math.max(s.disabledUntil, s.cooldownUntil, s.openUntil) <= now && s.failures === 0) continue;
    out[name] = {
      failures: s.failures, openUntil: s.openUntil, cooldownUntil: s.cooldownUntil,
      disabledUntil: s.disabledUntil, reason: s.reason, lastError: s.lastError, fp: keyFingerprint(name)
    };
  }
  return { savedAt: new Date(now).toISOString(), providers: out };
}

/** Restore a snapshot from exportState(); entries whose key fingerprint changed are dropped. */
export function importState(snapshot, now = Date.now()) {
  const restored = [];
  for (const [name, e] of Object.entries(snapshot?.providers || {})) {
    if (!e || (e.fp && e.fp !== keyFingerprint(name))) continue;
    if (Math.max(e.disabledUntil || 0, e.cooldownUntil || 0, e.openUntil || 0) <= now) continue;
    states.set(name, {
      ...blank(),
      failures: e.failures || 0, openUntil: e.openUntil || 0, cooldownUntil: e.cooldownUntil || 0,
      disabledUntil: e.disabledUntil || 0, reason: e.reason || null, lastError: e.lastError || null
    });
    restored.push(name);
  }
  return restored;
}

function persistNow() {
  if (inTest()) return;
  persist.save(PERSIST_NAME, () => exportState(), 500);
}

/** Load data/provider-health.json (no-op under test unless force). Returns restored names. */
export function loadPersisted({ force = false } = {}) {
  if (inTest() && !force) return [];
  const restored = importState(persist.load(PERSIST_NAME, null));
  if (restored.length) {
    const desc = restored.map(n => `${n}=${getState(n)}${get(n).reason ? `(${get(n).reason})` : ''}`).join(', ');
    console.log(`[Breaker] Restored persisted provider health: ${desc}`);
  }
  return restored;
}

loadPersisted();

// ---------------------------------------------------------------- state

export function getState(name, now = Date.now()) {
  const s = get(name);
  if (s.disabledUntil > now) return 'disabled';
  if (s.cooldownUntil > now) return 'cooldown';
  if (s.openUntil > now) return 'open';
  if (s.failures >= threshold()) return 'probing';
  return 'healthy';
}

/** 'auth' | 'billing' | 'bad_response' while disabled, else null. */
export function disabledReason(name, now = Date.now()) {
  const s = get(name);
  return s.disabledUntil > now && DISABLED_REASONS.includes(s.reason) ? s.reason : null;
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
  const changed = s.failures > 0 || s.openUntil > 0;
  s.failures = 0;
  s.openUntil = 0;
  s.probeInFlight = false;
  if (s.disabledUntil <= Date.now() && s.cooldownUntil <= Date.now()) {
    s.lastError = null;
    s.reason = null;
  }
  if (changed) persistNow();
}

/** Successful active health probe: close an open/probing breaker early (cooldown/disabled untouched). */
export function recordProbeSuccess(name) {
  const s = get(name);
  const was = getState(name);
  if (was !== 'open' && was !== 'probing') return false;
  recordSuccess(name);
  console.log(`[Breaker] '${name}' closed early by a successful health probe`);
  return true;
}

/** Failed active health probe: open the breaker now so users never hit the provider. */
export function openBreaker(name, err) {
  const s = get(name);
  s.probeInFlight = false;
  s.failures = Math.max(s.failures + 1, threshold());
  s.openUntil = Date.now() + cooldownMs();
  s.reason = 'breaker';
  s.lastError = (err?.message || 'health probe failed').slice(0, 160);
  persistNow();
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
  persistNow();
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
  persistNow();
  return ms;
}

/** 401/403 (auth) or 402 (billing): the key/account is broken; disable for AUTH_COOLDOWN_MS. */
export function recordAuthFailure(name, err) {
  const s = get(name);
  s.probeInFlight = false;
  s.disabledUntil = Date.now() + authCooldownMs();
  s.lastError = (err?.message || 'auth failure').slice(0, 160);
  s.reason = err?.status === 402 ? 'billing' : 'auth';
  console.warn(`[Breaker] '${name}' disabled for ${authCooldownMs() / 1000}s (${s.reason}, status ${err?.status})`);
  persistNow();
}

/** 200 with a non-JSON / malformed body (e.g. GitHub Models answering plain "OK"):
 *  the service is broken, not busy; disable for BAD_RESPONSE_COOLDOWN_MS. */
export function recordBadResponse(name, err) {
  const s = get(name);
  s.probeInFlight = false;
  const ms = badResponseCooldownMs();
  s.disabledUntil = Date.now() + ms;
  s.lastError = (err?.message || 'bad response').slice(0, 160);
  s.reason = 'bad_response';
  console.warn(`[Breaker] '${name}' disabled for ${ms / 1000}s (malformed response)`);
  persistNow();
}

/** Release a probe slot without recording an outcome (e.g. request skipped). */
export function releaseProbe(name) {
  get(name).probeInFlight = false;
}

/** Forget everything about one provider (dashboard saved/tested a new key). */
export function resetProvider(name) {
  if (!name) return;
  const had = states.delete(name);
  if (had) console.log(`[Breaker] '${name}' reset (re-enabled)`);
  persistNow();
}

export function resetAll() {
  states.clear();
  persistNow();
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
      disabledReason: disabledReason(n, now),
      lastError: s.lastError
    };
  }
  return out;
}
