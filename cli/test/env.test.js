import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv, mergeEnv, mergeEnvFile, backupFile, formatValue } from '../src/env.js';

const SAMPLE = `PORT=3003

# ---- providers
# Groq key goes here
GROQ_API_KEY=
GEMINI_API_KEY=existing-gemini   # inline comment
OPENROUTER_API_KEY="quoted value"

# ---- admin
# ADMIN_TOKEN=
# CORTEX_SECRET_KEY=
`;

test('parseEnv handles empty, inline comments, quotes, commented lines', () => {
  const env = parseEnv(SAMPLE);
  assert.equal(env.PORT, '3003');
  assert.equal(env.GROQ_API_KEY, '');
  assert.equal(env.GEMINI_API_KEY, 'existing-gemini');
  assert.equal(env.OPENROUTER_API_KEY, 'quoted value');
  assert.equal('ADMIN_TOKEN' in env, false);
});

test('merge fills empty keys in place, keeps existing values, preserves comments and order', () => {
  const { text, changed, kept } = mergeEnv(SAMPLE, { GROQ_API_KEY: 'gsk_new', GEMINI_API_KEY: 'should-not-win' });
  assert.deepEqual(changed, ['GROQ_API_KEY']);
  assert.deepEqual(kept, ['GEMINI_API_KEY']);
  const lines = text.split('\n');
  assert.equal(lines[3], '# Groq key goes here');
  assert.equal(lines[4], 'GROQ_API_KEY=gsk_new');
  assert.match(text, /GEMINI_API_KEY=existing-gemini {3}# inline comment/);
  // everything except the filled line is byte-identical
  assert.equal(text.replace('GROQ_API_KEY=gsk_new', 'GROQ_API_KEY='), SAMPLE);
});

test('explicit overwrite replaces an existing value', () => {
  const { text, changed } = mergeEnv(SAMPLE, { GEMINI_API_KEY: 'typed-by-user' }, { overwrite: ['GEMINI_API_KEY'] });
  assert.deepEqual(changed, ['GEMINI_API_KEY']);
  assert.match(text, /^GEMINI_API_KEY=typed-by-user$/m);
  assert.doesNotMatch(text, /existing-gemini/);
});

test('commented-out keys get an assignment right below the comment; unknown keys are appended', () => {
  const { text } = mergeEnv(SAMPLE, { ADMIN_TOKEN: 'a'.repeat(64), NEW_KEY: 'x' });
  const lines = text.split('\n');
  const i = lines.indexOf('# ADMIN_TOKEN=');
  assert.equal(lines[i + 1], `ADMIN_TOKEN=${'a'.repeat(64)}`);
  assert.equal(lines[i + 2], '# CORTEX_SECRET_KEY=');
  assert.match(text, /added by cortexgate init\nNEW_KEY=x\n$/);
});

test('CRLF files stay CRLF; undefined values ignored; values with spaces quoted', () => {
  const crlf = 'A=1\r\n# c\r\nB=\r\n';
  const { text } = mergeEnv(crlf, { B: 'two words', C: undefined });
  assert.equal(text, 'A=1\r\n# c\r\nB="two words"\r\n');
  assert.equal(formatValue('plain-Value_1'), 'plain-Value_1');
  assert.equal(formatValue('has#hash'), '"has#hash"');
});

test('mergeEnvFile backs up first, never overwrites, and is a no-op when nothing changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, SAMPLE);
  const r1 = mergeEnvFile(file, { GROQ_API_KEY: 'gsk_x', GEMINI_API_KEY: 'nope' }, { now: new Date(2026, 0, 2, 3, 4, 5) });
  assert.equal(r1.written, true);
  assert.equal(path.basename(r1.backup), '.env.bak-20260102-030405');
  assert.equal(fs.readFileSync(r1.backup, 'utf8'), SAMPLE);
  const after = parseEnv(fs.readFileSync(file, 'utf8'));
  assert.equal(after.GROQ_API_KEY, 'gsk_x');
  assert.equal(after.GEMINI_API_KEY, 'existing-gemini');

  const r2 = mergeEnvFile(file, { GROQ_API_KEY: 'different' });
  assert.equal(r2.written, false);
  assert.equal(r2.backup, null);
  assert.equal(parseEnv(fs.readFileSync(file, 'utf8')).GROQ_API_KEY, 'gsk_x');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mergeEnvFile creates .env from a template without a backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-env-'));
  const tpl = path.join(dir, '.env.example');
  fs.writeFileSync(tpl, SAMPLE);
  const file = path.join(dir, '.env');
  const r = mergeEnvFile(file, { ADMIN_TOKEN: 't' }, { templateFile: tpl });
  assert.equal(r.created, true);
  assert.equal(r.backup, null);
  assert.equal(parseEnv(fs.readFileSync(file, 'utf8')).ADMIN_TOKEN, 't');
  assert.equal(fs.readFileSync(tpl, 'utf8'), SAMPLE, 'template untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backupFile picks a unique name when one exists for the same second', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'A=1\n');
  const now = new Date(2026, 5, 1, 12, 0, 0);
  const b1 = backupFile(file, now);
  const b2 = backupFile(file, now);
  assert.notEqual(b1, b2);
  assert.ok(fs.existsSync(b1) && fs.existsSync(b2));
  assert.equal(backupFile(path.join(dir, 'missing')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
