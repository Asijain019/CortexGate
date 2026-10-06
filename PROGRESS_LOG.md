# Progress Log

Chronological record of project changes, oldest first. For current behavior and setup, see [README.md](README.md).

## Sep 30

- Gateway skeleton and Groq adapter; `/v1/chat/completions` returns OpenAI-compatible responses.
- Fixed Groq model configuration for the account's non-standard model catalog; verified cost tracking.
- Added the Gemini provider adapter and made the chat route provider-agnostic.
- Added provider-chain failover for 5xx, 429, and timeout errors, with provider request logging.

## Oct 1

- Set Gemini's default chat model to `gemini-3.8-flash` after the then-tested account returned 404 for older model names.
- Added Gemini embeddings, optional `SEMANTIC_SIMILARITY` task type, and an offline mock embedder.
- Added semantic caching with cosine similarity, TTL, LRU eviction, system-prompt namespaces, and savings statistics.
- Added an in-memory request log and polling dashboard for cache rate, token/cost savings, provider failovers, and recent requests.
- Integrated cache lookup, response caching, request logging, `/v1/chat/stats`, `/v1/chat/live`, and `/dashboard`.
- Added the threshold-tuning script and documented cache configuration. Measured 100% paraphrase hits and 0 wrong hits at threshold 0.92 using `SEMANTIC_SIMILARITY`.
- Verified Groq and Gemini requests, cache hits, and cost tracking with live provider keys.
- Recorded known cache limitations: negated and time-sensitive prompts may be incorrectly served from cache.

## Oct 2

- Added cache-match verification for borderline semantic matches, disk persistence for cache/history, live `.env` reload, circuit breaking, and dashboard health/reset controls.
- Fixed Gemini token accounting for thinking tokens and added the Gemini 3.8 Flash pricing entry.
- Added MongoDB request logging and the `/v1/chat/summary` aggregation endpoint.

## Oct 6

- Tested semantic verification against similar-but-different prompts; incorrect matches were rejected and paraphrases were confirmed.
- Updated README documentation for the implemented API, configuration, limitations, and project layout.
- Persisted dashboard request history and hardened provider failure retries.
- Updated dashboard theme contrast on `main` (upstream commit `6a904cf`).
- Confirmed the configured Gemini API key is accepted and `gemini-3.8-flash` is available. A live chat request to it returned 503 due to high demand, while `gemini-3.5-flash` completed successfully.
- Added a one-time Gemini fallback-model attempt for 429/503 responses, configurable with `GEMINI_FALLBACK_MODEL`; stopped passing Groq-only model names when Groq's circuit is open and made 504 provider timeouts fail over without same-provider retries.
- Documented the main gateway files, current provider fallback behavior, and how to demo Groq-to-Gemini failover; added `npm test`.
- Clarified that dashboard API costs are list-price estimates rather than actual billing data, exposed estimated savings after verifier calls, and documented that embedding usage is not yet included.
- Added `PROJECT_SCOPE.md` to separate implemented midterm work from proposed post-midterm features; updated README planned features for provider expansion, complexity-aware routing, custom endpoints, quota controls, evaluation, and dashboard analytics.
