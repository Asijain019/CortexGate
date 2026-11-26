import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-admin-'));
process.env.DATA_DIR = DIR;
delete process.env.ADMIN_TOKEN;

const express = (await import('express')).default;
const { default: adminRouter, adminAuth, jsonErrorHandler } = await import('../src/routes/admin.js');
const { providers, getCustomCatalog, getProviderChain } = await import('../src/providers/index.js');
const custom = await import('../src/providers/customProvider.js');
const keyStore = await import('../src/providers/keyStore.js');

const KEY = 'sk-custom-SECRET-abcdef-7788';
const GROQ_KEY = 'gsk_dashboard_SECRET_55aa';

// Fake OpenAI-compatible upstream.
const upstreamCalls = [];
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    upstreamCalls.push({ url: req.url, auth: req.headers.authorization || null, body: JSON.parse(body || '{}') });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  });
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

const app = express();
app.use(express.json());
app.use('/v1/admin', adminRouter, jsonErrorHandler);
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://localhost:${server.address().port}/v1/admin`;

test.after(() => {
  server.close();
  upstream.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});

async function call(method, p, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['content-type'] ??= 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(base + p, init);
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

function runAuth({ ip = '127.0.0.1', host = 'localhost:3003', headers = {}, method = 'GET', json = true } = {}) {
  let status = 200;
  let nextCalled = false;
  const h = Object.fromEntries(Object.entries({ host, ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  if (json) h['content-type'] = 'application/json; charset=utf-8';
  const req = { method, socket: { remoteAddress: ip }, get: k => h[k.toLowerCase()] };
  const res = { status(s) { status = s; return this; }, json() { return this; }, set() { return this; } };
  adminAuth(req, res, () => { nextCalled = true; });
  return { status, nextCalled };
}

test('auth: loopback allowed, remote rejected, rebinding Host rejected, token enforced', () => {
  assert.equal(runAuth().nextCalled, true);
  assert.equal(runAuth({ ip: '::ffff:127.0.0.1' }).nextCalled, true);
  assert.equal(runAuth({ ip: '10.0.0.5' }).status, 403);
  assert.equal(runAuth({ ip: '192.168.1.2', headers: { 'x-forwarded-for': '127.0.0.1' } }).status, 403);
  assert.equal(runAuth({ host: 'evil.example:3003' }).status, 403);
  assert.equal(runAuth({ headers: { 'x-forwarded-for': '203.0.113.9' } }).status, 403, 'loopback via a reverse proxy is not local');
  assert.equal(runAuth({ ip: '172.17.0.1' }).status, 403, 'docker bridge is not local');
  assert.equal(runAuth({ method: 'POST', headers: { origin: 'https://evil.example' } }).status, 403);
  assert.equal(runAuth({ method: 'POST', headers: { origin: 'http://localhost:3003' } }).nextCalled, true);
  assert.equal(runAuth({ method: 'POST', json: false }).status, 415);
  assert.equal(runAuth({ method: 'DELETE', json: false }).nextCalled, true, 'DELETE always preflights cross-site');

  process.env.ADMIN_TOKEN = 'admintoken-xyz';
  try {
    assert.equal(runAuth().status, 401, 'token required even from loopback once set');
    assert.equal(runAuth({ headers: { 'x-admin-token': 'wrong' } }).status, 401);
    assert.equal(runAuth({ ip: '10.0.0.5', host: 'gw.example', headers: { 'x-admin-token': 'admintoken-xyz' } }).nextCalled, true);
  } finally {
    delete process.env.ADMIN_TOKEN;
  }
});

test('GET /providers lists builtins, presets and never keys', async () => {
  const r = await call('GET', '/providers');
  assert.equal(r.status, 200);
  const groq = r.json.builtin.find(b => b.name === 'groq');
  assert.ok(groq && 'keySource' in groq && 'keyHint' in groq);
  assert.ok(r.json.builtin.find(b => b.name === 'cloudflare').needsAccountId);
  assert.ok(r.json.presets.length >= 10);
  for (const p of r.json.presets) {
    assert.ok(p.baseUrl.startsWith('http') && p.signupUrl && typeof p.free === 'boolean' && p.note);
    if (p.free && p.pricing !== 'local') assert.match(p.note, /free tier\/credits|trial credits/i);
  }
});

test('builtin key: PUT stores encrypted, response only has keyHint, DELETE falls back', async () => {
  const bad = await call('PUT', '/providers/builtin/groq/key', { apiKey: 'has space in it' });
  assert.equal(bad.status, 400);
  assert.equal((await call('PUT', '/providers/builtin/nope/key', { apiKey: 'abcdefghijk' })).status, 404);
  assert.equal((await call('PUT', '/providers/builtin/groq/key', '{oops')).status, 400);

  const put = await call('PUT', '/providers/builtin/groq/key', { apiKey: GROQ_KEY });
  assert.equal(put.status, 200);
  assert.ok(!put.text.includes(GROQ_KEY));
  assert.equal(put.json.provider.keySource, 'dashboard');
  assert.equal(put.json.provider.keyHint, 'gsk…55aa');
  assert.equal(put.json.provider.configured, true);
  assert.equal(keyStore.getProviderKey(['GROQ_API_KEY']), GROQ_KEY);
  assert.ok(!fs.readFileSync(path.join(DIR, keyStore.STORE_FILE), 'utf8').includes(GROQ_KEY));

  const list = await call('GET', '/providers');
  assert.ok(!list.text.includes(GROQ_KEY));

  const del = await call('DELETE', '/providers/builtin/groq/key', {});
  assert.equal(del.status, 200);
  assert.notEqual(keyStore.getProviderKey(['GROQ_API_KEY'], 'groq'), GROQ_KEY);
});

test('custom provider: validation errors', async () => {
  const clash = await call('POST', '/providers/custom', { name: 'Groq', baseUrl: upstreamBase, model: 'm' });
  assert.equal(clash.status, 400);
  assert.match(clash.json.error.message, /built-in/);
  assert.equal((await call('POST', '/providers/custom', { name: 'cache', baseUrl: upstreamBase, model: 'm' })).status, 400);

  for (const baseUrl of ['ftp://example.com/v1', 'not a url', 'javascript:alert(1)', 'http://user:pw@example.com/v1', '']) {
    const r = await call('POST', '/providers/custom', { name: 'x1', baseUrl, model: 'm' });
    assert.equal(r.status, 400, `rejects ${baseUrl}`);
  }
  assert.equal((await call('POST', '/providers/custom', { name: 'x1', baseUrl: upstreamBase })).status, 400, 'model required');
  assert.equal((await call('POST', '/providers/custom', { name: 'x1', baseUrl: upstreamBase, model: 'm', quality: 3 })).status, 400);
  assert.equal((await call('POST', '/providers/custom', [])).status, 400);
});

test('custom provider CRUD: registered for routing immediately, key never returned, /test works', async () => {
  const created = await call('POST', '/providers/custom', {
    name: 'My Fake LLM!', baseUrl: `${upstreamBase}/v1/`, apiKey: KEY, model: 'fake-model', modelHeavy: 'fake-big',
    quality: 0.7, pricePrompt: 1, priceCompletion: 2
  });
  assert.equal(created.status, 201, created.text);
  const cp = created.json;
  assert.equal(cp.name, 'my-fake-llm');
  assert.equal(cp.baseUrl, `${upstreamBase}/v1`);
  assert.deepEqual(cp.models, { light: 'fake-model', standard: 'fake-model', heavy: 'fake-big' });
  assert.equal(cp.keyHint, 'sk-…7788');
  assert.ok(!created.text.includes(KEY));

  // registry + catalog
  assert.ok(providers['my-fake-llm']);
  assert.ok(getProviderChain().includes('my-fake-llm'));
  const cat = getCustomCatalog()['my-fake-llm'];
  assert.equal(cat.custom, true);
  assert.deepEqual(cat.price, { prompt: 1, completion: 2 });
  assert.equal(cat.quality.standard, 0.7);

  const dup = await call('POST', '/providers/custom', { name: 'my-fake-llm', baseUrl: upstreamBase, model: 'm' });
  assert.equal(dup.status, 400);

  // adapter routes to <baseUrl>/chat/completions with the stored key
  const out = await providers['my-fake-llm'].sendChatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.content, 'OK');
  const last = upstreamCalls.at(-1);
  assert.equal(last.url, '/v1/chat/completions');
  assert.equal(last.auth, `Bearer ${KEY}`);
  assert.ok(Math.abs(providers['my-fake-llm'].calculateCost({ prompt_tokens: 1e6, completion_tokens: 1e6 }) - 3) < 1e-9);

  // /test (by name and by id)
  const t = await call('POST', `/providers/my-fake-llm/test`, {});
  assert.equal(t.status, 200);
  assert.equal(t.json.ok, true);
  assert.equal(t.json.sample, 'OK');
  assert.ok(Number.isFinite(t.json.latencyMs));
  assert.equal(upstreamCalls.at(-1).body.max_tokens, 16);
  assert.equal(upstreamCalls.at(-1).body.messages[0].content, 'Reply with OK');
  const t2 = await call('POST', `/providers/${cp.id}/test`, {});
  assert.equal(t2.json.ok, true);

  // PATCH without apiKey keeps the key; listing never shows it
  const patched = await call('PATCH', `/providers/custom/${cp.id}`, { model: 'fake-model-2', enabled: false });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.model, 'fake-model-2');
  assert.equal(patched.json.keyHint, 'sk-…7788');
  assert.equal(patched.json.enabled, false);
  assert.equal(providers['my-fake-llm'].isConfigured(), false);
  assert.ok(patched.json.lastTest?.ok);
  const list = await call('GET', '/providers');
  assert.ok(!list.text.includes(KEY));
  assert.equal(list.json.custom.length, 1);

  const disabledTest = await call('POST', `/providers/my-fake-llm/test`, {});
  assert.equal(disabledTest.json.ok, false);

  // persisted encrypted and reloadable
  const onDisk = fs.readFileSync(path.join(DIR, keyStore.STORE_FILE), 'utf8');
  assert.ok(!onDisk.includes(KEY) && !onDisk.includes('my-fake-llm'));

  assert.equal((await call('PATCH', '/providers/custom/cp_missing', { model: 'x' })).status, 404);

  const del = await fetch(`${base}/providers/custom/${cp.id}`, { method: 'DELETE' }).then(async r => ({ status: r.status }));
  assert.equal(del.status, 200);
  assert.equal(providers['my-fake-llm'], undefined);
  assert.equal(getCustomCatalog()['my-fake-llm'], undefined);
  assert.equal((await call('DELETE', `/providers/custom/${cp.id}`, {})).status, 404);
});

test('custom providers reload from the encrypted store', () => {
  const view = custom.createCustom({ name: 'reloaded', baseUrl: 'http://localhost:11434', model: 'qwen2.5:0.5b' });
  assert.equal(view.baseUrl, 'http://localhost:11434/v1', 'bare host gets /v1');
  assert.equal(view.local, true);
  delete providers.reloaded;
  keyStore._reload();
  assert.equal(custom.loadCustomProviders(), 1);
  assert.ok(providers.reloaded);
  custom.deleteCustom(view.id);
});

test('client keys admin API: create reveals the key once, list/patch/delete never expose key or hash', async () => {
  const c = await call('POST', '/keys', { name: 'admin-test', rpmLimit: 5, allowedProviders: ['groq'] });
  assert.equal(c.status, 201, c.text);
  assert.match(c.json.key, /^cg-[A-Za-z0-9_-]{40}$/);
  const { key, record } = c.json;
  assert.equal(record.hash, undefined);
  const list = await call('GET', '/keys');
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes(key) && !list.text.includes('"hash"'));
  assert.ok(['auto', 'required', 'off'].includes(list.json.authMode));
  const p = await call('PATCH', `/keys/${record.id}`, { enabled: false });
  assert.equal(p.json.record.enabled, false);
  assert.ok(!p.text.includes(key));
  assert.equal((await call('POST', '/keys', { name: 'bad', allowedProviders: ['nope'] })).status, 400);
  assert.equal((await call('POST', '/keys', { name: 'x' }, { 'content-type': 'text/plain' })).status, 415);
  const d = await call('DELETE', `/keys/${record.id}`, {});
  assert.equal(d.status, 200);
  assert.equal(d.json.ok, true);
  assert.equal((await call('DELETE', `/keys/${record.id}`, {})).status, 404);
  assert.ok(!fs.readFileSync(path.join(DIR, 'client-keys.json'), 'utf8').includes(key));
});

test('/test redacts a key echoed by the upstream error', async () => {
  const echo = http.createServer((req, res) => {
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { message: `Invalid key ${KEY}` } }));
  });
  await new Promise(r => echo.listen(0, '127.0.0.1', r));
  try {
    const c = await call('POST', '/providers/custom', { name: 'echoer', baseUrl: `http://127.0.0.1:${echo.address().port}/v1`, apiKey: KEY, model: 'm' });
    const t = await call('POST', '/providers/echoer/test', {});
    assert.equal(t.json.ok, false);
    assert.equal(t.json.status, 401);
    assert.ok(!t.text.includes(KEY), 'key must be redacted');
    await call('DELETE', `/providers/custom/${c.json.id}`, {});
  } finally {
    echo.close();
  }
});
