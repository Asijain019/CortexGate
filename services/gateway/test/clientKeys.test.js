import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated data dir, no Redis, unreachable MongoDB (never the user's real data/ or databases).
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-ckeys-'));
process.env.DATA_DIR = DIR;
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:9/cortexgate-test';
for (const k of ['ADMIN_TOKEN', 'CLIENT_AUTH', 'CORTEXGATE_BOOTSTRAP_KEY']) delete process.env[k];

const express = (await import('express')).default;
const clientKeys = await import('../src/auth/clientKeys.js');
const auth = await import('../src/middleware/clientAuth.js');
const { default: adminRouter, jsonErrorHandler } = await import('../src/routes/admin.js');
const { default: chatRouter } = await import('../src/routes/chat.js');
const { default: analyticsRouter } = await import('../src/routes/analytics.js');
const { rateLimit } = await import('../src/middleware/rateLimit.js');
const requestLog = await import('../src/stats/requestLog.js');
const persist = await import('../src/stats/persist.js');
const { install, fake } = await import('./helpers/fakes.js');

const app = express();
app.use(express.json());
app.get('/v1/models', auth.clientAuth({ allowAdminToken: true }), (req, res) => res.json({ object: 'list', data: [] }));
app.use('/v1/admin', adminRouter, jsonErrorHandler);
app.use('/v1/analytics', auth.monitorAuth, analyticsRouter);
app.use('/v1/chat', auth.chatGate, rateLimit, chatRouter);
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const groq = fake(() => ({ content: 'from groq', usage: { total_tokens: 7 } }), { calculateCost: () => 0.01 });
const gemini = fake(() => ({ content: 'from gemini', usage: { total_tokens: 5 } }), { calculateCost: () => 0.01 });
const restore = install({ gemini, groq });

test.after(() => {
  restore();
  server.close();
  persist.flushAll();
  fs.rmSync(DIR, { recursive: true, force: true });
});

function withEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const done = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  let out;
  try { out = fn(); } catch (e) { done(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(done);
  done();
  return out;
}

async function call(method, p, { body, headers = {}, remote = false } = {}) {
  const init = { method, headers: { ...headers } };
  if (remote) init.headers['x-forwarded-for'] = '203.0.113.9'; // proxied request = not local
  if (body !== undefined) {
    init.headers['content-type'] ??= 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(base + p, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}

const chat = (opts = {}) => call('POST', '/v1/chat/completions', {
  ...opts,
  headers: { 'x-cache': 'bypass', ...(opts.headers || {}) },
  body: { messages: [{ role: 'user', content: opts.prompt || 'hello there' }], ...(opts.body || {}) }
});
const bearer = key => ({ authorization: `Bearer ${key}` });
const mkKey = async (body) => {
  const r = await call('POST', '/v1/admin/keys', { body });
  assert.equal(r.status, 201, r.text);
  return r.json;
};

test('key format, hash-only storage, one-time reveal', async () => {
  const k = clientKeys.generateKey();
  assert.match(k, /^cg-[A-Za-z0-9_-]{40}$/);

  const created = await mkKey({ name: 'svc-a' });
  const { key, record } = created;
  assert.match(key, /^cg-[A-Za-z0-9_-]{40}$/);
  assert.equal(record.keyHint, `${key.slice(0, 7)}…${key.slice(-4)}`);
  assert.equal(record.hash, undefined);
  assert.equal(record.enabled, true);
  assert.equal(record.spendUsd, 0);

  const onDisk = fs.readFileSync(path.join(DIR, 'client-keys.json'), 'utf8');
  assert.ok(!onDisk.includes(key), 'plain key must never be stored');
  assert.ok(onDisk.includes(clientKeys.hashKey(key)));

  const list = await call('GET', '/v1/admin/keys');
  assert.equal(list.status, 200);
  assert.ok(['auto', 'required', 'off'].includes(list.json.authMode));
  assert.ok(!list.text.includes(key));
  assert.ok(!list.text.includes(clientKeys.hashKey(key)), 'hash is not returned either');
  assert.ok(list.json.keys.some(r => r.id === record.id));

  // Reload from disk: still verifiable by hash.
  clientKeys._reload();
  assert.equal(clientKeys.verifyKey(key)?.id, record.id);
  assert.equal(clientKeys.verifyKey(key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(clientKeys.verifyKey('not-a-key'), null);
});

test('admin CRUD: validation, patch, revoke, auth', async () => {
  const bad = [
    {}, { name: '' }, { name: 'x'.repeat(65) }, { name: 'ok', rpmLimit: -1 }, { name: 'ok', rpmLimit: 1.5 },
    { name: 'ok', budgetUsd: 'abc' }, { name: 'ok', allowedProviders: ['nope'] }, { name: 'ok', allowedProviders: 'groq' },
    { name: 'ok', expiresAt: '2001-01-01T00:00:00Z' }, { name: 'ok', expiresAt: 'soon' }, { name: 'ok', allowedPolicies: ['fast'] }
  ];
  for (const body of bad) assert.equal((await call('POST', '/v1/admin/keys', { body })).status, 400, JSON.stringify(body));
  assert.equal((await call('POST', '/v1/admin/keys', { body: '[]' })).status, 400);

  const { record } = await mkKey({ name: ' crud ', rpmLimit: 10, tpmLimit: 5000, budgetUsd: 2.5, allowedProviders: ['GROQ', 'openai'] });
  assert.equal(record.name, 'crud');
  assert.deepEqual(record.allowedProviders, ['groq', 'openrouter'], 'canonical names (openai -> openrouter alias)');

  const p = await call('PATCH', `/v1/admin/keys/${record.id}`, { body: { name: 'renamed', enabled: false, rpmLimit: null, allowedProviders: null } });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.record.name, 'renamed');
  assert.equal(p.json.record.enabled, false);
  assert.equal(p.json.record.rpmLimit, null);
  assert.equal(p.json.record.tpmLimit, 5000, 'untouched fields kept');
  assert.equal(p.json.record.allowedProviders, null);
  assert.equal((await call('PATCH', `/v1/admin/keys/${record.id}`, { body: { enabled: 'yes' } })).status, 400);
  assert.equal((await call('PATCH', '/v1/admin/keys/ck_missing', { body: { name: 'x' } })).status, 404);

  assert.equal((await call('DELETE', `/v1/admin/keys/${record.id}`)).status, 200);
  assert.equal((await call('DELETE', `/v1/admin/keys/${record.id}`)).status, 404);

  // Admin auth: proxied/remote without token -> 403; token enforced once set.
  assert.equal((await call('GET', '/v1/admin/keys', { remote: true })).status, 403);
  await withEnv({ ADMIN_TOKEN: 'adm-test-token-123' }, async () => {
    assert.equal((await call('GET', '/v1/admin/keys')).status, 401);
    assert.equal((await call('POST', '/v1/admin/keys', { body: { name: 'x' } })).status, 401);
    assert.equal((await call('GET', '/v1/admin/keys', { remote: true, headers: { 'x-admin-token': 'adm-test-token-123' } })).status, 200);
  });
});

test('auth modes: auto (local vs remote), required, off; Bearer and x-api-key', async () => {
  const { key } = await mkKey({ name: 'modes' });

  // auto (default)
  assert.equal((await chat()).status, 200, 'local keyless allowed in auto');
  assert.equal((await chat({ headers: bearer('sk-dummy-openai-sdk') })).status, 200, 'dummy non-cg key ignored locally');
  const remote = await chat({ remote: true });
  assert.equal(remote.status, 401);
  assert.equal(remote.json.error.code, 'INVALID_API_KEY');
  assert.ok(remote.headers.get('www-authenticate'));
  assert.equal((await chat({ remote: true, headers: bearer(key) })).status, 200);
  assert.equal((await chat({ remote: true, headers: { 'x-api-key': key } })).status, 200);
  assert.equal((await chat({ headers: bearer('cg-' + 'x'.repeat(40)) })).status, 401, 'unknown cg- key rejected even locally');
  assert.equal((await call('GET', '/v1/models', { remote: true })).status, 401);
  assert.equal((await call('GET', '/v1/models')).status, 200);

  await withEnv({ CLIENT_AUTH: 'required' }, async () => {
    assert.equal((await chat()).status, 401, 'local needs a key too');
    assert.equal((await chat({ headers: bearer('sk-dummy') })).status, 401);
    const ok = await chat({ headers: bearer(key) });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.object, 'chat.completion');
    assert.equal((await call('GET', '/v1/models')).status, 401);
    assert.equal((await call('GET', '/v1/models', { headers: bearer(key) })).status, 200);
    await withEnv({ ADMIN_TOKEN: 'adm-xyz-123456' }, async () => {
      assert.equal((await call('GET', '/v1/models', { headers: { 'x-admin-token': 'adm-xyz-123456' } })).status, 200);
      assert.equal((await chat({ headers: { 'x-admin-token': 'adm-xyz-123456' } })).status, 401, 'admin token is not a client key');
    });
  });

  await withEnv({ CLIENT_AUTH: 'off' }, async () => {
    assert.equal((await chat({ remote: true })).status, 200);
    assert.equal((await call('GET', '/v1/chat/stats', { remote: true })).status, 200);
  });

  await withEnv({ CLIENT_AUTH: 'bogus' }, () => assert.equal(auth.authMode(), 'auto'));
});

test('disabled / expired keys -> 403 codes', async () => {
  const { key, record } = await mkKey({ name: 'lifecycle' });
  assert.equal((await chat({ headers: bearer(key) })).status, 200);

  await call('PATCH', `/v1/admin/keys/${record.id}`, { body: { enabled: false } });
  const d = await chat({ headers: bearer(key) });
  assert.equal(d.status, 403);
  assert.equal(d.json.error.code, 'KEY_DISABLED');

  await call('PATCH', `/v1/admin/keys/${record.id}`, { body: { enabled: true, expiresAt: new Date(Date.now() - 1000).toISOString() } });
  const e = await chat({ headers: bearer(key) });
  assert.equal(e.status, 403);
  assert.equal(e.json.error.code, 'KEY_EXPIRED');

  await call('PATCH', `/v1/admin/keys/${record.id}`, { body: { expiresAt: null } });
  assert.equal((await chat({ headers: bearer(key) })).status, 200);

  await call('DELETE', `/v1/admin/keys/${record.id}`);
  const revoked = await chat({ headers: bearer(key) });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.json.error.code, 'INVALID_API_KEY');
});

test('per-key RPM -> 429 KEY_RATE_LIMITED with Retry-After', async () => {
  const { key } = await mkKey({ name: 'rpm', rpmLimit: 2 });
  assert.equal((await chat({ headers: bearer(key) })).status, 200);
  assert.equal((await chat({ headers: bearer(key) })).status, 200);
  const r = await chat({ headers: bearer(key) });
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, 'KEY_RATE_LIMITED');
  const ra = Number(r.headers.get('retry-after'));
  assert.ok(ra >= 1 && ra <= 60, `Retry-After ${ra}`);
  // Another key is unaffected.
  const other = await mkKey({ name: 'rpm-other', rpmLimit: 2 });
  assert.equal((await chat({ headers: bearer(other.key) })).status, 200);
});

test('per-key TPM: once the window holds tpmLimit tokens -> 429', async () => {
  const { key } = await mkKey({ name: 'tpm', tpmLimit: 10 });
  assert.equal((await chat({ headers: bearer(key) })).status, 200); // 5-7 tokens
  assert.equal((await chat({ headers: bearer(key) })).status, 200); // >= 10 afterwards
  const r = await chat({ headers: bearer(key) });
  assert.equal(r.status, 429);
  assert.match(r.json.error.message, /tokens per minute/);
});

test('budget: spend accumulates, then 402 BUDGET_EXCEEDED; resetSpend re-opens', async () => {
  const { key, record } = await mkKey({ name: 'budget', budgetUsd: 0.015 });
  assert.equal((await chat({ headers: bearer(key) })).status, 200); // 0.01
  assert.equal((await chat({ headers: bearer(key) })).status, 200); // 0.02 (was below budget when admitted)
  const r = await chat({ headers: bearer(key) });
  assert.equal(r.status, 402);
  assert.equal(r.json.error.code, 'BUDGET_EXCEEDED');

  const rec = (await call('GET', '/v1/admin/keys')).json.keys.find(k => k.id === record.id);
  assert.ok(Math.abs(rec.spendUsd - 0.02) < 1e-9);
  assert.equal(rec.requests, 2);
  assert.ok(rec.tokens >= 10 && rec.tokens <= 14, `tokens ${rec.tokens}`); // 5-7 per fake call
  assert.equal(rec.errors, 0);
  assert.ok(rec.lastUsedAt);
  assert.equal(rec.budgetRemainingUsd, 0);

  // Request-log rows carry the key id/name (never the key).
  const row = requestLog.getHistory().find(x => x.apiKeyId === record.id);
  assert.equal(row.apiKeyName, 'budget');
  assert.ok(!JSON.stringify(requestLog.getHistory()).includes(key));

  await call('PATCH', `/v1/admin/keys/${record.id}`, { body: { resetSpend: true } });
  assert.equal((await chat({ headers: bearer(key) })).status, 200);
});

test('allowedProviders: forced provider outside the list -> 403; routing stays inside the list', async () => {
  const { key } = await mkKey({ name: 'groq-only', allowedProviders: ['groq'] });
  const denied = await chat({ headers: bearer(key), body: { provider: 'gemini' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, 'PROVIDER_NOT_ALLOWED');
  const deniedModel = await chat({ headers: bearer(key), body: { model: 'gemini/some-model' } });
  assert.equal(deniedModel.status, 403);

  const before = gemini.calls.length;
  for (let i = 0; i < 3; i++) {
    const r = await chat({ headers: bearer(key), prompt: `route me ${i}` });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.provider, 'groq');
  }
  assert.equal(gemini.calls.length, before, 'gemini never attempted for a groq-only key');

  const pol = await mkKey({ name: 'cost-only', allowedPolicies: ['cost'] });
  const pd = await chat({ headers: bearer(pol.key), body: { routing_policy: 'quality' } });
  assert.equal(pd.status, 403);
  assert.equal(pd.json.error.code, 'POLICY_NOT_ALLOWED');
  const pok = await chat({ headers: bearer(pol.key) });
  assert.equal(pok.status, 200);
  assert.equal(pok.json.routing.policy, 'cost', 'default policy replaced by the first allowed one');
});

test('bootstrap import is idempotent and never resurrects a revoked key', async () => {
  const boot = clientKeys.generateKey();
  assert.equal(clientKeys.importBootstrap(undefined), 'none');
  assert.equal(clientKeys.importBootstrap('cg-short'), 'invalid');
  assert.equal(clientKeys.importBootstrap(boot), 'imported');
  assert.equal(clientKeys.importBootstrap(boot), 'exists');
  const recs = clientKeys.listKeys().filter(k => k.name === 'bootstrap');
  assert.equal(recs.length, 1);
  assert.ok(!fs.readFileSync(path.join(DIR, 'client-keys.json'), 'utf8').includes(boot));

  await withEnv({ CLIENT_AUTH: 'required' }, async () => {
    assert.equal((await chat({ headers: bearer(boot) })).status, 200);
  });

  clientKeys._reload();
  assert.equal(clientKeys.importBootstrap(boot), 'exists', 'idempotent across restarts');
  clientKeys.deleteKey(recs[0].id);
  assert.equal(clientKeys.importBootstrap(boot), 'revoked');
  clientKeys._reload();
  assert.equal(clientKeys.importBootstrap(boot), 'revoked', 'tombstone persisted');
  assert.equal(clientKeys.verifyKey(boot), null);
});

test('monitoring endpoints follow the admin rule', async () => {
  assert.equal((await call('GET', '/v1/chat/stats')).status, 200, 'local ok');
  assert.equal((await call('GET', '/v1/chat/stats', { remote: true })).status, 403);
  assert.equal((await call('GET', '/v1/analytics?range=15m', { remote: true })).status, 403);
  assert.equal((await call('POST', '/v1/chat/reset', { remote: true, body: {} })).status, 403);
  assert.equal((await call('POST', '/v1/chat/reset', { headers: { origin: 'https://evil.example' }, body: {} })).status, 403, 'cross-site reset');
  const { key } = await mkKey({ name: 'not-admin' });
  assert.equal((await call('GET', '/v1/chat/stats', { remote: true, headers: bearer(key) })).status, 403, 'client keys do not grant monitoring');
  await withEnv({ ADMIN_TOKEN: 'adm-monitor-123' }, async () => {
    const r = await call('GET', '/v1/chat/stats', { remote: true });
    assert.equal(r.status, 401);
    assert.equal((await call('GET', '/v1/chat/stats', { remote: true, headers: { 'x-admin-token': 'wrong' } })).status, 401);
    assert.equal((await call('GET', '/v1/chat/stats', { remote: true, headers: { 'x-admin-token': 'adm-monitor-123' } })).status, 200);
    assert.equal((await call('GET', '/v1/chat/stats')).status, 200, 'local still ok with a token configured');
  });
});

test('isLocalRequest + wsAllowed', () => {
  const req = ({ ip = '127.0.0.1', host = 'localhost:3003', url = '/ws/metrics', headers = {} } = {}) =>
    ({ url, socket: { remoteAddress: ip }, headers: { host, ...headers } });
  assert.equal(auth.isLocalRequest(req()), true);
  assert.equal(auth.isLocalRequest(req({ ip: '::ffff:127.0.0.1' })), true);
  assert.equal(auth.isLocalRequest(req({ ip: '172.17.0.1' })), false, 'docker bridge is not local');
  assert.equal(auth.isLocalRequest(req({ host: 'evil.example' })), false, 'DNS rebinding');
  assert.equal(auth.isLocalRequest(req({ headers: { 'x-forwarded-for': '1.2.3.4' } })), false, 'reverse proxy');

  assert.equal(auth.wsAllowed(req()), true);
  assert.equal(auth.wsAllowed(req({ headers: { origin: 'http://localhost:3003' } })), true);
  assert.equal(auth.wsAllowed(req({ headers: { origin: 'https://evil.example' } })), false, 'cross-site WS hijack');
  assert.equal(auth.wsAllowed(req({ ip: '10.0.0.8', host: 'gw.example' })), false);
  withEnv({ ADMIN_TOKEN: 'adm-ws-token-1' }, () => {
    assert.equal(auth.wsAllowed(req({ ip: '10.0.0.8', host: 'gw.example', url: '/ws/metrics?token=adm-ws-token-1' })), true);
    assert.equal(auth.wsAllowed(req({ ip: '10.0.0.8', host: 'gw.example', url: '/ws/metrics?token=nope' })), false);
  });
  withEnv({ CLIENT_AUTH: 'off' }, () => assert.equal(auth.wsAllowed(req({ ip: '10.0.0.8', host: 'gw.example' })), true));
});
