// `cortexgate init`: locate repo, choose mode/port, collect provider keys, generate secrets,
// merge them into services/gateway/.env (backup first, never overwriting existing values
// unless the user typed a new one), write ~/.cortexgate/config.json.
import fs from 'node:fs';
import path from 'node:path';
import { resolveSettings, isRepo, writeConfig, readConfig, envFile, gatewayDir, DEFAULT_PORT } from './config.js';
import { readEnvFile, mergeEnvFile } from './env.js';
import { generateAdminToken, generateClientKey, generateSecretKey } from './secrets.js';
import { ask, askChoice, askSecret, askYesNo, closePrompts } from './prompt.js';
import { detectCompose } from './docker.js';
import { usageError } from './args.js';
import { c, out, warnLine, okLine } from './ui.js';

export const PROVIDER_PROMPTS = [
  { env: 'GROQ_API_KEY', label: 'Groq', url: 'https://console.groq.com/keys' },
  { env: 'GEMINI_API_KEY', label: 'Google Gemini', url: 'https://aistudio.google.com/apikey' },
  { env: 'OPENROUTER_API_KEY', label: 'OpenRouter', url: 'https://openrouter.ai/keys' },
  { env: 'CEREBRAS_API_KEY', label: 'Cerebras', url: 'https://cloud.cerebras.ai' },
  { env: 'MISTRAL_API_KEY', label: 'Mistral', url: 'https://console.mistral.ai/api-keys' },
  { env: 'NVIDIA_API_KEY', label: 'NVIDIA NIM', url: 'https://build.nvidia.com' },
  { env: 'SAMBANOVA_API_KEY', label: 'SambaNova', url: 'https://cloud.sambanova.ai' },
  { env: 'COHERE_API_KEY', label: 'Cohere', url: 'https://dashboard.cohere.com/api-keys' },
  { env: 'GITHUB_TOKEN', label: 'GitHub Models', url: 'https://github.com/settings/tokens' },
  { env: 'HUGGINGFACE_API_KEY', label: 'Hugging Face', url: 'https://huggingface.co/settings/tokens' },
  { env: 'CLOUDFLARE_API_TOKEN', label: 'Cloudflare Workers AI', url: 'https://dash.cloudflare.com/profile/api-tokens', alias: 'CLOUDFLARE_API_KEY', account: 'CLOUDFLARE_ACCOUNT_ID' }
];

const isSet = (env, key) => Boolean(env && typeof env[key] === 'string' && env[key].trim() !== '');

/**
 * Decide which generated secrets to add. Pure apart from the generators (injectable for tests).
 * Existing values always win. CORTEX_SECRET_KEY reuses data/.secret when present so dashboard-saved
 * provider keys (encrypted with it) stay readable.
 */
export function planSecrets(current, { dataSecret = null, encryptedStoreExists = false, gen = {} } = {}) {
  const g = { admin: generateAdminToken, client: generateClientKey, secret: generateSecretKey, ...gen };
  const updates = {};
  const generated = [];
  const notes = [];
  if (!isSet(current, 'ADMIN_TOKEN')) { updates.ADMIN_TOKEN = g.admin(); generated.push('ADMIN_TOKEN'); }
  if (!isSet(current, 'CORTEXGATE_BOOTSTRAP_KEY')) { updates.CORTEXGATE_BOOTSTRAP_KEY = g.client(); generated.push('CORTEXGATE_BOOTSTRAP_KEY'); }
  if (!isSet(current, 'CORTEX_SECRET_KEY')) {
    if (dataSecret) {
      updates.CORTEX_SECRET_KEY = dataSecret;
      notes.push('CORTEX_SECRET_KEY copied from data/.secret (keeps dashboard-saved provider keys decryptable)');
    } else if (encryptedStoreExists) {
      notes.push('CORTEX_SECRET_KEY not set: data/providers.enc.json exists without data/.secret, so no new key was generated (it could not decrypt the existing store)');
    } else {
      updates.CORTEX_SECRET_KEY = g.secret();
      generated.push('CORTEX_SECRET_KEY');
    }
  }
  return { updates, generated, notes };
}

function readDataSecret(repoPath) {
  const dir = path.join(gatewayDir(repoPath), 'data');
  let secret = null;
  try { secret = fs.readFileSync(path.join(dir, '.secret'), 'utf8').trim() || null; } catch { /* none */ }
  return { dataSecret: secret, encryptedStoreExists: fs.existsSync(path.join(dir, 'providers.enc.json')) };
}

export async function runInit(flags) {
  const interactive = !flags.yes;
  const cfg = readConfig();
  let detected;
  try {
    detected = resolveSettings({ repo: flags.repo }).repoPath;
  } catch {
    detected = null;
  }

  out(c.bold('CortexGate setup'));
  if (interactive) out(c.dim('Press Enter to accept the [default]. Ctrl+C aborts without changing anything.\n'));

  // 1. repo
  let repoPath = flags.repo ? path.resolve(String(flags.repo)) : detected;
  if (interactive) {
    for (;;) {
      const answer = await ask('CortexGate repo path', { def: repoPath || '' });
      const p = answer ? path.resolve(answer) : null;
      if (p && isRepo(p)) { repoPath = p; break; }
      out(`  ${c.red('✗')} ${p || '(empty)'} is not a CortexGate checkout (expected services/gateway/src/index.js)`);
      if (!process.stdin.isTTY) throw usageError('repo path not found');
    }
  } else if (!repoPath || !isRepo(repoPath)) {
    throw usageError(`CortexGate checkout not found${repoPath ? ` at ${repoPath}` : ''} — pass --repo <path>`);
  }

  // 2. mode
  const compose = detectCompose();
  const dockerReady = !compose.error && compose.daemonUp;
  let mode = flags.docker ? 'docker' : flags.node ? 'node' : flags.mode ? String(flags.mode).toLowerCase() : null;
  if (mode && !['docker', 'node'].includes(mode)) throw usageError(`--mode must be docker or node (got '${flags.mode}')`);
  if (!mode) {
    const def = cfg.mode || (dockerReady ? 'docker' : 'node');
    if (interactive) {
      out(c.dim(`  docker: gateway + worker + redis + ollama in containers${dockerReady ? '' : ' (Docker not detected/running)'}`));
      out(c.dim('  node:   gateway runs directly with your Node.js (needs `npm install` in services/gateway)'));
      mode = await askChoice('Run mode', ['docker', 'node'], { def });
    } else {
      mode = def;
    }
  }
  if (mode === 'docker' && !dockerReady) warnLine(compose.error || 'Docker daemon is not running — start Docker Desktop before `cortexgate start`.');

  // 3. port
  let port = flags.port !== undefined ? Number(flags.port) : Number(cfg.port || DEFAULT_PORT);
  if (interactive && flags.port === undefined) {
    for (;;) {
      port = Number(await ask('Gateway port', { def: String(port) }));
      if (Number.isInteger(port) && port > 0 && port < 65536) break;
      out(`  ${c.red('✗')} enter a port between 1 and 65535`);
      if (!process.stdin.isTTY) throw usageError('invalid port');
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw usageError(`invalid --port '${flags.port}'`);

  // 4. provider keys
  const envPath = envFile(repoPath);
  const examplePath = path.join(gatewayDir(repoPath), '.env.example');
  const current = readEnvFile(envPath) || readEnvFile(examplePath) || {};
  const entered = {};
  if (interactive && flags.keys !== false) {
    const have = PROVIDER_PROMPTS.filter(p => isSet(current, p.env) || (p.alias && isSet(current, p.alias))).map(p => p.label);
    out('');
    out(`Provider API keys${have.length ? ` (already set: ${have.join(', ')})` : ''}. Input is hidden; Enter skips / keeps the current value.`);
    if (await askYesNo('Add or change provider keys now?', { def: have.length === 0 })) {
      for (const p of PROVIDER_PROMPTS) {
        const already = isSet(current, p.env) || (p.alias && isSet(current, p.alias));
        const v = await askSecret(`  ${p.label} ${c.dim(`(${p.env}${already ? ', set — Enter keeps it' : `, ${p.url}`})`)}`);
        if (v) {
          entered[p.env] = v;
          if (p.account && !isSet(current, p.account)) {
            const acct = await ask(`  ${p.label} account id (${p.account})`);
            if (acct) entered[p.account] = acct;
          }
        }
      }
    }
  }
  closePrompts();

  // 5. secrets + merge
  const plan = planSecrets(current, readDataSecret(repoPath));
  const updates = { ...entered, ...plan.updates };
  const result = mergeEnvFile(envPath, updates, { overwrite: Object.keys(entered), templateFile: examplePath });

  // 6. config
  const url = `http://localhost:${port}`;
  const cfgFile = writeConfig({ ...cfg, repoPath, mode, port, url });

  out('');
  if (result.created) okLine(`Created ${envPath} from .env.example`);
  if (result.backup) okLine(`Backed up previous .env → ${result.backup}`);
  if (result.changed.length) okLine(`Wrote ${result.changed.join(', ')} to ${envPath}`);
  else okLine(`${envPath} already had everything — not modified`);
  const keptSecrets = ['ADMIN_TOKEN', 'CORTEXGATE_BOOTSTRAP_KEY', 'CORTEX_SECRET_KEY'].filter(k => isSet(current, k));
  if (keptSecrets.length) okLine(`Kept existing ${keptSecrets.join(', ')} (not shown)`);
  for (const n of plan.notes) okLine(n);
  okLine(`Saved ${cfgFile}  (mode ${mode}, port ${port})`);

  const reveal = plan.generated.filter(k => k !== 'CORTEX_SECRET_KEY');
  if (reveal.length) {
    out('');
    out(c.yellow('Generated credentials — shown once. They are saved in services/gateway/.env; keep them private.'));
    if (plan.updates.CORTEXGATE_BOOTSTRAP_KEY) out(`  client key  (Authorization: Bearer …)   ${c.bold(plan.updates.CORTEXGATE_BOOTSTRAP_KEY)}`);
    if (plan.updates.ADMIN_TOKEN) out(`  admin token (dashboard / x-admin-token) ${c.bold(plan.updates.ADMIN_TOKEN)}`);
  }
  out('');
  out('Next:');
  out(`  cortexgate start        ${c.dim(`# ${mode} mode on :${port}`)}`);
  out('  cortexgate status');
  out('  cortexgate test "What is 2+2?"');
  out(c.dim('If a gateway is already running, restart it (`cortexgate restart`) so it picks up the new admin token / bootstrap key.'));
  return 0;
}
