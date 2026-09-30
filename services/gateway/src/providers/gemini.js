import fetch from 'node-fetch';

const PRICING = {
  'gemini-1.5-flash': { prompt: 0.075 / 1_000_000, completion: 0.30 / 1_000_000 },
  'gemini-2.0-flash': { prompt: 0.10 / 1_000_000, completion: 0.40 / 1_000_000 },
  'gemini-2.5-flash': { prompt: 0.10 / 1_000_000, completion: 0.40 / 1_000_000 },
  'gemini-1.5-pro': { prompt: 1.25 / 1_000_000, completion: 5.00 / 1_000_000 },
  'gemini-1.0-pro': { prompt: 0.50 / 1_000_000, completion: 1.50 / 1_000_000 }
};

const DEFAULT_MODEL = 'gemini-1.5-flash';

export function calculateCost(usage, model) {
  if (!usage) return 0;
  const targetModel = (model || process.env.GEMINI_MODEL || DEFAULT_MODEL).replace(/^models\//, '');
  const rates = PRICING[targetModel] || PRICING[DEFAULT_MODEL];
  const promptTokens = usage.prompt_tokens || usage.promptTokens || 0;
  const completionTokens = usage.completion_tokens || usage.completionTokens || 0;
  return (promptTokens * rates.prompt) + (completionTokens * rates.completion);
}

export async function listAvailableModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error('GEMINI_API_KEY is not configured');
    error.status = 500;
    throw error;
  }
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  if (!response.ok) {
    const error = new Error(`Gemini list-models error (status ${response.status})`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  return (data.models || [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''));
}

export async function sendChatCompletion({ messages, model }, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error('GEMINI_API_KEY is not configured');
    error.status = 500;
    throw error;
  }

  let selectedModel = model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  if (!selectedModel.startsWith('models/')) {
    selectedModel = `models/${selectedModel}`;
  }

  // Format messages for Gemini API
  let systemInstruction = undefined;
  const systemMessages = messages.filter(m => m.role === 'system');
  if (systemMessages.length > 0) {
    systemInstruction = {
      parts: systemMessages.map(m => ({
        text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      }))
    };
  }

  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => {
      const role = m.role === 'assistant' ? 'model' : 'user';
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return {
        role,
        parts: [{ text }]
      };
    });

  const payload = { contents };
  if (systemInstruction) {
    payload.systemInstruction = systemInstruction;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/${selectedModel}:generateContent?key=${apiKey}`;

  let response;
  try {
    const signal = options.signal || AbortSignal.timeout(15000);
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      const error = new Error('Gemini request timed out');
      error.status = 504;
      throw error;
    }
    const error = new Error(`Gemini network error: ${err.message}`);
    error.status = 500;
    throw error;
  }

  if (!response.ok) {
    let errorMsg = `Gemini API error (status ${response.status})`;
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
  const candidate = data.candidates && data.candidates[0];
  const parts = candidate?.content?.parts || [];
  const content = parts.map(p => p.text || '').join('');

  const usageMeta = data.usageMetadata || {};
  const usage = {
    prompt_tokens: usageMeta.promptTokenCount || 0,
    completion_tokens: usageMeta.candidatesTokenCount || 0,
    total_tokens: usageMeta.totalTokenCount || (usageMeta.promptTokenCount || 0) + (usageMeta.candidatesTokenCount || 0)
  };

  const cleanModelName = selectedModel.replace(/^models\//, '');

  return {
    content,
    usage,
    provider: 'gemini',
    model: cleanModelName
  };
}
