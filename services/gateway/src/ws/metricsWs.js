import { WebSocketServer } from 'ws';
import * as semanticCache from '../cache/semanticCache.js';
import * as requestLog from '../stats/requestLog.js';
import * as circuit from '../gateway/circuitBreaker.js';
import { providers } from '../providers/index.js';
import { getMongoRecent, getMongoSummary } from '../stats/mongoLogger.js';

/**
 * Initialize a WebSocket server that streams the same live metrics as the HTTP `/v1/chat/live` endpoint.
 * The server is attached to the already‑listening HTTP server (`server`).
 */
export function initWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws/metrics' });
  const wsPort = process.env.PORT || 3002; console.log('WebSocket metrics server listening on ws://localhost:' + wsPort + '/ws/metrics');

  // Broadcast function – builds the payload identical to the `/live` route.
  async function broadcast() {
    let recent = requestLog.getLive().recent;
    let historySource = 'local';
    let mongoAvailable = false;
    try {
      recent = await getMongoRecent();
      mongoAvailable = true;
      if (!requestLog.hasMongoWriteError()) historySource = 'mongodb';
    } catch (err) {
      console.warn(`[MongoDB History Warning] ${err.message}`);
    }
    if (historySource !== 'mongodb') recent = requestLog.getLive().recent;

    const payload = {
      cache: semanticCache.getStats(),
      ...requestLog.getLive(),
      recent,
      persistence: {
        mongodb: !mongoAvailable ? 'unavailable' : historySource === 'mongodb' ? 'connected' : 'degraded',
        historySource,
      },
      breakers: circuit.getStatus(Object.keys(providers))
    };
    const data = JSON.stringify(payload);
    wss.clients.forEach(client => {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
    });
  }

  // Send an initial snapshot when a client connects.
  wss.on('connection', ws => {
    console.log('Metrics WS client connected');
    ws.send(JSON.stringify({ message: 'connected' }));
    // Send updates every 2 seconds.
    const interval = setInterval(broadcast, 2000);
    ws.on('close', () => {
      clearInterval(interval);
      console.log('Metrics WS client disconnected');
    });
  });
}
