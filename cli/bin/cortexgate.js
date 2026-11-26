#!/usr/bin/env node
import { main } from '../src/main.js';

main(process.argv.slice(2)).then(
  code => { process.exitCode = typeof code === 'number' ? code : 0; },
  err => {
    process.stderr.write(`cortexgate: ${err?.message || err}\n`);
    if (process.env.CORTEXGATE_DEBUG && err?.stack) process.stderr.write(`${err.stack}\n`);
    process.exitCode = typeof err?.exitCode === 'number' ? err.exitCode : 1;
  }
);
