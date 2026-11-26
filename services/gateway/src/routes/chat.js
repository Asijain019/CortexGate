import { Router } from 'express';
import * as semanticCache from '../cache/semanticCache.js';
import * as requestLog from '../stats/requestLog.js';
import * as circuit from '../gateway/circuitBreaker.js';
import * as providerStats from '../gateway/providerStats.js';
import { dispatch } from '../gateway/dispatch.js';
import { classify, normalizePolicy, resetRoundRobin } from '../gateway/router.js';
import { buildLivePayload, buildProvidersPayload } from '../gateway/liveStatus.js';
import { clearMongoRequests, getMongoSummary } from '../stats/mongoLogger.js';

const router = Router();

const completionId = () => `chatcmpl-${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

router.post('/completions', async (req, res) => {
  const body = req.body || {};
  const { messages, model } = body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: { message: "Invalid request: 'messages' must be a non-empty array.", type: 'invalid_request_error' }
    });
  }

  const startedAt = Date.now();
  const promptPreview = String(messages[messages.length - 1]?.content ?? '').slice(0, 70);
  const policy = normalizePolicy(body.routing_policy || req.headers['x-routing-policy']);
  const providerParam = body.provider || req.headers['x-provider'];

  // --- Semantic cache lookup (skipped if x-cache: bypass) ---
  const useCache = req.headers['x-cache'] !== 'bypass';
  let cacheCtx = { vector: null, hit: null, key: null, rejected: null, verifyCost: 0, verifyFailed: false, embedCost: 0 };
  if (useCache) {
    cacheCtx = await semanticCache.lookup(messages);
    if (cacheCtx.hit) {
      const { entry, similarity, verified } = cacheCtx.hit;
      const cls = classify(messages);
      const route = {
        tier: cls.tier, task: cls.task, estTokens: cls.estTokens, score: cls.score, policy,
        reason: `semantic cache hit (similarity ${similarity.toFixed(3)}${verified ? ', verified' : ''})`, override: null
      };
      console.log(`[Gateway] CACHE HIT (similarity ${similarity.toFixed(3)}${verified ? ', verified' : ''}) - saved $${entry.cost.toFixed(6)}`);
      await requestLog.record({
        provider: 'cache', model: entry.response?.model || null, cache: true, similarity, verified,
        cost: 0, verifyCost: cacheCtx.verifyCost || 0, embedCost: cacheCtx.embedCost || 0, savedCost: entry.cost,
        tokens: 0, savedTokens: entry.response.usage?.total_tokens || 0,
        latencyMs: Date.now() - startedAt, prompt: promptPreview,
        failedProviders: [], skippedProviders: [], status: 'ok', route, attempts: []
      });
      return res.json({
        id: completionId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: entry.response.model,
        choices: [{ index: 0, message: { role: 'assistant', content: entry.response.content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        provider: 'cache',
        cost: 0,
        cache: {
          hit: true, similarity, verified,
          original_provider: entry.provider,
          saved_cost: entry.cost,
          saved_tokens: entry.response.usage?.total_tokens || 0
        },
        routing: { tier: route.tier, task: route.task, reason: route.reason, policy, estTokens: route.estTokens },
        attempts: []
      });
    }
  }

  // Tier downgrade under load: body allow_downgrade or header x-allow-downgrade (default by policy).
  const allowDowngrade = body.allow_downgrade ?? req.headers['x-allow-downgrade'];
  const out = await dispatch({ messages, model, provider: providerParam, policy, allowDowngrade });
  const r = out.routing;
  const routing = {
    tier: r.tier, task: r.task, reason: r.reason, policy: r.policy, estTokens: r.estTokens,
    estInputTokens: r.estInputTokens, estOutputTokens: r.estOutputTokens, requiredQuality: r.requiredQuality,
    estCost: r.estCost, downgrade: r.downgrade, queuedMs: r.queuedMs, allowDowngrade: r.allowDowngrade,
    eligible: r.eligible, excluded: r.excluded, candidates: r.candidates
  };
  const route = { ...r };

  const verification = cacheCtx.rejected ? 'rejected' : cacheCtx.verifyFailed ? 'failed' : null;
  const common = {
    latencyMs: Date.now() - startedAt, prompt: promptPreview,
    failedProviders: out.failedProviders, skippedProviders: out.skippedProviders,
    verification, nearSimilarity: cacheCtx.rejected?.similarity ?? null,
    verifyCost: cacheCtx.verifyCost || 0, embedCost: cacheCtx.embedCost || 0,
    route, attempts: out.attempts
  };

  if (out.result) {
    if (useCache) {
      semanticCache.store({ vector: cacheCtx.vector, key: cacheCtx.key, response: out.result, cost: out.cost, provider: out.provider });
    }
    await requestLog.record({
      provider: out.provider, model: out.model, cache: false, cost: out.cost,
      tokens: out.result.usage?.total_tokens || 0, status: 'ok', cacheBypassed: !useCache, ...common
    });
    return res.json({
      id: completionId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: out.result.model,
      choices: [{ index: 0, message: { role: 'assistant', content: out.result.content }, finish_reason: 'stop' }],
      usage: out.result.usage,
      provider: out.provider,
      cost: out.cost,
      cache: { hit: false, bypassed: !useCache || undefined, rejected_near_match: cacheCtx.rejected ? cacheCtx.rejected.similarity : undefined },
      routing,
      attempts: out.attempts
    });
  }

  const status = out.error?.status || 502;
  await requestLog.record({ provider: 'none', cache: false, cost: 0, status: 'error', cacheBypassed: !useCache, ...common });
  if (out.error?.retryAfterSec) res.set('Retry-After', String(out.error.retryAfterSec));
  return res.status(status).json({
    error: {
      message: out.error?.message || 'Failed to process chat completion request across all configured providers',
      type: 'api_error',
      code: out.error?.code || 'ALL_PROVIDERS_FAILED',
      status,
      retry_after: out.error?.retryAfterSec
    },
    routing,
    attempts: out.attempts
  });
});

router.get('/stats', (req, res) => {
  res.json(semanticCache.getStats());
});

router.get('/live', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await buildLivePayload());
});

router.get('/providers', (req, res) => {
  res.json(buildProvidersPayload());
});

// Wipe cache + history (handy before a demo). Require MongoDB so reset does not
// leave old persisted records visible in the dashboard.
router.post('/reset', async (req, res) => {
  let deletedCount;
  try {
    deletedCount = await clearMongoRequests();
  } catch (err) {
    return res.status(503).json({
      ok: false,
      error: `MongoDB is unavailable; demo data was not reset (${err.message})`
    });
  }

  semanticCache.clear();
  requestLog.clear();
  providerStats.clear();
  circuit.resetAll();
  resetRoundRobin();
  res.json({ ok: true, deletedCount });
});

router.get('/summary', async (req, res) => {
  const summary = await getMongoSummary();
  res.json(summary);
});

export default router;
