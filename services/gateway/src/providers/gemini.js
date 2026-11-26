import { providerError, fetchFailure, notConfigured, retryAfterFromResponse, costFromPricing } from './openaiCompat.js';
import { getProviderKey } from './keyStore.js';

// Dashboard-saved key (encrypted store) wins over GEMINI_API_KEY; resolved on every call.
const apiKeyNow = () => getProviderKey(['GEMINI_API_KEY'], 'gemini');

const M = 1_000_000;
export const PRICING = {
  'gemini-3.8-flash': { prompt: 0.10 / M, completion: 0.40 / M },
  'gemini-3.5-flash': { prompt: 0.10 / M, completion: 0.40 / M },
  'gemini-3.5-flash-lite': { prompt: 0.05 / M, completion: 0.20 / M },
  'gemini-2.5-flash': { prompt: 0.10 / M, completion: 0.40 / M },
  'gemini-2.0-flash': { prompt: 0.10 / M, completion: 0.40 / M },
  'gemini-1.5-flash': { prompt: 0.075 / M, completion: 0.30 / M },
  'gemini-1.5-pro': { prompt: 1.25 / M, completion: 5.00 / M }
};

const DEFAULT_MODEL = 'gemini-3.8-flash';
const DEFAULT_FALLBACK_MODEL = 'gemini-3.5-flash-lite';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const strip = m => String(m || '').trim().replace(/^models\//, '');

export function isConfigured() {
  return Boolean(apiKeyNow());
}

export function calculateCost(usage, model) {
  return costFromPricing(PRICING, usage, strip(model || process.env.GEMINI_MODEL || DEFAULT_MODEL), DEFAULT_MODEL);
}

/** GEMINI_FALLBACK_MODEL may be a comma-separated list. */
export function fallbackModels() {
  return (process.env.GEMINI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL).split(',').map(strip).filter(Boolean);
}

export async function listAvailableModels() {
  const apiKey = apiKeyNow();
  if (!apiKey) throw notConfigured('Gemini', 'GEMINI_API_KEY');
  const response = await fetch(`${BASE}/models?key=${encodeURIComponent(apiKey)}`);
  if (!response.ok) throw providerError(`Gemini list-models error (status ${response.status})`, response.status);
  const data = await response.json();
  return (data.models || [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .map(m => strip(m.name));
}

// google.rpc.RetryInfo { retryDelay: "31s" } inside error.details
function retryInfoMs(errorJson) {
  const details = errorJson?.error?.details;
  if (!Array.isArray(details)) return undefined;
  for (const d of details) {
    if (String(d['@type'] || '').includes('RetryInfo') && d.retryDelay) {
      const secs = parseFloat(String(d.retryDelay));
      if (Number.isFinite(secs)) return Math.round(secs * 1000);
    }
  }
  return undefined;
}

function toPayload(messages) {
  const text = c => (typeof c === 'string' ? c : JSON.stringify(c));
  const systemMessages = messages.filter(m => m.role === 'system');
  const payload = {
    contents: messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: text(m.content) }] }))
  };
  if (systemMessages.length) payload.systemInstruction = { parts: systemMessages.map(m => ({ text: text(m.content) })) };
  return payload;
}

/**
 * Tries the selected model, then each GEMINI_FALLBACK_MODEL on 429/503, all
 * under the single options.signal deadline that dispatch provides.
 */
export async function sendChatCompletion({ messages, model }, options = {}) {
  const apiKey = apiKeyNow();
  if (!apiKey) throw notConfigured('Gemini', 'GEMINI_API_KEY');

  const timeoutMs = parseInt(process.env.GEMINI_TIMEOUT_MS || '', 10);
  const signal = options.signal || AbortSignal.timeout(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000);
  const fetcher = options.fetch || globalThis.fetch;
  const payload = JSON.stringify(toPayload(messages));

  const models = [];
  for (const m of [strip(model || process.env.GEMINI_MODEL || DEFAULT_MODEL), ...fallbackModels()]) {
    if (m && !models.includes(m)) models.push(m);
  }

  for (let i = 0; i < models.length; i++) {
    const last = i === models.length - 1;
    let response;
    try {
      response = await fetcher(`${BASE}/models/${encodeURIComponent(models[i])}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal
      });
    } catch (err) {
      const e = fetchFailure(err, 'Gemini', signal);
      if (i > 0) e.transient = false;
      throw e;
    }

    if (!response.ok) {
      let message = `Gemini API error (status ${response.status})`;
      let errorJson = null;
      try {
        errorJson = await response.json();
        if (errorJson?.error?.message) message = `Gemini: ${String(errorJson.error.message).slice(0, 300)}`;
      } catch { /* non-JSON error body */ }
      const error = providerError(message, response.status);
      const retryAfterMs = retryAfterFromResponse(response) ?? retryInfoMs(errorJson);
      if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
      if ((response.status === 429 || response.status === 503) && !last && !signal.aborted) {
        console.warn(`[Gemini] Model '${models[i]}' returned ${response.status}; trying fallback model '${models[i + 1]}'`);
        continue;
      }
      if (i > 0) error.transient = false;
      throw error;
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      throw signal.aborted ? fetchFailure(err, 'Gemini', signal) : providerError('Gemini returned a non-JSON response', 502, { code: 'BAD_RESPONSE' });
    }
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const content = parts.map(p => p.text || '').join('');
    const u = data.usageMetadata || {};
    const total = u.totalTokenCount || 0;
    const prompt = u.promptTokenCount || 0;
    const candidates = u.candidatesTokenCount || 0;
    return {
      content,
      usage: {
        prompt_tokens: prompt,
        completion_tokens: total ? Math.max(0, total - prompt) : candidates,
        total_tokens: total || prompt + candidates
      },
      provider: 'gemini',
      model: data.modelVersion || models[i]
    };
  }
  throw providerError('Gemini request failed without an API response', 502);
}
