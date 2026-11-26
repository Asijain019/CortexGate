// Dashboard-managed provider secrets, encrypted at rest in <DATA_DIR>/providers.enc.json.
//
// Document shape (only ever on disk encrypted):
//   { version: 1, builtin: { [provider]: { apiKey?, accountId?, updatedAt } }, custom: [CustomRecord] }
//
// getProviderKey(envNames, name?) -> dashboard key for that provider if saved, else first env value.
// Every adapter calls it per request, so key changes apply immediately.
import { readEncryptedFile, writeEncryptedFile, maskKey } from '../security/secrets.js';

export const STORE_FILE = 'providers.enc.json';

/** Built-in providers whose credentials the dashboard can manage. */
export const BUILTIN_KEYS = {
  groq: { label: 'Groq', keyEnv: ['GROQ_API_KEY'] },
  openrouter: { label: 'OpenRouter', keyEnv: ['OPENROUTER_API_KEY', 'OPENAI_API_KEY'] },
  nvidia: { label: 'NVIDIA NIM', keyEnv: ['NVIDIA_API_KEY', 'NVDIA_API_KEY'] },
  gemini: { label: 'Google Gemini', keyEnv: ['GEMINI_API_KEY'] },
  cerebras: { label: 'Cerebras', keyEnv: ['CEREBRAS_API_KEY'] },
  cloudflare: { label: 'Cloudflare Workers AI', keyEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY'], accountEnv: ['CLOUDFLARE_ACCOUNT_ID'] },
  cohere: { label: 'Cohere', keyEnv: ['COHERE_API_KEY'] },
  together: { label: 'Together AI', keyEnv: ['TOGETHER_API_KEY'] },
  sambanova: { label: 'SambaNova', keyEnv: ['SAMBANOVA_API_KEY'] },
  mistral: { label: 'Mistral', keyEnv: ['MISTRAL_API_KEY'] },
  huggingface: { label: 'Hugging Face', keyEnv: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'] },
  github: { label: 'GitHub Models', keyEnv: ['GITHUB_TOKEN'] },
  ollama: { label: 'Ollama (local)', keyEnv: ['OLLAMA_API_KEY'], keyless: true },
  lmstudio: { label: 'LM Studio (local)', keyEnv: ['LMSTUDIO_API_KEY'], keyless: true }
};

const inTestWithoutDir = () => Boolean(process.env.NODE_TEST_CONTEXT) && !process.env.DATA_DIR;

let store = null;
let loadError = null;

function emptyStore() {
  return { version: 1, builtin: {}, custom: [] };
}

/** Load (once) and return the decrypted store. Never throws; a load error blocks writes. */
export function getStore() {
  if (store) return store;
  if (inTestWithoutDir()) { store = emptyStore(); return store; }
  try {
    const doc = readEncryptedFile(STORE_FILE);
    store = { ...emptyStore(), ...(doc || {}) };
    if (!store.builtin || typeof store.builtin !== 'object') store.builtin = {};
    if (!Array.isArray(store.custom)) store.custom = [];
    loadError = null;
  } catch (err) {
    loadError = err.message;
    console.warn(`[KeyStore] Could not read ${STORE_FILE}: ${err.message}. Dashboard keys are ignored and writes are blocked until this is fixed.`);
    store = emptyStore();
  }
  return store;
}

export function getLoadError() {
  getStore();
  return loadError;
}

/** Persist the current store. Throws if the existing file could not be decrypted (avoid data loss). */
export function saveStore() {
  const s = getStore();
  if (loadError) throw Object.assign(new Error(`Key store is unreadable (${loadError}); refusing to overwrite it`), { status: 500 });
  if (inTestWithoutDir()) return;
  writeEncryptedFile(STORE_FILE, s);
}

/** Test helper: drop the in-memory copy so the next call re-reads disk. */
export function _reload() {
  store = null;
  loadError = null;
}

function firstEnv(names = []) {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return '';
}

function providerForEnv(envNames) {
  const first = envNames?.[0];
  if (!first) return null;
  for (const [name, def] of Object.entries(BUILTIN_KEYS)) if (def.keyEnv.includes(first)) return name;
  return null;
}

/** Dashboard key (if saved) else first non-empty env var. */
export function getProviderKey(envNames = [], name = providerForEnv(envNames)) {
  const saved = name ? getStore().builtin[name]?.apiKey : '';
  return saved || firstEnv(envNames);
}

/** Cloudflare account id: dashboard value else env. */
export function getProviderAccountId(name, envNames = BUILTIN_KEYS[name]?.accountEnv || []) {
  return getStore().builtin[name]?.accountId || firstEnv(envNames);
}

export function keySource(name) {
  const def = BUILTIN_KEYS[name];
  if (!def) return null;
  if (getStore().builtin[name]?.apiKey) return 'dashboard';
  return firstEnv(def.keyEnv) ? 'env' : null;
}

export function keyHint(name) {
  return maskKey(getProviderKey(BUILTIN_KEYS[name]?.keyEnv || [], name)) || null;
}

export function accountIdSource(name) {
  const def = BUILTIN_KEYS[name];
  if (!def?.accountEnv) return null;
  if (getStore().builtin[name]?.accountId) return 'dashboard';
  return firstEnv(def.accountEnv) ? 'env' : null;
}

export function setBuiltinKey(name, { apiKey, accountId } = {}) {
  const s = getStore();
  const prev = s.builtin[name] || {};
  const next = { ...prev, updatedAt: new Date().toISOString() };
  if (apiKey !== undefined) next.apiKey = apiKey;
  if (accountId !== undefined) next.accountId = accountId;
  s.builtin[name] = next;
  try {
    saveStore();
  } catch (err) {
    s.builtin[name] = prev.apiKey || prev.accountId ? prev : undefined;
    if (!s.builtin[name]) delete s.builtin[name];
    throw err;
  }
}

export function clearBuiltinKey(name) {
  const s = getStore();
  const prev = s.builtin[name];
  delete s.builtin[name];
  try {
    saveStore();
  } catch (err) {
    if (prev) s.builtin[name] = prev;
    throw err;
  }
}
