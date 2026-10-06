// Reloads .env while the server runs, so you can add or remove an API key
// without restarting. (PORT changes still need a restart.)
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

export function watchEnv(onReload) {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;

  let known = new Set(Object.keys(dotenv.parse(fs.readFileSync(file))));

  fs.watchFile(file, { interval: 1000 }, () => {
    try {
      const parsed = dotenv.parse(fs.readFileSync(file));
      const changed = [];
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] !== v) { process.env[k] = v; changed.push(k); }
      }
      for (const k of known) {
        if (!(k in parsed)) { delete process.env[k]; changed.push(k); }
      }
      known = new Set(Object.keys(parsed));
      if (changed.length) {
        console.log(`[Env] .env reloaded, changed: ${changed.join(', ')}`);
        onReload(changed);
      }
    } catch (err) {
      console.warn(`[Env] Could not reload .env: ${err.message}`);
    }
  });
}
