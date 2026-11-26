import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { request, describeHttpError, tcpCheck, portFree, GatewayError, unreachableMessage } from './http.js';
import { c, sym, out, err, okLine, warnLine, failLine, table, formatDuration } from './ui.js';
import { buildStatus, formatStatus } from './status.js';
import { intFlag, numberFlag, usageError } from './args.js';
import { detectCompose, compose, requireCompose } from './docker.js';
import * as proc from './proc.js';
import { paths, isRepo, gatewayDir } from './config.js';
import { askYesNo, closePrompts } from './prompt.js';

const fail = (message, exitCode = 1) => Object.assign(new Error(message), { exitCode });

function requireRepo(ctx) {
  if (!ctx.repoPath || !isRepo(ctx.repoPath)) {
    throw fail(`CortexGate checkout not found${ctx.repoPath ? ` at ${ctx.repoPath}` : ''} — run \`cortexgate init\` or pass --repo <path>`);
  }
}

async function health(url, timeoutMs = 2500) {
  try {
    const res = await request(url, '/health', { timeoutMs });
    if (res.ok && res.data && (res.data.status === 'ok' || res.data.ok === true)) return res.data;
    return null;
  } catch {
    return null;
  }
}

async function waitForHealth(url, { timeoutMs = 30000, pid, logName, env } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await health(url, 1500);
    if (h) return h;
    if (pid && !proc.isAlive(pid)) {
      const tail = proc.tailLines(proc.logFile(logName, env), 20) || [];
      throw fail(`The ${logName} process exited during startup. Last log lines:\n${tail.map(l => `  ${l}`).join('\n')}\n(full log: ${proc.logFile(logName, env)})`);
    }
    await proc.sleep(500);
  }
  return null;
}

function hostPortFromUrl(raw, defPort) {
  try {
    const u = new URL(raw);
    return { host: u.hostname.replace(/^\[|\]$/g, '') || 'localhost', port: Number(u.port) || defPort };
  } catch {
    return null;
  }
}

function managedNode(ctx) {
  const services = proc.runningServices();
  const state = proc.readState();
  const alive = services.gateway.alive && (!state || Number(state.port) === Number(ctx.port));
  return { alive, services, state };
}

// ---------------------------------------------------------------- start / stop / restart

export async function start(ctx) {
  requireRepo(ctx);
  const existing = await health(ctx.url);
  if (existing) {
    const m = managedNode(ctx);
    if (m.alive) out(`CortexGate is already running at ${ctx.url} (node mode, pid ${m.services.gateway.pid}).`);
    else out(`A gateway already answers at ${ctx.url} — leaving it alone. (Use --port to start another instance.)`);
    return 0;
  }
  if (!ctx.envExists) warnLine(`No ${ctx.envPath} — run \`cortexgate init\` first (starting anyway with defaults).`);

  if (ctx.mode === 'docker') {
    requireCompose();
    out(`Starting CortexGate with Docker Compose on port ${ctx.port}…`);
    const args = ['up', '-d'];
    if (ctx.flags.build) args.push('--build');
    const code = await compose(args, { repoPath: ctx.repoPath, port: ctx.port });
    if (code !== 0) throw fail(`docker compose up failed (exit ${code})`);
    const h = await waitForHealth(ctx.url, { timeoutMs: 90000 });
    if (!h) throw fail(`Containers started but ${ctx.url}/health did not answer within 90s — check \`cortexgate logs\``);
    out(`${c.bold('CortexGate')}  ${c.green(`${sym.dot} running`)}  ${ctx.url}  ${c.dim('(docker mode)')}`);
    out(`dashboard: ${ctx.url}/dashboard`);
    return 0;
  }

  // node mode
  if (!(await portFree(ctx.port)) || (await tcpCheck('127.0.0.1', ctx.port, 800))) {
    throw fail(`Port :${ctx.port} is already in use by another program — free it or choose another with --port`);
  }
  const m = managedNode(ctx);
  for (const name of ['gateway', 'worker']) {
    if (m.services[name].alive) {
      out(`Stopping stale ${name} (pid ${m.services[name].pid})…`);
      await proc.killTree(m.services[name].pid);
    }
    proc.clearPid(name);
  }
  const pids = {};
  pids.gateway = proc.spawnService('gateway', { repoPath: ctx.repoPath, port: ctx.port });
  out(`Started gateway (pid ${pids.gateway}) → log ${proc.logFile('gateway')}`);

  if (ctx.flags.worker !== false) {
    const redisUrl = ctx.dotenv.REDIS_URL || 'redis://127.0.0.1:6380';
    const hp = hostPortFromUrl(redisUrl, 6379);
    if (hp && (await tcpCheck(hp.host, hp.port, 1200))) {
      pids.worker = proc.spawnService('worker', { repoPath: ctx.repoPath, port: ctx.port });
      out(`Started worker  (pid ${pids.worker}) → log ${proc.logFile('worker')}`);
    } else {
      warnLine(`Redis not reachable at ${hp ? `${hp.host}:${hp.port}` : redisUrl} — worker not started (queued overflow requests need it).`);
    }
  }
  proc.writeState({ mode: 'node', port: ctx.port, url: ctx.url, repoPath: ctx.repoPath, startedAt: new Date().toISOString(), pids });
  process.stdout.write('Waiting for /health');
  const timer = setInterval(() => process.stdout.write('.'), 1000);
  let h;
  try {
    h = await waitForHealth(ctx.url, { timeoutMs: 30000, pid: pids.gateway, logName: 'gateway' });
  } finally {
    clearInterval(timer);
    process.stdout.write('\n');
  }
  if (!h) throw fail(`Gateway started (pid ${pids.gateway}) but ${ctx.url}/health did not answer within 30s — see \`cortexgate logs\``);
  out(`${c.bold('CortexGate')}  ${c.green(`${sym.dot} running`)}  ${ctx.url}  ${c.dim('(node mode)')}`);
  out(`dashboard: ${ctx.url}/dashboard`);
  return 0;
}

export async function stop(ctx) {
  if (ctx.mode === 'docker') {
    requireRepo(ctx);
    requireCompose();
    const args = ctx.flags.all ? ['down'] : ['stop', 'gateway', 'worker'];
    out(ctx.flags.all ? 'Stopping the whole compose stack (volumes are kept)…' : 'Stopping gateway and worker containers (redis/ollama keep running)…');
    const code = await compose(args, { repoPath: ctx.repoPath, port: ctx.port });
    if (code !== 0) throw fail(`docker compose ${args[0]} failed (exit ${code})`);
    out('Stopped.');
    return 0;
  }
  const services = proc.runningServices();
  let stopped = 0;
  for (const name of ['worker', 'gateway']) {
    const { pid, alive } = services[name];
    if (alive) {
      const ok = await proc.killTree(pid);
      if (!ok) throw fail(`Could not stop ${name} (pid ${pid})`);
      out(`Stopped ${name} (pid ${pid}).`);
      stopped++;
    }
    proc.clearPid(name);
  }
  try { fs.unlinkSync(proc.stateFile()); } catch { /* none */ }
  if (!stopped) out('Nothing to stop — no CortexGate processes started by `cortexgate start` are running.');
  if (await health(ctx.url, 1500)) {
    warnLine(`A gateway still answers at ${ctx.url}; it was not started by cortexgate, so it was left running.`);
  }
  return 0;
}

export async function restart(ctx) {
  await stop(ctx);
  if (ctx.mode === 'node') {
    // give the OS a moment to release the port
    for (let i = 0; i < 20 && !(await portFree(ctx.port)); i++) await proc.sleep(250);
  }
  return start(ctx);
}

// ---------------------------------------------------------------- status

export async function collectStatus(ctx) {
  const facts = { url: ctx.url, mode: ctx.mode, errors: [] };
  let h = null;
  try {
    const res = await request(ctx.url, '/health', { timeoutMs: 3000 });
    if (res.ok) h = res.data || {};
    else facts.errors.push(`/health returned HTTP ${res.status}`);
  } catch (e) {
    facts.errors.push(e instanceof GatewayError ? e.message : String(e.message || e));
  }
  facts.running = Boolean(h);
  facts.health = h;
  const m = ctx.mode === 'node' ? managedNode(ctx) : null;
  facts.managed = m ? m.alive : null;
  if (m?.alive) facts.localStartedAt = m.state?.startedAt;
  if (!facts.running) return facts;

  const opts = { adminToken: ctx.adminToken, timeoutMs: 5000 };
  const [prov, live, keysRes] = await Promise.all([
    request(ctx.url, '/v1/chat/providers', opts).catch(() => null),
    request(ctx.url, '/v1/chat/live', opts).catch(() => null),
    request(ctx.url, '/v1/admin/keys', opts).catch(() => null)
  ]);
  if (prov?.ok) facts.providers = prov.data;
  else if (prov) facts.errors.push(describeHttpError(prov, 'providers'));
  if (live?.ok) facts.live = live.data;
  if (keysRes?.ok && keysRes.data?.authMode) facts.authMode = keysRes.data.authMode;
  if (!facts.authMode && !h.auth && !h.authMode && !h.clientAuth) {
    // Builds before client keys have no client auth at all; otherwise fall back to what .env asks for.
    facts.authMode = keysRes?.status === 404 ? 'none (gateway predates client keys)' : (ctx.dotenv.CLIENT_AUTH || 'auto');
  }
  // Uptime for a gateway we didn't start (node mode, local URL, /health without uptime).
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(ctx.url);
  const hasUptime = ['uptime', 'uptimeSec', 'uptimeMs', 'startedAt'].some(k => h[k] !== undefined);
  if (ctx.mode === 'node' && !facts.localStartedAt && !hasUptime && local) {
    facts.external = true;
    facts.localStartedAt = proc.processStartedAt(proc.listeningPid(ctx.port));
  }
  return facts;
}

export async function status(ctx) {
  const facts = await collectStatus(ctx);
  const view = buildStatus(facts);
  if (ctx.flags.json) {
    out(JSON.stringify(view, null, 2));
    return view.running ? 0 : 1;
  }
  if (!view.running) {
    view.errors = [];
    out(formatStatus(view));
    out(c.dim(`${unreachableMessage(ctx.url)}`));
    return 1;
  }
  out(formatStatus(view));
  return 0;
}

// ---------------------------------------------------------------- logs

export async function logs(ctx) {
  const service = ctx.flags.worker ? 'worker' : 'gateway';
  const lines = intFlag(ctx.flags.lines ?? 100, 'lines', { min: 1, max: 100000 });
  if (ctx.mode === 'docker') {
    requireRepo(ctx);
    const args = ['logs', '--tail', String(lines)];
    if (ctx.flags.follow) args.push('-f');
    args.push(service);
    return compose(args, { repoPath: ctx.repoPath, port: ctx.port });
  }
  const file = proc.logFile(service);
  const tail = proc.tailLines(file, lines);
  if (tail === null) {
    throw fail(`No ${service} log at ${file} — logs exist only for processes started with \`cortexgate start\` (node mode).`);
  }
  for (const l of tail) out(l);
  if (!ctx.flags.follow) return 0;
  err(c.dim(`— following ${file} (Ctrl+C to stop)`));
  await new Promise(resolve => {
    const stopFollow = proc.followFile(file, chunk => process.stdout.write(chunk));
    process.once('SIGINT', () => { stopFollow(); resolve(); });
  });
  return 0;
}

// ---------------------------------------------------------------- open

export function openerFor(platform, target) {
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', target] };
  if (platform === 'darwin') return { cmd: 'open', args: [target] };
  return { cmd: 'xdg-open', args: [target] };
}

export async function open(ctx) {
  const target = `${ctx.url}/dashboard`;
  if (!(await health(ctx.url))) warnLine(unreachableMessage(ctx.url));
  const { cmd, args } = openerFor(process.platform, target);
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
    child.on('error', () => err(`Could not launch a browser — open ${target} manually.`));
    child.unref();
  } catch {
    err(`Could not launch a browser — open ${target} manually.`);
  }
  out(`Opening ${target}`);
  return 0;
}

// ---------------------------------------------------------------- keys

async function adminCall(ctx, method, urlPath, body) {
  let res;
  try {
    res = await request(ctx.url, urlPath, { method, body, adminToken: ctx.adminToken, timeoutMs: 10000 });
  } catch (e) {
    throw fail(e.message);
  }
  if (!res.ok) throw fail(describeHttpError(res, `${method} ${urlPath}`));
  return res.data;
}

const fmtNum = n => (Number.isFinite(n) ? n.toLocaleString('en-US') : '-');
const fmtUsd = n => (Number.isFinite(n) ? `$${n < 0.01 && n > 0 ? n.toFixed(6) : n.toFixed(2)}` : '-');
function fmtAgo(iso) {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '-';
  const d = formatDuration((Date.now() - t) / 1000);
  return d ? `${d} ago` : '-';
}

export function keyRows(keys, now = Date.now()) {
  return keys.map(k => {
    const expired = k.expiresAt && Date.parse(k.expiresAt) <= now;
    const state = !k.enabled ? c.yellow('disabled') : expired ? c.red('expired') : c.green('active');
    const limits = [k.rpmLimit ? `${k.rpmLimit} rpm` : null, k.tpmLimit ? `${k.tpmLimit} tpm` : null].filter(Boolean).join(', ') || '-';
    const spend = Number.isFinite(k.budgetUsd) && k.budgetUsd !== null ? `${fmtUsd(k.spendUsd || 0)} / ${fmtUsd(k.budgetUsd)}` : fmtUsd(k.spendUsd || 0);
    return [k.id, k.name || '-', k.keyHint || '-', state, fmtNum(k.requests || 0), fmtNum(k.tokens || 0), spend, limits, fmtAgo(k.lastUsedAt)];
  });
}

async function resolveKeyId(ctx, ref) {
  if (!ref) throw usageError('missing key id (see `cortexgate keys list`)');
  const data = await adminCall(ctx, 'GET', '/v1/admin/keys');
  const keys = data?.keys || [];
  const byId = keys.find(k => k.id === ref);
  if (byId) return byId;
  const byName = keys.filter(k => k.name === ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw fail(`More than one key is named '${ref}' — use the id (\`cortexgate keys list\`)`);
  throw fail(`No key with id or name '${ref}'`);
}

export async function keys(ctx, rest) {
  const [sub, ...args] = rest;
  switch (sub) {
    case undefined:
    case 'list':
    case 'ls': {
      const data = await adminCall(ctx, 'GET', '/v1/admin/keys');
      if (ctx.flags.json) { out(JSON.stringify(data, null, 2)); return 0; }
      const list = data?.keys || [];
      if (!list.length) out('No client keys yet. Create one: cortexgate keys create <name>');
      else out(table(['ID', 'NAME', 'KEY', 'STATUS', 'REQUESTS', 'TOKENS', 'SPEND', 'LIMITS', 'LAST USED'], keyRows(list)));
      if (data?.authMode) out(c.dim(`\nclient auth mode: ${data.authMode}`));
      return 0;
    }
    case 'create':
    case 'new': {
      const name = args.join(' ').trim();
      if (!name) throw usageError('usage: cortexgate keys create <name> [--rpm N] [--tpm N] [--budget USD] [--expires ISO] [--providers a,b]');
      const body = { name };
      const rpm = intFlag(ctx.flags.rpm, 'rpm', { min: 1 });
      const tpm = intFlag(ctx.flags.tpm, 'tpm', { min: 1 });
      const budget = numberFlag(ctx.flags.budget, 'budget', { min: 0 });
      if (rpm !== undefined) body.rpmLimit = rpm;
      if (tpm !== undefined) body.tpmLimit = tpm;
      if (budget !== undefined) body.budgetUsd = budget;
      if (ctx.flags.expires !== undefined) {
        const t = Date.parse(String(ctx.flags.expires));
        if (!Number.isFinite(t)) throw usageError(`--expires must be an ISO date (got '${ctx.flags.expires}')`);
        body.expiresAt = new Date(t).toISOString();
      }
      if (ctx.flags.providers !== undefined) {
        body.allowedProviders = String(ctx.flags.providers).split(',').map(s => s.trim()).filter(Boolean);
      }
      const data = await adminCall(ctx, 'POST', '/v1/admin/keys', body);
      if (ctx.flags.json) { out(JSON.stringify(data, null, 2)); return 0; }
      out(`Created key ${c.bold(data.record?.name || name)} (id ${data.record?.id || '?'})`);
      out('');
      out(`  ${c.bold(c.green(data.key))}`);
      out('');
      out(c.yellow('This is the only time the full key is shown — store it now (it is kept only as a hash).'));
      out(c.dim(`Use it as: Authorization: Bearer <key>   (OpenAI SDK: base_url=${ctx.url}/v1, api_key=<key>)`));
      return 0;
    }
    case 'revoke':
    case 'delete':
    case 'rm': {
      const k = await resolveKeyId(ctx, args[0]);
      if (!ctx.flags.yes) {
        if (!process.stdin.isTTY) throw usageError('refusing to revoke without --yes in a non-interactive shell');
        const okGo = await askYesNo(`Revoke key '${k.name}' (${k.keyHint || k.id})? Clients using it will get 401`, { def: false });
        closePrompts();
        if (!okGo) { out('Cancelled.'); return 1; }
      }
      await adminCall(ctx, 'DELETE', `/v1/admin/keys/${encodeURIComponent(k.id)}`);
      out(`Revoked ${k.name} (${k.id}).`);
      return 0;
    }
    case 'disable':
    case 'enable': {
      const k = await resolveKeyId(ctx, args[0]);
      const data = await adminCall(ctx, 'PATCH', `/v1/admin/keys/${encodeURIComponent(k.id)}`, { enabled: sub === 'enable' });
      const rec = data?.record || data;
      out(`${sub === 'enable' ? 'Enabled' : 'Disabled'} ${rec?.name || k.name} (${k.id}).`);
      return 0;
    }
    default:
      throw usageError(`unknown keys subcommand '${sub}' (list, create, revoke, disable, enable)`);
  }
}

// ---------------------------------------------------------------- test

export function summarizeCompletion(data, elapsedMs) {
  const answer = data?.choices?.[0]?.message?.content ?? '';
  const attempts = Array.isArray(data?.attempts) ? data.attempts : [];
  const r = data?.routing || {};
  const cacheHit = data?.cache?.hit;
  return {
    answer: String(answer).trim(),
    provider: data?.provider || '-',
    model: data?.model || '-',
    tier: r.tier || '-',
    policy: r.policy || '-',
    task: r.task || null,
    attempts: attempts.length || (cacheHit ? 0 : 1),
    attemptTrail: attempts.map(a => {
      const okA = a.outcome ? a.outcome === 'ok' : !a.error;
      const mark = okA ? '✓' : `✗ ${a.outcome || 'error'}`;
      return `${a.provider} ${mark}${Number.isFinite(a.latencyMs) ? ` ${a.latencyMs}ms` : ''}`;
    }).join(' → '),
    latencyMs: elapsedMs,
    tokens: data?.usage?.total_tokens ?? null,
    cost: Number.isFinite(data?.cost) ? data.cost : null,
    cache: cacheHit ? `hit (similarity ${Number(data.cache.similarity || 0).toFixed(3)})` : data?.cache?.bypassed ? 'bypassed' : 'miss',
    reason: r.reason || null
  };
}

export async function test(ctx, rest) {
  const prompt = rest.join(' ').trim();
  if (!prompt) throw usageError('usage: cortexgate test "<prompt>" [--policy cost|balanced|quality] [--provider NAME]');
  const body = { messages: [{ role: 'user', content: prompt }] };
  if (ctx.flags.policy) {
    const p = String(ctx.flags.policy).toLowerCase();
    if (!['cost', 'balanced', 'quality'].includes(p)) throw usageError('--policy must be cost, balanced or quality');
    body.routing_policy = p;
  }
  if (ctx.flags.provider) body.provider = String(ctx.flags.provider);
  const headers = {};
  if (ctx.flags.cache === false) headers['x-cache'] = 'bypass';
  const started = Date.now();
  let res;
  try {
    res = await request(ctx.url, '/v1/chat/completions', { method: 'POST', body, apiKey: ctx.apiKey, headers, timeoutMs: 90000 });
  } catch (e) {
    throw fail(e.message);
  }
  const elapsed = Date.now() - started;
  if (ctx.flags.json) {
    out(JSON.stringify(res.data, null, 2));
    return res.ok ? 0 : 1;
  }
  if (!res.ok) {
    let msg = describeHttpError(res, 'completion failed');
    if (res.status === 401 && !ctx.apiKey) msg += '\n(no client key was sent — none found in --key, CORTEXGATE_API_KEY or .env CORTEXGATE_BOOTSTRAP_KEY)';
    const attempts = res.data?.attempts;
    if (Array.isArray(attempts) && attempts.length) {
      msg += `\nattempts: ${attempts.map(a => `${a.provider} ${a.outcome || 'error'}${a.httpStatus ? ` ${a.httpStatus}` : ''}`).join(' → ')}`;
    }
    throw fail(msg);
  }
  const s = summarizeCompletion(res.data, elapsed);
  out(s.answer || c.dim('(empty answer)'));
  out('');
  out(`${c.dim('provider')} ${c.bold(s.provider)}  ${c.dim('model')} ${s.model}  ${c.dim('tier')} ${s.tier}${s.task ? ` (${s.task})` : ''}  ${c.dim('policy')} ${s.policy}`);
  const bits = [
    `${c.dim('attempts')} ${s.attempts}${s.attemptTrail ? ` (${s.attemptTrail})` : ''}`,
    `${c.dim('latency')} ${(s.latencyMs / 1000).toFixed(2)}s`,
    s.tokens !== null ? `${c.dim('tokens')} ${s.tokens}` : null,
    s.cost !== null ? `${c.dim('cost')} $${s.cost.toFixed(6)}` : null,
    `${c.dim('cache')} ${s.cache}`
  ].filter(Boolean);
  out(bits.join('  '));
  if (ctx.apiKeySource) out(c.dim(`key: ${ctx.apiKeySource}`));
  return 0;
}

// ---------------------------------------------------------------- doctor

const PROVIDER_KEY_VARS = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'SAMBANOVA_API_KEY', 'MISTRAL_API_KEY',
  'GITHUB_TOKEN', 'HUGGINGFACE_API_KEY', 'CEREBRAS_API_KEY', 'CLOUDFLARE_API_TOKEN', 'COHERE_API_KEY', 'TOGETHER_API_KEY'];

export function countProviderKeys(dotenv) {
  return PROVIDER_KEY_VARS.filter(k => (dotenv[k] || (k === 'CLOUDFLARE_API_TOKEN' && dotenv.CLOUDFLARE_API_KEY) || '').trim() !== '')
    .map(k => k.replace(/_(API_KEY|API_TOKEN|TOKEN)$/, '').toLowerCase());
}

export async function doctor(ctx) {
  const results = [];
  const add = (level, msg) => {
    results.push(level);
    (level === 'ok' ? okLine : level === 'warn' ? warnLine : failLine)(msg);
  };
  out(c.bold('CortexGate doctor'));

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 18 ? 'ok' : 'fail', `Node ${process.versions.node}${major >= 18 ? '' : ' — Node 18+ is required (the gateway is tested on Node 24)'}`);

  const cfgExists = fs.existsSync(paths().config);
  add(cfgExists ? 'ok' : 'warn', cfgExists ? `Config ${paths().config} (mode ${ctx.mode}, port ${ctx.port})` : `No config at ${paths().config} — run \`cortexgate init\` (using mode ${ctx.mode}, port ${ctx.port})`);

  const repoOk = ctx.repoPath && isRepo(ctx.repoPath);
  add(repoOk ? 'ok' : 'fail', repoOk ? `Repo ${ctx.repoPath}` : `CortexGate checkout not found${ctx.repoPath ? ` at ${ctx.repoPath}` : ''} — pass --repo or run \`cortexgate init\``);
  if (repoOk && ctx.mode === 'node' && !fs.existsSync(path.join(gatewayDir(ctx.repoPath), 'node_modules'))) {
    add('fail', `Gateway dependencies missing — run \`npm install\` in ${gatewayDir(ctx.repoPath)}`);
  }

  if (repoOk) {
    if (!ctx.envExists) {
      add('fail', `No ${ctx.envPath} — run \`cortexgate init\``);
    } else {
      const keysSet = countProviderKeys(ctx.dotenv);
      add(keysSet.length ? 'ok' : 'warn', `.env present — ${keysSet.length} provider key(s)${keysSet.length ? `: ${keysSet.join(', ')}` : ' (add some with `cortexgate init` or the dashboard)'}`);
      add(ctx.dotenv.ADMIN_TOKEN ? 'ok' : 'warn', ctx.dotenv.ADMIN_TOKEN ? 'ADMIN_TOKEN set' : 'ADMIN_TOKEN not set — admin API/dashboard key management works from localhost only');
      add(ctx.dotenv.CORTEXGATE_BOOTSTRAP_KEY ? 'ok' : 'warn', ctx.dotenv.CORTEXGATE_BOOTSTRAP_KEY ? 'CORTEXGATE_BOOTSTRAP_KEY set (client key for `cortexgate test`)' : 'CORTEXGATE_BOOTSTRAP_KEY not set — `cortexgate init` can generate one');
      add('ok', `CLIENT_AUTH=${ctx.dotenv.CLIENT_AUTH || '(unset → auto)'}`);
    }
  }

  const d = detectCompose();
  if (d.error) add(ctx.mode === 'docker' ? 'fail' : 'warn', d.error);
  else if (!d.daemonUp) add(ctx.mode === 'docker' ? 'fail' : 'warn', `Docker Compose ${d.version}${d.legacy ? ' (legacy docker-compose)' : ''} found, but the Docker daemon is not running`);
  else add('ok', `Docker ${d.dockerVersion}, Compose ${d.version}${d.legacy ? ' (legacy docker-compose — v2 recommended)' : ''}`);

  const h = await health(ctx.url, 3000);
  if (h) {
    add('ok', `Port :${ctx.port} in use by CortexGate`);
  } else if (await tcpCheck('127.0.0.1', ctx.port, 800)) {
    add('fail', `Port :${ctx.port} is in use by another program — choose another with \`cortexgate init --port N\``);
  } else {
    add('ok', `Port :${ctx.port} free`);
  }

  const redisUrl = ctx.dotenv.REDIS_URL || 'redis://127.0.0.1:6380';
  const rhp = hostPortFromUrl(redisUrl, 6379);
  if (rhp) {
    const up = await tcpCheck(rhp.host, rhp.port);
    add(up ? 'ok' : 'warn', up ? `Redis reachable at ${rhp.host}:${rhp.port}` : `Redis not reachable at ${rhp.host}:${rhp.port} — rate limiting falls back to in-memory (start it: docker compose up -d redis)`);
  }

  const ollamaBase = (ctx.dotenv.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  try {
    const res = await request(ollamaBase, '/api/tags', { timeoutMs: 2000 });
    const models = Array.isArray(res.data?.models) ? res.data.models.map(m => m.name) : [];
    add(res.ok ? 'ok' : 'warn', res.ok ? `Ollama reachable at ${ollamaBase} (${models.length} model${models.length === 1 ? '' : 's'}${models.length ? `: ${models.slice(0, 3).join(', ')}` : ' — pull one: docker exec cortexgate_ollama ollama pull qwen2.5:0.5b'})` : `Ollama at ${ollamaBase} answered HTTP ${res.status}`);
  } catch {
    add('warn', `Ollama not reachable at ${ollamaBase} (optional local provider)`);
  }

  const mongoUri = ctx.dotenv.MONGODB_URI;
  if (mongoUri) {
    if (/^mongodb\+srv:/i.test(mongoUri)) add('ok', 'MongoDB: SRV URI configured (not probed)');
    else {
      const m = /^mongodb:\/\/(?:[^@/]*@)?([^/,?:]+)(?::(\d+))?/i.exec(mongoUri);
      if (m) {
        const up = await tcpCheck(m[1], Number(m[2] || 27017));
        add(up ? 'ok' : 'warn', up ? `MongoDB reachable at ${m[1]}:${m[2] || 27017}` : `MongoDB not reachable at ${m[1]}:${m[2] || 27017} — history stays in local files (optional)`);
      }
    }
  } else {
    add('ok', 'MongoDB not configured (optional)');
  }

  if (h) add('ok', `Gateway healthy at ${ctx.url}`);
  else add('warn', `${unreachableMessage(ctx.url)}`);

  const fails = results.filter(r => r === 'fail').length;
  const warns = results.filter(r => r === 'warn').length;
  out('');
  out(fails ? c.red(`${fails} problem(s), ${warns} warning(s)`) : warns ? c.yellow(`No problems, ${warns} warning(s)`) : c.green('All good'));
  return fails ? 1 : 0;
}

export function version(v) {
  out(`cortexgate ${v} (node ${process.versions.node}, ${process.platform}-${process.arch})`);
  return 0;
}
