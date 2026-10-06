// Request history for the dashboard. Persisted to disk, so it survives restarts.
import * as persist from './persist.js';

const MAX_ENTRIES = 200;
const saved = persist.load('requests', null);

const recent = Array.isArray(saved?.recent) ? saved.recent : [];
const totals = { requests: 0, spent: 0, failovers: 0, errors: 0, ...(saved?.totals || {}) };
const byProvider = { ...(saved?.byProvider || {}) };

const persistNow = () => persist.save('requests', () => ({ recent, totals, byProvider }));
import { logRequestToMongo } from './mongoLogger.js';

const MAX_ENTRIES = 50;
const recent = [];
const totals = { requests: 0, spent: 0, failovers: 0, errors: 0 };
const byProvider = {};

export function record(entry) {
  recent.unshift({ time: new Date().toISOString(), ...entry });
  if (recent.length > MAX_ENTRIES) recent.pop();

  totals.requests++;
  totals.spent += (entry.cost || 0) + (entry.verifyCost || 0);
  if (entry.failedProviders && entry.failedProviders.length > 0) totals.failovers++;
  if (entry.status === 'error') totals.errors++;
  byProvider[entry.provider] = (byProvider[entry.provider] || 0) + 1;
  persistNow();

  // Persistent MongoDB logging (fire-and-forget, non-blocking)
  logRequestToMongo(row).catch(() => {});
}

export function getLive() {
  return { totals, byProvider, recent };
}

export function clear() {
  recent.length = 0;
  Object.assign(totals, { requests: 0, spent: 0, failovers: 0, errors: 0 });
  for (const k of Object.keys(byProvider)) delete byProvider[k];
  persistNow();
}
