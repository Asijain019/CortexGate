import assert from 'node:assert/strict';
import test from 'node:test';
import { computeAnalytics, percentile, errorType, RANGES } from '../src/stats/analytics.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const at = minsAgo => new Date(NOW - minsAgo * 60_000).toISOString();
const route = (tier, task, policy = 'balanced') => ({ tier, task, policy, estTokens: 10, score: 0.2, reason: 'x', override: null });

const rows = [
  // 1) clean groq success
  { time: at(1), status: 'ok', provider: 'groq', model: 'gpt-oss-20b', cost: 0.001, tokens: 100, latencyMs: 400,
    route: route('light', 'factual'), attempts: [{ provider: 'groq', model: 'gpt-oss-20b', outcome: 'ok', latencyMs: 380 }] },
  // 2) gemini timeout -> nvidia 401 -> groq ok (recovered failover, chain 3)
  { time: at(2), status: 'ok', provider: 'groq', model: 'gpt-oss-120b', cost: 0.002, tokens: 200, latencyMs: 12000,
    failedProviders: ['gemini', 'nvidia'], route: route('heavy', 'reasoning', 'quality'),
    attempts: [
      { provider: 'gemini', model: 'g', outcome: 'timeout', httpStatus: 504, latencyMs: 10000, error: 'gemini timed out' },
      { provider: 'nvidia', model: 'n', outcome: 'error', httpStatus: 401, latencyMs: 200, error: 'bad key' },
      { provider: 'groq', model: 'gpt-oss-120b', outcome: 'ok', latencyMs: 1500 }
    ] },
  // 3) cache hit (verified)
  { time: at(3), status: 'ok', provider: 'cache', cache: true, verified: true, cost: 0, savedCost: 0.003, verifyCost: 0.0001,
    embedCost: 0.00001, tokens: 0, latencyMs: 50, route: route('light', 'chat'), attempts: [] },
  // 4) all failed: sambanova 402, github 502 non-JSON, openrouter 429 (unrecovered)
  { time: at(4), status: 'error', provider: 'none', cost: 0, latencyMs: 900, failedProviders: ['sambanova', 'github', 'openrouter'],
    route: route('standard', 'code', 'cost'), verification: 'rejected',
    attempts: [
      { provider: 'sambanova', outcome: 'error', httpStatus: 402, latencyMs: 100, error: 'billing' },
      { provider: 'github', outcome: 'error', httpStatus: 502, latencyMs: 300, error: 'GitHub Models returned a non-JSON response: OK' },
      { provider: 'openrouter', outcome: 'rate_limited', httpStatus: 429, latencyMs: 500, error: 'too many' }
    ] },
  // 5) queued
  { time: at(5), status: 'queued', provider: 'none', latencyMs: 0, attempts: [] },
  // 6) legacy row with no attempts, bypassed cache, 30 minutes ago
  { time: at(30), status: 'ok', provider: 'nvidia', model: 'nemo', cost: 0, tokens: 50, latencyMs: 700, cacheBypassed: true },
  // 7) outside the 1h window
  { time: at(90), status: 'ok', provider: 'groq', cost: 1, tokens: 9999, latencyMs: 1 },
  // 8) mistral 500 then groq ok
  { time: at(1.2), status: 'ok', provider: 'groq', model: 'gpt-oss-20b', cost: 0.001, tokens: 100, latencyMs: 800,
    failedProviders: ['mistral'], route: route('light', 'factual'),
    attempts: [
      { provider: 'mistral', outcome: 'error', httpStatus: 500, latencyMs: 300, error: 'internal' },
      { provider: 'groq', model: 'gpt-oss-20b', outcome: 'ok', latencyMs: 450 }
    ] }
];

test('nearest-rank percentiles', () => {
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(s, 50), 5);
  assert.equal(percentile(s, 95), 10);
  assert.equal(percentile(s, 10), 1);
  assert.equal(percentile([42], 99), 42);
  assert.equal(percentile([], 50), null);
});

test('errorType mapping follows the contract', () => {
  assert.equal(errorType({ outcome: 'timeout' }), 'timeout');
  assert.equal(errorType({ outcome: 'rate_limited', httpStatus: 429 }), 'rate_limited');
  assert.equal(errorType({ outcome: 'error', httpStatus: 401 }), 'auth');
  assert.equal(errorType({ outcome: 'error', httpStatus: 403 }), 'auth');
  assert.equal(errorType({ outcome: 'error', httpStatus: 402 }), 'billing');
  assert.equal(errorType({ outcome: 'error', httpStatus: 502, error: 'X returned a non-JSON response' }), 'bad_response');
  assert.equal(errorType({ outcome: 'error', httpStatus: 502, error: 'upstream down' }), 'server');
  assert.equal(errorType({ outcome: 'error', httpStatus: 503 }), 'server');
  assert.equal(errorType({ outcome: 'error', httpStatus: 400 }), 'other');
  assert.equal(errorType({ outcome: 'error' }), 'other');
});

test('1h aggregation: totals, buckets, latency', () => {
  const a = computeAnalytics(rows, { range: '1h', now: NOW });
  assert.equal(a.range, '1h');
  assert.equal(a.bucketMs, 60_000);
  assert.equal(a.source, 'local');
  assert.equal(a.series.length, 61, 'one bucket per minute incl. partial edges');
  assert.equal(a.series.reduce((s, b) => s + b.requests, 0), 7);

  const t = a.totals;
  assert.equal(t.requests, 7);
  assert.equal(t.ok, 5);
  assert.equal(t.errors, 1);
  assert.equal(t.queued, 1);
  assert.equal(t.cacheHits, 1);
  assert.equal(t.failovers, 3);
  assert.equal(t.tokens, 450);
  assert.ok(Math.abs(t.cost - 0.004) < 1e-12);
  assert.ok(Math.abs(t.netSaved - (0.003 - 0.0001 - 0.00001)) < 1e-12);
  assert.equal(t.successRate, round4(5 / 6));
  // latencies (non-queued): 400, 12000, 50, 900, 700, 800 -> sorted 50,400,700,800,900,12000
  assert.equal(t.p50LatencyMs, 700);
  assert.equal(t.p95LatencyMs, 12000);
  assert.equal(t.avgLatencyMs, Math.round((400 + 12000 + 50 + 900 + 700 + 800) / 6));

  const minute1 = a.series.find(b => b.t === new Date(Math.floor((NOW - 60_000) / 60_000) * 60_000).toISOString());
  assert.equal(minute1.requests, 1);
  assert.deepEqual(minute1.byProvider, { groq: 1 });
  const emptyBucket = a.series[0];
  assert.equal(emptyBucket.avgLatencyMs, null);
});

test('providers, errorsByType, models, tiers, tasks, policies', () => {
  const a = computeAnalytics(rows, { range: '1h', now: NOW });
  const p = Object.fromEntries(a.providers.map(x => [x.name, x]));
  assert.equal(p.groq.requests, 3);
  assert.equal(p.groq.ok, 3);
  assert.equal(p.groq.tokens, 400);
  assert.equal(p.groq.share, round4(3 / 5));
  assert.equal(p.cache.requests, 1);
  assert.equal(p.nvidia.requests, 2, 'one 401 attempt + one legacy synthesised success');
  assert.equal(p.nvidia.errorsByType.auth, 1);
  assert.equal(p.gemini.errorsByType.timeout, 1);
  assert.equal(p.sambanova.errorsByType.billing, 1);
  assert.equal(p.github.errorsByType.bad_response, 1);
  assert.equal(p.openrouter.errorsByType.rate_limited, 1);
  assert.equal(p.mistral.errorsByType.server, 1);
  assert.equal(p.gemini.successRate, 0);

  const m = a.models.find(x => x.provider === 'groq' && x.model === 'gpt-oss-20b');
  assert.equal(m.requests, 2);
  assert.equal(m.tokens, 200);

  assert.equal(a.tiers.light.requests, 3);
  assert.equal(a.tiers.heavy.requests, 1);
  assert.equal(a.tiers.standard.requests, 1);
  assert.deepEqual(a.tasks, { factual: 2, reasoning: 1, chat: 1, code: 1 });
  assert.deepEqual(a.policies, { balanced: 3, quality: 1, cost: 1 });
});

test('failover chains and transitions', () => {
  const f = computeAnalytics(rows, { range: '1h', now: NOW }).failover;
  assert.equal(f.requestsWithFailover, 3);
  assert.equal(f.recovered, 2);
  assert.equal(f.unrecovered, 1);
  assert.equal(f.maxChainLength, 3);
  assert.equal(f.avgChainLength, round2((3 + 3 + 2) / 3));
  assert.equal(f.rate, round4(3 / 5), 'dispatched rows = rows with attempts (incl. legacy)');
  const tr = Object.fromEntries(f.transitions.map(x => [`${x.from}>${x.to}`, x.count]));
  assert.deepEqual(tr, { 'gemini>nvidia': 1, 'nvidia>groq': 1, 'sambanova>github': 1, 'github>openrouter': 1, 'mistral>groq': 1 });
  assert.ok(f.topFailing.every(x => x.count === 1 && x.topReason));
});

test('cache block and error list', () => {
  const a = computeAnalytics(rows, { range: '1h', now: NOW });
  assert.equal(a.cache.hits, 1);
  assert.equal(a.cache.verifiedHits, 1);
  assert.equal(a.cache.rejected, 1);
  assert.equal(a.cache.bypassed, 1);
  assert.equal(a.cache.lookups, 5);
  assert.equal(a.cache.hitRate, round4(1 / 5));
  const errs = Object.fromEntries(a.errors.map(e => [e.type, e]));
  assert.equal(errs.timeout.count, 1);
  assert.equal(errs.bad_response.lastMessage, 'GitHub Models returned a non-JSON response: OK');
});

test('ranges and bucket sizes', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(RANGES).map(([k, v]) => [k, v.bucketMs])),
    { '15m': 30_000, '1h': 60_000, '24h': 1_800_000, '7d': 21_600_000 });
  const d = computeAnalytics(rows, { range: '24h', now: NOW });
  assert.equal(d.totals.requests, 8, 'the 90-minute-old row is inside 24h');
  assert.equal(computeAnalytics(rows, { range: '15m', now: NOW }).totals.requests, 6);
  assert.equal(computeAnalytics([], { range: 'bogus', now: NOW }).range, '1h');
  const empty = computeAnalytics([], { range: '7d', now: NOW });
  assert.equal(empty.totals.successRate, null);
  assert.equal(empty.failover.rate, null);
});

function round4(v) { return Number(v.toFixed(4)); }
function round2(v) { return Number(v.toFixed(2)); }
