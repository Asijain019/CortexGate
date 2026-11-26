import fetch from 'node-fetch';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Pricing per 1M tokens in USD
const PRICING = {
  'liquid/lfm-3-1.7b:free': { prompt: 0, completion: 0 },
  'google/gemma-4-26b-a4b-it:free': { prompt: 0, completion: 0 },
  'nvidia/nemotron-3.5-lightning:free': { prompt: 0, completion: 0 },
  'meta-llama/llama-3.3-70b-instruct:free': { prompt: 0, completion: 0 },
  'deepseek/deepseek-r1:free': { prompt: 0, completion: 0 }
};

const DEFAULT_MODEL = 'liquid/lfm-3-1.7b:free';

export function calculateCost(usage, model) {
  if (!usage) return 0;
  const targetModel = model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const rates = PRICING[targetModel] || { prompt: 0, completion: 0 };
  const promptTokens = usage.prompt_tokens || usage.promptTokens || 0;
  const completionTokens = usage.completion_tokens || usage.completionTokens || 0;
  return (promptTokens * rates.prompt) + (completionTokens * rates.completion);
}

export async function sendChatCompletion({ messages, model }, options = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error('OPENROUTER_API_KEY / OPENAI_API_KEY is not configured');
    error.status = 500;
    error.transient = false;
    throw error;
  }

  const selectedModel = model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;

  let response;
  try {
    const signal = options.signal || AbortSignal.timeout(15000);
    response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://cortexgate.ai',
        'X-Title': 'CortexGate'
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: messages
      }),
      signal
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      const error = new Error('OpenRouter request timed out');
      error.status = 504;
      throw error;
    }
    const error = new Error(`OpenRouter network error: ${err.message}`);
    error.status = 500;
    throw error;
  }

  if (!response.ok) {
    let errorMsg = `OpenRouter API error (status ${response.status})`;
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
    provider: 'openrouter',
    model: data.model || selectedModel
  };
}
