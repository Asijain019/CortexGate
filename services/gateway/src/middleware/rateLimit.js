import { createClient } from 'redis';
import { requestQueue } from '../queues/requestQueue.js';

// Simple token‑bucket per API key (or per IP if no key).
// 1000 tokens per 60-second window is plenty for dev/demo use.
// Only /v1/chat/completions reaches this code (monitoring routes are bypassed above).
const MAX_TOKENS = 1000;
const REFILL_INTERVAL = 60; // seconds

const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6380' });
redis.on('error', (err) => console.error('Redis error', err));
await redis.connect();

/**
 * Middleware that checks the token bucket. If a token is available the request proceeds.
 * If the bucket is empty the request payload is queued via BullMQ and the client receives 202.
 */
export async function rateLimit(req, res, next) {
  // Monitoring / utility routes must never be rate-limited – they are needed
  // for the dashboard status poll, stats and admin resets.
  const bypass = ['/live', '/stats', '/summary', '/reset'];
  if (bypass.includes(req.path)) return next();

  try {
    const apiKey = req.headers['x-api-key'] || req.ip; // fallback to IP
    const tokenKey = `rate:${apiKey}`;

    // Initialise token bucket if missing
    let tokens = await redis.get(tokenKey);
    if (tokens === null) {
      await redis.set(tokenKey, MAX_TOKENS - 1, { EX: REFILL_INTERVAL });
      return next();
    }

    tokens = parseInt(tokens, 10);
    if (tokens > 0) {
      await redis.decr(tokenKey);
      return next();
    }

    // No tokens – enqueue request for later processing
    await requestQueue.add('queuedRequest', {
      method: req.method,
      path: req.originalUrl,
      headers: req.headers,
      body: req.body,
    });
    res.status(202).json({ message: 'Request queued due to rate limit' });
  } catch (err) {
    console.error('Rate limit middleware error', err);
    res.status(500).json({ error: 'Rate limit error' });
  }
}
