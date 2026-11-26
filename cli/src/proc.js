// Node-mode process management: detached gateway/worker, pid files, log files.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { paths, gatewayDir } from './config.js';

export const SERVICES = {
  gateway: { script: path.join('src', 'index.js') },
  worker: { script: path.join('src', 'workers', 'requestWorker.js') }
};

export const pidFile = (name, env = process.env) => path.join(paths(env).run, `${name}.pid`);
export const stateFile = (env = process.env) => path.join(paths(env).run, 'state.json');
export const logFile = (name, env = process.env) => path.join(paths(env).logs, `${name}.log`);

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function readPid(name, env = process.env) {
  try {
    const pid = parseInt(fs.readFileSync(pidFile(name, env), 'utf8').trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function readState(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(env), 'utf8'));
  } catch {
    return null;
  }
}

/** { gateway: {pid, alive}, worker: {pid, alive} } */
export function runningServices(env = process.env) {
  const res = {};
  for (const name of Object.keys(SERVICES)) {
    const pid = readPid(name, env);
    res[name] = { pid, alive: pid ? isAlive(pid) : false };
  }
  return res;
}

/** Spawn one service detached with stdout+stderr appended to its log file. Returns the pid. */
export function spawnService(name, { repoPath, port, env = process.env, extraEnv = {} }) {
  const p = paths(env);
  fs.mkdirSync(p.logs, { recursive: true });
  fs.mkdirSync(p.run, { recursive: true });
  const cwd = gatewayDir(repoPath);
  const script = SERVICES[name].script;
  if (!fs.existsSync(path.join(cwd, script))) throw new Error(`Missing ${path.join(cwd, script)} — is repoPath correct?`);
  const log = logFile(name, env);
  const fd = fs.openSync(log, 'a');
  fs.writeSync(fd, `\n===== ${new Date().toISOString()} cortexgate start ${name} (port ${port}) =====\n`);
  const childEnv = { ...process.env, ...extraEnv, PORT: String(port) };
  // Our own CLI settings are not meant for the gateway.
  delete childEnv.CORTEXGATE_HOME;
  let child;
  try {
    child = spawn(process.execPath, [script], {
      cwd,
      env: childEnv,
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', fd, fd]
    });
  } finally {
    fs.closeSync(fd);
  }
  if (!child.pid) throw new Error(`Failed to start ${name}`);
  child.on('error', () => {});
  child.unref();
  fs.writeFileSync(pidFile(name, env), String(child.pid));
  return child.pid;
}

export function writeState(state, env = process.env) {
  fs.mkdirSync(paths(env).run, { recursive: true });
  fs.writeFileSync(stateFile(env), `${JSON.stringify(state, null, 2)}\n`);
}

/** Kill a process tree. Windows: taskkill /T /F. POSIX: SIGTERM the process group, then SIGKILL. */
export async function killTree(pid, { timeoutMs = 5000 } = {}) {
  if (!isAlive(pid)) return true;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(150);
  }
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(200);
  }
  return !isAlive(pid);
}

export function clearPid(name, env = process.env) {
  try { fs.unlinkSync(pidFile(name, env)); } catch { /* none */ }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Last n lines of a file (reads at most the final 256 KiB). */
export function tailLines(file, n = 50) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Follow a file (poll-based, works on Windows). Returns a stop function. */
export function followFile(file, onChunk, intervalMs = 500) {
  let pos = 0;
  try { pos = fs.statSync(file).size; } catch { pos = 0; }
  const timer = setInterval(() => {
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < pos) pos = 0; // truncated / rotated
    if (size === pos) return;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      pos = size;
      onChunk(buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

/** PID listening on a local TCP port (best effort; null when unknown). */
export function listeningPid(port) {
  const opts = { encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000 };
  if (process.platform === 'win32') {
    const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], opts);
    if (r.error || r.status !== 0) return null;
    for (const line of r.stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && /LISTEN/i.test(parts[3]) && parts[1].endsWith(`:${port}`)) {
        const pid = parseInt(parts[4], 10);
        if (pid > 0) return pid;
      }
    }
    return null;
  }
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], opts);
  if (r.error || r.status !== 0) return null;
  const pid = parseInt(r.stdout.trim().split(/\s+/)[0], 10);
  return pid > 0 ? pid : null;
}

/** ISO start time of a process (best effort; null when unknown). */
export function processStartedAt(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const opts = { encoding: 'utf8', windowsHide: true, shell: false, timeout: 8000 };
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`], opts);
    const t = Date.parse(String(r.stdout || '').trim());
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const r = spawnSync('ps', ['-o', 'etimes=', '-p', String(pid)], opts);
  const sec = parseInt(String(r.stdout || '').trim(), 10);
  return Number.isFinite(sec) ? new Date(Date.now() - sec * 1000).toISOString() : null;
}
