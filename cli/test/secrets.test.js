import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateClientKey, generateAdminToken, generateSecretKey, CLIENT_KEY_RE, maskSecret } from '../src/secrets.js';
import { planSecrets } from '../src/init.js';

test('client key is cg- + 40 url-safe chars and random', () => {
  const keys = new Set();
  for (let i = 0; i < 50; i++) {
    const k = generateClientKey();
    assert.match(k, CLIENT_KEY_RE);
    assert.equal(k.length, 43);
    keys.add(k);
  }
  assert.equal(keys.size, 50);
});

test('admin token and secret key are 64 hex chars (32 bytes)', () => {
  assert.match(generateAdminToken(), /^[0-9a-f]{64}$/);
  assert.match(generateSecretKey(), /^[0-9a-f]{64}$/);
  assert.notEqual(generateAdminToken(), generateAdminToken());
});

test('maskSecret never reveals the middle', () => {
  const k = 'cg-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn';
  assert.equal(maskSecret(k), 'cg-ABCD…klmn');
  assert.equal(maskSecret('short'), '•••••');
  assert.equal(maskSecret(''), '');
});

const gen = { admin: () => 'ADMIN', client: () => 'cg-CLIENT', secret: () => 'SECRET' };

test('planSecrets generates only missing values', () => {
  const p = planSecrets({ ADMIN_TOKEN: 'keep', CORTEXGATE_BOOTSTRAP_KEY: '' }, { gen });
  assert.deepEqual(p.updates, { CORTEXGATE_BOOTSTRAP_KEY: 'cg-CLIENT', CORTEX_SECRET_KEY: 'SECRET' });
  assert.deepEqual(p.generated, ['CORTEXGATE_BOOTSTRAP_KEY', 'CORTEX_SECRET_KEY']);
});

test('planSecrets reuses data/.secret, and never invents a key for an orphaned encrypted store', () => {
  const reuse = planSecrets({}, { dataSecret: 'f'.repeat(64), gen });
  assert.equal(reuse.updates.CORTEX_SECRET_KEY, 'f'.repeat(64));
  assert.ok(!reuse.generated.includes('CORTEX_SECRET_KEY'));
  const orphan = planSecrets({}, { encryptedStoreExists: true, gen });
  assert.equal(orphan.updates.CORTEX_SECRET_KEY, undefined);
  assert.equal(orphan.notes.length, 1);
  const none = planSecrets({ ADMIN_TOKEN: 'a', CORTEXGATE_BOOTSTRAP_KEY: 'b', CORTEX_SECRET_KEY: 'c' }, { gen });
  assert.deepEqual(none.updates, {});
});
