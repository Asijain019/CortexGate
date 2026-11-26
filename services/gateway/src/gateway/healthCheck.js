// Active provider health checks.
//
// Every HEALTHCHECK_INTERVAL_MS (default 60000; 0 disables) each configured provider
// that is not disabled (auth / billing / bad_response) or in 429 cooldown is probed:
//
//   1. A free GET on a cheap metadata endpoint (models list / key info) with a
//      HEALTHCHECK_TIMEOUT_MS (default 5000) timeout. No tokens are spent.
//        2xx + JSON    -> ok
//        401/403/402   -> provider disabled (auth / billing), like a failed request
//        non-JSON 2xx  -> disabled (bad_response)
//        5xx/network/timeout -> breaker opened now, before a user request hits it
//        404/429/other -> inconclusive (reported, no state change)
//   2. Only if the breaker is 'open' or 'probing' (and HEALTHCHECK_CHAT_PROBE is not
//      'false'): a tiny chat completion on the light model with the normal per-attempt
//      timeout, because the chat path is what failed. Success closes the breaker early;
//      failure keeps / re-opens it. Healthy providers never get chat probes, so no
//      quota is spent on them. Providers without a metadata endpoint (custom ones) only
//      get the chat probe, and only while their breaker is open.
//
// Results are exposed as providers[name].health = { lastCheckAt, ok, latencyMs, error }.
// Never started under NODE_ENV=test / node --test.
import * as circuit from './circuitBreaker.js';
import { providers, isConfigured } from '../providers/index.js';
import { configuredProviders, catalog, timeoutFor } from './router.js';

const intEnv = (name, def) => {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
};
export const healthCheckIntervalMs = () => intEnv('HEALTHCHECK_INTERVAL_MS', 60000);
const probeTimeoutMs = () => Math.max(500, intEnv('HEALTHCHECK_TIMEOUT_MS', 5000));
const chatProbeEnabled = () => String(process.env.HEALTHCHECK_CHAT_PROBE || 'true').toLowerCase() !== 'false';
const inTest = () => Boolean(process.env.NODE_TEST_CONTEXT) || process.env.NODE_ENV === 'test';

const ollamaBase = () => (process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');

// Free metadata endpoints. auth: 'bearer' (default) | 'google' (x-goog-api-key) | 'none'.
export const PROBES = {
  groq: { url: 'https://api.groq.com/openai/v1/models', keyEnv: ['GROQ_API_KEY'] },
  openrouter: { url: 'https://openrouter.ai/api/v1/key', keyEnv: ['OPENROUTER_API_KEY', 'OPENAI_API_KEY'] },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/models', keyEnv: ['NVIDIA_API_KEY', 'NVDIA_API_KEY'] },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', keyEnv: ['GEMINI_API_KEY'], auth: 'google' },
  sambanova: { url: 'https://api.sambanova.ai/v1/models', keyEnv: ['SAMBANOVA_API_KEY'] },
  mistral: { url: 'https://api.mistral.ai/v1/models', keyEnv: ['MISTRAL_API_KEY'] },
  huggingface: { url: 'https://huggingface.co/api/whoami-v2', keyEnv: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'] },
  github: { url: 'https://models.github.ai/catalog/models', keyEnv: ['GITHUB_TOKEN'] },
  cerebras: { url: 'https://api.cerebras.ai/v1/models', keyEnv: ['CEREBRAS_API_KEY'] },
  cloudflare: { url: 'https://api.cloudflare.com/client/v4/user/tokens/verify', keyEnv: ['CLOUDFLARE_API_TOKEN'] },
  cohere: { url: 'https://api.cohere.com/v1/models?page_size=1', keyEnv: ['COHERE_API_KEY'] },
  ollama: { url: () => `${ollamaBase()}/models`, keyEnv: [], auth: 'none' }
};

const health = new Map();
const blankHealth = () => ({ lastCheckAt: null, ok: null, latencyMs: null, error: null });

/** providers[name].health for the live payload. */
export function getHealth(name) {
  return { ...(health.get(name) || blankHealth()) };
}

export function clearHealth() {
  health.clear();
}

// ---------------------------------------------------------------- key lookup

let keyStorePromise = null;
function firstEnv(names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return '';
}

/** Dashboard-saved key (keyStore.js, if present) else the env value. Never logged. */
async function getKey(name, envNames) {
  if (!envNames.length) return '';
  keyStorePromise ??= import('../providers/keyStore.js').catch(() => null);
  const ks = await keyStorePromise;
  if (typeof ks?.getProviderKey === 'function') {
    try {
      const v = ks.getProviderKey(envNames, name);
      if (typeof v === 'string' && v.trim()) return v.trim();
    } catch { /* fall back to env */ }
  }
  return firstEnv(envNames);
}

// ---------------------------------------------------------------- probes

const errMsg = (e, fallback) => String(e?.message || fallback || 'error').slice(0, 200);

async function metadataProbe(name, spec, fetcher) {
  const url = typeof spec.url === 'function' ? spec.url() : spec.url;
  const headers = { Accept: 'application/json' };
  if (spec.auth !== 'none') {
    const key = await getKey(name, spec.keyEnv || []);
    if (key) {
      if (spec.auth === 'google') headers['x-goog-api-key'] = key;
      else headers.Authorization = `Bearer ${key}`;
    }
  }
  const t0 = Date.now();
  let res;
  try {
    res = await fetcher(url, { method: 'GET', headers, signal: AbortSignal.timeout(probeTimeoutMs()) });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { kind: 'down', latencyMs: Date.now() - t0, error: timedOut ? `health probe timed out after ${probeTimeoutMs()}ms` : `network error: ${errMsg(e)}` };
  }
  const latencyMs = Date.now() - t0;
  const status = res.status;
  if (status >= 200 && status < 300) {
    let text = '';
    try { text = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json()); } catch { /* empty */ }
    try {
      JSON.parse(text);
      return { kind: 'ok', latencyMs, status };
    } catch {
      return { kind: 'bad_response', latencyMs, status, error: `health probe returned a non-JSON response: ${String(text).trim().slice(0, 60)}` };
    }
  }
  const error = `health probe HTTP ${status}`;
  if (status === 401 || status === 403 || status === 402) return { kind: 'auth', latencyMs, status, error };
  if (status >= 500) return { kind: 'down', latencyMs, status, error };
  return { kind: 'inconclusive', latencyMs, status, error };
}

async function chatProbe(name) {
  const adapter = providers[name];
  const ms = timeoutFor(name);
  const t0 = Date.now();
  try {
    const signal = AbortSignal.timeout(ms);
    const call = Promise.resolve().then(() => adapter.sendChatCompletion(
      { messages: [{ role: 'user', content: 'Reply with the single word OK.' }], model: catalog(name).light.model, max_tokens: 8 },
      { signal }
    ));
    const timeout = new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error(`chat probe timed out after ${ms}ms`), { code: 'PROVIDER_TIMEOUT', status: 504 })), { once: true });
    });
    await Promise.race([call, timeout]);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, err: e };
  }
}

function applyChatFailure(name, err) {
  if (err?.status === 429) circuit.recordRateLimit(name, err.retryAfterMs, err);
  else if ([401, 402, 403].includes(err?.status)) circuit.recordAuthFailure(name, err);
  else if (err?.code === 'BAD_RESPONSE') circuit.recordBadResponse(name, err);
  else circuit.openBreaker(name, err);
}

/** Probe one provider and update breaker + health. Returns the health record. */
export async function checkProvider(name, { fetch: fetcher = globalThis.fetch } = {}) {
  const state = circuit.getState(name);
  if (state === 'disabled' || state === 'cooldown') return getHealth(name);
  const spec = PROBES[name];
  const rec = { ...blankHealth(), lastCheckAt: new Date().toISOString() };
  const breakerOpen = state === 'open' || state === 'probing';

  let metadataOk = null; // null = no metadata probe / inconclusive
  if (spec) {
    const r = await metadataProbe(name, spec, fetcher);
    rec.latencyMs = r.latencyMs;
    if (r.kind === 'ok') {
      metadataOk = true;
      rec.ok = true;
    } else {
      rec.ok = r.kind === 'inconclusive' ? null : false;
      rec.error = r.error;
      const err = Object.assign(new Error(r.error), { status: r.status });
      if (r.kind === 'auth') circuit.recordAuthFailure(name, err);
      else if (r.kind === 'bad_response') circuit.recordBadResponse(name, err);
      else if (r.kind === 'down') circuit.openBreaker(name, err);
      if (r.kind !== 'inconclusive') metadataOk = false;
    }
  }

  // Breaker open: confirm the chat path itself before closing it.
  if (breakerOpen && metadataOk !== false && providers[name]) {
    if (chatProbeEnabled()) {
      const r = await chatProbe(name);
      rec.latencyMs = r.latencyMs;
      if (r.ok) {
        rec.ok = true;
        rec.error = null;
        circuit.recordProbeSuccess(name);
      } else {
        rec.ok = false;
        rec.error = `chat probe: ${errMsg(r.err)}`;
        applyChatFailure(name, r.err);
      }
    } else if (metadataOk) {
      circuit.recordProbeSuccess(name);
    }
  }

  health.set(name, rec);
  return getHealth(name);
}

let running = null;

/** Probe every configured, non-disabled provider once (in parallel). */
export async function runHealthChecks({ fetch: fetcher, names } = {}) {
  if (running) return running;
  const list = (names || configuredProviders()).filter(n => providers[n] && isConfigured(n));
  running = (async () => {
    const results = await Promise.allSettled(list.map(n => checkProvider(n, { fetch: fetcher })));
    const summary = {};
    list.forEach((n, i) => {
      const r = results[i];
      summary[n] = r.status === 'fulfilled' ? r.value : { ...blankHealth(), ok: false, error: errMsg(r.reason) };
    });
    return summary;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

let timer = null;
let firstTimer = null;

/** Start periodic checks (no-op under test or when HEALTHCHECK_INTERVAL_MS=0). Returns stop(). */
export function startHealthChecks({ intervalMs = healthCheckIntervalMs(), firstDelayMs = 3000 } = {}) {
  stopHealthChecks();
  if (inTest() || !intervalMs) {
    if (!inTest()) console.log('[Health] Active health checks disabled (HEALTHCHECK_INTERVAL_MS=0)');
    return stopHealthChecks;
  }
  const tick = async () => {
    try {
      const s = await runHealthChecks();
      const desc = Object.entries(s)
        .map(([n, h]) => `${n}=${h.ok === true ? 'ok' : h.ok === false ? 'FAIL' : h.lastCheckAt ? '?' : circuit.getState(n)}`)
        .join(' ');
      console.log(`[Health] ${desc}`);
    } catch (e) {
      console.warn(`[Health] check failed: ${errMsg(e)}`);
    }
  };
  firstTimer = setTimeout(tick, firstDelayMs);
  firstTimer.unref?.();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  console.log(`[Health] Active health checks every ${Math.round(intervalMs / 1000)}s`);
  return stopHealthChecks;
}

export function stopHealthChecks() {
  clearTimeout(firstTimer);
  clearInterval(timer);
  firstTimer = null;
  timer = null;
}
