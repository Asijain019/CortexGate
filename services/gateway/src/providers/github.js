import fetch from 'node-fetch';

const GITHUB_MODELS_URL = 'https://models.github.ai/inference/chat/completions';

const DEFAULT_MODEL = 'openai/gpt-4o-mini';

export function calculateCost() {
  return 0;
}

export async function sendChatCompletion({ messages, model }, options = {}) {
  const apiKey = process.env.GITHUB_TOKEN;
  if (!apiKey) {
    const error = new Error('GITHUB_TOKEN is not configured');
    error.status = 500;
    error.transient = false;
    throw error;
  }

  const selectedModel = model || process.env.GITHUB_MODEL || DEFAULT_MODEL;

  let response;
  try {
    const signal = options.signal || AbortSignal.timeout(15000);
    response = await fetch(GITHUB_MODELS_URL, {
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
      const error = new Error('GitHub Models request timed out');
      error.status = 504;
      throw error;
    }
    const error = new Error(`GitHub Models network error: ${err.message}`);
    error.status = 500;
    throw error;
  }

  if (!response.ok) {
    let errorMsg = `GitHub Models API error (status ${response.status})`;
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

  const rawBody = await response.text();
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (_) {
    const error = new Error(`GitHub Models returned a non-JSON response: ${rawBody.trim().slice(0, 100)}`);
    error.status = 502;
    throw error;
  }
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
    provider: 'github',
    model: data.model || selectedModel
  };
}
