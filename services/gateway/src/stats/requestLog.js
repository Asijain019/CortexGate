// Request history for the dashboard. Persisted to disk, so it survives restarts.
// Row shape follows the shared contract (route, attempts, model, embedCost ...).
import * as persist from './persist.js';
import { logRequestToMongo, warnMongoUnavailable } from './mongoLogger.js';

// Full local history (analytics fallback when MongoDB is down) vs. rows sent to /live.
const MAX_ENTRIES = Math.max(200, parseInt(process.env.REQUEST_LOG_MAX || '5000', 10) || 5000);
const LIVE_ENTRIES = 200;
const inTest = Boolean(process.env.NODE_TEST_CONTEXT);
const saved = inTest ? null : persist.load('requests', null);

// `history` is newest first; persisted under the legacy key "recent".
const history = Array.isArray(saved?.recent) ? saved.recent.slice(0, MAX_ENTRIES) : [];
const totals = { requests: 0, spent: 0, failovers: 0, errors: 0, queued: 0, ...(saved?.totals || {}) };
const byProvider = { ...(saved?.byProvider || {}) };
let mongoWriteError = null;

const persistNow = () => {
  if (inTest) return;
  persist.save('requests', () => ({ recent: history, totals, byProvider }), 1500);
};

function buildRow(entry) {
  return {
    time: new Date().toISOString(),
    prompt: '',
    status: 'ok',
    provider: 'none',
    model: null,
    cache: false,
    similarity: null,
    verified: false,
    cost: 0,
    verifyCost: 0,
    embedCost: 0,
    savedCost: 0,
    tokens: 0,
    latencyMs: 0,
    failedProviders: [],
    skippedProviders: [],
    route: null,
    attempts: [],
    verification: null,
    nearSimilarity: null,
    apiKeyId: null,
    apiKeyName: null,
    ...entry
  };
}

function push(row) {
  history.unshift(row);
  if (history.length > MAX_ENTRIES) history.length = MAX_ENTRIES;
}

function toMongo(row) {
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

export async function record(entry) {
  const row = buildRow(entry);
  push(row);

  totals.requests++;
  totals.spent += (row.cost || 0) + (row.verifyCost || 0) + (row.embedCost || 0);
  if (row.failedProviders && row.failedProviders.length > 0) totals.failovers++;
  if (row.status === 'error') totals.errors++;
  byProvider[row.provider] = (byProvider[row.provider] || 0) + 1;
  persistNow();
  toMongo(row);
  return row;
}

/** A request the rate limiter parked in the queue (202). */
export async function recordQueued(entry = {}) {
  const row = buildRow({ status: 'queued', provider: 'none', ...entry });
  push(row);
  totals.queued++;
  persistNow();
  toMongo(row);
  return row;
}

export function getLive() {
  return { totals, byProvider, recent: history.slice(0, LIVE_ENTRIES) };
}

/** Whole local history, newest first (do not mutate). */
export function getHistory() {
  return history;
}

export function hasMongoWriteError() {
  return Boolean(mongoWriteError);
}

export function clear() {
  history.length = 0;
  Object.assign(totals, { requests: 0, spent: 0, failovers: 0, errors: 0, queued: 0 });
  for (const k of Object.keys(byProvider)) delete byProvider[k];
  mongoWriteError = null;
  persistNow();
}
