import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, usageError } from './args.js';
import { resolveSettings, envFile } from './config.js';
import { readEnvFile } from './env.js';
import { c } from './ui.js';
import * as cmd from './commands.js';
import { runInit } from './init.js';

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
export const VERSION = pkg.version;

export const ARG_SPEC = {
  boolean: ['yes', 'follow', 'json', 'help', 'docker', 'node', 'all', 'version', 'worker', 'cache', 'build', 'keys', 'force'],
  alias: { y: 'yes', f: 'follow', h: 'help', v: 'version', n: 'lines', p: 'port' }
};

export const HELP = `${'cortexgate'} — set up, run and manage a CortexGate gateway

Usage: cortexgate <command> [options]

Setup
  init                     interactive setup: repo, mode, port, provider keys, secrets → services/gateway/.env
                           flags: --yes (non-interactive) --mode docker|node --port N --repo PATH --no-keys
  doctor                   check node, docker, port, .env, redis, ollama, mongo, gateway health

Run
  start [--docker|--node]  start the gateway (node mode also starts the worker when Redis is reachable;
                           --no-worker to skip, --build to rebuild the Docker image)
  stop  [--docker|--node]  stop it (docker: stops gateway+worker containers; --all = docker compose down)
  restart                  stop + start in the configured mode
  status [--json]          health, uptime, auth mode, policy, redis/mongo, provider summary
  logs [-f] [--worker] [-n N]   show (and follow) gateway or worker logs
  open                     open the dashboard in your browser

Client keys (admin API)
  keys list [--json]
  keys create <name> [--rpm N] [--tpm N] [--budget USD] [--expires ISO] [--providers a,b]
  keys disable <id|name> | keys enable <id|name> | keys revoke <id|name> [--yes]

Try it
  test "<prompt>" [--policy cost|balanced|quality] [--provider NAME] [--no-cache] [--json]

Other
  version | help

Global options
  --repo PATH   CortexGate checkout (default: config, then current dir, then the checkout this CLI lives in)
  --port N      gateway port (default: config or 3003)      --url URL   full gateway URL
  --key cg-...  client key (else $CORTEXGATE_API_KEY, else CORTEXGATE_BOOTSTRAP_KEY from .env)

Environment
  CORTEXGATE_HOME        config/logs/pids directory (default ~/.cortexgate)
  CORTEXGATE_API_KEY     client key for \`test\`        CORTEXGATE_ADMIN_TOKEN   overrides ADMIN_TOKEN from .env
  NO_COLOR               disable colours
`;

/** Settings + secrets for commands (secrets are only ever sent as headers, never printed). */
export function context(flags) {
  const s = resolveSettings(flags);
  const envPath = s.repoPath ? envFile(s.repoPath) : null;
  const dotenv = (envPath && readEnvFile(envPath)) || {};
  if (flags.key === true) throw usageError('--key needs a value (cg-...)');
  const adminToken = process.env.CORTEXGATE_ADMIN_TOKEN || dotenv.ADMIN_TOKEN || null;
  const apiKey = flags.key || process.env.CORTEXGATE_API_KEY || dotenv.CORTEXGATE_BOOTSTRAP_KEY || null;
  const apiKeySource = flags.key ? '--key' : process.env.CORTEXGATE_API_KEY ? 'CORTEXGATE_API_KEY' : dotenv.CORTEXGATE_BOOTSTRAP_KEY ? 'CORTEXGATE_BOOTSTRAP_KEY (.env)' : null;
  return { ...s, flags, envPath, envExists: Boolean(envPath && fs.existsSync(envPath)), dotenv, adminToken, apiKey, apiKeySource };
}

export async function main(argv) {
  const flags = parseArgs(argv, ARG_SPEC);
  const [command, ...rest] = flags._;
  if (flags.version && !command) return cmd.version(VERSION);
  if (!command || command === 'help' || (flags.help && !command)) {
    process.stdout.write(HELP);
    return command || flags.help ? 0 : 0;
  }
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  switch (command) {
    case 'init': return runInit(flags);
    case 'start': return cmd.start(context(flags));
    case 'stop': return cmd.stop(context(flags));
    case 'restart': return cmd.restart(context(flags));
    case 'status': return cmd.status(context(flags));
    case 'logs': return cmd.logs(context(flags));
    case 'open': return cmd.open(context(flags));
    case 'keys': return cmd.keys(context(flags), rest);
    case 'test': return cmd.test(context(flags), rest);
    case 'doctor': return cmd.doctor(context(flags));
    case 'version': case '--version': return cmd.version(VERSION);
    default:
      process.stderr.write(`${c.red('Unknown command')} '${command}'. Run \`cortexgate help\`.\n`);
      return 2;
  }
}
