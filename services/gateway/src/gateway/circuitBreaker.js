// Remembers which providers are failing so we stop hammering them.
// After BREAKER_THRESHOLD consecutive failures a provider is skipped for
// BREAKER_COOLDOWN_MS, then probed again automatically.
const states = new Map();
const threshold = () => parseInt(process.env.BREAKER_THRESHOLD || '3', 10);
const cooldownMs = () => parseInt(process.env.BREAKER_COOLDOWN_MS || '20000', 10);

function get(name) {
  if (!states.has(name)) states.set(name, { failures: 0, openUntil: 0, lastError: null });
  return states.get(name);
}

export function canAttempt(name) {
  return Date.now() >= get(name).openUntil;
}

export function recordSuccess(name) {
  const s = get(name);
  s.failures = 0;
  s.openUntil = 0;
  s.lastError = null;
}

export function recordFailure(name, err) {
  const s = get(name);
  s.failures++;
  s.lastError = (err?.message || 'error').slice(0, 120);
  if (s.failures >= threshold()) {
    s.openUntil = Date.now() + cooldownMs();
    console.warn(`[Breaker] '${name}' marked unhealthy for ${cooldownMs() / 1000}s after ${s.failures} failures`);
  }
}

export function resetAll() {
  states.clear();
}

export function getStatus(names = []) {
  const out = {};
  for (const n of new Set([...names, ...states.keys()])) {
    const s = get(n);
    const remaining = Math.max(0, s.openUntil - Date.now());
    let state = 'healthy';
    if (remaining > 0) state = 'open';
    else if (s.failures >= threshold()) state = 'probing';
    out[n] = { state, failures: s.failures, retryInMs: remaining, lastError: s.lastError };
  }
  return out;
}
