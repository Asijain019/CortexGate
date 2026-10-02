# Progress Log

Chronological record of what has been built. One line per change, newest at the bottom.
For project documentation, see [README.md](README.md).

- Sep 30 - Gateway skeleton + Groq adapter working, /v1/chat/completions returns OpenAI-compatible responses
- Sep 30 - Fixed Groq model config — account has a non-standard model catalog, gpt-oss-20b now in use, cost tracking verified against a live request.
- Sep 30 - Gemini provider adapter added, chat route updated to be provider-agnostic
- Sep 30 - Failover logic added to chat route with automatic retry on 5xx/429/timeout and provider logging
- Oct 1 - Updated default Gemini model to gemini-3.8-flash (gemini-1.5-flash and 2.5-flash return 404 on new keys)
- Oct 1 - Embedding module added for semantic cache (Gemini embedding API, optional SEMANTIC_SIMILARITY task type, offline mock embedder for tests)
- Oct 1 - In-memory semantic cache added: cosine similarity, TTL, LRU eviction, per-system-prompt namespaces, savings stats
- Oct 1 - In-memory request log added (provider, cache hit/miss, latency, cost, failovers) to feed the dashboard
- Oct 1 - Polling dashboard added: hit rate, tokens and cost saved, spend, failover tags, recent requests, built-in prompt tester
- Oct 1 - Gateway checks semantic cache before provider dispatch (hits return provider 'cache' at zero cost), logs every request, exposes GET /v1/chat/stats and /v1/chat/live, serves /dashboard. Verified live: paraphrase served from cache at similarity 0.992, different question correctly missed
- Oct 1 - Threshold tuning script added: measures paraphrase hit rate vs wrong-hit rate across similarity thresholds
- Oct 1 - Cache settings documented in .env.example (embedding model, task type, threshold 0.92)
- Oct 1 - Threshold tuning on 16 pairs (8 paraphrase, 8 different): default embeddings overlapped (tau=0.85 gave 25% hits), SEMANTIC_SIMILARITY task type gave 100% paraphrase hits with 0 wrong hits at tau=0.92
- Oct 1 - Verified both providers live with real keys (Groq gpt-oss-20b, Gemini 3.8 flash); cost tracking confirmed on real requests
- Oct 1 - Known issues: Gemini usage undercounts thinking tokens (cost understated) and gemini-3.8-flash is missing from the pricing table; fix pending in providers/gemini.js
- Oct 1 - Cache verified end to end with live embeddings: paraphrase hit at similarity 0.992 (saved 119 tokens), 'capital of Italy' correctly missed
- Oct 2 - Fixed gemini.js: default model set to gemini-3.8-flash, added pricing entry, and corrected token calculation to account for hidden thinking tokens.
- Oct 2 - Added MongoDB request logger (mongoLogger.js) with non-blocking fire-and-forget logging and GET /v1/chat/summary aggregation endpoint.
