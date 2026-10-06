// Tiny JSON-file persistence so the cache and request history survive restarts.
// Files live in services/gateway/data/ (git-ignored). Replaced by MongoDB later.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = process.env.DATA_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

const getters = new Map();
const timers = new Map();
const fileFor = name => path.join(DIR, `${name}.json`);

export function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeNow(name, getter) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${fileFor(name)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(getter()));
    fs.renameSync(tmp, fileFor(name));
  } catch (err) {
    console.warn(`[Persist] Could not write ${name}: ${err.message}`);
  }
}

// Debounced save: many quick changes become one write.
export function save(name, getter, delayMs = 700) {
  getters.set(name, getter);
  clearTimeout(timers.get(name));
  timers.set(name, setTimeout(() => {
    timers.delete(name);
    getters.delete(name);
    writeNow(name, getter);
  }, delayMs));
}

export function flushAll() {
  for (const [name, getter] of getters) {
    clearTimeout(timers.get(name));
    writeNow(name, getter);
  }
  getters.clear();
  timers.clear();
}

process.on('exit', flushAll);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { flushAll(); process.exit(0); });
}
