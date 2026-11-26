import 'dotenv/config';
import { Queue } from 'bullmq';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6380';
console.log('Queue Redis URL:', redisUrl);

export const requestQueue = new Queue('requestQueue', {
  connection: { url: redisUrl, maxRetriesPerRequest: null }
});
