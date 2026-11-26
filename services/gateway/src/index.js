import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import chatRouter from './routes/chat.js';
import { rateLimit } from './middleware/rateLimit.js';
import * as circuit from './gateway/circuitBreaker.js';
import { watchEnv } from './gateway/envWatcher.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

app.use('/v1/chat', rateLimit, chatRouter);

// Live dashboard (polls /v1/chat/live)
app.get('/dashboard', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

// Pick up .env edits (API keys, thresholds) without a restart.
watchEnv(() => circuit.resetAll());

// Start HTTP server and then init WebSocket metrics server
const server = app.listen(PORT, () => {
  console.log(`CortexGate Gateway listening on port ${PORT}`);
  import('./ws/metricsWs.js').then(({ initWs }) => initWs(server));
});

export default app;
