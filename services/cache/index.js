import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
let pipeline;
try {
  ({ pipeline } = require('@xenova/transformers'));
} catch (e) {
  const gatewayPath = path.resolve(fileURLToPath(import.meta.url), '../../gateway/node_modules/@xenova/transformers');
  ({ pipeline } = require(gatewayPath));
}

let embedderPromise = null;

// Initialize embedding pipeline (lazy loaded singleton)
function getEmbedder() {
  if (!embedderPromise) {
    console.log('[SemanticCache] Initializing local MiniLM embedding model...');
    embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedderPromise;
}

// Generate normalized vector embedding for prompt text
export async function getEmbedding(text) {
  const extractor = await getEmbedder();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// Cosine similarity between two normalized vectors
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
  }
  return dotProduct;
}

// In-memory cache store array
const cacheStore = [];

/**
 * Searches in-memory cache for prompt similarity above threshold.
 * Threshold defaults to process.env.CACHE_SIMILARITY_THRESHOLD or 0.92
 */
export async function checkCache(promptText) {
  const threshold = parseFloat(process.env.CACHE_SIMILARITY_THRESHOLD || '0.92');
  const embedding = await getEmbedding(promptText);

  let bestMatch = null;
  let highestSimilarity = 0;

  for (const entry of cacheStore) {
    const similarity = cosineSimilarity(embedding, entry.embedding);
    if (similarity > highestSimilarity) {
      highestSimilarity = similarity;
      bestMatch = entry;
    }
  }

  if (bestMatch && highestSimilarity >= threshold) {
    const avoidedTokens = bestMatch.usage?.total_tokens || 0;
    const avoidedCost = bestMatch.cost || 0;
    console.log(
      `[Cache HIT] Similarity: ${highestSimilarity.toFixed(4)} >= ${threshold} | ` +
      `Avoided tokens: ${avoidedTokens} | Cost saved: $${avoidedCost.toFixed(6)}`
    );

    return {
      hit: true,
      similarity: highestSimilarity,
      entry: bestMatch,
      embedding
    };
  }

  console.log(
    `[Cache MISS] Max similarity: ${highestSimilarity.toFixed(4)} < ${threshold}`
  );

  return {
    hit: false,
    similarity: highestSimilarity,
    embedding
  };
}

/**
 * Adds prompt, response, embedding and metadata to in-memory cache
 */
export function setCache({ promptText, embedding, responseContent, usage, provider, model, cost }) {
  cacheStore.push({
    prompt: promptText,
    embedding,
    responseContent,
    usage,
    provider,
    model,
    cost,
    timestamp: new Date().toISOString()
  });
  console.log(`[Cache STORE] Cached prompt ("${promptText.slice(0, 30)}...") [Total cached: ${cacheStore.length}]`);
}

/**
 * Utility to extract user prompt string from OpenAI messages array
 */
export function extractPromptText(messages) {
  if (!Array.isArray(messages)) return '';
  const userMessages = messages.filter(m => m.role === 'user');
  if (userMessages.length === 0) return '';
  return userMessages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
}
