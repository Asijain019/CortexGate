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

## Nov 26

- Merged upstream provider integrations and queued rate limiting (`5ef058d`). Fixed the `redis`/`bullmq` dependency conflict, made the gateway start without Redis, read `REDIS_URL` everywhere, and added `DNS_SERVERS` for MongoDB Atlas SRV lookups on Windows.
- Live-tested every provider key: Groq, NVIDIA, OpenRouter and Gemini (`3.5-flash-lite`) work; Mistral key expired (401), SambaNova needs billing (402), Hugging Face needs credits (402), GitHub Models returns plain-text "OK" for every request.
- Diagnosed the Gemini errors: embeddings were healthy (40 concurrent calls, all 200); Gemini chat models returned `503 high demand` or timed out, and one search could trigger up to four Gemini calls. Added an embedding memo and cooldown, light-tier cache verification, and a Gemini fallback-model list.
- Cache: time-sensitive bypass, negation and number guards, embedding cost accounting, `netSaved = costSaved − verifyCost − embedCost`, hit rate over cacheable lookups only, default threshold aligned to 0.92.
- Cache TTL by question type (factual 7 d, code 3 d, general 24 h, creative 6 h), fixed expiry that hits never extend, background sweep, 1 000-entry LRU cap, Float32 vectors in memory and base64 on disk.
- Smart routing: task classification, input/output token estimation, quality floors per tier, context-window checks, expected-cost estimates, and cost/balanced/quality policies with per-request overrides.
- Capacity-aware dispatch: per-provider in-flight caps and rolling RPM/TPM budgets, load penalty, least-loaded selection with round robin for ties, 2.5 s bounded capacity queue, policy-controlled quality downgrades, `503 CAPACITY_EXHAUSTED` with `Retry-After`.
- Bounded failover: 10 s fixed per-attempt timeout, at most 3 attempts, 25 s request budget, 429 cooldowns using `Retry-After`, auth/billing/bad-response disabling persisted across restarts, active health checks every 60 s. A heavy request that took five attempts and 28 s now completes in one attempt (~6.7 s).
- Added providers: Ollama (local, Docker service), LM Studio (local), Cerebras, Cloudflare Workers AI, Cohere and Together, plus user-defined OpenAI-compatible providers with presets.
- Dashboard-managed API keys encrypted with AES-256-GCM, admin API restricted to localhost or `ADMIN_TOKEN`, key hints only.
- Analytics API (`/v1/analytics`): time series, p50/p95/p99 latency, error types, per-provider and per-model usage, tier/task/policy usage, failover chains and cache funnel. MongoDB now stores routing decisions and attempt chains.
- Rebuilt the dashboard as a multi-page console (overview, analytics, providers, routing, logs, playground, settings) with WebSocket live updates.
- Test suite expanded from 5 to 119 tests; updated README, PROJECT_SCOPE and `.env.example`.
- Client API keys (`cg-…`): SHA-256-hashed storage, one-time reveal, per-key RPM/TPM limits (Redis), spend budgets, expiry, enable/disable, provider and policy restrictions (failover stays inside the allowed set), per-key usage in analytics, OpenAI SDK compatible (`Authorization: Bearer`). Auth modes `auto` / `required` / `off`; monitoring routes and WebSocket protected by localhost or `ADMIN_TOKEN`; `CORTEXGATE_BOOTSTRAP_KEY` for the first key. Dashboard API keys section and playground key field.
- Docker deployment: gateway image (Node 24 Alpine, non-root, health check), compose services gateway, worker, Redis, Ollama and optional MongoDB, `gateway_data` volume, localhost-only binding by default, `CLIENT_AUTH=required`. Added `docs/DEPLOY.md` (VPS with Caddy/Nginx TLS, Render, Railway, Fly.io).
- `cortexgate` CLI (no dependencies): `init` (merges `.env` with backup, generates admin token, encryption key and first client key), `start`/`stop`/`restart` in Docker or background Node mode, `status`, `logs`, `open`, `keys create/list/enable/disable/revoke`, `test`, `doctor`.
- Verified live in Docker with `CLIENT_AUTH=required`: no key / wrong key → 401, bootstrap key → served by groq, monitoring without admin token → 401, new key with 2 RPM → 200, 200, 429; `cortexgate keys list` showed per-key usage. Cloudflare key name alias `CLOUDFLARE_API_KEY` accepted. Tests: 132 gateway + 39 CLI.
