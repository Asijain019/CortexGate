import { Router } from 'express';
import { providers, getProviderChain } from '../providers/index.js';

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
      cost
    });
  }

  const status = lastError?.status || 500;
  return res.status(status).json({
    error: {
      message: lastError?.message || 'Failed to process chat completion request across all configured providers',
      type: 'api_error',
      status
    }
  });
});

export default router;
