import crypto from 'crypto';
import { embed } from './embedder.js';
import { checkCachedAnswer } from './verifier.js';
import * as persist from '../stats/persist.js';

// In-memory store, saved to disk (data/cache.json) so it survives restarts.
// Later: swap `entries` for Qdrant/pgvector.
const entries = [];

const stats = {
  requests: 0,
  hits: 0,
  misses: 0,
  tokensSaved: 0,
  costSaved: 0,      // USD, counterfactual: what the avoided call would have cost
  verifications: 0,  // second-opinion checks on borderline matches
  rejections: 0,     // wrong hits blocked by the check
  verifyErrors: 0,
  verifyCost: 0      // USD spent on those checks
};

const threshold = () => parseFloat(process.env.CACHE_THRESHOLD || '0.88');
const trustAbove = () => parseFloat(process.env.CACHE_TRUST_ABOVE || '0.985');
const verifyOn = () => (process.env.CACHE_VERIFY || 'true').toLowerCase() !== 'false';
const ttlMs = () => parseInt(process.env.CACHE_TTL_MS || String(24 * 60 * 60 * 1000), 10);
const maxEntries = () => parseInt(process.env.CACHE_MAX_ENTRIES || '500', 10);

// ---- load from disk ----
const savedCache = persist.load('cache', null);
if (Array.isArray(savedCache?.entries)) {
  const now = Date.now();
  for (const e of savedCache.entries) {
    if (now - e.createdAt <= ttlMs()) entries.push(e);
  }
  console.log(`[Cache] Restored ${entries.length} entries from disk`);
}
Object.assign(stats, persist.load('cache-stats', {}));

const round = v => v.map(x => Math.round(x * 1e5) / 1e5);
const persistEntries = () => persist.save('cache', () => ({
  entries: entries.map(e => ({ ...e, vector: round(e.vector) }))
}), 1000);
const persistStats = () => persist.save('cache-stats', () => stats, 500);

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function contentToString(content) {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

// Text we embed = the last user message. Namespace = system prompt, so prompts
// under different system instructions never share cache entries.
export function extractKey(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const text = lastUser ? contentToString(lastUser.content).trim() : '';
  const system = messages.filter(m => m.role === 'system').map(m => contentToString(m.content)).join('\n');
  const namespace = crypto.createHash('sha1').update(system).digest('hex').slice(0, 12);
  // Multi-turn chats depend on history, so only single-turn prompts are cacheable.
  const cacheable = text.length > 0 && messages.filter(m => m.role !== 'system').length === 1;
  return { text, namespace, cacheable };
}

/**
 * Returns { vector, key, hit, rejected, verifyCost, verifyFailed }.
 * hit = { entry, similarity, verified } or null. Never throws.
 */
export async function lookup(messages) {
  const { text, namespace, cacheable } = extractKey(messages);
  stats.requests++;

  const miss = (extra = {}) => {
    stats.misses++;
    persistStats();
    return { vector: null, key: null, hit: null, rejected: null, verifyCost: 0, verifyFailed: false, ...extra };
  };

  if (!cacheable) return miss();

  let vector;
  try {
    vector = await embed(text);
  } catch (err) {
    console.warn(`[Cache] Embedding failed, skipping cache: ${err.message}`);
    return miss();
  }
  const key = { text, namespace };

  const now = Date.now();
  let best = null;
  let bestScore = -1;
  for (const e of entries) {
    if (e.namespace !== namespace || now - e.createdAt > ttlMs()) continue;
    const score = cosineSimilarity(vector, e.vector);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  console.log(`[Cache] Best similarity: ${bestScore.toFixed(3)} (threshold ${threshold()})`);

  if (!best || bestScore < threshold()) return miss({ vector, key });

  const registerHit = (verified, verifyCost) => {
    best.lastUsed = now;
    stats.hits++;
    stats.tokensSaved += best.response.usage?.total_tokens || 0;
    stats.costSaved += best.cost;
    persistStats();
    return {
      vector, key, rejected: null, verifyCost, verifyFailed: false,
      hit: { entry: best, similarity: bestScore, verified }
    };
  };

  // Very close match: trust it. Borderline match: ask a model to confirm.
  if (!verifyOn() || bestScore >= trustAbove()) return registerHit(false, 0);

  console.log(`[Cache] Borderline match (${bestScore.toFixed(3)}), verifying...`);
  const v = await checkCachedAnswer({ storedQuestion: best.prompt, storedAnswer: best.response.content, newQuestion: text });
  stats.verifications++;
  stats.verifyCost += v.cost || 0;

  if (v.same === true) {
    // Remember the new wording so next time it is an exact (trusted) match.
    entries.push({ ...best, prompt: text, vector, createdAt: now, lastUsed: now, alias: true });
    persistEntries();
    return registerHit(true, v.cost || 0);
  }
  if (v.same === false) {
    stats.rejections++;
    console.log(`[Cache] Match REJECTED by verification: "${best.prompt}" vs "${text}"`);
    return miss({ vector, key, rejected: { similarity: bestScore, against: best.prompt }, verifyCost: v.cost || 0 });
  }
  stats.verifyErrors++;
  console.warn('[Cache] Verification failed, treating as a miss (precision first)');
  return miss({ vector, key, verifyFailed: true, verifyCost: v.cost || 0 });
}

/** Store a successful answer. Call after the provider responds. */
export function store({ vector, key, response, cost, provider }) {
  if (!vector || !key) return;
  if (entries.length >= maxEntries()) {
    let idx = 0; // least-recently-used eviction
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].lastUsed < entries[idx].lastUsed) idx = i;
    }
    entries.splice(idx, 1);
  }
  const now = Date.now();
  entries.push({
    namespace: key.namespace, prompt: key.text, vector,
    response, cost, provider, createdAt: now, lastUsed: now
  });
  persistEntries();
}

export function getStats() {
  return {
    ...stats,
    netCostSaved: stats.costSaved - stats.verifyCost,
    hitRate: stats.requests ? stats.hits / stats.requests : 0,
    entries: entries.length,
    threshold: threshold(),
    trustAbove: trustAbove(),
    verifyEnabled: verifyOn()
  };
}

export function clear() {
  entries.length = 0;
  for (const k of Object.keys(stats)) stats[k] = 0;
  persistEntries();
  persistStats();
}
