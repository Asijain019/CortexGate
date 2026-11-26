import fetch from 'node-fetch';

const SAMBANOVA_API_URL = 'https://api.sambanova.ai/v1/chat/completions';

const PRICING = {
  'gpt-oss-120b': { prompt: 0.15 / 1_000_000, completion: 0.60 / 1_000_000 },
  'Meta-Llama-3.1-8B-Instruct': { prompt: 0.10 / 1_000_000, completion: 0.20 / 1_000_000 },
  'Meta-Llama-3.3-70B-Instruct': { prompt: 0.60 / 1_000_000, completion: 1.20 / 1_000_000 }
};

const DEFAULT_MODEL = 'gpt-oss-120b';

export function calculateCost(usage, model) {
  if (!usage) return 0;
  const targetModel = model || process.env.SAMBANOVA_MODEL || DEFAULT_MODEL;
  const rates = PRICING[targetModel] || PRICING[DEFAULT_MODEL];
  const promptTokens = usage.prompt_tokens || usage.promptTokens || 0;
  const completionTokens = usage.completion_tokens || usage.completionTokens || 0;
  return (promptTokens * rates.prompt) + (completionTokens * rates.completion);
}

export async function sendChatCompletion({ messages, model }, options = {}) {
  const apiKey = process.env.SAMBANOVA_API_KEY;
  if (!apiKey) {
    const error = new Error('SAMBANOVA_API_KEY is not configured');
    error.status = 500;
    error.transient = false;
    throw error;
  }

  const selectedModel = model || process.env.SAMBANOVA_MODEL || DEFAULT_MODEL;

  let response;
  try {
    const signal = options.signal || AbortSignal.timeout(15000);
    response = await fetch(SAMBANOVA_API_URL, {
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
      const error = new Error('SambaNova request timed out');
      error.status = 504;
      throw error;
    }
    const error = new Error(`SambaNova network error: ${err.message}`);
    error.status = 500;
    throw error;
  }

  if (!response.ok) {
    let errorMsg = `SambaNova API error (status ${response.status})`;
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
    provider: 'sambanova',
    model: data.model || selectedModel
  };
}
