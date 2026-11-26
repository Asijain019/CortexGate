// ~/.cortexgate/config.json  { repoPath, mode: "docker"|"node", port, url }
// CORTEXGATE_HOME overrides the directory (used by tests and for side-by-side instances).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 3003;

export function homeDir(env = process.env) {
  return env.CORTEXGATE_HOME ? path.resolve(env.CORTEXGATE_HOME) : path.join(os.homedir(), '.cortexgate');
}

export const paths = (env = process.env) => {
  const home = homeDir(env);
  return {
    home,
    config: path.join(home, 'config.json'),
    logs: path.join(home, 'logs'),
    run: path.join(home, 'run')
  };
};

export function readConfig(env = process.env) {
  const file = paths(env).config;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
}

export function writeConfig(cfg, env = process.env) {
  const p = paths(env);
  fs.mkdirSync(p.home, { recursive: true });
  const clean = {};
  for (const k of ['repoPath', 'mode', 'port', 'url']) if (cfg[k] !== undefined && cfg[k] !== null) clean[k] = cfg[k];
  for (const [k, v] of Object.entries(cfg)) if (!(k in clean) && v !== undefined) clean[k] = v;
  const tmp = `${p.config}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`);
  fs.renameSync(tmp, p.config);
  return p.config;
}

/** True when dir looks like a CortexGate checkout. */
export function isRepo(dir) {
  if (!dir) return false;
  try {
    return fs.existsSync(path.join(dir, 'services', 'gateway', 'src', 'index.js'));
  } catch {
    return false;
  }
}

/** Walk up from `start` looking for a CortexGate checkout. */
export function findRepoUpwards(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (isRepo(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The checkout this CLI ships in (cli/ lives at the repo root). */
export function bundledRepo() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, '..', '..');
  return isRepo(candidate) ? candidate : null;
}

/**
 * Effective settings: flags > env > config file > detection > defaults.
 * Returns { repoPath, mode, port, url, configFile, configured }.
 */
export function resolveSettings(flags = {}, env = process.env, cwd = process.cwd()) {
  const cfg = readConfig(env);
  const ev = k => (env[k] === undefined || env[k] === '' ? undefined : env[k]);
  const repoPath = flags.repo
    ? path.resolve(String(flags.repo))
    : ev('CORTEXGATE_REPO')
      ? path.resolve(ev('CORTEXGATE_REPO'))
      : cfg.repoPath || findRepoUpwards(cwd) || bundledRepo();
  let mode = flags.docker ? 'docker' : flags.node ? 'node' : (flags.mode || cfg.mode || 'node');
  mode = String(mode).toLowerCase();
  if (mode !== 'docker' && mode !== 'node') throw Object.assign(new Error(`Unknown mode '${mode}' (use docker or node)`), { exitCode: 2 });
  const portRaw = flags.port ?? ev('CORTEXGATE_PORT') ?? cfg.port ?? DEFAULT_PORT;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error(`Invalid port '${portRaw}'`), { exitCode: 2 });
  }
  // A config url only applies when the port was not overridden on the command line / env.
  const portOverridden = flags.port !== undefined || ev('CORTEXGATE_PORT') !== undefined;
  const url = String(flags.url || ev('CORTEXGATE_URL') || (!portOverridden && cfg.url) || `http://localhost:${port}`).replace(/\/+$/, '');
  return { repoPath: repoPath || null, mode, port, url, configFile: paths(env).config, configured: Object.keys(cfg).length > 0 };
}

export function gatewayDir(repoPath) {
  return path.join(repoPath, 'services', 'gateway');
}

export function envFile(repoPath) {
  return path.join(gatewayDir(repoPath), '.env');
}
