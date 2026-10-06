import { MongoClient } from 'mongodb';

let client = null;
let db = null;
let connectionPromise = null;
let connectionRetryAt = 0;
let connectionError = null;

async function getDb() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/cortexgate';
  if (db) return db;
  if (Date.now() < connectionRetryAt) throw connectionError;
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
      connectionError = err;
      connectionRetryAt = Date.now() + 5000;
      throw err;
    });
  }
  return connectionPromise;
}

/**
 * Asynchronous helper to store a request record in MongoDB.
 * Never throws if MongoDB is unavailable; the request log keeps local history
 * as a fallback and exposes the persistence status to the dashboard.
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
      verified: entry.verified === true,
      verification: entry.verification || null,
      nearSimilarity: typeof entry.nearSimilarity === 'number' ? entry.nearSimilarity : null,
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
    return { persisted: true };
  } catch (err) {
    // Mongo logger failure must never crash the gateway or lose local history.
    console.warn(`[MongoDB Logger Warning] Failed to log request: ${err.message}`);
    return { persisted: false, error: err.message };
  }
}

/**
 * Read the dashboard history from MongoDB so a page reload reflects stored rows.
 * Throws on connection errors; the API can then report that it used local history.
 */
export async function getMongoRecent(limit = 200) {
  const database = await getDb();
  const collection = database.collection('requests');
  const docs = await collection.find({})
    .sort({ created_at: -1, _id: -1 })
    .limit(limit)
    .toArray();

  return docs.map(doc => ({
    time: doc.ts || doc.created_at?.toISOString?.() || '',
    prompt: doc.prompt || '',
    provider: doc.provider || 'unknown',
    cache: Boolean(doc.cacheHit),
    similarity: typeof doc.similarity === 'number' ? doc.similarity : null,
    verified: doc.verified === true,
    verification: doc.verification || null,
    nearSimilarity: typeof doc.nearSimilarity === 'number' ? doc.nearSimilarity : null,
    tokens: doc.tokens || 0,
    cost: doc.actualCost || 0,
    savedCost: doc.savedCost || 0,
    latencyMs: doc.latencyMs || 0,
    failedProviders: doc.failedProviders || [],
    status: doc.status || 'ok'
  }));
}

/** Clear request history when the user explicitly resets demo data. */
export async function clearMongoRequests() {
  const database = await getDb();
  const result = await database.collection('requests').deleteMany({});
  return result.deletedCount || 0;
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
