import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-keystore-'));
process.env.DATA_DIR = DIR;
delete process.env.CORTEX_SECRET_KEY;

const secrets = await import('../src/security/secrets.js');
const keyStore = await import('../src/providers/keyStore.js');

const SECRET = 'gsk_UNITTEST_secret_value_9876';

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('AES-256-GCM round trip with a fresh IV per value', () => {
  const a = secrets.encrypt('hello');
  const b = secrets.encrypt('hello');
  assert.notEqual(a, b, 'random IV makes ciphertexts differ');
  assert.equal(secrets.decrypt(a), 'hello');
  assert.deepEqual(secrets.decryptJSON(secrets.encryptJSON({ x: [1, 2] })), { x: [1, 2] });
  assert.ok(fs.existsSync(path.join(DIR, '.secret')), 'generated key file when CORTEX_SECRET_KEY is unset');
});

test('tampered ciphertext, tag or wrong key fail authentication', () => {
  const env = secrets.encrypt('top secret');
  const parts = env.split('.');
  const flip = s => { const b = Buffer.from(s, 'base64url'); b[0] ^= 1; return b.toString('base64url'); };
  assert.throws(() => secrets.decrypt([parts[0], parts[1], parts[2], flip(parts[3])].join('.')), /authentication failed/);
  assert.throws(() => secrets.decrypt([parts[0], parts[1], flip(parts[2]), parts[3]].join('.')), /authentication failed/);
  assert.throws(() => secrets.decrypt(env, crypto.randomBytes(32)), /authentication failed/);
  assert.throws(() => secrets.decrypt('garbage'), /envelope/);
});

test('CORTEX_SECRET_KEY (hex) is used when set', () => {
  const key = crypto.randomBytes(32);
  process.env.CORTEX_SECRET_KEY = key.toString('hex');
  try {
    const env = secrets.encrypt('x');
    assert.equal(secrets.decrypt(env, key), 'x');
  } finally {
    delete process.env.CORTEX_SECRET_KEY;
  }
});

test('maskKey shows only first 3 + last 4', () => {
  assert.equal(secrets.maskKey('sk-abcdefghijklmnop1234'), 'sk-…1234');
  assert.equal(secrets.maskKey(''), null);
  assert.ok(!secrets.maskKey('short1').includes('short'));
  assert.equal(secrets.redact(`bad key ${SECRET}!`, SECRET), `bad key gsk…9876!`);
});

test('dashboard key overrides env, persists encrypted (no plaintext on disk), clears back to env', () => {
  process.env.GROQ_API_KEY = 'env-key-value-123456';
  try {
    assert.equal(keyStore.getProviderKey(['GROQ_API_KEY']), 'env-key-value-123456');
    assert.equal(keyStore.keySource('groq'), 'env');

    keyStore.setBuiltinKey('groq', { apiKey: SECRET });
    assert.equal(keyStore.getProviderKey(['GROQ_API_KEY']), SECRET);
    assert.equal(keyStore.keySource('groq'), 'dashboard');
    assert.equal(keyStore.keyHint('groq'), 'gsk…9876');

    const onDisk = fs.readFileSync(path.join(DIR, keyStore.STORE_FILE), 'utf8');
    assert.ok(!onDisk.includes(SECRET), 'key must not be stored in plaintext');
    assert.ok(!onDisk.includes('groq'), 'provider names are inside the ciphertext too');

    keyStore._reload();
    assert.equal(keyStore.getProviderKey(['GROQ_API_KEY'], 'groq'), SECRET, 'survives reload from disk');

    keyStore.clearBuiltinKey('groq');
    assert.equal(keyStore.getProviderKey(['GROQ_API_KEY']), 'env-key-value-123456');
  } finally {
    delete process.env.GROQ_API_KEY;
  }
});

test('cloudflare account id resolves dashboard then env', () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'envacct123';
  try {
    assert.equal(keyStore.getProviderAccountId('cloudflare'), 'envacct123');
    keyStore.setBuiltinKey('cloudflare', { apiKey: 'cf-token-abcdefgh', accountId: 'dashacct456' });
    assert.equal(keyStore.getProviderAccountId('cloudflare'), 'dashacct456');
    keyStore.clearBuiltinKey('cloudflare');
  } finally {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
  }
});

test('a tampered store file is detected and writes are refused (no silent data loss)', () => {
  keyStore.setBuiltinKey('cerebras', { apiKey: 'csk-1234567890abcd' });
  const file = path.join(DIR, keyStore.STORE_FILE);
  const wrapper = JSON.parse(fs.readFileSync(file, 'utf8'));
  const p = wrapper.data.split('.');
  const ct = Buffer.from(p[3], 'base64url'); ct[ct.length - 1] ^= 0xff; p[3] = ct.toString('base64url');
  wrapper.data = p.join('.');
  fs.writeFileSync(file, JSON.stringify(wrapper));

  keyStore._reload();
  assert.match(keyStore.getLoadError(), /authentication failed/);
  assert.equal(keyStore.getProviderKey(['CEREBRAS_API_KEY']), '', 'tampered values are not used');
  assert.throws(() => keyStore.setBuiltinKey('groq', { apiKey: 'another-key-12345' }), /refusing to overwrite/);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(wrapper), 'file untouched');
  fs.rmSync(file);
  keyStore._reload();
});
