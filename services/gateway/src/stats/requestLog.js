// Request history for the dashboard. Persisted to disk, so it survives restarts.
import * as persist from './persist.js';
import { logRequestToMongo, warnMongoUnavailable } from './mongoLogger.js';

const MAX_ENTRIES = 200;
const saved = persist.load('requests', null);

const recent = Array.isArray(saved?.recent) ? saved.recent : [];
const totals = { requests: 0, spent: 0, failovers: 0, errors: 0, ...(saved?.totals || {}) };
const byProvider = { ...(saved?.byProvider || {}) };
let mongoWriteError = null;

const persistNow = () => persist.save('requests', () => ({ recent, totals, byProvider }));

export async function record(entry) {
  const row = { time: new Date().toISOString(), ...entry };
  recent.unshift(row);
  if (recent.length > MAX_ENTRIES) recent.pop();

  totals.requests++;
  totals.spent += (row.cost || 0) + (row.verifyCost || 0);
  if (entry.failedProviders && entry.failedProviders.length > 0) totals.failovers++;
  if (entry.status === 'error') totals.errors++;
  byProvider[entry.provider] = (byProvider[entry.provider] || 0) + 1;
  persistNow();

  // MongoDB is optional and must not delay completion or provider failover.
  void logRequestToMongo(row)
    .then(result => {
      if (!result.persisted) mongoWriteError = result.error || 'MongoDB write failed';
    })
    .catch(err => {
      mongoWriteError = err.message || 'MongoDB write failed';
      warnMongoUnavailable(err);
    });
}

export function getLive() {
  return { totals, byProvider, recent };
}

export function hasMongoWriteError() {
  return Boolean(mongoWriteError);
}

export function clear() {
  recent.length = 0;
  Object.assign(totals, { requests: 0, spent: 0, failovers: 0, errors: 0 });
  for (const k of Object.keys(byProvider)) delete byProvider[k];
  mongoWriteError = null;
  persistNow();
}
