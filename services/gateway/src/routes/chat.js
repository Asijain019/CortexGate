import { Router } from 'express';
import { providers, getProviderChain } from '../providers/index.js';
import * as semanticCache from '../cache/semanticCache.js';
import * as requestLog from '../stats/requestLog.js';
import { getMongoSummary } from '../stats/mongoLogger.js';

const router = Router();

function isRetryableError(error) {
  if (!error) return false;
  const status = error.status;
  if (!status) return true; // Network error, timeout, etc.
  if (status === 429) return true; // Too Many Requests / Rate limit
  if (status >= 500 && status < 600) return true; // 5xx Server Error
  return false;
}

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
  const failedProviders = [];

  // --- Semantic cache lookup (skipped if x-cache: bypass) ---
  const useCache = req.headers['x-cache'] !== 'bypass';
  let cacheCtx = { vector: null, hit: null, key: null };
  if (useCache) {
    cacheCtx = await semanticCache.lookup(messages);
    if (cacheCtx.hit) {
      const { entry, similarity } = cacheCtx.hit;
      console.log(`[Gateway] CACHE HIT (similarity ${similarity.toFixed(3)}) - saved $${entry.cost.toFixed(6)}`);
      requestLog.record({ provider: 'cache', cache: true, similarity, cost: 0, savedCost: entry.cost, savedTokens: entry.response.usage?.total_tokens || 0, latencyMs: Date.now() - startedAt, prompt: promptPreview, failedProviders: [], status: 'ok' });
      return res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: entry.response.model,
        choices: [{ index: 0, message: { role: 'assistant', content: entry.response.content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        provider: 'cache',
        cost: 0,
        cache: { hit: true, similarity, original_provider: entry.provider, saved_cost: entry.cost, saved_tokens: entry.response.usage?.total_tokens || 0 }
      });
    }
  }

  const providerParam = requestedProvider || req.headers['x-provider'];
  const providerChain = getProviderChain(providerParam);

  let lastError = null;
  let result = null;
  let servingProvider = null;

  for (let i = 0; i < providerChain.length; i++) {
    const pName = providerChain[i];
    const adapter = providers[pName];

    console.log(`[Gateway] Attempting completion with provider: '${pName}'`);

    try {
      result = await adapter.sendChatCompletion({ messages, model });
      servingProvider = pName;
      console.log(`[Gateway] Request successfully served by provider: '${servingProvider}'`);
      break;
    } catch (err) {
      lastError = err;
      failedProviders.push(pName);
      const statusStr = err.status ? `(status ${err.status})` : '(network/timeout error)';
      console.warn(`[Gateway] Provider '${pName}' failed ${statusStr}: ${err.message}`);

      const hasNext = i < providerChain.length - 1;
      if (isRetryableError(err) && hasNext) {
        console.log(`[Gateway] Failover triggered: retrying with next provider in chain...`);
        continue;
      } else {
        break;
      }
    }
  }

  if (result) {
    const adapter = providers[servingProvider];
    const cost = adapter ? adapter.calculateCost(result.usage, result.model) : 0;

    // Write to cache (sync here is cheap; in-memory)
    if (useCache) {
      semanticCache.store({ vector: cacheCtx.vector, key: cacheCtx.key, response: result, cost, provider: servingProvider });
    }

    requestLog.record({ provider: servingProvider, cache: false, cost, tokens: result.usage?.total_tokens || 0, latencyMs: Date.now() - startedAt, prompt: promptPreview, failedProviders, status: 'ok' });
    return res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: result.content
          },
          finish_reason: 'stop'
        }
      ],
      usage: result.usage,
      provider: servingProvider,
      cost,
      cache: { hit: false }
    });
  }

  const status = lastError?.status || 500;
  requestLog.record({ provider: 'none', cache: false, cost: 0, latencyMs: Date.now() - startedAt, prompt: promptPreview, failedProviders, status: 'error' });
  return res.status(status).json({
    error: {
      message: lastError?.message || 'Failed to process chat completion request across all configured providers',
      type: 'api_error',
      status
    }
  });
});

router.get('/stats', (req, res) => {
  res.json(semanticCache.getStats());
});

router.get('/live', (req, res) => {
  res.json({ cache: semanticCache.getStats(), ...requestLog.getLive() });
});

router.get('/summary', async (req, res) => {
  const summary = await getMongoSummary();
  res.json(summary);
});

export default router;
