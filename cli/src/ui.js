// Plain terminal output helpers: ANSI colours only when stdout is a TTY (respects NO_COLOR / FORCE_COLOR).
const useColor = () => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY);
};

const wrap = (open, close) => s => (useColor() ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39)
};

export const sym = {
  dot: '●',
  ok: '✓',
  warn: '!',
  fail: '✗',
  sep: '·'
};

export const out = (...lines) => { for (const l of lines) process.stdout.write(`${l}\n`); };
export const err = (...lines) => { for (const l of lines) process.stderr.write(`${l}\n`); };

export const okLine = msg => out(`  ${c.green(sym.ok)} ${msg}`);
export const warnLine = msg => out(`  ${c.yellow(sym.warn)} ${msg}`);
export const failLine = msg => out(`  ${c.red(sym.fail)} ${msg}`);

/** 8094s -> "2h 14m"; 45 -> "45s"; 90061 -> "1d 1h". */
export function formatDuration(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) return null;
  let s = Math.max(0, Math.floor(Number(sec)));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const visibleLength = s => String(s).replace(ANSI_RE, '').length;

/** Render rows (arrays of strings) as left-aligned columns. */
export function table(headers, rows) {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map(r => visibleLength(r[i] ?? ''))));
  const line = r => r.map((cell, i) => {
    const v = String(cell ?? '');
    return i === r.length - 1 ? v : v + ' '.repeat(widths[i] - visibleLength(v));
  }).join('  ');
  return [c.dim(line(headers)), ...rows.map(line)].join('\n');
}
