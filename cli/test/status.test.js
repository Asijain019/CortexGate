import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeProviders, buildStatus, formatStatus, pickUptimeSec, providerSummaryLine } from '../src/status.js';
import { formatDuration, table } from '../src/ui.js';
import { summarizeCompletion, keyRows, countProviderKeys, openerFor } from '../src/commands.js';

before(() => { process.env.NO_COLOR = '1'; delete process.env.FORCE_COLOR; });

const p = (configured, enabled, state) => ({ configured, enabled, state });
const PROVIDERS = {
  groq: p(true, true, 'healthy'), openrouter: p(true, true, 'healthy'), nvidia: p(true, true, 'healthy'),
  gemini: p(true, true, 'healthy'), ollama: p(true, true, 'healthy'),
  sambanova: p(true, false, 'disabled'), github: p(true, false, 'disabled'), mistral: p(true, false, 'disabled'),
  cerebras: p(false, false, 'unconfigured'), cloudflare: p(false, false, 'unconfigured'), cohere: p(false, false, 'unconfigured'),
  together: p(false, false, 'unconfigured'), lmstudio: p(false, false, 'unconfigured'), huggingface: p(false, false, 'unconfigured')
};

test('formatDuration', () => {
  assert.equal(formatDuration(8040), '2h 14m');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(125), '2m 5s');
  assert.equal(formatDuration(90061), '1d 1h');
  assert.equal(formatDuration(null), null);
});

test('summarizeProviders counts healthy / disabled / no key', () => {
  const s = summarizeProviders(PROVIDERS);
  assert.equal(s.healthy, 5);
  assert.equal(s.disabled, 3);
  assert.equal(s.noKey, 6);
  assert.equal(providerSummaryLine(s), '5 healthy · 3 disabled · 6 no key');
  const s2 = summarizeProviders({ a: p(true, true, 'open'), b: p(true, true, 'probing'), c: p(true, true, 'cooldown') });
  assert.equal(providerSummaryLine(s2), '0 healthy · 1 circuit open · 1 probing · 1 cooling down · 0 disabled · 0 no key');
});

test('status block matches the documented layout', () => {
  const now = Date.parse('2026-11-26T12:00:00Z');
  const facts = {
    url: 'http://localhost:3003', mode: 'node', running: true, managed: true,
    health: { status: 'ok' },
    localStartedAt: new Date(now - (2 * 3600 + 14 * 60) * 1000).toISOString(),
    authMode: 'required',
    live: { config: { routingPolicy: 'balanced', rateLimit: { redis: 'connected' } }, persistence: { mongodb: 'connected' } },
    providers: PROVIDERS
  };
  const text = formatStatus(buildStatus(facts, now));
  assert.equal(text, [
    'CortexGate  ● running  http://localhost:3003  (node mode, up 2h 14m)',
    'auth: required · policy: balanced · redis: connected · mongo: connected',
    'providers: 5 healthy · 3 disabled · 6 no key'
  ].join('\n'));
});

test('health-reported fields win; stopped gateway renders one line', () => {
  const view = buildStatus({ url: 'http://localhost:3013', mode: 'docker', running: true, health: { status: 'ok', uptimeSec: 59, auth: 'auto', redis: 'connected', mongo: 'unavailable', policy: 'cost' } });
  assert.equal(formatStatus(view).split('\n')[0], 'CortexGate  ● running  http://localhost:3013  (docker mode, up 59s)');
  assert.match(formatStatus(view), /auth: auto \(keys for non-local clients\) · policy: cost · redis: connected · mongo: unavailable/);
  const down = formatStatus(buildStatus({ url: 'http://localhost:3003', mode: 'node', running: false }));
  assert.equal(down, 'CortexGate  ● stopped  http://localhost:3003  (node mode)');
});

test('pickUptimeSec sources', () => {
  const now = 1_000_000;
  assert.equal(pickUptimeSec({ uptime: 12 }, null, now), 12);
  assert.equal(pickUptimeSec({ uptimeMs: 5000 }, null, now), 5);
  assert.equal(pickUptimeSec({}, new Date(now - 10_000).toISOString(), now), 10);
  assert.equal(pickUptimeSec({}, null, now), null);
});

test('summarizeCompletion extracts routing facts from a gateway response', () => {
  const s = summarizeCompletion({
    model: 'openai/gpt-oss-20b', provider: 'groq', cost: 0.000017, usage: { total_tokens: 116 },
    choices: [{ message: { content: ' 4 ' } }],
    cache: { hit: false },
    routing: { tier: 'light', policy: 'balanced', task: 'factual' },
    attempts: [
      { provider: 'github', outcome: 'auth', latencyMs: 300 },
      { provider: 'groq', outcome: 'ok', latencyMs: 450 }
    ]
  }, 1234);
  assert.equal(s.answer, '4');
  assert.equal(s.attempts, 2);
  assert.equal(s.attemptTrail, 'github ✗ auth 300ms → groq ✓ 450ms');
  assert.equal(s.tier, 'light');
  assert.equal(s.cache, 'miss');
  const hit = summarizeCompletion({ provider: 'cache', cache: { hit: true, similarity: 0.97 }, attempts: [] }, 5);
  assert.equal(hit.cache, 'hit (similarity 0.970)');
  assert.equal(hit.attempts, 0);
});

test('key table rows', () => {
  const rows = keyRows([
    { id: 'k1', name: 'ci', keyHint: 'cg-abcd…wxyz', enabled: true, requests: 1200, tokens: 34000, spendUsd: 0.5, budgetUsd: 5, rpmLimit: 60, tpmLimit: null, lastUsedAt: null },
    { id: 'k2', name: 'old', keyHint: 'cg-zzzz…0000', enabled: false, requests: 0, tokens: 0, spendUsd: 0, budgetUsd: null, rpmLimit: null, tpmLimit: null }
  ]);
  assert.deepEqual(rows[0], ['k1', 'ci', 'cg-abcd…wxyz', 'active', '1,200', '34,000', '$0.50 / $5.00', '60 rpm', 'never']);
  assert.equal(rows[1][3], 'disabled');
  assert.equal(rows[1][7], '-');
  const t = table(['A', 'BB'], [['x', 'y']]);
  assert.equal(t, 'A  BB\nx  y');
});

test('countProviderKeys lists names only and honours the Cloudflare alias', () => {
  assert.deepEqual(countProviderKeys({ GROQ_API_KEY: 'x', GEMINI_API_KEY: '', CLOUDFLARE_API_KEY: 'y', GITHUB_TOKEN: 'z' }), ['groq', 'github', 'cloudflare']);
});

test('openerFor picks a platform browser launcher without a shell', () => {
  assert.deepEqual(openerFor('win32', 'http://x'), { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', 'http://x'] });
  assert.equal(openerFor('darwin', 'u').cmd, 'open');
  assert.equal(openerFor('linux', 'u').cmd, 'xdg-open');
});
