## Progress Log

- Sep 30 - Gateway skeleton + Groq adapter working, /v1/chat/completions returns OpenAI-compatible responses
- Fixed Groq model config — account has a non-standard model catalog, gpt-oss-20b now in use, cost tracking verified against a live request.
- Sep 30 - Gemini provider adapter added, chat route updated to be provider-agnostic
- Sep 30 - Failover logic added to chat route with automatic retry on 5xx/429/timeout and provider logging
- Oct 1 - Updated default Gemini model to gemini-3.8-flash (gemini-1.5-flash and 2.5-flash return 404 on new keys)
- Oct 1 - Embedding module added for semantic cache (Gemini embedding API, optional SEMANTIC_SIMILARITY task type, offline mock embedder for tests)
- Oct 1 - In-memory semantic cache added: cosine similarity, TTL, LRU eviction, per-system-prompt namespaces, savings stats
- Oct 1 - In-memory request log added (provider, cache hit/miss, latency, cost, failovers) to feed the dashboard
