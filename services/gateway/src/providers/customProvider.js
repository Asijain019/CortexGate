// User-defined OpenAI-compatible providers (added from the dashboard).
// Records (including their API keys) live in the encrypted key store; only the
// public view (keyHint, never the key) leaves this module.
import crypto from 'node:crypto';
import { createOpenAICompatAdapter } from './openaiCompat.js';
import { registerProvider, unregisterProvider, isBuiltin } from './index.js';
import { getStore, saveStore } from './keyStore.js';
import { maskKey } from '../security/secrets.js';

const M = 1_000_000;
const MAX_NAME = 40;

export class ValidationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME)
    .replace(/-+$/g, '');
}

/**
 * Normalise a base URL. Accepts ".../v1", ".../v1/", a bare host (→ "/v1" appended)
 * or the full ".../chat/completions" endpoint (suffix stripped). http(s) only, no credentials.
 */
export function normalizeBaseUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new ValidationError("'baseUrl' is required");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("'baseUrl' must be a valid absolute URL such as https://api.example.com/v1");
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ValidationError("'baseUrl' must use http or https");
  if (url.username || url.password) throw new ValidationError("'baseUrl' must not contain credentials; use 'apiKey'");
  if (url.search || url.hash) throw new ValidationError("'baseUrl' must not contain a query string or fragment");
  let p = url.pathname.replace(/\/+$/, '');
  p = p.replace(/\/chat\/completions$/i, '').replace(/\/completions$/i, '').replace(/\/+$/, '');
  if (!p) p = '/v1';
  return `${url.protocol}//${url.host}${p}`;
}

const isLocalUrl = u => {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h === 'host.docker.internal';
  } catch { return false; }
};

const records = () => getStore().custom;

function num(value, field, { min = 0, max = Infinity, def } = {}) {
  if (value === undefined || value === null || value === '') return def;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new ValidationError(`'${field}' must be a number between ${min} and ${max === Infinity ? 'any' : max}`);
  return n;
}

function str(value, field, { required = false, max = 200 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`'${field}' is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new ValidationError(`'${field}' must be a string`);
  const v = value.trim();
  if (required && !v) throw new ValidationError(`'${field}' is required`);
  if (v.length > max) throw new ValidationError(`'${field}' is too long (max ${max} characters)`);
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new ValidationError(`'${field}' contains control characters`);
  return v || undefined;
}

export function validateApiKey(value, field = 'apiKey') {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`'${field}' must be a string`);
  const v = value.trim();
  if (!v) return '';
  if (v.length > 1000) throw new ValidationError(`'${field}' is too long`);
  if (/\s|[\u0000-\u001f\u007f]/.test(v)) throw new ValidationError(`'${field}' must not contain whitespace or control characters`);
  return v;
}

const modelsOf = r => ({ light: r.modelLight || r.model, standard: r.model, heavy: r.modelHeavy || r.model });

/** The public CustomProvider shape (never contains the key). */
export function publicView(r) {
  return {
    id: r.id,
    name: r.name,
    label: r.label || r.name,
    baseUrl: r.baseUrl,
    model: r.model,
    models: modelsOf(r),
    quality: r.quality,
    price: { prompt: r.pricePrompt || 0, completion: r.priceCompletion || 0 },
    enabled: r.enabled !== false,
    keyHint: maskKey(r.apiKey),
    hasKey: Boolean(r.apiKey),
    local: isLocalUrl(r.baseUrl),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastTest: r.lastTest || null
  };
}

function catalogEntry(r) {
  const q = r.quality;
  return {
    label: r.label || r.name,
    custom: true,
    models: modelsOf(r),
    quality: { light: q, standard: q, heavy: q },
    price: { prompt: r.pricePrompt || 0, completion: r.priceCompletion || 0 },
    speed: isLocalUrl(r.baseUrl) ? 0.4 : 0.7
  };
}

function buildAdapter(r) {
  // The adapter reads the live record so PATCHes (key, url, model) apply without re-registering.
  const live = () => records().find(x => x.id === r.id) || r;
  const rate = { prompt: (r.pricePrompt || 0) / M, completion: (r.priceCompletion || 0) / M };
  const pricing = {};
  for (const m of Object.values(modelsOf(r))) pricing[m] = rate;
  const base = createOpenAICompatAdapter({
    name: r.name,
    label: r.label || r.name,
    url: () => `${live().baseUrl}/chat/completions`,
    keyEnv: [],
    resolveKey: () => live().apiKey || '',
    defaultModel: r.model,
    pricing,
    isConfigured: () => live().enabled !== false,
    configEnv: 'enabled=true',
    timeoutMs: isLocalUrl(r.baseUrl) ? () => parseInt(process.env.CUSTOM_LOCAL_TIMEOUT_MS || '30000', 10) : undefined
  });
  return {
    ...base,
    custom: true,
    id: r.id,
    defaultModel: () => live().model,
    calculateCost: usage => {
      const l = live();
      const p = usage?.prompt_tokens || 0;
      const c = usage?.completion_tokens || 0;
      return (p * (l.pricePrompt || 0) + c * (l.priceCompletion || 0)) / M;
    }
  };
}

function register(r) {
  unregisterProvider(r.name);
  registerProvider(r.name, buildAdapter(r), catalogEntry(r));
}

/** Register every saved custom provider. Returns how many were loaded. */
export function loadCustomProviders() {
  let n = 0;
  for (const r of records()) {
    try {
      if (!r?.name || isBuiltin(r.name)) continue;
      register(r);
      n++;
    } catch (err) {
      console.warn(`[CustomProvider] Skipping '${r?.name}': ${err.message}`);
    }
  }
  if (n) console.log(`[CustomProvider] Loaded ${n} custom provider(s)`);
  return n;
}

export function listCustom() {
  return records().map(publicView);
}

export function findCustom(idOrName) {
  const key = String(idOrName || '');
  return records().find(r => r.id === key || r.name === key) || null;
}

function parseBody(body, existing) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Request body must be a JSON object');
  const out = {};
  if (!existing || body.name !== undefined) {
    const rawName = str(body.name, 'name', { required: !existing, max: 80 });
    const name = slugify(rawName);
    if (!name) throw new ValidationError("'name' must contain at least one letter or digit");
    if (isBuiltin(name)) throw new ValidationError(`'name' "${name}" clashes with a built-in provider; choose another name`);
    const clash = records().find(r => r.name === name && r.id !== existing?.id);
    if (clash) throw new ValidationError(`A custom provider named "${name}" already exists`);
    out.name = name;
    if (body.label === undefined) out.label = rawName;
  }
  if (body.label !== undefined) out.label = str(body.label, 'label', { max: 80 }) || out.name || existing?.name;
  if (!existing || body.baseUrl !== undefined) out.baseUrl = normalizeBaseUrl(body.baseUrl);
  if (!existing || body.model !== undefined) out.model = str(body.model, 'model', { required: true, max: 200 });
  if (body.modelLight !== undefined) out.modelLight = str(body.modelLight, 'modelLight', { max: 200 }) || null;
  if (body.modelHeavy !== undefined) out.modelHeavy = str(body.modelHeavy, 'modelHeavy', { max: 200 }) || null;
  if (!existing || body.quality !== undefined) out.quality = num(body.quality, 'quality', { min: 0, max: 1, def: 0.6 });
  if (!existing || body.pricePrompt !== undefined) out.pricePrompt = num(body.pricePrompt, 'pricePrompt', { min: 0, max: 1000, def: 0 });
  if (!existing || body.priceCompletion !== undefined) out.priceCompletion = num(body.priceCompletion, 'priceCompletion', { min: 0, max: 1000, def: 0 });
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new ValidationError("'enabled' must be true or false");
    out.enabled = body.enabled;
  } else if (!existing) out.enabled = true;
  if (body.apiKey !== undefined && body.apiKey !== null) out.apiKey = validateApiKey(body.apiKey); // '' clears
  return out;
}

function persist(mutate, rollback) {
  mutate();
  try {
    saveStore();
  } catch (err) {
    rollback();
    throw err;
  }
}

export function createCustom(body) {
  const fields = parseBody(body, null);
  const now = new Date().toISOString();
  const r = {
    id: `cp_${crypto.randomBytes(6).toString('hex')}`,
    modelLight: null, modelHeavy: null, apiKey: '',
    ...fields,
    createdAt: now, updatedAt: now, lastTest: null
  };
  persist(() => records().push(r), () => { const i = records().indexOf(r); if (i >= 0) records().splice(i, 1); });
  register(r);
  return publicView(r);
}

export function updateCustom(id, body) {
  const r = findCustom(id);
  if (!r) return null;
  const fields = parseBody(body, r);
  const before = { ...r };
  persist(() => Object.assign(r, fields, { updatedAt: new Date().toISOString() }), () => {
    for (const k of Object.keys(r)) delete r[k];
    Object.assign(r, before);
  });
  if (before.name !== r.name) unregisterProvider(before.name);
  register(r);
  return publicView(r);
}

export function deleteCustom(id) {
  const r = findCustom(id);
  if (!r) return false;
  const idx = records().indexOf(r);
  persist(() => records().splice(idx, 1), () => records().splice(idx, 0, r));
  unregisterProvider(r.name);
  return true;
}

/** Store the last /test outcome on the record (best effort). */
export function setLastTest(id, lastTest) {
  const r = findCustom(id);
  if (!r) return;
  const prev = r.lastTest;
  try {
    persist(() => { r.lastTest = lastTest; }, () => { r.lastTest = prev; });
  } catch { r.lastTest = lastTest; /* keep in memory even if disk write fails */ }
}

/** The live (secret-bearing) key for redaction only; never returned to clients. */
export function _secretOf(idOrName) {
  return findCustom(idOrName)?.apiKey || '';
}
