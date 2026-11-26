import fetch from 'node-fetch';

const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

const DEFAULT_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';

export function calculateCost() {
  // NVIDIA NIM free developer credits
  return 0;
}

export async function sendChatCompletion({ messages, model }, options = {}) {
  const apiKey = process.env.NVIDIA_API_KEY || process.env.NVDIA_API_KEY;
  if (!apiKey) {
    const error = new Error('NVIDIA_API_KEY is not configured');
    error.status = 500;
    error.transient = false;
    throw error;
  }

  const selectedModel = model || process.env.NVIDIA_MODEL || DEFAULT_MODEL;

  let response;
  try {
    const signal = options.signal || AbortSignal.timeout(15000);
    response = await fetch(NVIDIA_API_URL, {
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
      const error = new Error('NVIDIA request timed out');
      error.status = 504;
      throw error;
    }
    const error = new Error(`NVIDIA network error: ${err.message}`);
    error.status = 500;
    throw error;
  }

  if (!response.ok) {
    let errorMsg = `NVIDIA API error (status ${response.status})`;
    try {
      const errorJson = await response.json();
      if (errorJson.detail || errorJson.error?.message) {
        errorMsg = errorJson.detail || errorJson.error.message;
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
    provider: 'nvidia',
    model: data.model || selectedModel
  };
}
