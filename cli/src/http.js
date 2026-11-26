// Small fetch wrapper with timeouts and friendly errors (Node 18+ global fetch).
import net from 'node:net';

export class GatewayError extends Error {
  constructor(message, { status = null, code = null, body = null, unreachable = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
    this.unreachable = unreachable;
  }
}

function portOf(url) {
  try {
    const u = new URL(url);
    return u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch {
    return '?';
  }
}

export function unreachableMessage(url) {
  return `Gateway not reachable on :${portOf(url)} (${url}) — run \`cortexgate start\``;
}

/**
 * request(baseUrl, path, { method, body, adminToken, apiKey, timeoutMs, headers })
 * Resolves { status, ok, data, headers }. Throws GatewayError only when the server cannot be reached
 * (or on timeout); HTTP errors are returned so callers can explain them.
 */
export async function request(baseUrl, urlPath, { method = 'GET', body, adminToken, apiKey, timeoutMs = 10000, headers = {} } = {}) {
  const h = { accept: 'application/json', ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (adminToken) h['x-admin-token'] = adminToken;
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(baseUrl + urlPath, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') {
      throw new GatewayError(`Request to ${baseUrl}${urlPath} timed out after ${Math.round(timeoutMs / 1000)}s`, { code: 'TIMEOUT' });
    }
    throw new GatewayError(unreachableMessage(baseUrl), { unreachable: true, code: e?.cause?.code || 'UNREACHABLE' });
  }
  let text = '';
  try {
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  return { status: res.status, ok: res.ok, data, headers: res.headers };
}

/** Human message for a non-2xx response. */
export function describeHttpError(res, context = '') {
  const e = res.data?.error;
  let raw = res.data?.raw;
  if (raw && /<html|<!doctype/i.test(raw)) raw = (/<pre>([\s\S]*?)<\/pre>/i.exec(raw)?.[1] || '').trim() || null;
  const msg = typeof e === 'string' ? e : e?.message || res.data?.message || raw || `HTTP ${res.status}`;
  const code = typeof e === 'object' && e?.code ? ` [${e.code}]` : '';
  let hint = '';
  if (res.status === 401 && /admin/i.test(msg)) hint = ' — check ADMIN_TOKEN in services/gateway/.env (or set CORTEXGATE_ADMIN_TOKEN)';
  else if (res.status === 403 && /ADMIN_TOKEN/.test(msg)) hint = ' — set ADMIN_TOKEN in services/gateway/.env (`cortexgate init` generates one) and restart the gateway';
  else if (res.status === 401) hint = ' — pass a client key with --key, CORTEXGATE_API_KEY, or CORTEXGATE_BOOTSTRAP_KEY in .env';
  else if (res.status === 404 && /\/admin\/keys/.test(context)) hint = ' — this gateway build has no client-key API yet (restart it on the latest code)';
  return `${context ? `${context}: ` : ''}${msg}${code} (HTTP ${res.status})${hint}`;
}

/** Resolve true if a TCP connection to host:port succeeds within timeoutMs. */
export function tcpCheck(host, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port: Number(port) });
    const done = ok => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** Resolve true when nothing is listening on the port (we can bind it). */
export function portFree(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(Number(port), host);
  });
}
