import 'dotenv/config';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { dispatch } from '../gateway/dispatch.js';

// Processes requests the rate limiter queued, using the same routing + failover as the API.
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6380';
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
console.log(`Worker Redis URL: ${redisUrl}`);

const worker = new Worker(
  'requestQueue',
  async job => {
    const { headers = {}, body } = job.data;
    const { messages, model, provider, routing_policy: routingPolicy } = body || {};
    if (!Array.isArray(messages) || !messages.length) {
      console.warn(`Queued job ${job.id} missing messages, skipping`);
      return null;
    }
    const out = await dispatch({
      messages,
      model,
      provider: provider || headers['x-provider'],
      policy: routingPolicy || headers['x-routing-policy']
    });
    const summary = {
      ok: Boolean(out.result),
      provider: out.provider,
      model: out.model,
      cost: out.cost,
      routing: out.routing,
      attempts: out.attempts,
      error: out.error
    };
    console.log(`Queued job ${job.id}: ${summary.ok ? `served by ${out.provider}/${out.model}` : `failed (${out.error?.code})`} [${out.routing.tier}]`);
    return { ...summary, content: out.result?.content ?? null, usage: out.result?.usage ?? null };
  },
  { connection, sharedConnection: true }
);

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed:`, err);
});

console.log('CortexGate request worker started');
