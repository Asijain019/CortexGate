import 'dotenv/config';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { dispatch } from '../gateway/dispatch.js';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6380';
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
console.log(`Worker Redis URL: ${redisUrl}`);

const worker = new Worker(
  'requestQueue',
  async job => {
    const { method, path, headers, body } = job.data;
    const fakeReq = { method, originalUrl: path, headers, body };
    const fakeRes = {
      json: data => console.log('Queued request processed →', data),
      status: code => ({ json: d => console.log(`Queued request status ${code}:`, d) })
    };
    const { messages, model, provider } = body || {};
    if (!messages) {
      console.warn('Queued job missing messages, skipping');
      return;
    }
    const result = await dispatch({ messages, model, providerParam: provider });
    console.log('Result from queued request:', result);
    return result;
  },
  { connection, sharedConnection: true }
);

worker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed:`, err);
});

console.log('CortexGate request worker started');
