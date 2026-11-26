// Symmetric encryption for secrets at rest (provider API keys, custom providers).
//
//   Algorithm : AES-256-GCM, 12-byte random IV per encryption, 16-byte auth tag (verified on decrypt).
//   Master key: CORTEX_SECRET_KEY env (32 bytes as 64 hex chars or base64). Any other non-empty value
//               is treated as a passphrase and stretched with scrypt. Without it a random key is
//               generated once into <DATA_DIR>/.secret (mode 0600) and a warning is printed.
//   Envelope  : "v1.<iv b64url>.<tag b64url>.<ciphertext b64url>"
//
// Nothing in this module ever logs key material or plaintext.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALG = 'aes-256-gcm';
const VERSION = 'v1';
const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

let cachedKey = null;
let cachedFor = null;
let warned = false;

/** Data directory (read live so tests can point DATA_DIR at a temp folder). */
export function dataDir() {
  return process.env.DATA_DIR || DEFAULT_DIR;
}

function decodeKey(raw) {
  const v = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  if (/^[A-Za-z0-9+/_-]{43,44}={0,2}$/.test(v)) {
    const b = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 32) return b;
  }
  // Passphrase: stretch it. Fixed salt is acceptable because the output is only used as a
  // local wrapping key; operators who care should supply 32 random bytes instead.
  return crypto.scryptSync(v, 'cortexgate-secret-v1', 32);
}

function loadOrCreateFileKey() {
  const dir = dataDir();
  const file = path.join(dir, '.secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return decodeKey(existing);
  } catch { /* not there yet */ }
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  if (!warned) {
    warned = true;
    console.warn(`[Secrets] CORTEX_SECRET_KEY is not set; generated a local encryption key in ${file}. ` +
      'Keep that file private (it is git-ignored) or set CORTEX_SECRET_KEY to 32 random bytes (hex).');
  }
  return key;
}

/** The 32-byte master key (cached per source). */
export function getMasterKey() {
  const envKey = process.env.CORTEX_SECRET_KEY?.trim();
  const source = envKey ? `env:${crypto.createHash('sha256').update(envKey).digest('hex')}` : `file:${dataDir()}`;
  if (cachedKey && cachedFor === source) return cachedKey;
  cachedKey = envKey ? decodeKey(envKey) : loadOrCreateFileKey();
  cachedFor = source;
  return cachedKey;
}

/** Test helper: forget the cached key. */
export function _resetKeyCache() {
  cachedKey = null;
  cachedFor = null;
}

const b64u = buf => buf.toString('base64url');
const unb64u = s => Buffer.from(s, 'base64url');

export function encrypt(plaintext, key = getMasterKey()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [VERSION, b64u(iv), b64u(cipher.getAuthTag()), b64u(ct)].join('.');
}

/** Throws if the envelope is malformed, the key is wrong or the data was tampered with. */
export function decrypt(envelope, key = getMasterKey()) {
  const parts = String(envelope || '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unrecognised secret envelope');
  const [, iv, tag, ct] = parts.map((p, i) => (i === 0 ? p : unb64u(p)));
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Corrupt secret envelope');
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Secret authentication failed (wrong CORTEX_SECRET_KEY or tampered data)');
  }
}

export const encryptJSON = obj => encrypt(JSON.stringify(obj));
export const decryptJSON = env => JSON.parse(decrypt(env));

/** Read <DATA_DIR>/<file>. Returns null if absent; throws if present but undecryptable. */
export function readEncryptedFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dataDir(), file), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const wrapper = JSON.parse(raw);
  if (!wrapper || wrapper.alg !== ALG || typeof wrapper.data !== 'string') throw new Error(`${file} has an unknown format`);
  return decryptJSON(wrapper.data);
}

/** Atomically write obj encrypted into <DATA_DIR>/<file>. */
export function writeEncryptedFile(file, obj) {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file);
  const tmp = `${target}.${process.pid}.tmp`;
  const wrapper = { version: 1, alg: ALG, updatedAt: new Date().toISOString(), data: encryptJSON(obj) };
  fs.writeFileSync(tmp, JSON.stringify(wrapper), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/** Non-reversible display hint: first 3 + "…" + last 4 (less for short values). */
export function maskKey(value) {
  const v = String(value || '');
  if (!v) return null;
  if (v.length >= 12) return `${v.slice(0, 3)}…${v.slice(-4)}`;
  if (v.length >= 6) return `…${v.slice(-2)}`;
  return '…';
}

/** Replace any occurrence of `secret` inside `text` (provider errors sometimes echo keys). */
export function redact(text, ...secrets) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s && typeof s === 'string' && s.length >= 4) out = out.split(s).join(maskKey(s) || '…');
  }
  return out;
}

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a ?? '').length === String(b ?? '').length;
}
