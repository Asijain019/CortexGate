// Measures cosine similarity for paraphrase pairs (should HIT) and
// different-meaning pairs (should MISS), then prints a precision/hit-rate table.
// Uses only the embedding API - no chat provider calls. Run from services/gateway:
//   node scripts/tune-threshold.mjs
import 'dotenv/config';
import { embedWithInfo, getEmbedderState } from '../src/cache/embedder.js';
import { cosineSimilarity, sameNumbers, hasNegation } from '../src/cache/semanticCache.js';

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
let apiCalls = 0;
// embedWithInfo memoizes exact text, so each distinct sentence is embedded once.
async function vec(text) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const info = await embedWithInfo(text);
      if (info.apiCall) { apiCalls++; await sleep(300); } // be gentle with free-tier rate limits
      return info.vector;
    } catch (e) {
      if (['EMBED_RATE_LIMITED', 'EMBED_COOLDOWN', 'EMBED_TIMEOUT'].includes(e.code) && attempt < 3) {
        const until = getEmbedderState().cooldownUntil;
        const wait = until ? Math.max(1000, Date.parse(until) - Date.now()) : 5000;
        console.log(`  ${e.code}, waiting ${Math.round(wait / 1000)}s...`);
        await sleep(wait);
        continue;
      }
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
const thresholds = [0.70, 0.75, 0.80, 0.85, 0.88, 0.90, 0.92, 0.95, 0.985];
for (const t of thresholds) {
  const tp = same.filter(r => r.sim >= t).length;
  const fp = diff.filter(r => r.sim >= t).length;
  const prec = tp + fp ? (tp / (tp + fp)) * 100 : 100;
  console.log(`   ${t.toFixed(2)}   |   ${String(tp).padStart(2)}/${same.length} (${((tp / same.length) * 100).toFixed(0).padStart(3)}%)        |   ${String(fp).padStart(2)}/${diff.length} wrong                       |  ${prec.toFixed(0)}%`);
}
// Pairs that embeddings cannot tell apart; the cache's rule-based guards handle them.
const GUARDED = [
  ['Convert 10 miles to km', 'Convert 20 miles to km'],
  ['Is placement good in JKLU?', 'Is placement not good in JKLU?'],
  ['Foods that contain gluten', 'Foods without gluten']
];
console.log('\nGUARDED PAIRS (similarity / numeric guard / negation guard):');
for (const r of await score(GUARDED)) {
  const numeric = sameNumbers(r.a, r.b) ? 'same numbers' : 'NUMBERS DIFFER -> miss';
  const neg = hasNegation(r.a) !== hasNegation(r.b) ? 'NEGATION MISMATCH -> verify/miss' : 'no negation mismatch';
  console.log(`  ${r.sim.toFixed(3)}  "${r.a}" <-> "${r.b}"  [${numeric}; ${neg}]`);
}
console.log(`\nEmbedding API calls made: ${apiCalls} (memoized repeats excluded)`);
console.log('Pick the highest threshold that still gives a good hit rate with 0 wrong hits (default CACHE_THRESHOLD=0.92).');
