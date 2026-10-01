// In-memory live log for the dashboard. Later: replaced/backed by MongoDB logging.
const MAX_ENTRIES = 50;
const recent = [];
const totals = { requests: 0, spent: 0, failovers: 0, errors: 0 };
const byProvider = {};

export function record(entry) {
  const row = { time: new Date().toISOString(), ...entry };
  recent.unshift(row);
  if (recent.length > MAX_ENTRIES) recent.pop();

  totals.requests++;
  totals.spent += entry.cost || 0;
  if (entry.failedProviders && entry.failedProviders.length > 0) totals.failovers++;
  if (entry.status === 'error') totals.errors++;
  byProvider[entry.provider] = (byProvider[entry.provider] || 0) + 1;
}

export function getLive() {
  return { totals, byProvider, recent };
}
