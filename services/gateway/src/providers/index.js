import * as groq from './groq.js';
import * as openrouter from './openrouter.js';
import * as nvidia from './nvidia.js';
import * as gemini from './gemini.js';
import * as sambanova from './sambanova.js';
import * as mistral from './mistral.js';
import * as huggingface from './huggingface.js';
import * as github from './github.js';
import * as ollama from './ollama.js';
import * as cerebras from './cerebras.js';
import * as cloudflare from './cloudflare.js';
import * as cohere from './cohere.js';
import * as together from './together.js';
import * as lmstudio from './lmstudio.js';

// Mutable map so tests can swap in fake adapters. `openai` is an alias of openrouter.
export const providers = {
  groq,
  openrouter,
  openai: openrouter,
  nvidia,
  gemini,
  sambanova,
  mistral,
  huggingface,
  github,
  cerebras,
  cloudflare,
  cohere,
  together,
  ollama,
  lmstudio
};

export const ALIASES = { openai: 'openrouter' };

export const DEFAULT_ORDER =
  'groq,openrouter,nvidia,gemini,cerebras,cloudflare,cohere,together,sambanova,mistral,huggingface,github,ollama,lmstudio';

/** Names shipped with the gateway (plus aliases and reserved words); custom providers may not use them. */
export const BUILTIN_NAMES = new Set([...Object.keys(providers), 'cache', 'none', 'all', 'custom', 'auto', 'default', 'unknown']);
export const isBuiltin = name => BUILTIN_NAMES.has(String(name || '').toLowerCase());

// ---------------------------------------------------------------- custom providers
// Registered at runtime (dashboard / data/providers.enc.json). The router merges
// getCustomCatalog() into its catalog per request, so new providers route immediately.
const customCatalog = {};

/**
 * @param {string} name   slug, not a builtin
 * @param {object} adapter { sendChatCompletion, calculateCost, isConfigured, defaultModel?, timeoutMs? }
 * @param {object} catalogEntry { label, custom: true, models: {light,standard,heavy},
 *                                quality: {light,standard,heavy}, price: {prompt,completion} (USD/1M), speed }
 */
export function registerProvider(name, adapter, catalogEntry) {
  if (!name || isBuiltin(name)) throw new Error(`Cannot register provider '${name}': name is reserved`);
  if (!adapter || typeof adapter.sendChatCompletion !== 'function') throw new Error('adapter.sendChatCompletion is required');
  providers[name] = adapter;
  customCatalog[name] = { custom: true, ...catalogEntry };
}

export function unregisterProvider(name) {
  if (isBuiltin(name)) return false;
  const had = Boolean(customCatalog[name]);
  delete customCatalog[name];
  if (had) delete providers[name];
  return had;
}

/** { [name]: catalogEntry } for custom providers (fresh copy). */
export function getCustomCatalog() {
  const out = {};
  for (const [k, v] of Object.entries(customCatalog)) {
    out[k] = { ...v, models: { ...v.models }, quality: { ...v.quality }, price: { ...v.price } };
  }
  return out;
}

export const isCustom = name => Boolean(customCatalog[name]);

/**
 * Catalog hints for built-ins the router's DEFAULTS table does not know yet
 * (same shape as getCustomCatalog entries; models read env live).
 */
export function getBuiltinCatalogHints() {
  const m = (p, d) => {
    const standard = process.env[`${p}_MODEL`] || d;
    return { light: process.env[`${p}_MODEL_LIGHT`] || standard, standard, heavy: process.env[`${p}_MODEL_HEAVY`] || standard };
  };
  return {
    together: {
      label: 'Together AI', custom: false,
      models: m('TOGETHER', 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free'),
      quality: { light: 0.72, standard: 0.72, heavy: 0.72 },
      price: { prompt: 0, completion: 0 }, speed: 0.6
    },
    lmstudio: {
      label: 'LM Studio', custom: false,
      models: m('LMSTUDIO', 'local-model'),
      quality: { light: 0.45, standard: 0.45, heavy: 0.45 },
      price: { prompt: 0, completion: 0 }, speed: 0.4
    }
  };
}

export function canonicalName(name) {
  if (!name || typeof name !== 'string') return null;
  const key = name.trim().toLowerCase();
  const actual = ALIASES[key] || key;
  return providers[actual] ? actual : null;
}

/** All real provider names (no aliases). */
export function providerNames() {
  return Object.keys(providers).filter(k => !ALIASES[k]);
}

/** Configured = the adapter says so (API key present etc.).
 *  Adapters without isConfigured (test fakes) count as configured. */
export function isConfigured(name) {
  const adapter = providers[name];
  if (!adapter) return false;
  if (typeof adapter.isConfigured !== 'function') return true;
  try { return Boolean(adapter.isConfigured()); } catch { return false; }
}

/** Requested provider first, then PROVIDER_ORDER, then any remaining providers. */
export function getProviderChain(requestedProvider) {
  const envOrder = (process.env.PROVIDER_ORDER || DEFAULT_ORDER).split(',').map(s => s.trim()).filter(Boolean);
  const chain = [];
  const push = n => { const c = canonicalName(n); if (c && !chain.includes(c)) chain.push(c); };
  if (requestedProvider) push(requestedProvider);
  envOrder.forEach(push);
  providerNames().forEach(push);
  return chain;
}

// Load saved custom providers once the module graph is ready (server and worker both
// import this module). Skipped under node --test; tests call loadCustomProviders().
export const customProvidersReady = process.env.NODE_TEST_CONTEXT
  ? Promise.resolve(0)
  : import('./customProvider.js')
    .then(m => m.loadCustomProviders())
    .catch(err => { console.warn(`[Providers] Could not load custom providers: ${err.message}`); return 0; });
