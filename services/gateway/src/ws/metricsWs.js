import { WebSocketServer } from 'ws';
import { buildLivePayload } from '../gateway/liveStatus.js';

const INTERVAL_MS = 2000;

/**
 * WebSocket server streaming the same JSON as GET /v1/chat/live.
 * One shared 2s broadcast timer for all clients (idle when nobody is connected).
 */
export function initWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws/metrics' });
  console.log(`WebSocket metrics server listening on ws://localhost:${process.env.PORT || 3001}/ws/metrics`);

  let busy = false;
  async function broadcast() {
    if (busy || wss.clients.size === 0) return;
    busy = true;
    try {
      const data = JSON.stringify(await buildLivePayload());
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(data);
      }
    } catch (err) {
      console.warn(`[MetricsWS] Broadcast failed: ${err.message}`);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(broadcast, INTERVAL_MS);
  timer.unref?.();
  wss.on('close', () => clearInterval(timer));

  wss.on('connection', ws => {
    ws.send(JSON.stringify({ message: 'connected' }));
    // Immediate snapshot for the new client.
    buildLivePayload()
      .then(p => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(p)); })
      .catch(() => {});
  });

  return wss;
}
