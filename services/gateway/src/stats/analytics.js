// Aggregations for GET /v1/analytics. `computeAnalytics(rows, opts)` is pure (unit-tested);
// `getAnalytics(range)` picks the source: MongoDB when connected and writes are healthy,
// else the local request log.
import * as requestLog from './requestLog.js';
import { getMongoRange, warnMongoUnavailable } from './mongoLogger.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
export const RANGES = {
  '15m': { ms: 15 * MIN, bucketMs: 30_000 },
  '1h': { ms: HOUR, bucketMs: MIN },
  '24h': { ms: 24 * HOUR, bucketMs: 30 * MIN },
  '7d': { ms: 7 * 24 * HOUR, bucketMs: 6 * HOUR }
};
export const ERROR_TYPES = ['timeout', 'rate_limited', 'auth', 'billing', 'server', 'bad_response', 'other'];
const TIERS = ['light', 'standard', 'heavy'];

export const normalizeRange = r => (RANGES[r] ? r : '1h');

/** Nearest-rank percentile of an ascending-sorted array (null when empty). */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const round = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const ratio = (a, b) => (b > 0 ? round(a / b, 4) : null);

function latencyStats(values) {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return { avg: null, p50: null, p95: null, p99: null };
  return {
    avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99)
  };
}

/** Contract mapping: attempt -> errorsByType key. */
export function errorType(attempt = {}) {
  const outcome = attempt.outcome;
  const status = Number(attempt.httpStatus ?? attempt.status) || null;
  const msg = String(attempt.error || '');
  if (outcome === 'timeout') return 'timeout';
  if (outcome === 'rate_limited' || status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  if (outcome === 'bad_response' || attempt.code === 'BAD_RESPONSE' ||
      (status === 502 && /non-JSON|no choices|bad response/i.test(msg))) return 'bad_response';
  if (status >= 500 && status < 600) return status === 504 ? 'timeout' : 'server';
  return 'other';
}

const isFailed = a => a && a.outcome !== 'ok' && a.outcome !== 'skipped';
const add = (obj, key, n = 1) => { obj[key] = (obj[key] || 0) + n; };

/** Attempts for a row; legacy rows without `attempts` get them synthesised from failedProviders. */
function attemptsOf(row) {
  if (Array.isArray(row.attempts) && row.attempts.length) return row.attempts;
  if (row.cache || row.status === 'queued') return [];
  const out = (row.failedProviders || []).map(p => ({ provider: p, outcome: 'error', model: null }));
  if (row.status === 'ok' && row.provider && row.provider !== 'none' && row.provider !== 'cache') {
    out.push({ provider: row.provider, model: row.model, outcome: 'ok', latencyMs: row.latencyMs });
  }
  return out;
}

const emptyErrors = () => Object.fromEntries(ERROR_TYPES.map(t => [t, 0]));

/**
 * @param {object[]} rows request-log rows (any order)
 * @param {{range?: string, now?: number, source?: string}} opts
 */
export function computeAnalytics(rows, { range = '1h', now = Date.now(), source = 'local' } = {}) {
  range = normalizeRange(range);
  const { ms, bucketMs } = RANGES[range];
  const fromMs = now - ms;
  const startBucket = Math.floor(fromMs / bucketMs) * bucketMs;

  const inRange = [];
  for (const r of rows || []) {
    const t = Date.parse(r?.time);
    if (Number.isFinite(t) && t >= fromMs && t <= now + 1000) inRange.push({ r, t });
  }
  inRange.sort((a, b) => a.t - b.t); // oldest first so "last" wins naturally

  // ---- series skeleton
  const buckets = new Map();
  for (let b = startBucket; b <= now; b += bucketMs) {
    buckets.set(b, { t: new Date(b).toISOString(), requests: 0, cacheHits: 0, errors: 0, failovers: 0, tokens: 0,
      cost: 0, savedCost: 0, avgLatencyMs: null, p95LatencyMs: null, byProvider: {}, _lat: [] });
  }

  const T = { requests: 0, ok: 0, errors: 0, queued: 0, cacheHits: 0, failovers: 0, tokens: 0, cost: 0, verifyCost: 0,
    embedCost: 0, savedCost: 0 };
  const allLat = [];
  const prov = new Map();
  const models = new Map();
  const tiers = Object.fromEntries(TIERS.map(t => [t, { requests: 0, cost: 0, _lat: [] }]));
  const tasks = {};
  const policies = {};
  const errs = new Map();
  const failingBy = new Map();
  const transitions = new Map();
  const cache = { lookups: 0, hits: 0, verifiedHits: 0, rejected: 0, bypassed: 0, savedCost: 0, verifyCost: 0, embedCost: 0 };
  const keyAgg = new Map();
  const F = { requestsWithFailover: 0, chainSum: 0, maxChainLength: 0, recovered: 0, unrecovered: 0, dispatched: 0 };

  const provEntry = name => {
    if (!prov.has(name)) prov.set(name, { name, requests: 0, ok: 0, errors: 0, tokens: 0, cost: 0, served: 0, _lat: [], errorsByType: emptyErrors() });
    return prov.get(name);
  };
  const noteError = (type, message, provider) => {
    const e = errs.get(type) || { type, count: 0, lastMessage: null, lastProvider: null };
    e.count++;
    if (message) { e.lastMessage = String(message).slice(0, 300); e.lastProvider = provider || null; }
    errs.set(type, e);
  };

  for (const { r, t } of inRange) {
    const b = buckets.get(Math.floor(t / bucketMs) * bucketMs);
    const cost = Number(r.cost) || 0;
    const verifyCost = Number(r.verifyCost) || 0;
    const embedCost = Number(r.embedCost) || 0;
    const savedCost = Number(r.savedCost) || 0;
    const tokens = r.cache ? 0 : (Number(r.tokens) || 0);
    const latency = Number(r.latencyMs);
    const queued = r.status === 'queued';
    const attempts = attemptsOf(r);
    const failed = attempts.filter(isFailed);
    const hasFailover = failed.length > 0 || (r.failedProviders?.length > 0);

    T.requests++;
    if (r.status === 'ok') T.ok++;
    else if (r.status === 'error') T.errors++;
    else if (queued) T.queued++;
    if (r.cache) T.cacheHits++;
    if (hasFailover) T.failovers++;
    T.tokens += tokens; T.cost += cost; T.verifyCost += verifyCost; T.embedCost += embedCost; T.savedCost += savedCost;
    if (!queued && Number.isFinite(latency)) allLat.push(latency);

    if (b) {
      b.requests++;
      if (r.cache) b.cacheHits++;
      if (r.status === 'error') b.errors++;
      if (hasFailover) b.failovers++;
      b.tokens += tokens; b.cost += cost; b.savedCost += savedCost;
      if (!queued && Number.isFinite(latency)) b._lat.push(latency);
      add(b.byProvider, r.provider || 'none');
    }

    // client API keys (rows without a key are grouped as id null, e.g. keyless localhost calls)
    const kid = r.apiKeyId || null;
    const k = keyAgg.get(kid) || { id: kid, name: kid ? null : '(no key)', requests: 0, tokens: 0, cost: 0, errors: 0 };
    k.requests++; k.tokens += tokens; k.cost += cost + verifyCost + embedCost;
    if (r.status === 'error') k.errors++;
    if (kid && r.apiKeyName) k.name = r.apiKeyName;
    keyAgg.set(kid, k);

    // cache
    if (!queued) {
      if (r.cacheBypassed) cache.bypassed++;
      else cache.lookups++;
      if (r.cache) {
        cache.hits++;
        if (r.verified) cache.verifiedHits++;
      }
      if (r.verification === 'rejected') cache.rejected++;
      cache.savedCost += savedCost; cache.verifyCost += verifyCost; cache.embedCost += embedCost;
    }

    // route
    const route = r.route || null;
    if (route?.tier && tiers[route.tier]) {
      const tt = tiers[route.tier];
      tt.requests++;
      tt.cost += cost;
      if (!queued && Number.isFinite(latency)) tt._lat.push(latency);
    }
    if (route?.task) add(tasks, route.task);
    if (route?.policy) add(policies, route.policy);

    // providers (per attempt) + cache pseudo-provider
    if (r.cache) {
      const p = provEntry('cache');
      p.requests++; p.ok++; p.served++;
      if (Number.isFinite(latency)) p._lat.push(latency);
    }
    for (const a of attempts) {
      if (!a?.provider || a.outcome === 'skipped') continue;
      const p = provEntry(a.provider);
      p.requests++;
      if (Number.isFinite(Number(a.latencyMs))) p._lat.push(Number(a.latencyMs));
      if (a.outcome === 'ok') p.ok++;
      else {
        p.errors++;
        const type = errorType(a);
        p.errorsByType[type]++;
        noteError(type, a.error, a.provider);
        const f = failingBy.get(a.provider) || { provider: a.provider, count: 0, reasons: {} };
        f.count++; add(f.reasons, type);
        failingBy.set(a.provider, f);
      }
    }
    if (r.status === 'ok' && !r.cache && r.provider && r.provider !== 'none') {
      const p = provEntry(r.provider);
      p.served++; p.tokens += tokens; p.cost += cost;
      const key = `${r.provider}|${r.model || ''}`;
      const m = models.get(key) || { provider: r.provider, model: r.model || null, requests: 0, tokens: 0, cost: 0, _lat: [] };
      m.requests++; m.tokens += tokens; m.cost += cost;
      if (Number.isFinite(latency)) m._lat.push(latency);
      models.set(key, m);
    }
    if (r.status === 'error' && attempts.length === 0) {
      noteError('no_provider', r.error || 'No provider was available for the request', null);
    }

    // failover chains
    if (attempts.length) {
      F.dispatched++;
      F.maxChainLength = Math.max(F.maxChainLength, attempts.length);
      if (hasFailover) {
        F.requestsWithFailover++;
        F.chainSum += attempts.length;
        if (r.status === 'ok') F.recovered++; else F.unrecovered++;
      }
      for (let i = 0; i + 1 < attempts.length; i++) {
        const from = attempts[i]?.provider;
        const to = attempts[i + 1]?.provider;
        if (!from || !to || !isFailed(attempts[i])) continue;
        const key = `${from}>${to}`;
        const tr = transitions.get(key) || { from, to, count: 0 };
        tr.count++;
        transitions.set(key, tr);
      }
    }
  }

  const L = latencyStats(allLat);
  const nonQueued = T.ok + T.errors;
  const totalServed = [...prov.values()].reduce((s, p) => s + p.served, 0);

  const series = [...buckets.values()].map(b => {
    const s = latencyStats(b._lat);
    const { _lat, ...rest } = b;
    return { ...rest, avgLatencyMs: s.avg, p95LatencyMs: s.p95 };
  });

  const providers = [...prov.values()].map(p => {
    const s = latencyStats(p._lat);
    return {
      name: p.name, requests: p.requests, ok: p.ok, errors: p.errors,
      successRate: ratio(p.ok, p.requests),
      avgLatencyMs: s.avg, p50LatencyMs: s.p50, p95LatencyMs: s.p95, p99LatencyMs: s.p99,
      tokens: p.tokens, cost: p.cost, served: p.served,
      share: ratio(p.served, totalServed),
      errorsByType: p.errorsByType
    };
  }).sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name));

  const modelRows = [...models.values()].map(m => {
    const s = latencyStats(m._lat);
    return { provider: m.provider, model: m.model, requests: m.requests, tokens: m.tokens, cost: m.cost, avgLatencyMs: s.avg };
  }).sort((a, b) => b.requests - a.requests);

  const tierOut = {};
  for (const t of TIERS) {
    tierOut[t] = { requests: tiers[t].requests, avgLatencyMs: latencyStats(tiers[t]._lat).avg, cost: tiers[t].cost };
  }

  const topFailing = [...failingBy.values()]
    .map(f => ({ provider: f.provider, count: f.count, topReason: Object.entries(f.reasons).sort((a, b) => b[1] - a[1])[0]?.[0] || null }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    range,
    bucketMs,
    source,
    from: new Date(fromMs).toISOString(),
    to: new Date(now).toISOString(),
    totals: {
      ...T,
      netSaved: T.savedCost - T.verifyCost - T.embedCost,
      avgLatencyMs: L.avg, p50LatencyMs: L.p50, p95LatencyMs: L.p95, p99LatencyMs: L.p99,
      successRate: ratio(T.ok, nonQueued),
      cacheHitRate: ratio(T.cacheHits, cache.lookups)
    },
    series,
    providers,
    models: modelRows,
    tiers: tierOut,
    tasks,
    policies,
    failover: {
      requestsWithFailover: F.requestsWithFailover,
      rate: ratio(F.requestsWithFailover, F.dispatched),
      avgChainLength: F.requestsWithFailover ? round(F.chainSum / F.requestsWithFailover, 2) : 0,
      maxChainLength: F.maxChainLength,
      recovered: F.recovered,
      unrecovered: F.unrecovered,
      topFailing,
      transitions: [...transitions.values()].sort((a, b) => b.count - a.count).slice(0, 25)
    },
    cache: {
      lookups: cache.lookups,
      hits: cache.hits,
      verifiedHits: cache.verifiedHits,
      rejected: cache.rejected,
      bypassed: cache.bypassed,
      hitRate: ratio(cache.hits, cache.lookups),
      savedCost: cache.savedCost,
      netSaved: cache.savedCost - cache.verifyCost - cache.embedCost
    },
    errors: [...errs.values()].sort((a, b) => b.count - a.count),
    keys: [...keyAgg.values()]
      .map(k => ({ ...k, name: k.name || k.id }))
      .sort((a, b) => b.requests - a.requests || String(a.name).localeCompare(String(b.name)))
  };
}

/** Source selection: MongoDB (if reachable and local writes are not failing) else local history. */
export async function getAnalytics(rangeParam, { now = Date.now() } = {}) {
  const range = normalizeRange(rangeParam);
  const from = new Date(now - RANGES[range].ms);
  if (!requestLog.hasMongoWriteError()) {
    try {
      const rows = await getMongoRange(from);
      return computeAnalytics(rows, { range, now, source: 'mongodb' });
    } catch (err) {
      warnMongoUnavailable(err);
    }
  }
  return computeAnalytics(requestLog.getHistory(), { range, now, source: 'local' });
}
