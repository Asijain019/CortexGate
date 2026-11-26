import crypto from 'crypto';
import { embedWithInfo, getEmbedderState, resetEmbedder } from './embedder.js';
import { checkCachedAnswer } from './verifier.js';
import * as persist from '../stats/persist.js';

// Semantic cache: in-memory store, saved to disk (data/cache.json) so it survives restarts.
// Later: swap `entries` for Qdrant/pgvector.
//
// Lookup pipeline (lookup() never throws):
//   1. Not cacheable (multi-turn / empty)          -> skip   (stats.uncacheable)
//   2. Time-sensitive prompt (today, latest, ...)   -> bypass (stats.bypassedTimeSensitive), never stored
//   3. Embed last user message (memoized, see embedder.js); embedder down / cooling
//      down after a 429                             -> skip   (stats.skippedUnavailable)
//   4. Best entry in the same namespace (system-prompt hash), not expired (TTL),
//      by cosine similarity  sim = (a.b) / (|a| |b|)
//   5. sim <  CACHE_THRESHOLD                       -> miss
//   6. numbers in the two questions differ          -> miss   (stats.numericGuardMisses)
//   7. sim >= CACHE_TRUST_ABOVE and no negation mismatch -> trusted hit
//   8. otherwise (borderline, or exactly one question negated): one verifier
//      call (light tier) when CACHE_VERIFY=true; YES -> hit, NO -> miss (rejection),
//      error -> miss. With CACHE_VERIFY=false borderline -> hit, negation mismatch -> miss.
//
// Stats formulas:
//   hitRate   = hits / (hits + misses)    over cacheable lookups only (steps 4-8);
//               skipped/bypassed lookups are neither hits nor misses
//   costSaved = sum of the original provider cost of every served hit (counterfactual)
//   tokensSaved = sum of the original total_tokens of every served hit
//   netSaved  = costSaved - verifyCost - embedCost   (what the cache actually saved)
//   embedCost = sum over real embedding calls of ceil(chars/4) * EMBED_PRICE_PER_1M / 1e6

const entries = [];

const ZERO_STATS = {
  requests: 0,              // every lookup() call
  hits: 0,
  misses: 0,
  tokensSaved: 0,
  costSaved: 0,             // USD, counterfactual: what the avoided calls would have cost
  verifications: 0,         // second-opinion checks on borderline matches
  rejections: 0,            // wrong hits blocked by the check
  verifyErrors: 0,
  verifyCost: 0,            // USD spent on those checks
  embedCalls: 0,            // real embedding API calls (memo hits excluded)
  embedErrors: 0,           // failed embedding API calls
  embedMemoHits: 0,         // embeddings served from the exact-text memo
  embedCost: 0,             // USD, estimated
  embedTokens: 0,           // estimated input tokens sent to the embedder
  bypassedTimeSensitive: 0,
  skippedUnavailable: 0,    // embedder unavailable (cooldown, error, not configured)
  uncacheable: 0,           // multi-turn or empty prompts
  numericGuardMisses: 0,
  negationGuarded: 0        // matches that could not be trusted because of a negation mismatch
};
const stats = { ...ZERO_STATS };

const floatEnv = (name, def) => {
  const v = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) ? v : def;
};
const threshold = () => floatEnv('CACHE_THRESHOLD', 0.92);
const trustAbove = () => floatEnv('CACHE_TRUST_ABOVE', 0.985);
const verifyOn = () => (process.env.CACHE_VERIFY || 'true').toLowerCase() !== 'false';
const ttlMs = () => floatEnv('CACHE_TTL_MS', 24 * 60 * 60 * 1000);
const maxEntries = () => Math.max(1, Math.floor(floatEnv('CACHE_MAX_ENTRIES', 500)));

// ---- load from disk ----
const savedCache = persist.load('cache', null);
if (Array.isArray(savedCache?.entries)) {
  const now = Date.now();
  for (const e of savedCache.entries) {
    if (now - e.createdAt <= ttlMs() && Array.isArray(e.vector)) entries.push(e);
  }
  console.log(`[Cache] Restored ${entries.length} entries from disk`);
}
{
  const saved = persist.load('cache-stats', {});
  for (const k of Object.keys(ZERO_STATS)) if (Number.isFinite(saved?.[k])) stats[k] = saved[k];
}

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
  if (typeof content === 'string') return content;
  // OpenAI multi-part content: keep the text parts only.
  if (Array.isArray(content)) {
    const text = content.map(p => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : '')).join(' ').trim();
    if (text) return text;
  }
  return JSON.stringify(content ?? '');
}

// Text we embed = the last user message. Namespace = system prompt, so prompts
// under different system instructions never share cache entries.
export function extractKey(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const lastUser = [...list].reverse().find(m => m?.role === 'user');
  const text = lastUser ? contentToString(lastUser.content).trim() : '';
  const system = list.filter(m => m?.role === 'system').map(m => contentToString(m.content)).join('\n');
  const namespace = crypto.createHash('sha1').update(system).digest('hex').slice(0, 12);
  // Multi-turn chats depend on history, so only single-turn prompts are cacheable.
  const cacheable = text.length > 0 && list.filter(m => m?.role !== 'system').length === 1;
  return { text, namespace, cacheable };
}

// ---- guards ----

const normalize = s => String(s).toLowerCase().replace(/[‘’ʼ]/g, "'");

const TIME_SENSITIVE = [
  /\b(today|tonight|tomorrow|yesterday|right now|nowadays|as of now)\b/,
  /\bnow\b/,
  /(?<!\b(electric|electrical|alternating|direct|ocean|eddy)\s)\bcurrent(ly)?\b/,
  /\b(latest|recent|recently|newest|upcoming|breaking)\b|\blive (score|scores|stream|updates?|results?)\b/,
  /\b(this|next|last|coming) (year|month|week|weekend|season|quarter)\b/,
  /\b(weather|forecast|temperature outside|news|headlines?)\b/,
  /\b(stock|share) price\b|\bstock market\b|\bexchange rate\b|\bprice of (bitcoin|btc|eth|gold|oil)\b/,
  /\bwhat (time|day|date|year) is it\b|\b(today'?s|current) (date|time|day)\b|\bwhat'?s the (date|time)\b/,
  /\bscore\b.*\b(match|game)\b|\b(match|game)\b.*\bscore\b/
];
function customBypassPatterns() {
  const raw = process.env.CACHE_BYPASS_PATTERNS;
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean).flatMap(s => {
    try { return [new RegExp(s, 'i')]; } catch { return []; }
  });
}
export function isTimeSensitive(text) {
  const t = normalize(text);
  return TIME_SENSITIVE.some(re => re.test(t)) || customBypassPatterns().some(re => re.test(t));
}

const NEGATION = /\b(not|no|never|none|nobody|nothing|nowhere|neither|nor|without|except|excluding|cannot|cant|dont|doesnt|didnt|isnt|arent|wasnt|werent|wont|shouldnt|couldnt|wouldnt|hasnt|havent|hadnt)\b|n't\b/;
export function hasNegation(text) {
  return NEGATION.test(normalize(text));
}

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100, thousand: 1000, million: 1e6, billion: 1e9, half: 0.5, dozen: 12
};
/** Sorted, de-duplicated list of numbers mentioned (digits and common number words). */
export function extractNumbers(text) {
  const t = normalize(text);
  const out = new Set();
  for (const m of t.matchAll(/-?\d+(?:,\d{3})*(?:\.\d+)?/g)) out.add(String(Number(m[0].replace(/,/g, ''))));
  for (const m of t.matchAll(/\b[a-z]+\b/g)) if (m[0] in NUMBER_WORDS) out.add(String(NUMBER_WORDS[m[0]]));
  return [...out].sort();
}
export function sameNumbers(a, b) {
  const x = extractNumbers(a), y = extractNumbers(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// ---- entries ----

function purgeExpired(now = Date.now()) {
  const ttl = ttlMs();
  let removed = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (now - entries[i].createdAt > ttl) { entries.splice(i, 1); removed++; }
  }
  return removed;
}

// Insert, replacing an existing entry with the same namespace + prompt, and
// evicting the least-recently-used entry when full.
function insertEntry(entry) {
  const dup = entries.findIndex(e => e.namespace === entry.namespace && e.prompt === entry.prompt);
  if (dup !== -1) entries.splice(dup, 1);
  purgeExpired();
  while (entries.length >= maxEntries()) {
    let idx = 0;
    for (let i = 1; i < entries.length; i++) if (entries[i].lastUsed < entries[idx].lastUsed) idx = i;
    entries.splice(idx, 1);
  }
  entries.push(entry);
  persistEntries();
}

/**
 * Returns { vector, key, hit, rejected, verifyCost, verifyFailed, embedCost, skipped }.
 *   hit     = { entry, similarity, verified } or null
 *   key     = null when the result must not be stored (uncacheable / time-sensitive / embed failed)
 *   skipped = null | 'uncacheable' | 'time_sensitive' | 'unavailable'
 * Never throws.
 */
export async function lookup(messages) {
  let embedCost = 0;
  const base = { vector: null, key: null, hit: null, rejected: null, verifyCost: 0, verifyFailed: false, embedCost: 0, skipped: null };
  try {
    stats.requests++;
    const { text, namespace, cacheable } = extractKey(messages);

    const skip = (reason, counter) => {
      stats[counter]++;
      persistStats();
      return { ...base, skipped: reason, embedCost };
    };
    if (!cacheable) return skip('uncacheable', 'uncacheable');
    if (isTimeSensitive(text)) return skip('time_sensitive', 'bypassedTimeSensitive');

    let vector;
    try {
      const info = await embedWithInfo(text);
      vector = info.vector;
      if (info.memoHit) stats.embedMemoHits++;
      if (info.apiCall) {
        stats.embedCalls++;
        stats.embedTokens += info.tokens;
        stats.embedCost += info.cost;
        embedCost = info.cost;
      }
    } catch (err) {
      // A real call failed -> count it. Cooldown / shared / unconfigured -> no call was made.
      if (!['EMBED_COOLDOWN', 'EMBED_SHARED_FAILURE', 'EMBED_NOT_CONFIGURED'].includes(err.code)) {
        stats.embedCalls++;
        stats.embedErrors++;
      }
      console.warn(`[Cache] Embedding unavailable, skipping cache: ${err.message}`);
      return skip('unavailable', 'skippedUnavailable');
    }

    const key = { text, namespace };
    const miss = (extra = {}) => {
      stats.misses++;
      persistStats();
      return { ...base, vector, key, embedCost, ...extra };
    };

    const now = Date.now();
    let best = null;
    let bestScore = -1;
    for (const e of entries) {
      if (e.namespace !== namespace || now - e.createdAt > ttlMs()) continue;
      const score = cosineSimilarity(vector, e.vector);
      if (score > bestScore) { bestScore = score; best = e; }
    }

    if (!best || bestScore < threshold()) return miss();
    console.log(`[Cache] Best similarity: ${bestScore.toFixed(3)} (threshold ${threshold()})`);

    // "10 miles to km" vs "20 miles to km" embed almost identically: never serve across numbers.
    if (!sameNumbers(text, best.prompt)) {
      stats.numericGuardMisses++;
      return miss({ nearSimilarity: bestScore });
    }

    const registerHit = (verified, verifyCost) => {
      best.lastUsed = now;
      stats.hits++;
      stats.tokensSaved += best.response?.usage?.total_tokens || 0;
      stats.costSaved += Number(best.cost) || 0;
      persistStats();
      persistEntries();
      return { ...base, vector, key, embedCost, verifyCost, hit: { entry: best, similarity: bestScore, verified } };
    };

    // "is X good" vs "is X not good" embed almost identically: never trust-serve.
    const negationMismatch = hasNegation(text) !== hasNegation(best.prompt);
    if (negationMismatch) stats.negationGuarded++;

    if (!negationMismatch && bestScore >= trustAbove()) return registerHit(false, 0);
    if (!verifyOn()) return negationMismatch ? miss({ nearSimilarity: bestScore }) : registerHit(false, 0);

    // At most one verification per request (only the best candidate is checked).
    console.log(`[Cache] ${negationMismatch ? 'Negation mismatch' : 'Borderline match'} (${bestScore.toFixed(3)}), verifying...`);
    const v = await checkCachedAnswer({ storedQuestion: best.prompt, storedAnswer: best.response?.content, newQuestion: text });
    const verifyCost = Number(v.cost) || 0;
    stats.verifications++;
    stats.verifyCost += verifyCost;

    if (v.same === true) {
      // Remember the new wording so next time it is an exact (trusted) match.
      insertEntry({ ...best, prompt: text, vector, createdAt: now, lastUsed: now, alias: true });
      return registerHit(true, verifyCost);
    }
    if (v.same === false) {
      stats.rejections++;
      console.log(`[Cache] Match REJECTED by verification: "${best.prompt}" vs "${text}"`);
      return miss({ rejected: { similarity: bestScore, against: best.prompt }, verifyCost });
    }
    stats.verifyErrors++;
    console.warn('[Cache] Verification failed, treating as a miss (precision first)');
    return miss({ verifyFailed: true, verifyCost });
  } catch (err) {
    console.warn(`[Cache] Lookup error, skipping cache: ${err.message}`);
    return { ...base, embedCost, skipped: 'unavailable' };
  }
}

/** Store a successful answer. Call after the provider responds. */
export function store({ vector, key, response, cost, provider }) {
  try {
    if (!vector || !key || !response) return;
    if (isTimeSensitive(key.text)) return; // defensive: lookup() already returns key=null for these
    const now = Date.now();
    insertEntry({
      namespace: key.namespace, prompt: key.text, vector,
      response, cost: Number(cost) || 0, provider, createdAt: now, lastUsed: now
    });
  } catch (err) {
    console.warn(`[Cache] Store failed: ${err.message}`);
  }
}

export function getStats() {
  const lookups = stats.hits + stats.misses;
  const embedder = getEmbedderState();
  const netSaved = stats.costSaved - stats.verifyCost - stats.embedCost;
  return {
    ...stats,
    lookups,                         // cacheable lookups = hits + misses
    hitRate: lookups ? stats.hits / lookups : 0,
    netSaved,
    netCostSaved: netSaved,          // legacy name
    entries: entries.length,
    threshold: threshold(),
    trustAbove: trustAbove(),
    verifyEnabled: verifyOn(),
    embedCooldownUntil: embedder.cooldownUntil,
    embedLastStatus: embedder.lastStatus,
    embedMemoSize: embedder.memoSize
  };
}

export function clear() {
  entries.length = 0;
  Object.assign(stats, ZERO_STATS);
  resetEmbedder();
  persistEntries();
  persistStats();
}
