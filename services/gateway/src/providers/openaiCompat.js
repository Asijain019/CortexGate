// Shared plumbing for provider adapters: error normalisation, Retry-After
// parsing, and a factory for OpenAI-compatible /chat/completions endpoints
// (groq, nvidia, openrouter, sambanova, mistral, github, huggingface, ollama,
// cerebras, cloudflare, cohere).
//
// Every adapter honours options.signal (dispatch passes AbortSignal.timeout)
// and throws errors shaped { status, code, retryAfterMs?, transient? }.
//
// Keys are resolved on every call through keyStore.getProviderKey, so a key saved
// from the dashboard (encrypted at rest) overrides the env var without a restart.
import { getProviderKey } from './keyStore.js';

export function providerError(message, status, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

/** Retry-After is either delta-seconds or an HTTP date. Returns ms or undefined. */
export function parseRetryAfter(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

export function retryAfterFromResponse(response) {
  try {
    return parseRetryAfter(response?.headers?.get?.('retry-after'));
  } catch {
    return undefined;
  }
}

export function isAbortError(err, signal) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError' || Boolean(signal?.aborted);
}

export function timeoutError(label) {
  return providerError(`${label} request timed out`, 504, { code: 'PROVIDER_TIMEOUT' });
}

/** Map a fetch() rejection to a gateway error. */
export function fetchFailure(err, label, signal) {
  if (isAbortError(err, signal)) return timeoutError(label);
  return providerError(`${label} network error: ${err?.message || 'unknown'}`, 502, { code: 'NETWORK_ERROR' });
}

export function notConfigured(label, envName) {
  return providerError(`${label}: ${envName} is not configured`, 500, { code: 'NOT_CONFIGURED', transient: false });
}

/** Build an error from a non-2xx response, extracting the provider's message. */
export async function httpFailure(response, label) {
  let message = `${label} API error (status ${response.status})`;
  try {
    const text = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
    try {
      const j = JSON.parse(text);
      const m = j?.error?.message || j?.detail || j?.message || (typeof j?.error === 'string' ? j.error : null) ||
        (Array.isArray(j?.errors) ? j.errors.map(e => e.message).join('; ') : null);
      if (m) message = `${label}: ${String(m).slice(0, 300)}`;
    } catch {
      if (text && text.trim()) message = `${label}: ${text.trim().slice(0, 200)}`;
    }
  } catch { /* body unreadable */ }
  const err = providerError(message, response.status);
  const retryAfterMs = retryAfterFromResponse(response);
  if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
  return err;
}

export function firstEnv(names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return '';
}

export function costFromPricing(pricing, usage, model, fallbackModel) {
  if (!usage || !pricing) return 0;
  const rates = pricing[model] || pricing[fallbackModel] || { prompt: 0, completion: 0 };
  const promptTokens = usage.prompt_tokens || usage.promptTokens || 0;
  const completionTokens = usage.completion_tokens || usage.completionTokens || 0;
  return (promptTokens * rates.prompt) + (completionTokens * rates.completion);
}

/**
 * Factory for an OpenAI-compatible adapter.
 * @param {object} cfg
 *   name, label, url (string or () => string), keyEnv (string[]; empty = no key needed),
 *   modelEnv, defaultModel, pricing ({model: {prompt, completion}} per token),
 *   headers (extra headers), isConfigured (optional override),
 *   timeoutMs (optional () => number: provider-specific per-attempt timeout hint),
 *   optionalKeyEnv (string[]: key sent if present but not required, e.g. a remote Ollama),
 *   resolveKey (optional () => string: overrides env/dashboard lookup; used by custom providers)
 */
export function createOpenAICompatAdapter(cfg) {
  const label = cfg.label || cfg.name;
  const keyEnv = cfg.keyEnv || [];
  const resolveUrl = () => (typeof cfg.url === 'function' ? cfg.url() : cfg.url);
  const defaultModel = () => (cfg.modelEnv && process.env[cfg.modelEnv]) || cfg.defaultModel;
  const resolveKey = () => {
    if (cfg.resolveKey) return cfg.resolveKey() || '';
    if (keyEnv.length) return getProviderKey(keyEnv, cfg.name);
    if (cfg.optionalKeyEnv?.length) return getProviderKey(cfg.optionalKeyEnv, cfg.name);
    return '';
  };

  function isConfigured() {
    if (cfg.isConfigured) return cfg.isConfigured();
    return keyEnv.length === 0 || Boolean(resolveKey());
  }

  function calculateCost(usage, model) {
    return costFromPricing(cfg.pricing, usage, model || defaultModel(), cfg.defaultModel);
  }

  async function sendChatCompletion({ messages, model, max_tokens: maxTokens }, options = {}) {
    const apiKey = resolveKey();
    if (keyEnv.length && !apiKey) throw notConfigured(label, keyEnv[0]);
    if (!isConfigured()) throw notConfigured(label, cfg.configEnv || 'configuration');

    const selectedModel = model || defaultModel();
    const signal = options.signal || AbortSignal.timeout(15000);
    const fetcher = options.fetch || globalThis.fetch;
    const headers = { 'Content-Type': 'application/json', ...(cfg.headers || {}) };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    let response;
    try {
      response = await fetcher(resolveUrl(), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: selectedModel, messages,
          ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { max_tokens: maxTokens } : {}),
          ...(cfg.extraBody || {})
        }),
        signal
      });
    } catch (err) {
      throw fetchFailure(err, label, signal);
    }

    if (!response.ok) throw await httpFailure(response, label);

    let raw;
    try {
      raw = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
    } catch (err) {
      throw fetchFailure(err, label, signal);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw providerError(`${label} returned a non-JSON response: ${String(raw).trim().slice(0, 100)}`, 502, { code: 'BAD_RESPONSE' });
    }
    const choice = data?.choices?.[0];
    if (!choice) {
      throw providerError(`${label} returned no choices`, 502, { code: 'BAD_RESPONSE' });
    }
    const content = typeof choice.message?.content === 'string' ? choice.message.content : '';
    const u = data.usage || {};
    const usage = {
      prompt_tokens: u.prompt_tokens || 0,
      completion_tokens: u.completion_tokens || 0,
      total_tokens: u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0)
    };
    return { content, usage, provider: cfg.name, model: data.model || selectedModel };
  }

  return {
    name: cfg.name,
    label,
    isConfigured,
    calculateCost,
    sendChatCompletion,
    defaultModel,
    timeoutMs: cfg.timeoutMs
  };
}
