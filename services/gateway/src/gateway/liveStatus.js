// Builds the shared /v1/chat/live payload (also pushed over ws://.../ws/metrics).
import * as semanticCache from '../cache/semanticCache.js';
import * as requestLog from '../stats/requestLog.js';
import { getMongoRecent, warnMongoUnavailable } from '../stats/mongoLogger.js';
import { getStatus as rateLimitStatus } from '../middleware/rateLimit.js';
import { providerNames, isConfigured, getProviderChain } from '../providers/index.js';
import * as circuit from './circuitBreaker.js';
import * as stats from './providerStats.js';
import { catalogModels, normalizePolicy, providerTimeoutMs, maxInflight, rrWeight, TIERS } from './router.js';

/** The contract's `providers` object (also GET /v1/chat/providers). */
export function buildProvidersPayload() {
  const status = circuit.getStatus(providerNames());
  const out = {};
  for (const name of getProviderChain()) {
    const configured = isConfigured(name);
    const b = status[name];
    const s = stats.summary(name);
    const state = configured ? b.state : 'unconfigured';
    out[name] = {
      configured,
      enabled: configured && state !== 'disabled',
      state,
      models: catalogModels(name),
      requests: s.requests,
      successes: s.successes,
      failures: s.failures,
      rateLimited: s.rateLimited,
      timeouts: s.timeouts,
      saturated: s.saturated,
      successRate: s.successRate,
      avgLatencyMs: s.avgLatencyMs,
      p95LatencyMs: s.p95LatencyMs,
      inflight: s.inflight,
      maxInflight: maxInflight(),
      cooldownUntil: configured ? b.cooldownUntil : null,
      lastError: s.lastError || b.lastError || null,
      lastErrorAt: s.lastErrorAt,
      rrWeight: rrWeight(name)
    };
  }
  return out;
}

/** OpenAI-style model list (GET /v1/models). */
export function buildModelList({ all = false } = {}) {
  const data = [];
  for (const name of getProviderChain()) {
    const configured = isConfigured(name);
    if (!configured && !all) continue;
    const models = catalogModels(name);
    const seen = new Map();
    for (const tier of TIERS) {
      const m = models[tier];
      if (seen.has(m)) { seen.get(m).tiers.push(tier); continue; }
      const row = { id: `${name}/${m}`, object: 'model', owned_by: name, tier, tiers: [tier], configured };
      seen.set(m, row);
      data.push(row);
    }
  }
  return { object: 'list', data };
}

function buildConfig(cache) {
  return {
    routingPolicy: normalizePolicy(),
    providerTimeoutMs: providerTimeoutMs(),
    requestBudgetMs: parseInt(process.env.REQUEST_BUDGET_MS || '30000', 10),
    providerOrder: getProviderChain(),
    cacheThreshold: cache.threshold ?? parseFloat(process.env.CACHE_THRESHOLD || '0.88'),
    cacheTrustAbove: cache.trustAbove ?? parseFloat(process.env.CACHE_TRUST_ABOVE || '0.985'),
    cacheVerify: cache.verifyEnabled ?? (process.env.CACHE_VERIFY || 'true').toLowerCase() !== 'false',
    rateLimit: rateLimitStatus()
  };
}

// MongoDB rows only carry a subset of fields; enrich them from the local log
// (same time + prompt) so route/attempts/model survive when history comes from Mongo.
function mergeRecent(mongoRows, localRows) {
  const local = new Map(localRows.map(r => [`${r.time}|${r.prompt}`, r]));
  return mongoRows.map(r => {
    const l = local.get(`${r.time}|${r.prompt}`);
    return l ? { ...r, ...l } : { route: null, attempts: [], model: null, skippedProviders: [], embedCost: 0, ...r };
  });
}

export async function buildLivePayload() {
  const live = requestLog.getLive();
  let recent = live.recent;
  let historySource = 'local';
  let mongoAvailable = false;
  try {
    const mongoRows = await getMongoRecent();
    mongoAvailable = true;
    if (!requestLog.hasMongoWriteError()) {
      historySource = 'mongodb';
      recent = mergeRecent(mongoRows, live.recent);
    }
  } catch (err) {
    warnMongoUnavailable(err);
  }

  const rawCache = semanticCache.getStats();
  const cache = {
    ...rawCache,
    netSaved: rawCache.netSaved ?? ((rawCache.costSaved || 0) - (rawCache.verifyCost || 0) - (rawCache.embedCost || 0))
  };
  const providersPayload = buildProvidersPayload();

  return {
    config: buildConfig(rawCache),
    providers: providersPayload,
    routing: { policy: normalizePolicy(), ...stats.getRouting() },
    cache,
    totals: live.totals,
    byProvider: live.byProvider,
    recent,
    persistence: {
      mongodb: !mongoAvailable ? 'unavailable' : historySource === 'mongodb' ? 'connected' : 'degraded',
      historySource
    },
    breakers: circuit.getStatus(providerNames())
  };
}
