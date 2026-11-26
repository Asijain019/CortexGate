import fetch from 'node-fetch';

const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B';

export function calculateCost() {
  return 0;
}

export async function sendChatCompletion({ messages, model }, options = {}) {
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  if (!apiKey) {
    const error = new Error('HUGGINGFACE_API_KEY is not configured');
    error.status = 500;
    error.transient = false;
    throw error;
  }

  const selectedModel = model || process.env.HUGGINGFACE_MODEL || DEFAULT_MODEL;
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const prompt = typeof lastUserMsg === 'string' ? lastUserMsg : JSON.stringify(lastUserMsg);

  let response;
  try {
    const signal = options.signal || AbortSignal.timeout(15000);
    const url = `https://router.huggingface.co/hf-inference/models/${selectedModel}`;
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: { max_new_tokens: 500, return_full_text: false }
      }),
      signal
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      const error = new Error('Hugging Face request timed out');
      error.status = 504;
      throw error;
    }
    const error = new Error(`Hugging Face network error: ${err.message}`);
    error.status = 500;
    throw error;
  }

  if (!response.ok) {
    let errorMsg = `Hugging Face API error (status ${response.status})`;
    try {
      const errorJson = await response.json();
      if (errorJson.error) {
        errorMsg = typeof errorJson.error === 'string' ? errorJson.error : JSON.stringify(errorJson.error);
      }
    } catch (_) {
      // Ignore JSON parse error
    }
    const error = new Error(errorMsg);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  let content = '';
  if (Array.isArray(data) && data[0]?.generated_text) {
    content = data[0].generated_text;
  } else if (typeof data === 'string') {
    content = data;
  } else if (data.generated_text) {
    content = data.generated_text;
  }

  return {
    content: content.trim(),
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    provider: 'huggingface',
    model: selectedModel
  };
}
