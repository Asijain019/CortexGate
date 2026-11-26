// Embeddings for the semantic cache.
//
// EMBEDDING_PROVIDER=gemini (default) | mock (offline testing only)
//
// Protection against provider rate limits (free-tier Gemini RPM is small):
//  1. Exact-text memo (LRU, EMBED_MEMO_SIZE, default 500): the same text is never
//     embedded twice; concurrent identical requests share one in-flight call.
//  2. Cooldown: a 429 (honoring Retry-After / RetryInfo) or 5xx/timeout puts the
//     embedder in a short cooldown. During it embedWithInfo() fails fast with
//     code 'EMBED_COOLDOWN' and no network call, so the cache is skipped instead
//     of delaying or failing the user's request.
//  3. Small timeout (EMBED_TIMEOUT_MS, default 5000).
//
// Cost estimate (gemini-embedding-001 bills input tokens only):
//   tokens = ceil(chars / 4)
//   cost   = tokens * EMBED_PRICE_PER_1M / 1e6      (default 0.15 USD per 1M tokens)

const EMBEDDING_MODEL = () => (process.env.EMBEDDING_MODEL || 'gemini-embedding-001').replace(/^models\//, '');
const provider = () => (process.env.EMBEDDING_PROVIDER || 'gemini').toLowerCase();
const num = (name, def) => {
  const v = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) && v >= 0 ? v : def;
};
const timeoutMs = () => num('EMBED_TIMEOUT_MS', 5000);
const memoSize = () => Math.max(0, Math.floor(num('EMBED_MEMO_SIZE', 500)));
const pricePer1M = () => num('EMBED_PRICE_PER_1M', 0.15);
const cooldown429Ms = () => num('EMBED_COOLDOWN_MS', 30000);        // when 429 has no Retry-After
const cooldownErrorMs = () => num('EMBED_ERROR_COOLDOWN_MS', 5000);  // after 5xx / timeout / network
const cooldownMaxMs = () => num('EMBED_COOLDOWN_MAX_MS', 120000);

export const estimateTokens = text => Math.ceil(String(text).length / 4);
export const estimateCost = text => (estimateTokens(text) * pricePer1M()) / 1e6;

// ---- state ----
const memo = new Map();      // key -> vector (Map keeps insertion order = LRU order)
const inflight = new Map();  // key -> Promise<vector>
let cooldownUntil = 0;
let lastStatus = null;       // last HTTP status (or 'timeout' / 'network')
let lastError = null;
let fetcher = (...args) => globalThis.fetch(...args);

/** Test hook: replace the HTTP client used for the Gemini embedding API. */
export function setFetch(fn) { fetcher = fn || ((...args) => globalThis.fetch(...args)); }

export function resetEmbedder() {
  memo.clear();
  inflight.clear();
  cooldownUntil = 0;
  lastStatus = null;
  lastError = null;
}

export function getEmbedderState() {
  return {
    provider: provider(),
    model: EMBEDDING_MODEL(),
    memoSize: memo.size,
    cooldownUntil: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null,
    lastStatus,
    lastError
  };
}

// Cheap offline embedder: hashed bag-of-words. Only matches prompts that share
// words, so it is NOT truly semantic. Use it for tests / when offline.
export function mockEmbed(text, dims = 256) {
  const vec = new Array(dims).fill(0);
  const stop = new Set(['the', 'a', 'an', 'is', 'of', 'what', 'which', 'to', 'in', 'and', 'for']);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !stop.has(w));
  for (const w of words) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    vec[h % dims] += 1;
  }
  return vec;
}

// Retry-After is seconds or an HTTP date; Google also puts RetryInfo.retryDelay ("23s") in the body.
function retryAfterMs(response, bodyText) {
  const header = response.headers?.get?.('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return secs * 1000;
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(bodyText || '');
  return m ? Number(m[1]) * 1000 : null;
}

function startCooldown(ms) {
  const until = Date.now() + Math.min(Math.max(ms, 0), cooldownMaxMs());
  if (until > cooldownUntil) cooldownUntil = until;
}

async function geminiEmbed(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY is not configured (needed for embeddings)');
    err.status = 500;
    err.code = 'EMBED_NOT_CONFIGURED';
    throw err;
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL()}:embedContent`;
  let response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      // Key in a header (not the URL) so it can never leak through logged URLs / error messages.
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        ...(process.env.EMBEDDING_TASK_TYPE ? { taskType: process.env.EMBEDDING_TASK_TYPE } : {})
      }),
      signal: AbortSignal.timeout(timeoutMs())
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    lastStatus = timedOut ? 'timeout' : 'network';
    startCooldown(cooldownErrorMs());
    const err = new Error(timedOut ? `Embedding request timed out after ${timeoutMs()}ms` : `Embedding network error: ${e?.message}`);
    err.status = timedOut ? 504 : 502;
    err.code = timedOut ? 'EMBED_TIMEOUT' : 'EMBED_NETWORK';
    throw err;
  }
  lastStatus = response.status;
  if (!response.ok) {
    let bodyText = '';
    try { bodyText = await response.text(); } catch { /* ignore */ }
    if (response.status === 429) startCooldown(retryAfterMs(response, bodyText) ?? cooldown429Ms());
    else if (response.status >= 500) startCooldown(cooldownErrorMs());
    const err = new Error(`Embedding API error (status ${response.status})`);
    err.status = response.status;
    err.code = response.status === 429 ? 'EMBED_RATE_LIMITED' : 'EMBED_HTTP';
    throw err;
  }
  const data = await response.json();
  const values = data.embedding?.values;
  if (!Array.isArray(values) || !values.length) {
    const err = new Error('Embedding API returned no vector');
    err.code = 'EMBED_EMPTY';
    throw err;
  }
  return values;
}

function memoGet(key) {
  if (!memo.has(key)) return null;
  const v = memo.get(key);
  memo.delete(key);   // refresh LRU position
  memo.set(key, v);
  return v;
}

function memoSet(key, vector) {
  const max = memoSize();
  if (!max) return;
  memo.delete(key);
  memo.set(key, vector);
  while (memo.size > max) memo.delete(memo.keys().next().value);
}

/**
 * Embed with bookkeeping. Resolves to
 *   { vector, memoHit, apiCall, tokens, cost }
 * apiCall = true when a real (billable) API call was made by this invocation.
 * Rejects with err.code:
 *   'EMBED_COOLDOWN' (no call made; embedder cooling down after a 429/5xx/timeout),
 *   'EMBED_RATE_LIMITED' | 'EMBED_HTTP' | 'EMBED_TIMEOUT' | 'EMBED_NETWORK' | ... (a call failed).
 */
export async function embedWithInfo(text) {
  const p = provider();
  const key = `${p}|${EMBEDDING_MODEL()}|${process.env.EMBEDDING_TASK_TYPE || ''}|${text}`;
  const cached = memoGet(key);
  if (cached) return { vector: cached, memoHit: true, apiCall: false, tokens: 0, cost: 0 };

  if (p === 'mock') {
    const vector = mockEmbed(text);
    memoSet(key, vector);
    return { vector, memoHit: false, apiCall: true, tokens: estimateTokens(text), cost: 0 };
  }

  // Identical text already being embedded by a concurrent request: share it (no extra call/cost).
  if (inflight.has(key)) {
    try {
      const vector = await inflight.get(key);
      return { vector, memoHit: true, apiCall: false, tokens: 0, cost: 0 };
    } catch (e) {
      const err = new Error(`Shared embedding call failed: ${e.message}`);
      err.code = 'EMBED_SHARED_FAILURE'; // the failed call is counted once, by its owner
      throw err;
    }
  }

  if (Date.now() < cooldownUntil) {
    const err = new Error(`Embedding provider cooling down for ${Math.ceil((cooldownUntil - Date.now()) / 1000)}s`);
    err.code = 'EMBED_COOLDOWN';
    throw err;
  }

  const promise = geminiEmbed(text);
  inflight.set(key, promise);
  try {
    const vector = await promise;
    memoSet(key, vector);
    lastError = null;
    return { vector, memoHit: false, apiCall: true, tokens: estimateTokens(text), cost: estimateCost(text) };
  } catch (err) {
    lastError = err.message;
    throw err;
  } finally {
    inflight.delete(key);
  }
}

/** Plain vector (used by scripts/tune-threshold.mjs). Throws on failure. */
export async function embed(text) {
  return (await embedWithInfo(text)).vector;
}
