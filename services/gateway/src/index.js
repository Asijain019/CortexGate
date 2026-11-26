import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import chatRouter from './routes/chat.js';
import { rateLimit } from './middleware/rateLimit.js';
import * as circuit from './gateway/circuitBreaker.js';
import { watchEnv } from './gateway/envWatcher.js';
import { buildModelList } from './gateway/liveStatus.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// OpenAI-style model list: { object: 'list', data: [{ id: 'groq/openai/gpt-oss-20b', owned_by, tier }] }
// ?all=1 includes unconfigured providers.
app.get('/v1/models', (req, res) => {
  res.json(buildModelList({ all: ['1', 'true'].includes(String(req.query.all || '').toLowerCase()) }));
});

app.use('/v1/chat', rateLimit, chatRouter);

// Live dashboard (polls /v1/chat/live or listens on /ws/metrics)
app.get('/dashboard', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

// Pick up .env edits (API keys, thresholds) without a restart.
watchEnv(() => circuit.resetAll());

const server = app.listen(PORT, () => {
  console.log(`CortexGate Gateway listening on port ${PORT}`);
  import('./ws/metricsWs.js').then(({ initWs }) => initWs(server));
});

export default app;
