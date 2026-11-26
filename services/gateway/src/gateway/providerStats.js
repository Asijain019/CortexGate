// Live per-provider counters + routing decision counts for the dashboard and
// for health-aware routing. Persisted to data/provider-stats.json (debounced),
// except under `node --test` so test runs never touch real data.
import * as persist from '../stats/persist.js';

const SAMPLE_LIMIT = 200;   // latency samples kept per provider
const WINDOW = 20;          // recent outcomes used for the routing success rate
const TIERS = ['light', 'standard', 'heavy'];
const TASKS = ['factual', 'code', 'reasoning', 'summarize', 'creative', 'chat'];

const inTest = Boolean(process.env.NODE_TEST_CONTEXT);
const saved = inTest ? null : persist.load('provider-stats', null);

const byProvider = {};
const inflight = {};
const routing = {
  tierCounts: Object.fromEntries(TIERS.map(t => [t, 0])),
  taskCounts: Object.fromEntries(TASKS.map(t => [t, 0])),
  downgrades: 0, capacityRejections: 0, queuedCount: 0, queuedTotalMs: 0
};
// Rolling 60s request/token windows per provider+model (for <P>_RPM / <P>_TPM budgets:
// groq, gemini and cerebras enforce them per model). Not persisted.
const RATE_WINDOW_MS = 60000;
const windows = {};

function blank() {
  return {
    requests: 0, successes: 0, failures: 0, rateLimited: 0, timeouts: 0, saturated: 0,
    latencies: [], recent: [], recentTimeouts: [], lastError: null, lastErrorAt: null, lastModel: null
  };
}

if (saved?.byProvider) {
  for (const [k, v] of Object.entries(saved.byProvider)) byProvider[k] = { ...blank(), ...v };
}
if (saved?.routing) {
  Object.assign(routing.tierCounts, saved.routing.tierCounts || {});
  Object.assign(routing.taskCounts, saved.routing.taskCounts || {});
  for (const k of ['downgrades', 'capacityRejections', 'queuedCount', 'queuedTotalMs']) {
    if (Number.isFinite(saved.routing[k])) routing[k] = saved.routing[k];
  }
}

const persistNow = () => {
  if (inTest) return;
  persist.save('provider-stats', () => ({ byProvider, routing }), 1000);
};

function get(name) {
  if (!byProvider[name]) byProvider[name] = blank();
  return byProvider[name];
}

export function inflightCount(name) {
  return inflight[name] || 0;
}

export function begin(name) {
  inflight[name] = (inflight[name] || 0) + 1;
}

export function end(name) {
  inflight[name] = Math.max(0, (inflight[name] || 0) - 1);
}

function pushRecent(s, ok, timedOut = false) {
  s.recent.push(ok ? 1 : 0);
  if (s.recent.length > WINDOW) s.recent.shift();
  if (!Array.isArray(s.recentTimeouts)) s.recentTimeouts = [];
  s.recentTimeouts.push(timedOut ? 1 : 0);
  if (s.recentTimeouts.length > WINDOW) s.recentTimeouts.shift();
}

export function recordSuccess(name, latencyMs, model) {
  const s = get(name);
  s.requests++;
  s.successes++;
  s.lastModel = model || s.lastModel;
  s.latencies.push(Math.round(latencyMs));
  if (s.latencies.length > SAMPLE_LIMIT) s.latencies.shift();
  pushRecent(s, true);
  persistNow();
}

/** outcome: 'timeout' | 'rate_limited' | 'error'. A timeout's latency (= the attempt
 *  timeout) is added to the latency samples so p95 reflects how slow the provider really is. */
export function recordFailure(name, outcome, err, latencyMs) {
  const s = get(name);
  if (outcome === 'timeout' && Number.isFinite(latencyMs) && latencyMs > 0) {
    s.latencies.push(Math.round(latencyMs));
    if (s.latencies.length > SAMPLE_LIMIT) s.latencies.shift();
  }
  s.requests++;
  s.failures++;
  if (outcome === 'timeout') s.timeouts++;
  if (outcome === 'rate_limited') s.rateLimited++;
  s.lastError = String(err?.message || outcome || 'error').slice(0, 200);
  s.lastErrorAt = new Date().toISOString();
  pushRecent(s, false, outcome === 'timeout');
  persistNow();
}

export function recordSaturated(name) {
  get(name).saturated++;
}

export function recordRoute({ tier, task }) {
  if (tier) routing.tierCounts[tier] = (routing.tierCounts[tier] || 0) + 1;
  if (task) routing.taskCounts[task] = (routing.taskCounts[task] || 0) + 1;
  persistNow();
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Summary used by the router and the dashboard. */
export function summary(name) {
  const s = get(name);
  const avg = s.latencies.length ? Math.round(s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length) : null;
  return {
    requests: s.requests,
    successes: s.successes,
    failures: s.failures,
    rateLimited: s.rateLimited,
    timeouts: s.timeouts,
    saturated: s.saturated,
    successRate: s.requests ? s.successes / s.requests : null,
    // Smoothed recent success rate (Laplace prior of 1/1) for routing.
    recentSuccessRate: (s.recent.reduce((a, b) => a + b, 0) + 1) / (s.recent.length + 1),
    // Share of the last WINDOW attempts that hit the per-attempt timeout (0..1).
    recentTimeoutRate: s.recentTimeouts?.length ? s.recentTimeouts.reduce((a, b) => a + b, 0) / s.recentTimeouts.length : 0,
    avgLatencyMs: avg,
    p50LatencyMs: percentile(s.latencies, 50),
    p95LatencyMs: percentile(s.latencies, 95),
    inflight: inflightCount(name),
    lastError: s.lastError,
    lastErrorAt: s.lastErrorAt
  };
}

export function recordDowngrade() { routing.downgrades++; persistNow(); }
export function recordCapacityRejection() { routing.capacityRejections++; persistNow(); }
/** A request that waited in the capacity queue for `ms`. */
export function recordQueued(ms) {
  routing.queuedCount++;
  routing.queuedTotalMs += Math.max(0, Math.round(ms));
  persistNow();
}

// ---------------------------------------------------------------- rate windows

const wkey = (name, model) => `${name}|${model || ''}`;

function prune(key, now) {
  const w = windows[key] || (windows[key] = []);
  while (w.length && w[0].t <= now - RATE_WINDOW_MS) w.shift();
  return w;
}

/** Count a request start against the provider's rolling window; returns the entry. */
export function recordStart(name, estTokens = 0, now = Date.now(), model) {
  const entry = { t: now, tokens: Math.max(0, Math.round(estTokens)) };
  prune(wkey(name, model), now).push(entry);
  return entry;
}

/** Replace the estimated tokens with the real usage once known. */
export function adjustTokens(entry, tokens) {
  if (entry && Number.isFinite(tokens) && tokens >= 0) entry.tokens = Math.round(tokens);
}

/** { rpm, tpm, entries } for the last 60s for one model (or all of the provider's models
 *  when model is undefined). Entries oldest first; do not mutate. */
export function rateUsage(name, now = Date.now(), model) {
  let w;
  if (model !== undefined) w = prune(wkey(name, model), now);
  else {
    w = [];
    for (const k of Object.keys(windows)) if (k.startsWith(`${name}|`)) w.push(...prune(k, now));
    w.sort((a, b) => a.t - b.t);
  }
  return { rpm: w.length, tpm: w.reduce((a, e) => a + e.tokens, 0), entries: w };
}

export function getRouting() {
  return {
    tierCounts: { ...routing.tierCounts },
    taskCounts: { ...routing.taskCounts },
    downgrades: routing.downgrades,
    capacityRejections: routing.capacityRejections,
    avgQueuedMs: routing.queuedCount ? Math.round(routing.queuedTotalMs / routing.queuedCount) : 0
  };
}

export function clear() {
  for (const k of Object.keys(byProvider)) delete byProvider[k];
  for (const t of Object.keys(routing.tierCounts)) routing.tierCounts[t] = 0;
  for (const t of Object.keys(routing.taskCounts)) routing.taskCounts[t] = 0;
  routing.downgrades = 0; routing.capacityRejections = 0; routing.queuedCount = 0; routing.queuedTotalMs = 0;
  for (const k of Object.keys(windows)) delete windows[k];
  persistNow();
}
