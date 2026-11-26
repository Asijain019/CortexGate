import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import chatRouter from './routes/chat.js';
import adminRouter, { jsonErrorHandler as adminJsonErrors } from './routes/admin.js';
import analyticsRouter from './routes/analytics.js';
import { rateLimit } from './middleware/rateLimit.js';
import * as circuit from './gateway/circuitBreaker.js';
import { watchEnv } from './gateway/envWatcher.js';
import { buildModelList } from './gateway/liveStatus.js';
import { importBootstrap } from './auth/clientKeys.js';
import { authMode, clientAuth, monitorAuth, chatGate, logStartup } from './middleware/clientAuth.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;
const startedAt = Date.now();

// Client API keys: import CORTEXGATE_BOOTSTRAP_KEY (hashed) once, then report the auth mode.
importBootstrap();
logStartup();

app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptimeSec: Math.round((Date.now() - startedAt) / 1000), authMode: authMode() });
});

// OpenAI-style model list: { object: 'list', data: [{ id: 'groq/openai/gpt-oss-20b', owned_by, tier }] }
// ?all=1 includes unconfigured providers. Needs a client key (or the admin token) unless CLIENT_AUTH allows.
app.get('/v1/models', clientAuth({ allowAdminToken: true }), (req, res) => {
  res.json(buildModelList({ all: ['1', 'true'].includes(String(req.query.all || '').toLowerCase()) }));
});

// Admin (keys, custom providers, client keys) and analytics: not rate-limited; admin has its own auth,
// analytics follows the monitoring rule (local or x-admin-token unless CLIENT_AUTH=off).
app.use('/v1/admin', adminRouter, adminJsonErrors);
app.use('/v1/analytics', monitorAuth, analyticsRouter);

// POST /completions: client key (+ per-key limits); everything else under /v1/chat is monitoring.
app.use('/v1/chat', chatGate, rateLimit, chatRouter);

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
  // Active provider health checks (HEALTHCHECK_INTERVAL_MS, 0 = off; never under tests).
  import('./gateway/healthCheck.js').then(({ startHealthChecks, stopHealthChecks }) => {
    startHealthChecks();
    server.on('close', stopHealthChecks);
  });
});

export default app;
