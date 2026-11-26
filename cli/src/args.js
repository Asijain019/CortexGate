// Tiny argv parser (no dependencies).
//   parseArgs(['keys', 'create', 'ci', '--rpm', '60', '-f', '--no-worker', '--port=3015'], spec)
//   -> { _: ['keys', 'create', 'ci'], rpm: '60', f: true, worker: false, port: '3015' }
// spec.boolean: flags that never take a value. spec.alias: { short: long }.
// Unknown flags followed by a non-flag token take it as their value, except booleans.
// '--' ends flag parsing.

export function parseArgs(argv, spec = {}) {
  const booleans = new Set(spec.boolean || []);
  const alias = spec.alias || {};
  const out = { _: [] };
  const set = (rawKey, value) => {
    const key = alias[rawKey] || rawKey;
    out[toCamel(key)] = value;
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith('--') && tok.length > 2) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (body.startsWith('no-') && !booleans.has(body)) {
        set(body.slice(3), false);
        continue;
      }
      const key = alias[body] || body;
      const next = argv[i + 1];
      if (!booleans.has(key) && next !== undefined && !isFlag(next)) {
        set(body, next);
        i++;
      } else {
        set(body, true);
      }
      continue;
    }
    if (tok.startsWith('-') && tok.length > 1 && !/^-\d/.test(tok)) {
      const letters = tok.slice(1);
      if (letters.length > 1) {
        // -fy -> f, y (all boolean)
        for (const ch of letters) set(ch, true);
        continue;
      }
      const key = alias[letters] || letters;
      const next = argv[i + 1];
      if (!booleans.has(key) && next !== undefined && !isFlag(next)) {
        set(letters, next);
        i++;
      } else {
        set(letters, true);
      }
      continue;
    }
    out._.push(tok);
  }
  return out;
}

function isFlag(tok) {
  return tok.startsWith('-') && tok.length > 1 && !/^-\d/.test(tok);
}

export function toCamel(s) {
  return s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** Parse an integer flag; throws a friendly error for junk. */
export function intFlag(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw usageError(`--${name} must be an integer between ${min} and ${max} (got '${value}')`);
  }
  return n;
}

export function numberFlag(value, name, { min = 0 } = {}) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw usageError(`--${name} must be a number >= ${min} (got '${value}')`);
  return n;
}

export function usageError(message) {
  const err = new Error(message);
  err.exitCode = 2;
  return err;
}
