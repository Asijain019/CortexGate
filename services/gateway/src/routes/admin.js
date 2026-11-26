// Admin API: provider keys, custom OpenAI-compatible providers and client API keys.
//
// Auth: if ADMIN_TOKEN is set, header x-admin-token must match it (constant-time compare).
// Otherwise only loopback clients are accepted, and the Host header must be a loopback name
// (blocks DNS-rebinding pages). State-changing requests must be Content-Type: application/json
// and, when an Origin header is present, same-origin (cross-site browser requests are refused).
// API keys are never returned; responses carry keyHint only (first 3 + last 4 characters).
import { Router } from 'express';
import * as circuit from '../gateway/circuitBreaker.js';
import { providers, isConfigured } from '../providers/index.js';
import * as keyStore from '../providers/keyStore.js';
import * as custom from '../providers/customProvider.js';
import { safeEqual, redact, maskKey } from '../security/secrets.js';
import * as clientKeys from '../auth/clientKeys.js';
import { isLocalRequest, authMode } from '../middleware/clientAuth.js';

const router = Router();

const TEST_TIMEOUT_MS = 15000;

const fail = (res, status, message, extra = {}) => res.status(status).json({ ok: false, error: { message, ...extra } });

export function adminAuth(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (token) {
    if (!safeEqual(req.get('x-admin-token') || '', token)) return fail(res, 401, 'Admin token required (x-admin-token header)');
  } else if (!isLocalRequest(req)) {
    // Loopback socket + loopback Host (blocks DNS rebinding) + no proxy forwarding headers.
    return fail(res, 403, 'Admin API is only available from localhost unless ADMIN_TOKEN is set');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.get('origin');
    if (origin) {
      let originHost = null;
      try { originHost = new URL(origin).host.toLowerCase(); } catch { /* invalid */ }
      if (originHost !== String(req.get('host') || '').toLowerCase()) return fail(res, 403, 'Cross-origin admin requests are not allowed');
    }
    // A JSON content type forces a CORS preflight for cross-site POST/PUT/PATCH (DELETE always preflights).
    if (req.method !== 'DELETE' && !/^application\/json(;|\s|$)/i.test(req.get('content-type') || '')) {
      return fail(res, 415, 'Content-Type must be application/json');
    }
  }
  res.set('Cache-Control', 'no-store');
  next();
}

router.use(adminAuth);

// ---------------------------------------------------------------- presets

// Free / free-tier OpenAI-compatible services a user can add with their own key.
// `free` = usable without paying today (free tier, free model or trial credits); always check `note`:
// limits and offers change. `pricing` says which: free-tier | trial-credits | paid | local.
export const PRESETS = [
  { id: 'together', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
    signupUrl: 'https://api.together.ai/', free: true, pricing: 'free-tier', requiresKey: true, suggestedName: 'together-ai',
    note: 'Free tier/credits: select "-Free" models cost nothing but are tightly rate-limited; other models are paid. Limits change.' },
  { id: 'fireworks', label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', defaultModel: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    signupUrl: 'https://fireworks.ai/', free: true, pricing: 'trial-credits', requiresKey: true, suggestedName: 'fireworks',
    note: 'Trial credits on signup, then pay-as-you-go. Limits change.' },
  { id: 'deepinfra', label: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    signupUrl: 'https://deepinfra.com/', free: false, pricing: 'paid', requiresKey: true, suggestedName: 'deepinfra',
    note: 'Pay-as-you-go with low per-token prices; trial credits are sometimes offered. Limits change.' },
  { id: 'chutes', label: 'Chutes', baseUrl: 'https://llm.chutes.ai/v1', defaultModel: 'deepseek-ai/DeepSeek-V3-0324',
    signupUrl: 'https://chutes.ai/', free: true, pricing: 'free-tier', requiresKey: true, suggestedName: 'chutes',
    note: 'Free tier/credits: has offered free or very cheap models with daily limits; check current terms. Limits change.' },
  { id: 'novita', label: 'Novita AI', baseUrl: 'https://api.novita.ai/v3/openai', defaultModel: 'meta-llama/llama-3.1-8b-instruct',
    signupUrl: 'https://novita.ai/', free: true, pricing: 'trial-credits', requiresKey: true, suggestedName: 'novita',
    note: 'Trial credits on signup (small), then paid. Limits change.' },
  { id: 'scaleway', label: 'Scaleway Generative APIs', baseUrl: 'https://api.scaleway.ai/v1', defaultModel: 'llama-3.1-8b-instruct',
    signupUrl: 'https://www.scaleway.com/en/generative-apis/', free: true, pricing: 'free-tier', requiresKey: true, suggestedName: 'scaleway',
    note: 'Free tier/credits: a free monthly token allowance, then paid (account + billing details required). Limits change.' },
  { id: 'groq-compatible', label: 'Groq (second key / other model)', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.1-8b-instant',
    signupUrl: 'https://console.groq.com/keys', free: true, pricing: 'free-tier', requiresKey: true, suggestedName: 'groq-2',
    note: 'Free tier/credits: free with per-model rate limits; Groq is also built in, so pick a different name. Limits change.' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini',
    signupUrl: 'https://platform.openai.com/api-keys', free: false, pricing: 'paid', requiresKey: true, suggestedName: 'openai-direct',
    note: 'Paid, prepaid credits required. The built-in "openai" name is an alias of OpenRouter, so use another name.' },
  { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', defaultModel: 'local-model',
    signupUrl: 'https://lmstudio.ai/', free: true, pricing: 'local', requiresKey: false, suggestedName: 'my-lmstudio',
    note: 'Runs on your machine, no key. Start the LM Studio server and use the model id it shows.' },
  { id: 'vllm', label: 'vLLM (local)', baseUrl: 'http://localhost:8000/v1', defaultModel: 'meta-llama/Llama-3.1-8B-Instruct',
    signupUrl: 'https://docs.vllm.ai/', free: true, pricing: 'local', requiresKey: false, suggestedName: 'my-vllm',
    note: 'Self-hosted, no key unless you start vLLM with --api-key. Use the model you served.' },
  { id: 'ollama', label: 'Ollama (local, OpenAI endpoint)', baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen2.5:0.5b',
    signupUrl: 'https://ollama.com/', free: true, pricing: 'local', requiresKey: false, suggestedName: 'my-ollama',
    note: 'Runs on your machine, no key. Pull the model first (ollama pull <model>).' }
];

// ---------------------------------------------------------------- views

const builtinTests = new Map();

function builtinView(name) {
  const def = keyStore.BUILTIN_KEYS[name];
  const view = {
    name,
    label: def.label,
    configured: isConfigured(name),
    keySource: keyStore.keySource(name),
    keyHint: keyStore.keyHint(name),
    envNames: def.keyEnv,
    keyless: Boolean(def.keyless),
    lastTest: builtinTests.get(name) || null
  };
  if (def.accountEnv) {
    view.needsAccountId = true;
    view.accountIdSource = keyStore.accountIdSource(name);
    view.accountIdHint = maskKey(keyStore.getProviderAccountId(name));
  }
  return view;
}

const builtinNames = () => Object.keys(keyStore.BUILTIN_KEYS).filter(n => providers[n]);

function resetBreaker(name) {
  try {
    if (typeof circuit.resetProvider === 'function') circuit.resetProvider(name);
  } catch { /* optional */ }
}

function handleError(res, err) {
  if (err instanceof custom.ValidationError || err?.status === 400) return fail(res, 400, err.message);
  console.warn(`[Admin] ${err?.message || err}`);
  return fail(res, err?.status && err.status >= 400 && err.status < 600 ? err.status : 500, err?.message || 'Internal error');
}

// ---------------------------------------------------------------- routes

router.get('/providers', (req, res) => {
  res.json({
    builtin: builtinNames().map(builtinView),
    custom: custom.listCustom(),
    presets: PRESETS,
    storeError: keyStore.getLoadError() || null
  });
});

router.put('/providers/builtin/:name/key', (req, res) => {
  const name = String(req.params.name || '').toLowerCase();
  const def = keyStore.BUILTIN_KEYS[name];
  if (!def || !providers[name]) return fail(res, 404, `Unknown built-in provider '${req.params.name}'`);
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'Request body must be a JSON object');
  try {
    const apiKey = custom.validateApiKey(body.apiKey);
    if (!apiKey && !def.keyless) return fail(res, 400, "'apiKey' is required");
    if (apiKey && apiKey.length < 8) return fail(res, 400, "'apiKey' looks too short");
    let accountId;
    if (body.accountId !== undefined && body.accountId !== null && body.accountId !== '') {
      if (!def.accountEnv) return fail(res, 400, `'accountId' is not used by ${name}`);
      if (typeof body.accountId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(body.accountId.trim())) {
        return fail(res, 400, "'accountId' must be 6-64 letters, digits, '-' or '_'");
      }
      accountId = body.accountId.trim();
    }
    if (def.accountEnv && !accountId && !keyStore.getProviderAccountId(name)) {
      return fail(res, 400, `'accountId' is required for ${name} (or set ${def.accountEnv[0]})`);
    }
    keyStore.setBuiltinKey(name, { apiKey: apiKey || undefined, accountId });
    resetBreaker(name);
    builtinTests.delete(name);
    res.json({ ok: true, provider: builtinView(name) });
  } catch (err) {
    handleError(res, err);
  }
});

router.delete('/providers/builtin/:name/key', (req, res) => {
  const name = String(req.params.name || '').toLowerCase();
  if (!keyStore.BUILTIN_KEYS[name] || !providers[name]) return fail(res, 404, `Unknown built-in provider '${req.params.name}'`);
  try {
    keyStore.clearBuiltinKey(name);
    resetBreaker(name);
    builtinTests.delete(name);
    res.json({ ok: true, provider: builtinView(name) });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/providers/custom', (req, res) => res.json(custom.listCustom()));

router.post('/providers/custom', (req, res) => {
  try {
    res.status(201).json(custom.createCustom(req.body));
  } catch (err) {
    handleError(res, err);
  }
});

router.patch('/providers/custom/:id', (req, res) => {
  try {
    const out = custom.updateCustom(req.params.id, req.body);
    if (!out) return fail(res, 404, `Custom provider '${req.params.id}' not found`);
    resetBreaker(out.name);
    res.json(out);
  } catch (err) {
    handleError(res, err);
  }
});

router.delete('/providers/custom/:id', (req, res) => {
  try {
    const rec = custom.findCustom(req.params.id);
    if (!rec || !custom.deleteCustom(req.params.id)) return fail(res, 404, `Custom provider '${req.params.id}' not found`);
    resetBreaker(rec.name);
    res.json({ ok: true, id: rec.id, name: rec.name });
  } catch (err) {
    handleError(res, err);
  }
});

/** 1-token round trip straight to the adapter (bypasses breaker, stats and cache). */
router.post('/providers/:name/test', async (req, res) => {
  const param = String(req.params.name || '');
  const rec = custom.findCustom(param);
  const name = rec ? rec.name : param.toLowerCase();
  const adapter = providers[name];
  if (!adapter) return fail(res, 404, `Unknown provider '${param}'`);

  const model = (typeof req.body?.model === 'string' && req.body.model.trim()) ||
    (rec ? rec.model : adapter.defaultModel?.()) || undefined;
  const secrets = rec ? [custom._secretOf(rec.id)] : [keyStore.getProviderKey(keyStore.BUILTIN_KEYS[name]?.keyEnv || [], name)];
  const started = Date.now();
  let result;
  if (!isConfigured(name)) {
    result = { ok: false, latencyMs: 0, model: model || null, error: rec ? 'Provider is disabled' : 'Provider is not configured (no API key / not enabled)' };
  } else {
    try {
      const out = await adapter.sendChatCompletion(
        { messages: [{ role: 'user', content: 'Reply with OK' }], model, max_tokens: 16 },
        { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) }
      );
      result = {
        ok: true,
        latencyMs: Date.now() - started,
        model: out?.model || model || null,
        sample: redact(String(out?.content ?? '').slice(0, 120), ...secrets)
      };
    } catch (err) {
      const timedOut = err?.code === 'PROVIDER_TIMEOUT' || err?.name === 'TimeoutError';
      result = {
        ok: false,
        latencyMs: Date.now() - started,
        model: model || null,
        status: err?.status || null,
        error: redact(timedOut ? `Timed out after ${TEST_TIMEOUT_MS}ms` : (err?.message || 'Request failed'), ...secrets).slice(0, 300)
      };
    }
  }
  const lastTest = { ok: result.ok, latencyMs: result.latencyMs, error: result.error || null, at: new Date().toISOString() };
  if (rec) custom.setLastTest(rec.id, lastTest);
  else builtinTests.set(name, lastTest);
  if (result.ok) resetBreaker(name);
  res.json(result);
});

// ---------------------------------------------------------------- client API keys
// Plain keys are returned exactly once (POST 201 { key, record }); records never include the hash.

function keyError(res, err) {
  if (err instanceof clientKeys.ValidationError) return fail(res, 400, err.message);
  return handleError(res, err);
}

router.get('/keys', (req, res) => {
  res.json({ keys: clientKeys.listKeys(), authMode: authMode() });
});

router.post('/keys', (req, res) => {
  try {
    const { key, record } = clientKeys.createKey(req.body);
    console.log(`[Admin] Created client key ${record.id} (${record.keyHint}) "${record.name}"`);
    res.status(201).json({ key, record });
  } catch (err) {
    keyError(res, err);
  }
});

router.patch('/keys/:id', (req, res) => {
  try {
    const record = clientKeys.updateKey(String(req.params.id), req.body);
    if (!record) return fail(res, 404, `Client key '${req.params.id}' not found`);
    res.json({ ok: true, record });
  } catch (err) {
    keyError(res, err);
  }
});

router.delete('/keys/:id', (req, res) => {
  const record = clientKeys.deleteKey(String(req.params.id));
  if (!record) return fail(res, 404, `Client key '${req.params.id}' not found`);
  console.log(`[Admin] Revoked client key ${record.id} (${record.keyHint})`);
  res.json({ ok: true, id: record.id });
});

/** Mount after the router on the same path: turns body-parser errors into JSON 400s. */
export function jsonErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.parse.failed') return fail(res, 400, 'Request body is not valid JSON');
  if (err?.type === 'entity.too.large') return fail(res, 413, 'Request body is too large');
  return fail(res, err?.status || 500, err?.expose ? err.message : 'Internal error');
}

export default router;
