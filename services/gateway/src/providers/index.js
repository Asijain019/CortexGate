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
  ollama
};

export const ALIASES = { openai: 'openrouter' };

export const DEFAULT_ORDER =
  'groq,openrouter,nvidia,gemini,cerebras,cloudflare,cohere,sambanova,mistral,huggingface,github,ollama';

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
