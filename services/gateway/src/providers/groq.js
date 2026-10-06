import fetch from 'node-fetch';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Pricing per 1M tokens in USD
const PRICING = {
  'openai/gpt-oss-20b': { prompt: 0.075 / 1_000_000, completion: 0.30 / 1_000_000 },
  'openai/gpt-oss-120b': { prompt: 0.15 / 1_000_000, completion: 0.60 / 1_000_000 },
  'qwen/qwen3.8-27b': { prompt: 0.10 / 1_000_000, completion: 0.40 / 1_000_000 }
};

const DEFAULT_MODEL = 'openai/gpt-oss-20b';

export function calculateCost(usage, model) {
  if (!usage) return 0;
  const targetModel = model || process.env.GROQ_MODEL || DEFAULT_MODEL;
  const rates = PRICING[targetModel] || PRICING[DEFAULT_MODEL];
  const promptTokens = usage.prompt_tokens || usage.promptTokens || 0;
  const completionTokens = usage.completion_tokens || usage.completionTokens || 0;
  return (promptTokens * rates.prompt) + (completionTokens * rates.completion);
}

export async function sendChatCompletion({ messages, model }, options = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    const error = new Error('GROQ_API_KEY is not configured');
    error.status = 500;
    error.transient = false;
    throw error;
  }

  const selectedModel = model || process.env.GROQ_MODEL || DEFAULT_MODEL;

  let response;
  try {
    const signal = options.signal || AbortSignal.timeout(15000);
    response = await fetch(GROQ_API_URL, {
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
      const error = new Error('Groq request timed out');
      error.status = 504;
      throw error;
    }
    const error = new Error(`Groq network error: ${err.message}`);
    error.status = 500;
    throw error;
  }

  if (!response.ok) {
    let errorMsg = `Groq API error (status ${response.status})`;
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
    provider: 'groq',
    model: data.model || selectedModel
  };
}
