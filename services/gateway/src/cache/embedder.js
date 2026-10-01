import fetch from 'node-fetch';

// EMBEDDING_PROVIDER=gemini (default) | mock (offline testing only)
const EMBEDDING_MODEL = () => process.env.EMBEDDING_MODEL || 'gemini-embedding-001';

// Cheap offline embedder: hashed bag-of-words. Only matches prompts that share
// words, so it is NOT truly semantic. Use it for tests / when offline.
function mockEmbed(text, dims = 256) {
  const vec = new Array(dims).fill(0);
  const stop = new Set(['the', 'a', 'an', 'is', 'of', 'what', 'which', 'to', 'in', 'and', 'for']);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !stop.has(w));
  for (const w of words) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    vec[h % dims] += 1;
  }
  return vec;
}

async function geminiEmbed(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY is not configured (needed for embeddings)');
    err.status = 500;
    throw err;
  }
  const model = EMBEDDING_MODEL().replace(/^models\//, '');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: { parts: [{ text }] },
      ...(process.env.EMBEDDING_TASK_TYPE ? { taskType: process.env.EMBEDDING_TASK_TYPE } : {})
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    const err = new Error(`Embedding API error (status ${response.status})`);
    err.status = response.status;
    throw err;
  }
  const data = await response.json();
  const values = data.embedding?.values;
  if (!values) throw new Error('Embedding API returned no vector');
  return values;
}

export async function embed(text) {
  if ((process.env.EMBEDDING_PROVIDER || 'gemini') === 'mock') return mockEmbed(text);
  return geminiEmbed(text);
}
