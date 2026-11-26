// Pure status summarising/formatting (unit-tested with fake payloads).
import { c, sym, formatDuration } from './ui.js';

/**
 * Count provider states from /v1/chat/providers ({ name: { configured, enabled, state, disabledReason } }).
 * Returns { healthy, open, disabled, noKey, other, total, byState }.
 */
export function summarizeProviders(providers) {
  const s = { healthy: 0, open: 0, halfOpen: 0, disabled: 0, noKey: 0, cooling: 0, other: 0, total: 0 };
  if (!providers || typeof providers !== 'object') return s;
  const list = Array.isArray(providers) ? providers : Object.values(providers);
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    s.total++;
    const state = String(p.state || '').toLowerCase();
    if (p.configured === false || state === 'unconfigured') s.noKey++;
    else if (state === 'disabled' || p.enabled === false) s.disabled++;
    else if (state === 'healthy' || state === 'closed' || state === 'ok') s.healthy++;
    else if (state === 'open') s.open++;
    else if (state === 'probing' || state === 'half-open' || state === 'half_open') s.halfOpen++;
    else if (state === 'cooldown' || state === 'rate_limited' || state === 'cooling') s.cooling++;
    else s.other++;
  }
  return s;
}

export function providerSummaryLine(sum) {
  const parts = [`${sum.healthy} healthy`];
  if (sum.open) parts.push(`${sum.open} circuit open`);
  if (sum.halfOpen) parts.push(`${sum.halfOpen} probing`);
  if (sum.cooling) parts.push(`${sum.cooling} cooling down`);
  if (sum.other) parts.push(`${sum.other} other`);
  parts.push(`${sum.disabled} disabled`);
  parts.push(`${sum.noKey} no key`);
  return parts.join(` ${sym.sep} `);
}

/** Pick an uptime (seconds) from /health (uptime / uptimeSec / uptimeMs / startedAt) or a local pid start time. */
export function pickUptimeSec(health, localStartedAt, now = Date.now()) {
  if (health && typeof health === 'object') {
    if (Number.isFinite(health.uptimeSec)) return health.uptimeSec;
    if (Number.isFinite(health.uptime)) return health.uptime;
    if (Number.isFinite(health.uptimeMs)) return health.uptimeMs / 1000;
    if (health.startedAt && Number.isFinite(Date.parse(health.startedAt))) return (now - Date.parse(health.startedAt)) / 1000;
  }
  if (localStartedAt && Number.isFinite(Date.parse(localStartedAt))) return (now - Date.parse(localStartedAt)) / 1000;
  return null;
}

/**
 * Build the status view from collected facts.
 * facts: { url, mode, running, managed, health, live, providers, authMode, redis, mongo, localStartedAt, errors: [] }
 */
export function buildStatus(facts, now = Date.now()) {
  const live = facts.live || {};
  const health = facts.health || {};
  const authMode = facts.authMode || health.auth || health.authMode || health.clientAuth || live.config?.clientAuth || null;
  const policy = health.policy || live.config?.routingPolicy || live.routing?.policy || null;
  const redis = facts.redis || health.redis || live.config?.rateLimit?.redis || null;
  const mongo = facts.mongo || health.mongo || health.mongodb || live.persistence?.mongodb || null;
  return {
    running: Boolean(facts.running),
    url: facts.url,
    mode: facts.mode,
    managed: facts.managed,
    external: Boolean(facts.running && facts.mode === 'node' && facts.managed === false),
    uptimeSec: facts.running ? pickUptimeSec(health, facts.localStartedAt, now) : null,
    authMode,
    authLabel: authLabel(authMode),
    policy,
    redis,
    mongo,
    providers: facts.providers ? summarizeProviders(facts.providers) : null,
    errors: facts.errors || []
  };
}

function authLabel(mode) {
  if (!mode) return null;
  const m = String(mode).toLowerCase();
  if (m === 'required') return 'required';
  if (m === 'off') return 'off (open)';
  if (m === 'auto') return 'auto (keys for non-local clients)';
  return m;
}

const stateColor = v => {
  const s = String(v || '').toLowerCase();
  if (['connected', 'ok', 'ready', 'required'].includes(s)) return c.green(v);
  if (['unavailable', 'disconnected', 'error', 'down', 'off (open)'].includes(s)) return c.red(v);
  return c.yellow(v);
};

export function formatStatus(view) {
  const lines = [];
  const where = [
    view.mode ? `${view.mode} mode` : null,
    view.uptimeSec !== null && view.uptimeSec !== undefined ? `up ${formatDuration(view.uptimeSec)}` : null
  ].filter(Boolean).join(', ');
  if (view.running) {
    lines.push(`${c.bold('CortexGate')}  ${c.green(`${sym.dot} running`)}  ${view.url}${where ? `  ${c.dim(`(${where})`)}` : ''}`);
  } else {
    lines.push(`${c.bold('CortexGate')}  ${c.red(`${sym.dot} stopped`)}  ${view.url}${view.mode ? `  ${c.dim(`(${view.mode} mode)`)}` : ''}`);
  }
  if (view.running) {
    const parts = [];
    parts.push(`auth: ${view.authLabel ? stateColor(view.authLabel) : c.dim('unknown')}`);
    parts.push(`policy: ${view.policy || c.dim('unknown')}`);
    parts.push(`redis: ${view.redis ? stateColor(view.redis) : c.dim('unknown')}`);
    parts.push(`mongo: ${view.mongo ? stateColor(view.mongo) : c.dim('unknown')}`);
    lines.push(parts.join(` ${sym.sep} `));
    if (view.providers) lines.push(`providers: ${providerSummaryLine(view.providers)}`);
  }
  for (const e of view.errors) lines.push(c.yellow(`note: ${e}`));
  return lines.join('\n');
}
