// .env reading and comment/order-preserving merge.
import fs from 'node:fs';
import path from 'node:path';

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const COMMENTED_RE = /^\s*#\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function unquote(raw) {
  let v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
    const q = v[0];
    v = v.slice(1, -1);
    if (q === '"') v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    return v;
  }
  // strip inline comment ( value # comment )
  const hash = v.search(/\s#/);
  if (hash !== -1) v = v.slice(0, hash).trim();
  return v;
}

/** Parse .env text into a plain object (the last assignment of a key wins, as with dotenv.parse). */
export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    out[m[1]] = unquote(m[2]);
  }
  return out;
}

export function readEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function formatValue(value) {
  const v = String(value);
  if (v === '') return '';
  if (/[\s#"'\\]/.test(v)) return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return v;
}

/**
 * Merge `updates` into .env text without disturbing comments, blank lines or ordering.
 *  - key present with a non-empty value: kept, unless the key is in `overwrite`
 *  - key present but empty (KEY=): value filled in place
 *  - key only present commented out (# KEY=...): uncommented assignment inserted right below it
 *  - key absent: appended at the end under a marker comment
 * Undefined / null update values are ignored.
 * Returns { text, changed: [keys written], kept: [keys left as they were] }.
 */
export function mergeEnv(text, updates, { overwrite = [], header = '# ---------------------------------------------------------------- added by cortexgate init' } = {}) {
  const src = String(text ?? '');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src === '' ? [] : src.split(/\r?\n/);
  const hadTrailingNewline = src === '' || /\r?\n$/.test(src);
  if (hadTrailingNewline && lines.length && lines[lines.length - 1] === '') lines.pop();
  const force = new Set(overwrite);
  const changed = [];
  const kept = [];
  const appended = [];

  for (const [key, rawValue] of Object.entries(updates)) {
    if (rawValue === undefined || rawValue === null) continue;
    const value = String(rawValue);
    const idx = lines.findLastIndex(l => LINE_RE.exec(l)?.[1] === key);
    if (idx !== -1) {
      const current = unquote(LINE_RE.exec(lines[idx])[2]);
      if (current !== '' && !force.has(key)) {
        kept.push(key);
        continue;
      }
      if (current === value) {
        kept.push(key);
        continue;
      }
      const prefix = /^\s*export\s+/.test(lines[idx]) ? 'export ' : '';
      lines[idx] = `${prefix}${key}=${formatValue(value)}`;
      changed.push(key);
      continue;
    }
    const commented = lines.findIndex(l => COMMENTED_RE.exec(l)?.[1] === key);
    if (commented !== -1) {
      lines.splice(commented + 1, 0, `${key}=${formatValue(value)}`);
      changed.push(key);
      continue;
    }
    appended.push(`${key}=${formatValue(value)}`);
    changed.push(key);
  }

  if (appended.length) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    if (header) lines.push(header);
    lines.push(...appended);
  }
  const out = lines.join(eol) + (lines.length ? eol : '');
  return { text: out, changed, kept };
}

export function timestamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Copy file to <file>.bak-<timestamp> (unique). Returns backup path or null when the file does not exist. */
export function backupFile(file, now = new Date()) {
  if (!fs.existsSync(file)) return null;
  let target = `${file}.bak-${timestamp(now)}`;
  let n = 1;
  while (fs.existsSync(target)) target = `${file}.bak-${timestamp(now)}-${n++}`;
  fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
  try { fs.chmodSync(target, 0o600); } catch { /* windows */ }
  return target;
}

/**
 * Merge updates into an .env file on disk. Creates it from `templateFile` (e.g. .env.example) when absent.
 * Always backs up an existing file first. Writes atomically.
 */
export function mergeEnvFile(file, updates, { overwrite = [], templateFile, now } = {}) {
  let base = '';
  let created = false;
  if (fs.existsSync(file)) {
    base = fs.readFileSync(file, 'utf8');
  } else {
    created = true;
    if (templateFile && fs.existsSync(templateFile)) base = fs.readFileSync(templateFile, 'utf8');
  }
  const result = mergeEnv(base, updates, { overwrite });
  if (!created && result.changed.length === 0) return { ...result, backup: null, created, written: false };
  const backup = created ? null : backupFile(file, now);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, result.text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { ...result, backup, created, written: true };
}
