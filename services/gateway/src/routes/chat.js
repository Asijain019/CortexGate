import { Router } from 'express';
import { providers } from '../providers/index.js';
import * as semanticCache from '../cache/semanticCache.js';
import * as requestLog from '../stats/requestLog.js';
import * as circuit from '../gateway/circuitBreaker.js';
import { dispatch } from '../gateway/dispatch.js';
import { getMongoSummary } from '../stats/mongoLogger.js';

const router = Router();

router.post('/completions', async (req, res) => {
  const { messages, model, provider: requestedProvider } = req.body || {};

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        message: "Invalid request: 'messages' must be a non-empty array.",
        type: 'invalid_request_error'
      }
    });
  }

  const startedAt = Date.now();
  const promptPreview = String(messages[messages.length - 1]?.content ?? '').slice(0, 70);

  // --- Semantic cache lookup (skipped if x-cache: bypass) ---
  const useCache = req.headers['x-cache'] !== 'bypass';
  let cacheCtx = { vector: null, hit: null, key: null, rejected: null, verifyCost: 0, verifyFailed: false };
  if (useCache) {
    cacheCtx = await semanticCache.lookup(messages);
    if (cacheCtx.hit) {
      const { entry, similarity, verified } = cacheCtx.hit;
      console.log(`[Gateway] CACHE HIT (similarity ${similarity.toFixed(3)}${verified ? ', verified' : ''}) - saved $${entry.cost.toFixed(6)}`);
      requestLog.record({
        provider: 'cache', cache: true, similarity, verified,
        cost: 0, verifyCost: cacheCtx.verifyCost, savedCost: entry.cost,
        savedTokens: entry.response.usage?.total_tokens || 0,
        latencyMs: Date.now() - startedAt, prompt: promptPreview,
        failedProviders: [], skippedProviders: [], status: 'ok'
      });
      return res.json({
        id: `chatcmpl-${Date.now()}`,
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
        }
      });
    }
  }

  const providerParam = requestedProvider || req.headers['x-provider'];
  const out = await dispatch({ messages, model, providerParam });

  const verification = cacheCtx.rejected ? 'rejected' : cacheCtx.verifyFailed ? 'failed' : null;
  const common = {
    latencyMs: Date.now() - startedAt, prompt: promptPreview,
    failedProviders: out.failedProviders, skippedProviders: out.skipped,
    verification, nearSimilarity: cacheCtx.rejected?.similarity ?? null,
    verifyCost: cacheCtx.verifyCost || 0
  };

  if (out.result) {
    if (useCache) {
      semanticCache.store({ vector: cacheCtx.vector, key: cacheCtx.key, response: out.result, cost: out.cost, provider: out.provider });
    }
    requestLog.record({
      provider: out.provider, cache: false, cost: out.cost,
      tokens: out.result.usage?.total_tokens || 0, status: 'ok', ...common
    });
    return res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: out.result.model,
      choices: [{ index: 0, message: { role: 'assistant', content: out.result.content }, finish_reason: 'stop' }],
      usage: out.result.usage,
      provider: out.provider,
      cost: out.cost,
      cache: { hit: false, rejected_near_match: cacheCtx.rejected ? cacheCtx.rejected.similarity : undefined }
    });
  }

  const status = out.lastError?.status || 500;
  requestLog.record({ provider: 'none', cache: false, cost: 0, status: 'error', ...common });
  return res.status(status).json({
    error: {
      message: out.lastError?.message || 'Failed to process chat completion request across all configured providers',
      type: 'api_error',
      status
    }
  });
});

router.get('/stats', (req, res) => {
  res.json(semanticCache.getStats());
});

router.get('/live', (req, res) => {
  res.json({
    cache: semanticCache.getStats(),
    ...requestLog.getLive(),
    breakers: circuit.getStatus(Object.keys(providers))
  });
});

// Wipe cache + history (handy before a demo).
router.post('/reset', (req, res) => {
  semanticCache.clear();
  requestLog.clear();
  circuit.resetAll();
  res.json({ ok: true });
});

router.get('/summary', async (req, res) => {
  const summary = await getMongoSummary();
  res.json(summary);
});

export default router;
