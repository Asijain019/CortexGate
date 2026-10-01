import crypto from 'crypto';
import { embed } from './embedder.js';

// In-memory store for the mid-term demo. Later: swap `entries` for Qdrant/pgvector.
const entries = [];

const stats = {
  requests: 0,
  hits: 0,
  misses: 0,
  tokensSaved: 0,
  costSaved: 0 // USD, counterfactual: what the avoided call would have cost
};

const threshold = () => parseFloat(process.env.CACHE_THRESHOLD || '0.92');
const ttlMs = () => parseInt(process.env.CACHE_TTL_MS || String(60 * 60 * 1000), 10);
const maxEntries = () => parseInt(process.env.CACHE_MAX_ENTRIES || '500', 10);

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

/** Returns { vector, hit } — hit is null on a miss. Never throws. */
export async function lookup(messages) {
  const { text, namespace, cacheable } = extractKey(messages);
  stats.requests++;
  if (!cacheable) {
    stats.misses++;
    return { vector: null, hit: null, key: null };
  }
  let vector;
  try {
    vector = await embed(text);
  } catch (err) {
    console.warn(`[Cache] Embedding failed, skipping cache: ${err.message}`);
    stats.misses++;
    return { vector: null, hit: null, key: null };
  }

  const now = Date.now();
  let best = null;
  let bestScore = -1;
  for (const e of entries) {
    if (e.namespace !== namespace || now - e.createdAt > ttlMs()) continue;
    const score = cosineSimilarity(vector, e.vector);
    if (score > bestScore) { bestScore = score; best = e; }
  }

  console.log(`[Cache] Best similarity: ${bestScore.toFixed(3)} (threshold ${threshold()})`);
  if (best && bestScore >= threshold()) {
    best.lastUsed = now;
    stats.hits++;
    stats.tokensSaved += best.response.usage?.total_tokens || 0;
    stats.costSaved += best.cost;
    return { vector, hit: { entry: best, similarity: bestScore }, key: { text, namespace } };
  }
  stats.misses++;
  return { vector, hit: null, key: { text, namespace } };
}

/** Store a successful answer. Call after the provider responds. */
export function store({ vector, key, response, cost, provider }) {
  if (!vector || !key) return;
  if (entries.length >= maxEntries()) {
    // least-recently-used eviction
    let idx = 0;
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
}

export function getStats() {
  return {
    ...stats,
    hitRate: stats.requests ? stats.hits / stats.requests : 0,
    entries: entries.length,
    threshold: threshold()
  };
}

export function clear() {
  entries.length = 0;
}
