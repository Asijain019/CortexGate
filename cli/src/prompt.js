// Interactive prompts: visible questions via readline, secrets via raw-mode masking.
// When stdin is not a TTY (piped input, CI), lines are read from a shared buffer and
// secrets are read the same way (nothing is echoed because there is no terminal echo).
import readline from 'node:readline';

let pipeReader = null;

function getPipeReader(input) {
  if (pipeReader) return pipeReader;
  const queue = [];
  const waiters = [];
  let ended = false;
  let buf = '';
  input.setEncoding('utf8');
  input.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (waiters.length) waiters.shift()(line); else queue.push(line);
    }
  });
  input.on('end', () => {
    ended = true;
    if (buf) { if (waiters.length) waiters.shift()(buf); else queue.push(buf); buf = ''; }
    while (waiters.length) waiters.shift()(null);
  });
  pipeReader = {
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (ended) return Promise.resolve(null);
      return new Promise(r => waiters.push(r));
    },
    close() { input.pause(); }
  };
  return pipeReader;
}

export function closePrompts(input = process.stdin) {
  if (pipeReader) { pipeReader.close(); pipeReader = null; }
  try { input.pause(); } catch { /* ignore */ }
}

/** Ask a visible question. Returns the trimmed answer or `def` when empty / input ended. */
export async function ask(question, { def = '', input = process.stdin, output = process.stdout } = {}) {
  const label = def !== '' && def !== undefined ? `${question} [${def}]: ` : `${question}: `;
  if (!input.isTTY) {
    output.write(label);
    const line = await getPipeReader(input).next();
    output.write('\n');
    const v = (line ?? '').trim();
    return v === '' ? String(def ?? '') : v;
  }
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    const answer = await new Promise(resolve => rl.question(label, resolve));
    const v = String(answer).trim();
    return v === '' ? String(def ?? '') : v;
  } finally {
    rl.close();
  }
}

export async function askYesNo(question, { def = true, ...opts } = {}) {
  const hint = def ? 'Y/n' : 'y/N';
  for (;;) {
    const a = (await ask(`${question} (${hint})`, { ...opts, def: '' })).toLowerCase();
    if (a === '') return def;
    if (['y', 'yes'].includes(a)) return true;
    if (['n', 'no'].includes(a)) return false;
  }
}

export async function askChoice(question, choices, { def, ...opts } = {}) {
  for (;;) {
    const a = (await ask(`${question} (${choices.join('/')})`, { ...opts, def })).toLowerCase();
    if (choices.includes(a)) return a;
    (opts.output || process.stdout).write(`  please answer one of: ${choices.join(', ')}\n`);
  }
}

/**
 * Read a secret without echoing it. In a TTY, characters are shown as '*'.
 * Supports Backspace, Ctrl+U (clear), Enter; Ctrl+C aborts the process (exit 130).
 */
export async function askSecret(question, { input = process.stdin, output = process.stdout } = {}) {
  const label = `${question}: `;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    output.write(label);
    const line = await getPipeReader(input).next();
    output.write('\n');
    return (line ?? '').trim();
  }
  output.write(label);
  return new Promise(resolve => {
    let value = '';
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    const finish = result => {
      input.removeListener('data', onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write('\n');
      resolve(result);
    };
    const onData = chunk => {
      // Pasted text arrives as one chunk; handle char by char. Ignore escape sequences (arrows).
      const s = String(chunk).replace(/\x1b\[[0-9;]*[A-Za-z~]/g, '').replace(/\x1b\[200~|\x1b\[201~/g, '');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') return finish(value.trim());
        if (ch === '\u0003') { // Ctrl+C
          input.setRawMode(Boolean(wasRaw));
          output.write('\n');
          process.exit(130);
        }
        if (ch === '\u0004') return finish(value.trim()); // Ctrl+D
        if (ch === '\u0015') { // Ctrl+U
          output.write('\b \b'.repeat(value.length));
          value = '';
          continue;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
        output.write('*');
      }
    };
    input.on('data', onData);
  });
}
