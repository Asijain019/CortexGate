// Client API keys ("virtual keys"): the credentials applications use to call CortexGate.
//
//   Format   : "cg-" + 40 url-safe random characters (240 bits of entropy).
//   Storage  : <DATA_DIR>/client-keys.json holds ONLY the sha256 hex digest plus a display hint
//              ("cg-xxxx…last4"). The plain key is returned exactly once, by createKey().
//   Lookup   : sha256(presented key) is compared against every stored digest with
//              crypto.timingSafeEqual (no early exit), so timing does not reveal partial matches.
//   Limits   : per-key rolling 60s RPM / TPM (Redis sorted sets when Redis is ready, else in-memory),
//              lifetime budgetUsd vs. accumulated spendUsd, expiresAt, enabled, allowedProviders,
//              allowedPolicies.
//   Bootstrap: CORTEXGATE_BOOTSTRAP_KEY=cg-... is imported (hashed) on startup as "bootstrap" when no
//              key with that hash exists. Revoked keys leave a hash tombstone so a bootstrap key that was
//              revoked is never resurrected by a restart.
//
// Nothing in this module logs or returns a plain key except createKey()'s one-time result.
import crypto from 'node:crypto';
import * as persist from '../stats/persist.js';
import { providerNames, canonicalName } from '../providers/index.js';

export const FILE = 'client-keys';
export const POLICIES = ['cost', 'balanced', 'quality'];
const KEY_RE = /^cg-[A-Za-z0-9_-]{20,128}$/;
const WINDOW_MS = 60_000;
const MAX_KEYS = 1000;
const MAX_LIMIT = 1e9;

export class ValidationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

// Under `node --test` without a DATA_DIR, never touch the real data/ directory.
const inTestWithoutDir = () => Boolean(process.env.NODE_TEST_CONTEXT) && !process.env.DATA_DIR;

let keys = null;        // records (with hash)
let revoked = [];       // sha256 digests of deleted keys (bootstrap tombstones)
const mem = new Map();  // id -> { req: number[], tok: Array<[ts, tokens]> }
let redisGetter = () => null;

function ensure() {
  if (keys) return keys;
  const saved = inTestWithoutDir() ? null : persist.load(FILE, null);
  keys = Array.isArray(saved?.keys) ? saved.keys.filter(k => k && typeof k.id === 'string' && /^[0-9a-f]{64}$/.test(k.hash || '')) : [];
  revoked = Array.isArray(saved?.revoked) ? saved.revoked.filter(h => /^[0-9a-f]{64}$/.test(h)) : [];
  return keys;
}
const snapshot = () => ({ version: 1, keys, revoked });
function persistNow() { if (!inTestWithoutDir()) persist.saveNow(FILE, snapshot); }
function persistLater() { if (!inTestWithoutDir()) persist.save(FILE, snapshot, 2000); }

/** Test helper: drop in-memory state and re-read the file. */
export function _reload() { keys = null; revoked = []; mem.clear(); ensure(); }
/** Rate-limit backend hook (middleware/rateLimit.js passes its Redis client getter). */
export function setRedisGetter(fn) { redisGetter = typeof fn === 'function' ? fn : () => null; }

// ---------------------------------------------------------------- primitives

export const generateKey = () => `cg-${crypto.randomBytes(30).toString('base64url')}`; // 40 chars
export const hashKey = key => crypto.createHash('sha256').update(String(key)).digest('hex');
export const keyHint = key => `${String(key).slice(0, 7)}…${String(key).slice(-4)}`;
export const isKeyFormat = key => typeof key === 'string' && KEY_RE.test(key);

/** Public view: everything except the hash, plus derived flags. */
export function publicView(rec) {
  if (!rec) return null;
  const { hash, ...rest } = rec;
  return {
    ...rest,
    expired: isExpired(rec),
    budgetRemainingUsd: rec.budgetUsd == null ? null : Math.max(0, rec.budgetUsd - (rec.spendUsd || 0))
  };
}
const isExpired = (rec, now = Date.now()) => Boolean(rec.expiresAt) && Date.parse(rec.expiresAt) <= now;

// ---------------------------------------------------------------- validation

function optLimit(v, field, { integer = false } = {}) {
  if (v === undefined) return undefined;
  if (v === null || v === '' || v === 0 || v === '0') return null;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > MAX_LIMIT) {
    throw new ValidationError(`'${field}' must be a positive number (or null for no limit)`);
  }
  if (integer && !Number.isInteger(n)) throw new ValidationError(`'${field}' must be a whole number`);
  return n;
}

function optName(v, required) {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string') throw new ValidationError("'name' must be a string of 1-64 characters");
  const name = v.trim();
  // eslint-disable-next-line no-control-regex
  if (name.length < 1 || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ValidationError("'name' must be 1-64 printable characters");
  }
  return name;
}

function optExpires(v, { create }) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const t = typeof v === 'string' || typeof v === 'number' ? Date.parse(typeof v === 'number' ? new Date(v).toISOString() : v) : NaN;
  if (!Number.isFinite(t)) throw new ValidationError("'expiresAt' must be an ISO date (or null)");
  if (create && t <= Date.now()) throw new ValidationError("'expiresAt' must be in the future");
  return new Date(t).toISOString();
}

function optList(v, field, universe, canon = x => x) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!Array.isArray(v) || v.length > 100) throw new ValidationError(`'${field}' must be an array of names (or null for all)`);
  if (!v.length) return null;
  const out = [];
  for (const item of v) {
    const name = typeof item === 'string' ? canon(item) : null;
    if (!name || !universe.includes(name)) {
      throw new ValidationError(`'${field}' contains an unknown value '${String(item).slice(0, 40)}'; known: ${universe.join(', ')}`);
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

const canonProvider = s => canonicalName(s);
const canonPolicy = s => String(s).trim().toLowerCase();

function validate(body, { create }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Request body must be a JSON object');
  const out = {
    name: optName(body.name, create),
    rpmLimit: optLimit(body.rpmLimit, 'rpmLimit', { integer: true }),
    tpmLimit: optLimit(body.tpmLimit, 'tpmLimit', { integer: true }),
    budgetUsd: optLimit(body.budgetUsd, 'budgetUsd'),
    expiresAt: optExpires(body.expiresAt, { create }),
    allowedProviders: optList(body.allowedProviders, 'allowedProviders', providerNames(), canonProvider),
    allowedPolicies: optList(body.allowedPolicies, 'allowedPolicies', POLICIES, canonPolicy)
  };
  if (!create) {
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new ValidationError("'enabled' must be true or false");
      out.enabled = body.enabled;
    }
    if (body.resetSpend !== undefined && typeof body.resetSpend !== 'boolean') throw new ValidationError("'resetSpend' must be true or false");
    out.resetSpend = body.resetSpend === true;
  }
  return out;
}

// ---------------------------------------------------------------- CRUD

function newRecord(name, plain, fields = {}) {
  return {
    id: `ck_${crypto.randomBytes(8).toString('hex')}`,
    name,
    keyHint: keyHint(plain),
    hash: hashKey(plain),
    enabled: true,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    expiresAt: fields.expiresAt ?? null,
    rpmLimit: fields.rpmLimit ?? null,
    tpmLimit: fields.tpmLimit ?? null,
    budgetUsd: fields.budgetUsd ?? null,
    spendUsd: 0,
    requests: 0,
    tokens: 0,
    errors: 0,
    allowedProviders: fields.allowedProviders ?? null,
    allowedPolicies: fields.allowedPolicies ?? null
  };
}

export function listKeys() {
  return ensure().map(publicView);
}

export function getKey(id) {
  return publicView(ensure().find(k => k.id === id));
}

export function keyCount() { return ensure().length; }

/** Returns { key, record }; `key` is the only time the plain value exists outside the caller. */
export function createKey(body) {
  const v = validate(body, { create: true });
  if (ensure().length >= MAX_KEYS) throw new ValidationError(`At most ${MAX_KEYS} client keys`);
  const plain = generateKey();
  const rec = newRecord(v.name, plain, v);
  keys.push(rec);
  persistNow();
  return { key: plain, record: publicView(rec) };
}

export function updateKey(id, body) {
  const v = validate(body, { create: false });
  const rec = ensure().find(k => k.id === id);
  if (!rec) return null;
  for (const f of ['name', 'rpmLimit', 'tpmLimit', 'budgetUsd', 'expiresAt', 'allowedProviders', 'allowedPolicies', 'enabled']) {
    if (v[f] !== undefined) rec[f] = v[f];
  }
  if (v.resetSpend) rec.spendUsd = 0;
  persistNow();
  return publicView(rec);
}

/** Revoke: removes the record and remembers its hash so a bootstrap import cannot bring it back. */
export function deleteKey(id) {
  const list = ensure();
  const i = list.findIndex(k => k.id === id);
  if (i < 0) return null;
  const [rec] = list.splice(i, 1);
  if (!revoked.includes(rec.hash)) revoked.push(rec.hash);
  if (revoked.length > 5000) revoked = revoked.slice(-5000);
  mem.delete(rec.id);
  persistNow();
  return publicView(rec);
}

/** Import CORTEXGATE_BOOTSTRAP_KEY (idempotent). Returns 'imported' | 'exists' | 'revoked' | 'invalid' | 'none'. */
export function importBootstrap(value = process.env.CORTEXGATE_BOOTSTRAP_KEY) {
  const plain = typeof value === 'string' ? value.trim() : '';
  if (!plain) return 'none';
  if (!isKeyFormat(plain)) {
    console.warn('[ClientKeys] CORTEXGATE_BOOTSTRAP_KEY ignored: expected "cg-" followed by 20-128 letters, digits, "-" or "_"');
    return 'invalid';
  }
  const hash = hashKey(plain);
  ensure();
  if (findByHash(hash)) return 'exists';
  if (revoked.includes(hash)) {
    console.warn(`[ClientKeys] CORTEXGATE_BOOTSTRAP_KEY (${keyHint(plain)}) was revoked; not re-importing it. Remove or rotate it in .env.`);
    return 'revoked';
  }
  keys.push(newRecord('bootstrap', plain));
  persistNow();
  console.log(`[ClientKeys] Imported bootstrap client key ${keyHint(plain)}`);
  return 'imported';
}

// ---------------------------------------------------------------- verification

function findByHash(hexDigest) {
  const want = Buffer.from(hexDigest, 'hex');
  let found = null;
  for (const rec of ensure()) {
    const have = Buffer.from(rec.hash, 'hex');
    if (have.length === want.length && crypto.timingSafeEqual(have, want) && !found) found = rec;
  }
  return found;
}

/** Internal record (with hash) for a presented plain key, or null. */
export function verifyKey(plain) {
  if (!isKeyFormat(plain)) return null;
  return findByHash(hashKey(plain));
}

const usd = n => (n >= 0.01 || n === 0 ? n.toFixed(4) : String(Number(n.toPrecision(3))));

/** Static checks: disabled, expired, budget. Returns null or { status, code, message }. */
export function checkAccess(rec, now = Date.now()) {
  if (!rec.enabled) return { status: 403, code: 'KEY_DISABLED', message: 'This API key is disabled' };
  if (isExpired(rec, now)) return { status: 403, code: 'KEY_EXPIRED', message: `This API key expired at ${rec.expiresAt}` };
  if (rec.budgetUsd != null && (rec.spendUsd || 0) >= rec.budgetUsd) {
    return { status: 402, code: 'BUDGET_EXCEEDED', message: `Budget exhausted for this API key ($${usd(rec.spendUsd || 0)} spent of $${usd(rec.budgetUsd)})` };
  }
  return null;
}

export const providerAllowed = (rec, name) => !rec?.allowedProviders || rec.allowedProviders.includes(canonicalName(name) || name);
export const policyAllowed = (rec, policy) => !rec?.allowedPolicies || rec.allowedPolicies.includes(policy);
/** Provider names the router must never use for this key. */
export function excludedProviders(rec) {
  if (!rec?.allowedProviders) return [];
  return providerNames().filter(n => !rec.allowedProviders.includes(n));
}

// ---------------------------------------------------------------- rate limits (rolling 60s)

function memState(id) {
  let s = mem.get(id);
  if (!s) { s = { req: [], tok: [] }; mem.set(id, s); }
  const cutoff = Date.now() - WINDOW_MS;
  while (s.req.length && s.req[0] <= cutoff) s.req.shift();
  while (s.tok.length && s.tok[0][0] <= cutoff) s.tok.shift();
  return s;
}
const retrySec = (oldest, now) => Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));

async function redisAdmit(redis, rec, now) {
  const cutoff = now - WINDOW_MS;
  if (rec.tpmLimit) {
    const k = `cg:tpm:${rec.id}`;
    await redis.zRemRangeByScore(k, 0, cutoff);
    const members = await redis.zRangeWithScores(k, 0, -1);
    const used = members.reduce((s, m) => s + (Number(String(m.value).split(':')[1]) || 0), 0);
    if (used >= rec.tpmLimit) return { ok: false, limit: 'tpm', retryAfterSec: retrySec(members[0]?.score ?? now, now) };
  }
  if (rec.rpmLimit) {
    const k = `cg:rpm:${rec.id}`;
    await redis.zRemRangeByScore(k, 0, cutoff);
    const count = await redis.zCard(k);
    if (count >= rec.rpmLimit) {
      const first = await redis.zRangeWithScores(k, 0, 0);
      return { ok: false, limit: 'rpm', retryAfterSec: retrySec(first[0]?.score ?? now, now) };
    }
    await redis.zAdd(k, { score: now, value: `${now}-${crypto.randomBytes(4).toString('hex')}` });
    await redis.pExpire(k, WINDOW_MS + 1000);
  }
  return { ok: true };
}

function memAdmit(rec, now) {
  const s = memState(rec.id);
  if (rec.tpmLimit) {
    const used = s.tok.reduce((a, [, n]) => a + n, 0);
    if (used >= rec.tpmLimit) return { ok: false, limit: 'tpm', retryAfterSec: retrySec(s.tok[0]?.[0] ?? now, now) };
  }
  if (rec.rpmLimit) {
    if (s.req.length >= rec.rpmLimit) return { ok: false, limit: 'rpm', retryAfterSec: retrySec(s.req[0], now) };
    s.req.push(now);
  }
  return { ok: true };
}

/** Admit one request against the key's RPM/TPM. Returns { ok } or { ok:false, limit, retryAfterSec }. */
export async function admit(rec, now = Date.now()) {
  if (!rec.rpmLimit && !rec.tpmLimit) return { ok: true };
  const redis = redisGetter();
  if (redis) {
    try { return await redisAdmit(redis, rec, now); } catch { /* fall back to memory */ }
  }
  return memAdmit(rec, now);
}

/**
 * After a completion: add spend/tokens/requests/errors, stamp lastUsedAt, feed the TPM window.
 * `cost` should already include verification + embedding cost.
 */
export function recordUsage(id, { cost = 0, tokens = 0, error = false } = {}) {
  const rec = ensure().find(k => k.id === id);
  if (!rec) return null;
  const now = Date.now();
  rec.requests = (rec.requests || 0) + 1;
  if (error) rec.errors = (rec.errors || 0) + 1;
  const c = Number(cost);
  if (Number.isFinite(c) && c > 0) rec.spendUsd = (rec.spendUsd || 0) + c;
  const t = Math.max(0, Math.round(Number(tokens) || 0));
  rec.tokens = (rec.tokens || 0) + t;
  rec.lastUsedAt = new Date(now).toISOString();
  if (t > 0 && rec.tpmLimit) {
    memState(rec.id).tok.push([now, t]);
    const redis = redisGetter();
    if (redis) {
      const k = `cg:tpm:${rec.id}`;
      redis.zAdd(k, { score: now, value: `${now}-${crypto.randomBytes(4).toString('hex')}:${t}` })
        .then(() => redis.pExpire(k, WINDOW_MS + 1000))
        .catch(() => {});
    }
  }
  persistLater();
  return rec;
}
