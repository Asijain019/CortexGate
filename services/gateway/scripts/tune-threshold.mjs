// Measures cosine similarity for paraphrase pairs (should HIT) and
// different-meaning pairs (should MISS), then prints a precision/hit-rate table.
// Uses only the embedding API - no chat provider calls. Run from services/gateway:
//   node scripts/tune-threshold.mjs
import 'dotenv/config';
import { embed } from '../src/cache/embedder.js';
import { cosineSimilarity } from '../src/cache/semanticCache.js';

const SAME = [
  ['What is the capital of France?', 'Which city is the capital of France?'],
  ['How do I reset my password?', 'I forgot my password, how can I change it?'],
  ['Explain what a REST API is', 'Can you describe what REST APIs are?'],
  ['How many days are in a leap year?', 'Number of days in a leap year?'],
  ['Give me tips to sleep better', 'How can I improve my sleep quality?'],
  ['What is machine learning?', 'Define machine learning for me'],
  ['How do I install Node.js on Windows?', 'Steps to set up Node.js on a Windows PC'],
  ['Who wrote Romeo and Juliet?', 'Which author is behind Romeo and Juliet?']
];
const DIFFERENT = [
  ['What is the capital of France?', 'What is the capital of Italy?'],
  ['How do I reset my password?', 'How do I reset my router?'],
  ['Explain what a REST API is', 'Explain what a GraphQL API is'],
  ['How many days are in a leap year?', 'How many days are in a week?'],
  ['What is machine learning?', 'What is machine code?'],
  ['Who wrote Romeo and Juliet?', 'Who wrote Hamlet?'],
  ['Give me tips to sleep better', 'Give me tips to study better'],
  ['How do I install Node.js on Windows?', 'How do I install Python on Linux?']
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const memo = new Map();
async function vec(text) {
  if (memo.has(text)) return memo.get(text);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const v = await embed(text);
      memo.set(text, v);
      await sleep(600); // be gentle with free-tier rate limits
      return v;
    } catch (e) {
      if (e.status === 429 && attempt < 2) { console.log('  rate limited, waiting 20s...'); await sleep(20000); continue; }
      throw e;
    }
  }
}

async function score(pairs) {
  const out = [];
  for (const [a, b] of pairs) out.push({ a, b, sim: cosineSimilarity(await vec(a), await vec(b)) });
  return out;
}

const same = await score(SAME);
const diff = await score(DIFFERENT);

const show = (title, rows) => {
  console.log(`\n${title}`);
  for (const r of rows) console.log(`  ${r.sim.toFixed(3)}  "${r.a}"  <->  "${r.b}"`);
};
show('PARAPHRASES (should be cache HITS):', same);
show('DIFFERENT QUESTIONS (should be cache MISSES):', diff);

console.log('\nThreshold | hit rate on paraphrases | wrong hits on different questions | precision');
console.log('----------|-------------------------|-----------------------------------|----------');
const thresholds = [0.70, 0.75, 0.80, 0.85, 0.88, 0.90, 0.92, 0.95];
for (const t of thresholds) {
  const tp = same.filter(r => r.sim >= t).length;
  const fp = diff.filter(r => r.sim >= t).length;
  const prec = tp + fp ? (tp / (tp + fp)) * 100 : 100;
  console.log(`   ${t.toFixed(2)}   |   ${String(tp).padStart(2)}/${same.length} (${((tp / same.length) * 100).toFixed(0).padStart(3)}%)        |   ${String(fp).padStart(2)}/${diff.length} wrong                       |  ${prec.toFixed(0)}%`);
}
console.log('\nPick the highest threshold that still gives a good hit rate with 0 wrong hits.');
