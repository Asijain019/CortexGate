import { MongoClient } from 'mongodb';

let client = null;
let db = null;
let connectionPromise = null;

async function getDb() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/cortexgate';
  if (db) return db;
  if (!connectionPromise) {
    connectionPromise = (async () => {
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
      await client.connect();
      // Target cortexgate database explicitly
      db = client.db('cortexgate');
      console.log(`[MongoDB] Connected successfully to ${uri} (database: cortexgate)`);
      return db;
    })().catch(err => {
      connectionPromise = null;
      throw err;
    });
  }
  return connectionPromise;
}

/**
 * Asynchronous fire-and-forget helper to store a request record in MongoDB.
 * Never throws or blocks main request execution.
 */
export async function logRequestToMongo(entry) {
  try {
    const database = await getDb();
    const collection = database.collection('requests');

    const doc = {
      ts: entry.ts || new Date().toISOString(),
      prompt: entry.prompt || '',
      provider: entry.provider || 'unknown',
      cacheHit: Boolean(entry.cacheHit || entry.cache),
      similarity: typeof entry.similarity === 'number' ? entry.similarity : null,
      tokens: entry.tokens || entry.savedTokens || 0,
      actualCost: entry.actualCost ?? ((entry.cost || 0) + (entry.verifyCost || 0)),
      counterfactualCost: entry.counterfactualCost || (entry.cache ? entry.savedCost : entry.cost) || 0,
      savedCost: entry.savedCost || 0,
      latencyMs: entry.latencyMs || 0,
      failedProviders: entry.failedProviders || [],
      status: entry.status || 200,
      created_at: new Date()
    };

    await collection.insertOne(doc);
  } catch (err) {
    // Non-blocking catch — Mongo logger failure must never crash or block requests
    console.warn(`[MongoDB Logger Warning] Failed to log request: ${err.message}`);
  }
}

/**
 * Returns aggregated summary statistics surviving server restarts.
 */
export async function getMongoSummary() {
  try {
    const database = await getDb();
    const collection = database.collection('requests');

    const pipeline = [
      {
        $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          actualCost: { $sum: '$actualCost' },
          counterfactualCost: { $sum: '$counterfactualCost' },
          savedCost: { $sum: '$savedCost' },
          totalTokens: { $sum: '$tokens' },
          cacheHits: {
            $sum: { $cond: ['$cacheHit', 1, 0] }
          },
          cacheMisses: {
            $sum: { $cond: ['$cacheHit', 0, 1] }
          }
        }
      }
    ];

    const results = await collection.aggregate(pipeline).toArray();
    if (results.length === 0) {
      return {
        totalRequests: 0,
        actualCost: 0,
        counterfactualCost: 0,
        savedCost: 0,
        totalTokens: 0,
        cacheHits: 0,
        cacheMisses: 0,
        hitRate: 0
      };
    }

    const res = results[0];
    return {
      totalRequests: res.totalRequests || 0,
      actualCost: res.actualCost || 0,
      counterfactualCost: res.counterfactualCost || 0,
      savedCost: res.savedCost || 0,
      totalTokens: res.totalTokens || 0,
      cacheHits: res.cacheHits || 0,
      cacheMisses: res.cacheMisses || 0,
      hitRate: res.totalRequests ? (res.cacheHits / res.totalRequests) : 0
    };
  } catch (err) {
    console.warn(`[MongoDB Summary Error] ${err.message}`);
    return {
      error: `MongoDB unreachable: ${err.message}`,
      totalRequests: 0,
      actualCost: 0,
      counterfactualCost: 0,
      savedCost: 0
    };
  }
}
