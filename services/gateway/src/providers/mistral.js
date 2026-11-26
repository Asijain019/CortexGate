import fetch from 'node-fetch';

const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';

const PRICING = {
  'mistral-small-latest': { prompt: 0.20 / 1_000_000, completion: 0.60 / 1_000_000 },
  'open-mistral-7b': { prompt: 0.25 / 1_000_000, completion: 0.25 / 1_000_000 }
};

const DEFAULT_MODEL = 'mistral-small-latest';

export function calculateCost(usage, model) {
  if (!usage) return 0;
  const targetModel = model || process.env.MISTRAL_MODEL || DEFAULT_MODEL;
  const rates = PRICING[targetModel] || PRICING[DEFAULT_MODEL];
  const promptTokens = usage.prompt_tokens || usage.promptTokens || 0;
  const completionTokens = usage.completion_tokens || usage.completionTokens || 0;
  return (promptTokens * rates.prompt) + (completionTokens * rates.completion);
}

export async function sendChatCompletion({ messages, model }, options = {}) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    const error = new Error('MISTRAL_API_KEY is not configured');
    error.status = 500;
    error.transient = false;
    throw error;
  }

  const selectedModel = model || process.env.MISTRAL_MODEL || DEFAULT_MODEL;

  let response;
  try {
    const signal = options.signal || AbortSignal.timeout(15000);
    response = await fetch(MISTRAL_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: messages
      }),
      signal
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      const error = new Error('Mistral request timed out');
      error.status = 504;
      throw error;
    }
    const error = new Error(`Mistral network error: ${err.message}`);
    error.status = 500;
    throw error;
  }

  if (!response.ok) {
    let errorMsg = `Mistral API error (status ${response.status})`;
    try {
      const errorJson = await response.json();
      if (errorJson.error?.message) {
        errorMsg = errorJson.error.message;
      }
    } catch (_) {
      // Ignore JSON parse error
    }
    const error = new Error(errorMsg);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const choice = data.choices && data.choices[0];
  const content = choice?.message?.content || '';

  const usage = {
    prompt_tokens: data.usage?.prompt_tokens || 0,
    completion_tokens: data.usage?.completion_tokens || 0,
    total_tokens: data.usage?.total_tokens || (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0)
  };

  return {
    content,
    usage,
    provider: 'mistral',
    model: data.model || selectedModel
  };
}
