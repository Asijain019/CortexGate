import { createClient } from 'redis';
import * as requestLog from '../stats/requestLog.js';
import { setRedisGetter } from '../auth/clientKeys.js';

// Simple token bucket per client API key id (or per IP if keyless), stored in Redis.
// Runs after clientAuth, so req.clientKey is set; the raw key is never used as a Redis key.
//   RATE_LIMIT_ENABLED     (default true)
//   RATE_LIMIT_MAX_TOKENS  (default 1000) requests per window
//   RATE_LIMIT_WINDOW_SEC  (default 60)
// When the bucket is empty the request is queued via BullMQ (202) and logged as 'queued'.
// While Redis is unreachable, rate limiting is skipped (fail-open).
const intEnv = (name, def) => {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};
const maxTokens = () => intEnv('RATE_LIMIT_MAX_TOKENS', 1000);
const windowSec = () => intEnv('RATE_LIMIT_WINDOW_SEC', 60);
const enabled = () => String(process.env.RATE_LIMIT_ENABLED ?? 'true').toLowerCase() !== 'false';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

const redis = createClient({
  url: REDIS_URL,
  socket: { reconnectStrategy: retries => Math.min(retries * 1000, 30_000) }
});
let redisDownLogged = false;
redis.on('ready', () => {
  redisDownLogged = false;
  console.log(`[RateLimit] Redis connected (${REDIS_URL})`);
});
redis.on('error', (err) => {
  if (!redisDownLogged) {
    console.warn(`[RateLimit] Redis unavailable at ${REDIS_URL} (${err.code || err.message}); rate limiting disabled until it is back`);
    redisDownLogged = true;
  }
});
if (enabled()) redis.connect().catch(() => {});
// Per-client-key RPM/TPM windows share this connection when it is ready.
setRedisGetter(() => (redis.isReady ? redis : null));

// The queue opens its own Redis connection, so load it only when first needed.
let queuePromise;
function getQueue() {
  queuePromise ||= import('../queues/requestQueue.js').then(m => m.requestQueue);
  return queuePromise;
}

/** For /live config.rateLimit */
export function getStatus() {
  return {
    enabled: enabled(),
    redis: redis.isReady ? 'connected' : 'unavailable',
    maxTokens: maxTokens(),
    windowSec: windowSec()
  };
}

// Monitoring / utility routes are never rate limited.
const BYPASS = new Set(['/live', '/stats', '/summary', '/reset', '/providers']);

export async function rateLimit(req, res, next) {
  if (BYPASS.has(req.path) || req.method === 'GET') return next();
  if (!enabled() || !redis.isReady) return next();

  try {
    const tokenKey = req.clientKey?.id ? `rate:key:${req.clientKey.id}` : `rate:ip:${req.ip}`;

    let tokens = await redis.get(tokenKey);
    if (tokens === null) {
      await redis.set(tokenKey, maxTokens() - 1, { EX: windowSec() });
      return next();
    }
    tokens = parseInt(tokens, 10);
    if (tokens > 0) {
      await redis.decr(tokenKey);
      return next();
    }

    const requestQueue = await getQueue();
    const job = await requestQueue.add('queuedRequest', {
      method: req.method,
      path: req.originalUrl,
      headers: { 'x-cache': req.headers['x-cache'], 'x-provider': req.headers['x-provider'], 'x-routing-policy': req.headers['x-routing-policy'] },
      body: req.body,
      apiKeyId: req.clientKey?.id || null
    });
    const messages = req.body?.messages;
    const last = Array.isArray(messages) ? messages[messages.length - 1]?.content : '';
    await requestLog.recordQueued({
      prompt: String(last ?? '').slice(0, 70),
      apiKeyId: req.clientKey?.id || null, apiKeyName: req.clientKey?.name || null
    });
    res.status(202).json({ message: 'Request queued due to rate limit', jobId: job?.id ?? null });
  } catch (err) {
    console.error('Rate limit middleware error', err);
    res.status(500).json({ error: 'Rate limit error' });
  }
}
