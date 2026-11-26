// Client authentication for the OpenAI-compatible API and the monitoring endpoints.
//
// CLIENT_AUTH (read live):
//   auto     (default) a client key is required unless the request is local (loopback socket, loopback
//            Host header, no proxy forwarding headers). Local dev, dashboard and playground keep working.
//            NOTE: in Docker, host requests arrive from the bridge IP, so they are NOT local.
//   required every POST /v1/chat/completions and GET /v1/models needs a valid key.
//   off      no client auth (a warning is printed at startup).
//
// Keys: `Authorization: Bearer cg-...` (OpenAI SDK default) or `x-api-key: cg-...`.
// In auto mode a local request carrying a non-"cg-" bearer (e.g. a dummy OpenAI SDK key) is treated as
// keyless; a "cg-" key is always validated.
//
// Monitoring (GET /v1/chat/live|stats|summary|providers, /v1/analytics, POST /v1/chat/reset, WS) uses the
// admin rule unless CLIENT_AUTH=off: local request, or x-admin-token (WS: ?token=) equal to ADMIN_TOKEN.
import { safeEqual } from '../security/secrets.js';
import * as clientKeys from '../auth/clientKeys.js';

export const AUTH_MODES = ['auto', 'required', 'off'];
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip'];

export function authMode() {
  const v = String(process.env.CLIENT_AUTH ?? 'auto').trim().toLowerCase();
  return AUTH_MODES.includes(v) ? v : 'auto';
}

const header = (req, name) => {
  const v = req.headers?.[name] ?? req.get?.(name);
  return Array.isArray(v) ? v[0] : v;
};

export function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

/**
 * True for a request made on this machine directly: loopback socket, loopback Host header (blocks
 * DNS rebinding) and no proxy forwarding headers (a reverse proxy on the same host must not make
 * every internet client look local).
 */
export function isLocalRequest(req) {
  const ip = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  if (!LOOPBACK_IPS.has(ip)) return false;
  if (!LOOPBACK_HOSTS.has(hostnameOf(header(req, 'host')))) return false;
  return !PROXY_HEADERS.some(h => header(req, h));
}

/** The presented client key (Bearer or x-api-key), or null. */
export function presentedKey(req) {
  const auth = header(req, 'authorization');
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    if (m) return m[1];
  }
  const x = header(req, 'x-api-key');
  return typeof x === 'string' && x.trim() ? x.trim() : null;
}

const ERROR_TYPES = { 401: 'authentication_error', 402: 'insufficient_quota', 403: 'permission_error', 429: 'rate_limit_error' };

/** OpenAI-style error body. */
export function sendError(res, status, code, message, extra = {}) {
  if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="cortexgate"');
  return res.status(status).json({ error: { message, type: ERROR_TYPES[status] || 'invalid_request_error', code, ...extra } });
}

export function adminTokenOk(value) {
  const token = process.env.ADMIN_TOKEN;
  return Boolean(token) && typeof value === 'string' && value.length > 0 && safeEqual(value, token);
}

/**
 * Resolve + check the client key. Options: { rate: true } also applies per-key RPM/TPM.
 * Sets req.clientKey (internal record) or null for allowed keyless local calls.
 */
export function clientAuth({ rate = false, allowAdminToken = false } = {}) {
  return async function clientAuthMiddleware(req, res, next) {
    req.clientKey = null;
    const mode = authMode();
    if (mode === 'off') return next();

    const local = isLocalRequest(req);
    let key = presentedKey(req);
    if (key && !key.startsWith('cg-') && mode === 'auto' && local) key = null; // dummy SDK key on localhost

    if (!key) {
      if (mode === 'auto' && local) return next();
      if (allowAdminToken && adminTokenOk(header(req, 'x-admin-token'))) return next();
      return sendError(res, 401, 'INVALID_API_KEY',
        'Missing API key. Send "Authorization: Bearer cg-..." (or x-api-key). Create keys in the dashboard (Keys & providers) or via POST /v1/admin/keys.');
    }

    const rec = clientKeys.verifyKey(key);
    if (!rec) return sendError(res, 401, 'INVALID_API_KEY', 'Invalid API key');
    const denied = clientKeys.checkAccess(rec);
    if (denied) return sendError(res, denied.status, denied.code, denied.message);

    if (rate) {
      const r = await clientKeys.admit(rec);
      if (!r.ok) {
        res.set('Retry-After', String(r.retryAfterSec));
        return sendError(res, 429, 'KEY_RATE_LIMITED',
          `Rate limit reached for this API key (${r.limit === 'tpm' ? `${rec.tpmLimit} tokens` : `${rec.rpmLimit} requests`} per minute). Retry after ${r.retryAfterSec}s`,
          { retry_after: r.retryAfterSec });
      }
    }
    req.clientKey = rec;
    next();
  };
}

/** Admin rule for monitoring routes (local or x-admin-token), unless CLIENT_AUTH=off. */
export function monitorAuth(req, res, next) {
  // State-changing monitoring calls (POST /v1/chat/reset) from a cross-site page are refused.
  if (req.method !== 'GET' && req.method !== 'HEAD' && authMode() !== 'off' && !sameOrigin(req)) {
    return sendError(res, 403, 'CROSS_ORIGIN', 'Cross-origin requests are not allowed');
  }
  if (authMode() === 'off' || isLocalRequest(req) || adminTokenOk(header(req, 'x-admin-token'))) {
    res.set('Cache-Control', 'no-store');
    return next();
  }
  if (process.env.ADMIN_TOKEN) return sendError(res, 401, 'ADMIN_TOKEN_REQUIRED', 'Admin token required (x-admin-token header)');
  return sendError(res, 403, 'ADMIN_LOCAL_ONLY', 'Monitoring endpoints are only available from localhost unless ADMIN_TOKEN is set');
}

/** True when there is no Origin header or it matches the Host header. */
function sameOrigin(req) {
  const origin = header(req, 'origin');
  if (!origin) return true;
  try { return new URL(origin).host.toLowerCase() === String(header(req, 'host') || '').toLowerCase(); } catch { return false; }
}

/** WebSocket upgrade check: off, local same-origin, or ?token=<ADMIN_TOKEN>. */
export function wsAllowed(req) {
  if (authMode() === 'off') return true;
  let token = null;
  try { token = new URL(req.url || '/', 'http://localhost').searchParams.get('token'); } catch { /* bad url */ }
  if (adminTokenOk(token)) return true;
  // Browsers do not apply CORS to WebSockets: refuse cross-site pages connecting to localhost.
  return isLocalRequest(req) && sameOrigin(req);
}

/** Router-level gate for /v1/chat: completions need a client key, the rest is monitoring. */
const completionsAuth = clientAuth({ rate: true });
export function chatGate(req, res, next) {
  if (req.method === 'POST' && req.path === '/completions') return completionsAuth(req, res, next);
  return monitorAuth(req, res, next);
}

export function logStartup() {
  const mode = authMode();
  const n = clientKeys.keyCount();
  if (mode === 'off') {
    console.warn('[ClientAuth] CLIENT_AUTH=off: the API and monitoring endpoints accept unauthenticated requests from anywhere');
  } else {
    console.log(`[ClientAuth] mode=${mode}, ${n} client key${n === 1 ? '' : 's'}${mode === 'auto' ? ' (localhost may call without a key)' : ''}`);
    if (n === 0 && mode === 'required') {
      console.warn('[ClientAuth] CLIENT_AUTH=required but no client keys exist: create one via POST /v1/admin/keys or set CORTEXGATE_BOOTSTRAP_KEY');
    }
  }
}
