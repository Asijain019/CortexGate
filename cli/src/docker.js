// docker compose detection and invocation (v2 plugin preferred, legacy docker-compose as fallback).
import { spawn, spawnSync } from 'node:child_process';

let cached;

/** Returns { cmd, baseArgs, version, legacy } or { error } describing what is missing. */
export function detectCompose({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  const opts = { encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000 };
  const dockerV = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], opts);
  const dockerFound = !dockerV.error;
  const daemonUp = dockerFound && dockerV.status === 0 && Boolean(dockerV.stdout.trim());
  const v2 = dockerFound ? spawnSync('docker', ['compose', 'version', '--short'], opts) : null;
  if (v2 && !v2.error && v2.status === 0) {
    cached = { cmd: 'docker', baseArgs: ['compose'], version: v2.stdout.trim(), legacy: false, daemonUp, dockerVersion: daemonUp ? dockerV.stdout.trim() : null };
    return cached;
  }
  const v1 = spawnSync('docker-compose', ['version', '--short'], opts);
  if (!v1.error && v1.status === 0) {
    cached = { cmd: 'docker-compose', baseArgs: [], version: v1.stdout.trim(), legacy: true, daemonUp, dockerVersion: daemonUp ? dockerV.stdout.trim() : null };
    return cached;
  }
  cached = {
    error: dockerFound
      ? 'Docker is installed but the Compose v2 plugin (`docker compose`) was not found. Update Docker Desktop, or install docker-compose — or use node mode: `cortexgate start --node`.'
      : 'Docker was not found on PATH. Install Docker Desktop (https://docs.docker.com/get-docker/) or use node mode: `cortexgate start --node`.',
    dockerFound,
    daemonUp
  };
  return cached;
}

export function requireCompose() {
  const d = detectCompose();
  if (d.error) throw Object.assign(new Error(d.error), { exitCode: 3 });
  if (!d.daemonUp) {
    throw Object.assign(new Error('Docker daemon is not running — start Docker Desktop and retry (or use `cortexgate start --node`).'), { exitCode: 3 });
  }
  return d;
}

/** Run `docker compose <args>` in repoPath with inherited stdio. Resolves the exit code. */
export function compose(args, { repoPath, port, bind, inherit = true, capture = false } = {}) {
  const d = requireCompose();
  const env = { ...process.env };
  if (port) env.CORTEXGATE_PORT = String(port);
  if (bind) env.CORTEXGATE_BIND = bind;
  delete env.CORTEXGATE_HOME;
  return new Promise((resolve, reject) => {
    const child = spawn(d.cmd, [...d.baseArgs, ...args], {
      cwd: repoPath,
      env,
      shell: false,
      windowsHide: true,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : inherit ? 'inherit' : 'ignore'
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', b => { stdout += b; });
      child.stderr.on('data', b => { stderr += b; });
    }
    child.on('error', reject);
    child.on('close', code => resolve(capture ? { code, stdout, stderr } : code));
  });
}
