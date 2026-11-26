// Semantic cache tests. No network: the Gemini embedding HTTP client and the
// verifier's dispatch are stubbed, so vectors (and therefore similarities) are exact.
import assert from 'node:assert/strict';
import test, { beforeEach, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortexgate-cache-test-'));
process.env.DATA_DIR = dataDir; // must be set before the cache module (persist.js) loads

const cache = await import('../src/cache/semanticCache.js');
const embedder = await import('../src/cache/embedder.js');
const verifier = await import('../src/cache/verifier.js');

const ENV_KEYS = ['EMBEDDING_PROVIDER', 'GEMINI_API_KEY', 'CACHE_THRESHOLD', 'CACHE_TRUST_ABOVE', 'CACHE_VERIFY',
  'CACHE_TTL_MS', 'CACHE_MAX_ENTRIES', 'EMBED_PRICE_PER_1M', 'CACHE_BYPASS_PATTERNS', 'EMBEDDING_TASK_TYPE',
  'EMBED_MEMO_SIZE', 'EMBED_COOLDOWN_MS'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));

// ---- helpers ----
const unit = s => [s, Math.sqrt(1 - s * s)];      // cosine([1,0], unit(s)) === s
const user = text => [{ role: 'user', content: text }];
const reply = (content, total_tokens = 100) => ({ content, usage: { total_tokens }, model: 'test-model' });

let vectors;     // text -> vector served by the stubbed embedding API
let fetchCalls;  // texts sent to the embedding API
let fetchMode;   // 'ok' | '429' | 'timeout' | '503'
function stubFetch() {
  embedder.setFetch(async (url, opts) => {
    assert.ok(!String(url).includes('test-key'), 'API key must not be in the URL');
    const text = JSON.parse(opts.body).content.parts[0].text;
    fetchCalls.push(text);
    if (fetchMode === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    if (fetchMode === '429') return new Response('{"error":{"code":429}}', { status: 429, headers: { 'Retry-After': '30' } });
    if (fetchMode === '503') return new Response('{}', { status: 503 });
    if (!vectors.has(text)) throw new Error(`test: no vector for "${text}"`);
    return new Response(JSON.stringify({ embedding: { values: vectors.get(text) } }), { status: 200 });
  });
}

let dispatchCalls;
let dispatchAnswer; // 'YES' | 'NO' | 'throw' | null
function stubDispatch() {
  verifier.setDispatch(async args => {
    dispatchCalls.push(args);
    if (dispatchAnswer === 'throw') throw new Error('all providers failed');
    if (dispatchAnswer === null) return { result: null, cost: 0 };
    return { result: { content: dispatchAnswer, usage: { total_tokens: 20 } }, cost: 0.0001, provider: 'groq' };
  });
}

async function seed(text, vector, cost = 0.002, tokens = 100) {
  vectors.set(text, vector);
  const r = await cache.lookup(user(text));
  assert.equal(r.hit, null, `seed "${text}" should miss`);
  cache.store({ vector: r.vector, key: r.key, response: reply(`answer to ${text}`, tokens), cost, provider: 'groq' });
  return r;
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.EMBEDDING_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'test-key';
  vectors = new Map();
  fetchCalls = [];
  fetchMode = 'ok';
  dispatchCalls = [];
  dispatchAnswer = 'YES';
  stubFetch();
  stubDispatch();
  cache.clear();
});

after(() => {
  embedder.setFetch(null);
  verifier.setDispatch(null);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

// ---- similarity math ----
test('cosineSimilarity math', () => {
  assert.equal(cache.cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(cache.cosineSimilarity([1, 2, 3], [2, 4, 6]), 1);          // scale invariant
  assert.equal(cache.cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cache.cosineSimilarity([1, 0], [-1, 0]), -1);
  assert.equal(cache.cosineSimilarity([1, 0], [1, 0, 0]), 0);              // length mismatch
  assert.equal(cache.cosineSimilarity([0, 0], [1, 0]), 0);                 // zero vector
  assert.ok(Math.abs(cache.cosineSimilarity([1, 0], unit(0.93)) - 0.93) < 1e-12);
});

test('defaults: threshold 0.92, trust 0.985, verify on', () => {
  const s = cache.getStats();
  assert.equal(s.threshold, 0.92);
  assert.equal(s.trustAbove, 0.985);
  assert.equal(s.verifyEnabled, true);
});

// ---- threshold boundary ----
test('threshold boundary: >= threshold hits, below misses', async () => {
  process.env.CACHE_VERIFY = 'false';
  await seed('capital of france', [1, 0]);
  vectors.set('capital city of france', unit(0.9205));
  vectors.set('capital of the french republic', unit(0.9195));
  const above = await cache.lookup(user('capital city of france'));
  assert.ok(above.hit, 'similarity 0.9205 should hit at threshold 0.92');
  const below = await cache.lookup(user('capital of the french republic'));
  assert.equal(below.hit, null, 'similarity 0.9195 should miss');
  assert.ok(below.key, 'a miss can still be stored');
});

// ---- trust vs verify ----
test('trusted path: similarity >= trustAbove is served without verification', async () => {
  await seed('who wrote hamlet', [1, 0]);
  vectors.set('who wrote hamlet?', unit(0.99));
  const r = await cache.lookup(user('who wrote hamlet?'));
  assert.ok(r.hit);
  assert.equal(r.hit.verified, false);
  assert.equal(dispatchCalls.length, 0);
});

test('verify path: borderline YES -> verified hit, one light-tier verify call', async () => {
  await seed('who wrote hamlet', [1, 0]);
  vectors.set('author of hamlet', unit(0.95));
  const r = await cache.lookup(user('author of hamlet'));
  assert.ok(r.hit);
  assert.equal(r.hit.verified, true);
  assert.equal(r.verifyCost, 0.0001);
  assert.equal(dispatchCalls.length, 1);
  assert.equal(dispatchCalls[0].tier, 'light');
  assert.equal(dispatchCalls[0].purpose, 'verify');
  // the alias is now stored: the same wording is a trusted exact match, no 2nd verification
  const again = await cache.lookup(user('author of hamlet'));
  assert.ok(again.hit);
  assert.equal(again.hit.verified, false);
  assert.equal(dispatchCalls.length, 1);
});

test('verify path: NO -> rejection miss; verifier error -> miss, never throws', async () => {
  await seed('national bird of india', [1, 0]);
  vectors.set('national animal of india', unit(0.95));
  dispatchAnswer = 'NO';
  const rejected = await cache.lookup(user('national animal of india'));
  assert.equal(rejected.hit, null);
  assert.equal(rejected.rejected.against, 'national bird of india');

  vectors.set('national tree of india', unit(0.94));
  dispatchAnswer = 'throw';
  const failed = await cache.lookup(user('national tree of india'));
  assert.equal(failed.hit, null);
  assert.equal(failed.verifyFailed, true);

  const s = cache.getStats();
  assert.equal(s.verifications, 2);
  assert.equal(s.rejections, 1);
  assert.equal(s.verifyErrors, 1);
});

test('verifier prompt is capped', () => {
  const long = 'x'.repeat(5000);
  const p = verifier.buildVerifyPrompt({ storedQuestion: long, storedAnswer: long, newQuestion: long });
  assert.ok(p.length < 2000, `prompt length ${p.length}`);
});

// ---- guards ----
test('negation guard: one-sided negation is never trust-served', async () => {
  await seed('is placement good in jklu', [1, 0]);
  vectors.set('is placement not good in jklu', unit(0.995)); // above trustAbove
  dispatchAnswer = 'NO';
  const r = await cache.lookup(user('is placement not good in jklu'));
  assert.equal(r.hit, null);
  assert.equal(dispatchCalls.length, 1, 'forced verification');
  assert.equal(cache.getStats().negationGuarded, 1);

  process.env.CACHE_VERIFY = 'false';
  vectors.set("isn't placement good in jklu", unit(0.995));
  const r2 = await cache.lookup(user("isn't placement good in jklu"));
  assert.equal(r2.hit, null, 'verification off -> miss');
});

test('negation detection', () => {
  for (const t of ['is it not safe', "it isn't safe", 'it isn’t safe', 'never do this', 'pasta without eggs', 'all except one', 'I cant go'])
    assert.ok(cache.hasNegation(t), t);
  for (const t of ['is it safe', 'notable people', 'knowledge base', 'nothingness'])
    assert.ok(!cache.hasNegation(t), t);
});

test('numeric guard: different numbers -> miss even at similarity ~1', async () => {
  await seed('convert 10 miles to km', [1, 0]);
  vectors.set('convert 20 miles to km', unit(0.999));
  const r = await cache.lookup(user('convert 20 miles to km'));
  assert.equal(r.hit, null);
  assert.equal(dispatchCalls.length, 0);
  assert.equal(cache.getStats().numericGuardMisses, 1);
  assert.deepEqual(cache.extractNumbers('top ten of 1,000 and 2.50'), ['10', '1000', '2.5'].sort());
  assert.ok(cache.sameNumbers('top 10 movies', 'top ten movies'));
  assert.ok(!cache.sameNumbers('what is 2+2', 'what is 2+3'));
});

test('time-sensitive prompts bypass the cache and are never stored or embedded', async () => {
  const r = await cache.lookup(user("What's the weather in Delhi today?"));
  assert.equal(r.skipped, 'time_sensitive');
  assert.equal(r.key, null);
  assert.equal(fetchCalls.length, 0, 'no embedding call');
  cache.store({ vector: r.vector, key: r.key, response: reply('sunny'), cost: 0.01 });
  assert.equal(cache.getStats().entries, 0);
  assert.equal(cache.getStats().bypassedTimeSensitive, 1);

  for (const t of ['latest iPhone price', 'what time is it', 'stock price of apple', 'news about AI', 'who is the current PM of India', 'best movies this year', 'what is happening now'])
    assert.ok(cache.isTimeSensitive(t), t);
  for (const t of ['what is electric current', 'where do penguins live', 'capital of france', 'how do I know python'])
    assert.ok(!cache.isTimeSensitive(t), t);

  process.env.CACHE_BYPASS_PATTERNS = 'bitcoin,\\bipl\\b';
  assert.ok(cache.isTimeSensitive('bitcoin halving explained'));
  assert.ok(cache.isTimeSensitive('IPL points table'));
});

// ---- embedder: memo, cooldown, cost ----
test('exact-text memo: identical prompts embed once', async () => {
  process.env.EMBED_PRICE_PER_1M = '0.15';
  const text = 'what is machine learning'; // 24 chars -> 6 tokens
  vectors.set(text, [1, 0]);
  for (let i = 0; i < 3; i++) await cache.lookup(user(text));
  assert.equal(fetchCalls.length, 1);
  const s = cache.getStats();
  assert.equal(s.embedCalls, 1);
  assert.equal(s.embedMemoHits, 2);
  assert.ok(Math.abs(s.embedCost - (6 * 0.15) / 1e6) < 1e-15);
});

test('concurrent identical prompts share one embedding call', async () => {
  vectors.set('same text', [1, 0]);
  await Promise.all([cache.lookup(user('same text')), cache.lookup(user('same text'))]);
  assert.equal(fetchCalls.length, 1);
});

test('429 -> cooldown: lookups skip gracefully without calling the API', async () => {
  fetchMode = '429';
  const r1 = await cache.lookup(user('first question'));
  assert.equal(r1.skipped, 'unavailable');
  assert.equal(r1.hit, null);
  assert.equal(r1.key, null);
  fetchMode = 'ok';
  vectors.set('second question', [1, 0]);
  const t0 = Date.now();
  const r2 = await cache.lookup(user('second question'));
  assert.ok(Date.now() - t0 < 100, 'no delay during cooldown');
  assert.equal(r2.skipped, 'unavailable');
  assert.equal(fetchCalls.length, 1, 'second lookup made no API call');
  const s = cache.getStats();
  assert.equal(s.embedErrors, 1);
  assert.equal(s.skippedUnavailable, 2);
  assert.equal(s.misses, 0, 'skipped lookups are not misses');
  assert.ok(s.embedCooldownUntil, 'cooldown visible in stats');
  const left = Date.parse(s.embedCooldownUntil) - Date.now();
  assert.ok(left > 25_000 && left <= 30_000, `honors Retry-After: 30 (${left}ms left)`);
});

test('timeout / 5xx -> skipped, never throws', async () => {
  fetchMode = 'timeout';
  const r = await cache.lookup(user('q1'));
  assert.equal(r.skipped, 'unavailable');
  embedder.resetEmbedder();
  fetchMode = '503';
  const r2 = await cache.lookup(user('q2'));
  assert.equal(r2.skipped, 'unavailable');
  assert.equal(cache.getStats().embedErrors, 2);
});

test('lookup never throws on bad input; multi-turn is uncacheable', async () => {
  for (const bad of [undefined, null, [], [{ role: 'user', content: { weird: true } }], [{}]]) {
    const r = await cache.lookup(bad);
    assert.equal(r.hit, null);
  }
  fetchCalls = [];
  const multi = await cache.lookup([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'and?' }]);
  assert.equal(multi.skipped, 'uncacheable');
  assert.equal(fetchCalls.length, 0);
});

test('system prompt namespaces are isolated', async () => {
  process.env.CACHE_VERIFY = 'false';
  await seed('tell me a joke', [1, 0]);
  const r = await cache.lookup([{ role: 'system', content: 'You are a pirate' }, { role: 'user', content: 'tell me a joke' }]);
  assert.equal(r.hit, null);
});

// ---- TTL / LRU ----
test('TTL expiry', async () => {
  process.env.CACHE_TTL_MS = '40';
  await seed('ttl question', [1, 0]);
  assert.ok((await cache.lookup(user('ttl question'))).hit, 'fresh entry hits');
  await new Promise(r => setTimeout(r, 70));
  assert.equal((await cache.lookup(user('ttl question'))).hit, null, 'expired entry misses');
});

test('LRU eviction removes the least-recently-used entry', async () => {
  process.env.CACHE_MAX_ENTRIES = '2';
  const tick = () => new Promise(r => setTimeout(r, 5));
  await seed('question a', [1, 0, 0]);
  await tick();
  await seed('question b', [0, 1, 0]);
  await tick();
  assert.ok((await cache.lookup(user('question a'))).hit); // a is now more recent than b
  await tick();
  await seed('question c', [0, 0, 1]);
  assert.equal(cache.getStats().entries, 2);
  assert.ok((await cache.lookup(user('question a'))).hit, 'a kept');
  assert.equal((await cache.lookup(user('question b'))).hit, null, 'b evicted');
});

test('storing the same prompt twice replaces instead of duplicating', async () => {
  await seed('dup question', [1, 0]);
  const r = await cache.lookup(user('dup question'));
  cache.store({ vector: r.vector, key: r.key, response: reply('v2'), cost: 0.001 });
  assert.equal(cache.getStats().entries, 1);
});

// ---- stats formulas ----
test('stats: hitRate over cacheable lookups, netSaved = costSaved - verifyCost - embedCost', async () => {
  process.env.EMBED_PRICE_PER_1M = '1000000'; // 1 USD per token -> easy numbers
  await seed('abcdefgh', [1, 0], 0.5, 40);            // 8 chars = 2 tokens; miss
  vectors.set('abcdefgh!', unit(0.95));               // 9 chars = 3 tokens; verified hit
  const hit = await cache.lookup(user('abcdefgh!'));
  assert.ok(hit.hit);
  assert.equal(hit.embedCost, 3);
  await cache.lookup(user('weather today'));          // bypassed: not a hit nor a miss
  await cache.lookup(user('abcdefgh'));               // memo + trusted hit, no new embed cost

  const s = cache.getStats();
  assert.equal(s.requests, 4);
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
  assert.equal(s.lookups, 3);
  assert.equal(s.hitRate, 2 / 3);
  assert.equal(s.costSaved, 1.0);
  assert.equal(s.tokensSaved, 80);
  assert.equal(s.verifyCost, 0.0001);
  assert.equal(s.embedCost, 5);
  assert.equal(s.embedCalls, 2);
  assert.ok(Math.abs(s.netSaved - (1.0 - 0.0001 - 5)) < 1e-12);
  assert.equal(s.netCostSaved, s.netSaved);
  for (const k of ['embedCalls', 'embedCost', 'embedErrors', 'embedMemoHits', 'bypassedTimeSensitive', 'skippedUnavailable', 'netSaved'])
    assert.ok(k in s, `contract field ${k}`);
});

test('mock embedder works offline (EMBEDDING_PROVIDER=mock)', async () => {
  process.env.EMBEDDING_PROVIDER = 'mock';
  process.env.CACHE_VERIFY = 'false';
  const r = await cache.lookup(user('What is the capital of France?'));
  cache.store({ vector: r.vector, key: r.key, response: reply('Paris'), cost: 0.001 });
  const again = await cache.lookup(user('what is THE capital of france'));
  assert.ok(again.hit);
  assert.equal(fetchCalls.length, 0);
  assert.equal(cache.getStats().embedCost, 0);
});
