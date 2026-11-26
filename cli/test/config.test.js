import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeDir, paths, readConfig, writeConfig, resolveSettings, isRepo, findRepoUpwards } from '../src/config.js';

let tmp;
let fakeRepo;
const saved = {};
const VARS = ['CORTEXGATE_HOME', 'CORTEXGATE_PORT', 'CORTEXGATE_URL', 'CORTEXGATE_REPO'];

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-home-'));
  for (const v of VARS) { saved[v] = process.env[v]; delete process.env[v]; }
  process.env.CORTEXGATE_HOME = path.join(tmp, 'home');
  fakeRepo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(fakeRepo, 'services', 'gateway', 'src'), { recursive: true });
  fs.writeFileSync(path.join(fakeRepo, 'services', 'gateway', 'src', 'index.js'), '');
});

after(() => {
  for (const v of VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('CORTEXGATE_HOME overrides ~/.cortexgate', () => {
  assert.equal(homeDir(), path.join(tmp, 'home'));
  assert.equal(paths().config, path.join(tmp, 'home', 'config.json'));
  assert.equal(homeDir({}), path.join(os.homedir(), '.cortexgate'));
});

test('missing config reads as {}; write then read round-trips with key order', () => {
  assert.deepEqual(readConfig(), {});
  const file = writeConfig({ url: 'http://localhost:3015', port: 3015, mode: 'node', repoPath: fakeRepo });
  const raw = fs.readFileSync(file, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(raw)), ['repoPath', 'mode', 'port', 'url']);
  assert.deepEqual(readConfig(), { repoPath: fakeRepo, mode: 'node', port: 3015, url: 'http://localhost:3015' });
});

test('corrupt config gives a clear error', () => {
  fs.writeFileSync(paths().config, '{nope');
  assert.throws(() => readConfig(), /Cannot read .*config\.json/);
  writeConfig({ repoPath: fakeRepo, mode: 'node', port: 3015, url: 'http://localhost:3015' });
});

test('resolveSettings precedence: flags > env > config', () => {
  let s = resolveSettings({}, process.env, tmp);
  assert.equal(s.port, 3015);
  assert.equal(s.url, 'http://localhost:3015');
  assert.equal(s.repoPath, fakeRepo);
  assert.equal(s.mode, 'node');

  s = resolveSettings({ port: '3020', docker: true }, process.env, tmp);
  assert.equal(s.port, 3020);
  assert.equal(s.url, 'http://localhost:3020', 'port flag must not keep the config url');
  assert.equal(s.mode, 'docker');

  s = resolveSettings({}, { ...process.env, CORTEXGATE_URL: 'http://10.0.0.5:9000/' }, tmp);
  assert.equal(s.url, 'http://10.0.0.5:9000');

  assert.throws(() => resolveSettings({ port: '99999' }, process.env, tmp), /Invalid port/);
  assert.throws(() => resolveSettings({ mode: 'k8s' }, process.env, tmp), /Unknown mode/);
});

test('repo detection walks upwards', () => {
  assert.ok(isRepo(fakeRepo));
  const deep = path.join(fakeRepo, 'services', 'gateway', 'src');
  assert.equal(findRepoUpwards(deep), fakeRepo);
  assert.equal(isRepo(tmp), false);
});
