import 'dotenv/config';
import { Queue } from 'bullmq';

// Direct connection options (no separate IORedis instance)
const connection = {
  host: '127.0.0.1',
  port: 6380,
  maxRetriesPerRequest: null,
};
console.log('Queue Redis URL:', `redis://${connection.host}:${connection.port}`);

export const requestQueue = new Queue('requestQueue', { connection });
