// End-to-end: run the real bin in a child process against a throwaway fake repo and CORTEXGATE_HOME.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from '../src/env.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cortexgate.js');
const EXAMPLE = `PORT=3003
# keys
GROQ_API_KEY=
GEMINI_API_KEY=
# ---- admin
# ADMIN_TOKEN=
# CORTEX_SECRET_KEY=
`;

let tmp, repo, home, envFile;

function run(args, { input, env = {} } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, CORTEXGATE_HOME: home, NO_COLOR: '1', CORTEXGATE_PORT: '', ...env },
    timeout: 30000
  });
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-'));
  repo = path.join(tmp, 'repo');
  home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(repo, 'services', 'gateway', 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'services', 'gateway', 'src', 'index.js'), '');
  fs.writeFileSync(path.join(repo, 'services', 'gateway', '.env.example'), EXAMPLE);
  envFile = path.join(repo, 'services', 'gateway', '.env');
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('help, version and unknown command exit codes', () => {
  const h = run(['help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /keys create <name>/);
  const v = run(['--version']);
  assert.equal(v.status, 0);
  assert.match(v.stdout, /^cortexgate \d+\.\d+\.\d+/);
  const u = run(['frobnicate']);
  assert.equal(u.status, 2);
  assert.match(u.stderr, /Unknown command/);
});

test('init --yes creates .env from the example, generates secrets, writes config', () => {
  const r = run(['init', '--yes', '--repo', repo, '--mode', 'node', '--port', '3015']);
  assert.equal(r.status, 0, r.stderr);
  const env = parseEnv(fs.readFileSync(envFile, 'utf8'));
  assert.match(env.ADMIN_TOKEN, /^[0-9a-f]{64}$/);
  assert.match(env.CORTEX_SECRET_KEY, /^[0-9a-f]{64}$/);
  assert.match(env.CORTEXGATE_BOOTSTRAP_KEY, /^cg-[A-Za-z0-9_-]{40}$/);
  // generated values are revealed exactly once, in this output
  assert.ok(r.stdout.includes(env.CORTEXGATE_BOOTSTRAP_KEY));
  assert.ok(r.stdout.includes(env.ADMIN_TOKEN));
  assert.ok(!r.stdout.includes(env.CORTEX_SECRET_KEY), 'encryption key is never printed');
  // comments preserved, ADMIN_TOKEN placed under its commented template line
  const text = fs.readFileSync(envFile, 'utf8');
  assert.match(text, /# ADMIN_TOKEN=\nADMIN_TOKEN=[0-9a-f]{64}\n# CORTEX_SECRET_KEY=\nCORTEX_SECRET_KEY=/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.deepEqual(cfg, { repoPath: repo, mode: 'node', port: 3015, url: 'http://localhost:3015' });
});

test('re-running init keeps existing secrets, makes no backup, prints nothing secret', () => {
  const before = fs.readFileSync(envFile, 'utf8');
  const r = run(['init', '--yes', '--repo', repo, '--mode', 'node', '--port', '3015']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(envFile, 'utf8'), before);
  const env = parseEnv(before);
  assert.ok(!r.stdout.includes(env.ADMIN_TOKEN));
  assert.ok(!r.stdout.includes(env.CORTEXGATE_BOOTSTRAP_KEY));
  assert.match(r.stdout, /Kept existing ADMIN_TOKEN, CORTEXGATE_BOOTSTRAP_KEY, CORTEX_SECRET_KEY/);
  assert.equal(fs.readdirSync(path.dirname(envFile)).filter(f => f.startsWith('.env.bak-')).length, 0);
});

test('interactive init over piped stdin: typed provider key is written, backup made, others untouched', () => {
  const before = parseEnv(fs.readFileSync(envFile, 'utf8'));
  // repo, mode, port, "add keys?", then one answer per provider prompt (only Groq typed)
  const answers = [repo, 'node', '3016', 'y', 'gsk_typed_value', '', '', '', '', '', '', '', '', '', ''].join('\n') + '\n';
  const r = run(['init'], { input: answers });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = parseEnv(fs.readFileSync(envFile, 'utf8'));
  assert.equal(after.GROQ_API_KEY, 'gsk_typed_value');
  assert.equal(after.GEMINI_API_KEY, '');
  assert.equal(after.ADMIN_TOKEN, before.ADMIN_TOKEN);
  assert.ok(!r.stdout.includes('gsk_typed_value'), 'typed secret not echoed');
  const backups = fs.readdirSync(path.dirname(envFile)).filter(f => f.startsWith('.env.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).port, 3016);
});

test('status/test against a fake gateway; unreachable gives a helpful error', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, admin: req.headers['x-admin-token'] });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', uptimeSec: 8040 }));
      if (req.url === '/v1/chat/providers') return res.end(JSON.stringify({ groq: { configured: true, enabled: true, state: 'healthy' }, cohere: { configured: false, enabled: false, state: 'unconfigured' } }));
      if (req.url === '/v1/chat/live') return res.end(JSON.stringify({ config: { routingPolicy: 'balanced', rateLimit: { redis: 'connected' } }, persistence: { mongodb: 'unavailable' } }));
      if (req.url === '/v1/admin/keys') return res.end(JSON.stringify({ keys: [], authMode: 'required' }));
      if (req.url === '/v1/chat/completions') {
        const b = JSON.parse(body);
        return res.end(JSON.stringify({ model: 'm', provider: 'groq', cost: 0, usage: { total_tokens: 3 }, choices: [{ message: { content: `echo:${b.messages[0].content}` } }], routing: { tier: 'light', policy: b.routing_policy || 'balanced' }, attempts: [{ provider: 'groq', outcome: 'ok', latencyMs: 5 }], cache: { hit: false } }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const runAsync = args => new Promise(resolve => {
    const child = spawn(process.execPath, [BIN, ...args, '--url', url, '--repo', repo], { env: { ...process.env, CORTEXGATE_HOME: home, NO_COLOR: '1' } });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    child.on('close', code => resolve({ code, stdout }));
  });
  try {
    const st = await runAsync(['status', '--docker']);
    assert.equal(st.code, 0);
    assert.match(st.stdout, /● running .*\(docker mode, up 2h 14m\)/);
    assert.match(st.stdout, /auth: required · policy: balanced · redis: connected · mongo: unavailable/);
    assert.match(st.stdout, /providers: 1 healthy · 0 disabled · 1 no key/);
    const env = parseEnv(fs.readFileSync(envFile, 'utf8'));
    assert.ok(seen.some(s => s.url === '/v1/admin/keys' && s.admin === env.ADMIN_TOKEN), 'admin token sent as header');

    const t = await runAsync(['test', 'hi there', '--policy', 'cost']);
    assert.equal(t.code, 0);
    assert.match(t.stdout, /echo:hi there/);
    assert.match(t.stdout, /provider groq .*tier light .*policy cost/);
    assert.ok(seen.some(s => s.url === '/v1/chat/completions' && s.auth === `Bearer ${env.CORTEXGATE_BOOTSTRAP_KEY}`));
  } finally {
    await new Promise(r => server.close(r));
  }
  const down = run(['status', '--url', url, '--repo', repo]);
  assert.equal(down.status, 1);
  assert.match(down.stdout, /● stopped/);
  assert.match(down.stdout, /Gateway not reachable on :\d+ .* run `cortexgate start`/);
  const t2 = run(['test', 'x', '--url', url, '--repo', repo]);
  assert.equal(t2.status, 1);
  assert.match(t2.stderr, /Gateway not reachable/);
});
