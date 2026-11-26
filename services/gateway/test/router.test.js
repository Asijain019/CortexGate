import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, route, scoreCandidate, normalizePolicy, catalog } from '../src/gateway/router.js';
import { dispatch } from '../src/gateway/dispatch.js';
import * as providerStats from '../src/gateway/providerStats.js';
import { providers, isConfigured, getProviderChain } from '../src/providers/index.js';
import { install, fake, ok, msg } from './helpers/fakes.js';

test('classifier: short factual question -> light', () => {
  const c = classify(msg('What is the capital of France?'));
  assert.equal(c.task, 'factual');
  assert.equal(c.tier, 'light');
  assert.ok(c.score < 0.3);
  assert.equal(c.estTokens, Math.ceil('What is the capital of France?'.length / 4));
  assert.match(c.reason, /light tier/);
});

test('classifier: code request -> standard', () => {
  const c = classify(msg('Write a Python function to reverse a linked list.'));
  assert.equal(c.task, 'code');
  assert.equal(c.tier, 'standard');
  const fenced = classify(msg('Why does this crash?\n```js\nconst x = null; x.foo();\n```'));
  assert.equal(fenced.task, 'code');
});

test('classifier: multi-step reasoning -> heavy', () => {
  const c = classify(msg('Prove step by step that the square root of 2 is irrational, and analyze why the proof by contradiction works.'));
  assert.equal(c.task, 'reasoning');
  assert.equal(c.tier, 'heavy');
});

test('classifier: creative, summarize, greeting; length alone never reaches heavy', () => {
  assert.equal(classify(msg('Write a short poem about autumn leaves')).task, 'creative');
  assert.equal(classify(msg('hello there!')).tier, 'light');

  const longDoc = 'The quarterly report covers revenue, hiring and logistics. '.repeat(150);
  const sum = classify(msg(`Summarize this:\n${longDoc}`));
  assert.equal(sum.task, 'summarize');
  assert.equal(sum.tier, 'standard');
  assert.ok(sum.estTokens > 1500);

  const longChat = classify(msg('Tell me about my trip plans. '.repeat(300)));
  assert.notEqual(longChat.tier, 'heavy');
});

test('policy normalisation: request value, then ROUTING_POLICY, then balanced', () => {
  const prev = process.env.ROUTING_POLICY;
  try {
    delete process.env.ROUTING_POLICY;
    assert.equal(normalizePolicy(), 'balanced');
    process.env.ROUTING_POLICY = 'quality';
    assert.equal(normalizePolicy(), 'quality');
    assert.equal(normalizePolicy('COST'), 'cost');
    assert.equal(normalizePolicy('nonsense'), 'quality');
  } finally {
    if (prev === undefined) delete process.env.ROUTING_POLICY; else process.env.ROUTING_POLICY = prev;
  }
});

test('policy ranking: cost prefers the free model, quality prefers the strong model', () => {
  const restore = install({ groq: fake(), nvidia: fake() }, { RR_BUCKET_DELTA: '0' });
  try {
    const cheap = route({ messages: msg('What is 2+2?'), policy: 'cost', tier: 'light' });
    assert.equal(cheap.candidates[0].provider, 'nvidia');
    assert.equal(cheap.policy, 'cost');

    const strong = route({ messages: msg('Prove it rigorously'), policy: 'quality', tier: 'heavy' });
    assert.equal(strong.candidates[0].provider, 'groq');
    assert.equal(strong.candidates[0].model, catalog('groq').heavy.model);
    assert.match(strong.reason, /policy quality/);

    const low = { model: 'x', quality: 0.4, price: 0, speed: 0.8 };
    const high = { model: 'y', quality: 0.85, price: 1.5, speed: 0.8 };
    assert.ok(scoreCandidate('groq', low, 'standard', 'cost') > scoreCandidate('groq', high, 'standard', 'cost'));
    assert.ok(scoreCandidate('groq', high, 'standard', 'quality') > scoreCandidate('groq', low, 'standard', 'quality'));
  } finally {
    restore();
  }
});

test('health-aware: recent failures push a provider down the ranking', () => {
  const restore = install({ groq: fake(), nvidia: fake() }, { RR_BUCKET_DELTA: '0' });
  try {
    const before = route({ messages: msg('hi'), policy: 'balanced', tier: 'light' });
    const nvidiaBefore = before.candidates.find(c => c.provider === 'nvidia').score;
    for (let i = 0; i < 10; i++) providerStats.recordFailure('nvidia', 'error', new Error('x'));
    const after = route({ messages: msg('hi'), policy: 'balanced', tier: 'light' });
    assert.ok(after.candidates.find(c => c.provider === 'nvidia').score < nvidiaBefore);
    assert.equal(after.candidates[0].provider, 'groq');
  } finally {
    restore();
  }
});

test('round robin rotates the first provider across requests within an equal bucket', async () => {
  const same = 'openai/gpt-oss-20b';
  const groq = fake(ok('groq'));
  const sambanova = fake(ok('sambanova'));
  const restore = install({ groq, sambanova }, {});
  const prev = { g: process.env.GROQ_MODEL_LIGHT, s: process.env.SAMBANOVA_MODEL_LIGHT };
  process.env.GROQ_MODEL_LIGHT = same;
  process.env.SAMBANOVA_MODEL_LIGHT = same;
  try {
    const served = [];
    for (let i = 0; i < 4; i++) served.push((await dispatch({ messages: msg('hi') })).provider);
    assert.notEqual(served[0], served[1]);
    assert.equal(served[0], served[2]);
    assert.equal(served[1], served[3]);
    assert.equal(groq.calls.length, 2);
    assert.equal(sambanova.calls.length, 2);

    // The non-chosen provider remains as a fallback.
    const plan = route({ messages: msg('hi') });
    assert.equal(plan.candidates.length, 2);
  } finally {
    restore();
    for (const [k, v] of [['GROQ_MODEL_LIGHT', prev.g], ['SAMBANOVA_MODEL_LIGHT', prev.s]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('weighted round robin honours <P>_RR_WEIGHT', () => {
  const same = 'openai/gpt-oss-20b';
  const restore = install({ groq: fake(), sambanova: fake() }, { GROQ_RR_WEIGHT: '2' });
  process.env.GROQ_MODEL_LIGHT = same;
  process.env.SAMBANOVA_MODEL_LIGHT = same;
  try {
    const firsts = [];
    for (let i = 0; i < 6; i++) firsts.push(route({ messages: msg('hi') }).candidates[0].provider);
    assert.equal(firsts.filter(p => p === 'groq').length, 4);
    assert.equal(firsts.filter(p => p === 'sambanova').length, 2);
  } finally {
    restore();
    delete process.env.GROQ_MODEL_LIGHT;
    delete process.env.SAMBANOVA_MODEL_LIGHT;
  }
});

test('explicit model / provider overrides go first', () => {
  const restore = install({ groq: fake(), gemini: fake(), nvidia: fake() });
  try {
    const a = route({ messages: msg('hi'), model: 'gemini/gemini-3.5-flash' });
    assert.deepEqual([a.candidates[0].provider, a.candidates[0].model], ['gemini', 'gemini-3.5-flash']);
    assert.equal(a.override, 'model');

    const b = route({ messages: msg('hi'), model: 'openai/gpt-oss-120b' }); // bare catalog id -> groq
    assert.deepEqual([b.candidates[0].provider, b.candidates[0].model], ['groq', 'openai/gpt-oss-120b']);

    const c = route({ messages: msg('hi'), provider: 'nvidia' });
    assert.equal(c.candidates[0].provider, 'nvidia');
    assert.equal(c.override, 'provider');
    assert.equal(c.candidates.length, 3);
  } finally {
    restore();
  }
});

test('unconfigured providers (cerebras, cloudflare, cohere, ollama) are excluded and never attempted', async () => {
  const keys = ['CEREBRAS_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'COHERE_API_KEY', 'OLLAMA_BASE_URL', 'OLLAMA_ENABLED'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  keys.forEach(k => delete process.env[k]);
  const real = { cerebras: providers.cerebras, cloudflare: providers.cloudflare, cohere: providers.cohere, ollama: providers.ollama };
  const groq = fake(ok());
  const restore = install({ groq, ...real });
  try {
    for (const n of Object.keys(real)) assert.equal(isConfigured(n), false, n);
    process.env.CLOUDFLARE_API_TOKEN = 'x'; // token without account id is still unconfigured
    assert.equal(isConfigured('cloudflare'), false);
    delete process.env.CLOUDFLARE_API_TOKEN;

    assert.ok(getProviderChain().includes('cerebras'));
    const plan = route({ messages: msg('hi'), provider: 'cerebras' });
    assert.deepEqual(plan.candidates.map(c => c.provider), ['groq']);
    assert.match(plan.reason, /cerebras' is not configured/);

    const out = await dispatch({ messages: msg('hi'), provider: 'cohere' });
    assert.equal(out.provider, 'groq');
    assert.deepEqual(out.attempts.map(a => a.provider), ['groq']);

    process.env.OLLAMA_ENABLED = 'true';
    assert.equal(isConfigured('ollama'), true);
  } finally {
    restore();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// ---------------------------------------------------------------- quality / cost / token / load aware routing

function withEnv(restore, env) {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  return () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    restore();
  };
}

test('estimate: input = chars/4, output by task, scaled by depth / brevity', () => {
  const f = classify(msg('What is the capital of France?'));
  assert.equal(f.estInputTokens, f.estTokens);
  assert.equal(f.estOutputTokens, 150);
  assert.equal(classify(msg('Write a Python function to reverse a linked list.')).estOutputTokens, 700);
  assert.ok(classify(msg('Explain step by step how TCP handshakes work in detail')).estOutputTokens > 250);
  assert.ok(classify(msg('Briefly, what is DNS?')).estOutputTokens < 150);
  const doc = 'Revenue grew and hiring slowed this quarter. '.repeat(200);
  const s = classify(msg(`Summarize this:\n${doc}`));
  assert.equal(s.estOutputTokens, Math.max(100, Math.min(Math.round(0.3 * s.estInputTokens), 600)));
});

test('eligibility: quality floor per tier and context window', () => {
  const restore = install({ groq: fake(), nvidia: fake(), cerebras: fake() });
  try {
    const heavy = route({ messages: msg('Prove it rigorously'), tier: 'heavy' });
    assert.equal(heavy.requiredQuality, 0.8);
    assert.deepEqual(heavy.candidates.map(c => c.provider), ['groq']);
    assert.match(heavy.excluded.nvidia, /quality 0\.66 < required 0\.80/);
    assert.match(heavy.excluded.cerebras, /quality/);
    assert.equal(heavy.eligible, 1);

    const std = route({ messages: msg('hi'), tier: 'standard' });
    assert.deepEqual(std.candidates.map(c => c.provider).sort(), ['groq', 'nvidia']);
    assert.ok(std.excluded.cerebras);

    // ~10k input tokens: cerebras' 8k context cannot hold it
    const big = route({ messages: msg('word '.repeat(8000)), tier: 'light' });
    assert.match(big.excluded.cerebras, /context 8192 </);
    assert.ok(big.candidates.some(c => c.provider === 'nvidia'));
    assert.match(big.excluded.groq, /exceeds TPM limit 8000/); // groq free tier: 8k tokens/min
    for (const c of big.top) assert.deepEqual(Object.keys(c).sort(), ['estCost', 'model', 'provider', 'quality', 'score']);
  } finally {
    restore();
  }
});

test('policy choice: cost -> cheapest eligible, quality -> best quality, balanced -> fast + good + cheap', () => {
  const restore = install({ groq: fake(), gemini: fake(), nvidia: fake() });
  try {
    const m = msg('Write a Python function to reverse a linked list.'); // standard
    const cost = route({ messages: m, policy: 'cost' });
    assert.equal(cost.candidates[0].provider, 'nvidia');
    assert.equal(cost.candidates[0].estCost, 0);
    const quality = route({ messages: m, policy: 'quality' });
    assert.equal(quality.candidates[0].provider, 'gemini');
    const balanced = route({ messages: m, policy: 'balanced' });
    assert.equal(balanced.candidates[0].provider, 'groq');
    assert.ok(balanced.estCost > 0);
  } finally {
    restore();
  }
});

test('latency-aware: a slow provider with timeouts ranks lower', () => {
  const restore = install({ groq: fake(), nvidia: fake() }, { RR_BUCKET_DELTA: '0' });
  try {
    const m = msg('hi');
    const before = route({ messages: m, policy: 'cost', tier: 'standard' }).candidates.find(c => c.provider === 'nvidia').score;
    for (let i = 0; i < 6; i++) providerStats.recordSuccess('nvidia', 7000, 'x');
    providerStats.recordFailure('nvidia', 'timeout', new Error('t'), 10000);
    for (let i = 0; i < 6; i++) providerStats.recordSuccess('groq', 500, 'x');
    const after = route({ messages: m, policy: 'balanced', tier: 'light' });
    assert.equal(after.candidates[0].provider, 'groq');
    assert.ok(route({ messages: m, policy: 'cost', tier: 'standard' }).candidates.find(c => c.provider === 'nvidia').score < before);
  } finally {
    restore();
  }
});

test('least-loaded pick: in-flight load moves an equal provider down', () => {
  const same = 'openai/gpt-oss-20b';
  const restore = withEnv(install({ groq: fake(), sambanova: fake() }), { GROQ_MODEL_LIGHT: same, SAMBANOVA_MODEL_LIGHT: same });
  try {
    for (let i = 0; i < 4; i++) providerStats.begin('groq');
    for (let i = 0; i < 3; i++) assert.equal(route({ messages: msg('hi') }).candidates[0].provider, 'sambanova');
    const g = route({ messages: msg('hi') }).candidates.find(c => c.provider === 'groq');
    assert.equal(g.load, 0.5);
  } finally {
    for (let i = 0; i < 4; i++) providerStats.end('groq');
    restore();
  }
});

test('RPM budget exhaustion excludes the provider (route.excluded reason)', () => {
  const restore = withEnv(install({ groq: fake(), nvidia: fake() }), { GROQ_RPM: '2' });
  try {
    const m = catalog('groq').light.model; // budgets are counted per model
    providerStats.recordStart('groq', 10, Date.now(), m);
    providerStats.recordStart('groq', 10, Date.now(), m);
    providerStats.recordStart('groq', 10, Date.now(), catalog('groq').heavy.model);
    const plan = route({ messages: msg('hi') });
    assert.ok(!plan.candidates.some(c => c.provider === 'groq'));
    assert.match(plan.excluded.groq, /rate budget: 2\/2/);
  } finally {
    restore();
  }
});

test('TPM limit: a request larger than the whole budget is excluded outright', () => {
  const restore = withEnv(install({ groq: fake(), nvidia: fake() }), { GROQ_TPM: '100' });
  try {
    const plan = route({ messages: msg('word '.repeat(400)) });
    assert.match(plan.excluded.groq, /exceeds TPM limit 100/);
    assert.deepEqual(plan.waitable, []);
  } finally {
    restore();
  }
});

test('custom catalog entries are merged and ranked', async () => {
  const idx = await import('../src/providers/index.js');
  if (typeof idx.registerProvider !== 'function') return;
  const restore = install({ groq: fake() });
  try {
    idx.registerProvider('acme-llm', fake(ok('acme')), {
      label: 'Acme', models: { light: 'acme-s', standard: 'acme-m', heavy: 'acme-l' },
      quality: { light: 0.7, standard: 0.85, heavy: 0.95 }, price: { prompt: 0, completion: 0 }, speed: 0.9
    });
    const plan = route({ messages: msg('Prove it rigorously'), tier: 'heavy', policy: 'quality' });
    assert.equal(plan.candidates[0].provider, 'acme-llm');
    assert.equal(plan.candidates[0].model, 'acme-l');
    assert.equal(plan.candidates[0].quality, 0.95);
    const out = await dispatch({ messages: msg('Prove it rigorously'), tier: 'heavy', policy: 'quality' });
    assert.equal(out.provider, 'acme-llm');
  } finally {
    idx.unregisterProvider('acme-llm');
    restore();
  }
});
