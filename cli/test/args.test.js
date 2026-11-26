import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, intFlag, numberFlag } from '../src/args.js';
import { ARG_SPEC } from '../src/main.js';

test('positional args and long flags with values', () => {
  const a = parseArgs(['keys', 'create', 'ci-bot', '--rpm', '60', '--budget=2.5'], ARG_SPEC);
  assert.deepEqual(a._, ['keys', 'create', 'ci-bot']);
  assert.equal(a.rpm, '60');
  assert.equal(a.budget, '2.5');
});

test('boolean flags never swallow the next token', () => {
  const a = parseArgs(['test', '--json', 'What is 2+2?'], ARG_SPEC);
  assert.equal(a.json, true);
  assert.deepEqual(a._, ['test', 'What is 2+2?']);
  const b = parseArgs(['init', '--yes', '--mode', 'node', '--port', '3015'], ARG_SPEC);
  assert.equal(b.yes, true);
  assert.equal(b.mode, 'node');
  assert.equal(b.port, '3015');
});

test('--no-x negation, short aliases and grouped shorts', () => {
  const a = parseArgs(['start', '--no-worker', '--node'], ARG_SPEC);
  assert.equal(a.worker, false);
  assert.equal(a.node, true);
  const b = parseArgs(['logs', '-f', '-n', '20', '--worker'], ARG_SPEC);
  assert.equal(b.follow, true);
  assert.equal(b.lines, '20');
  assert.equal(b.worker, true);
  const c = parseArgs(['keys', 'revoke', 'k1', '-fy'], ARG_SPEC);
  assert.equal(c.follow, true);
  assert.equal(c.yes, true);
});

test('-- ends flag parsing; negative numbers are values', () => {
  const a = parseArgs(['test', '--', '--not-a-flag'], ARG_SPEC);
  assert.deepEqual(a._, ['test', '--not-a-flag']);
  const b = parseArgs(['x', '--offset', '-5'], ARG_SPEC);
  assert.equal(b.offset, '-5');
});

test('kebab-case flags become camelCase', () => {
  assert.equal(parseArgs(['--api-key-name', 'x']).apiKeyName, 'x');
});

test('trailing value-less flag is true', () => {
  assert.equal(parseArgs(['keys', 'create', 'x', '--expires']).expires, true);
});

test('intFlag / numberFlag validate', () => {
  assert.equal(intFlag('60', 'rpm', { min: 1 }), 60);
  assert.equal(intFlag(undefined, 'rpm'), undefined);
  assert.throws(() => intFlag('6.5', 'rpm'), /--rpm must be an integer/);
  assert.throws(() => intFlag('0', 'rpm', { min: 1 }), e => e.exitCode === 2);
  assert.equal(numberFlag('2.5', 'budget'), 2.5);
  assert.throws(() => numberFlag('-1', 'budget'), /--budget/);
});
