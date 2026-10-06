# CortexGate: Midterm Work and Post-Midterm Scope

This document separates the functionality implemented by the midterm from proposed work. Items in the future sections are plans, not claims about current gateway behavior. The project should aim to be a focused, self-hosted, cost- and quota-aware gateway; it should not claim to outperform LiteLLM across all use cases.

## Work completed by midterm

CortexGate currently provides:

- An Express gateway with an OpenAI-compatible `POST /v1/chat/completions` endpoint.
- Groq and Google Gemini chat provider adapters, configurable provider ordering, and failover on provider errors.
- A configurable Gemini chat-model fallback for overload/rate-limit responses.
- Gemini embedding-based semantic caching, with cosine-similarity matching, persistence, expiry, and bounded cache size.
- A model-based check for borderline cache matches, to reduce incorrect answer reuse.
- A circuit breaker, live `.env` reload, request history, and optional MongoDB logging.
- A polling dashboard for request activity, cache statistics, provider failovers, and token-based cost estimates.
- Automated tests for provider failover and Gemini model fallback.

Current limitations to keep visible in the demo:

- Dashboard costs are list-price estimates, not provider billing data or proof of actual charges.
- Gemini embedding requests are not yet included in the cost estimate.
- Cache matching is limited to single-turn requests and can still be risky for negated or time-sensitive questions.
- Provider keys and limits are configured through environment variables; there is no dashboard for adding custom providers.
- Routing follows configured provider order; it does not yet classify request complexity or select models by quality/cost.

## Proposed post-midterm implementation

The recommended implementation order keeps the project deliverable and builds on its current gateway.

### 1. Expand provider support

Keep the provider interface consistent and add a small, testable set of providers. Candidate APIs to investigate:

| Candidate | Why consider it | Important caveat |
|---|---|---|
| Mistral API | Hosted models and a documented free-mode option | Quotas and eligible models can vary by account and change over time. |
| Cloudflare Workers AI | Hosted inference with a published daily no-cost allocation | Uses Cloudflare-specific model IDs and Neurons; some models or usage may require paid billing. |
| Cohere API | Trial access and separate chat/embedding capabilities | Trial call and rate limits apply. |
| OpenRouter | One API to a catalog that includes models marked free | Free-model availability and request limits vary; models may be shared or change. |
| Hugging Face Inference Providers | Broad model choice behind a common API | Included credits are small and can change; routed providers have their own limits. |
| Ollama (local) | Local models can avoid hosted API charges and external quotas | Requires compatible hardware, disk space, and an available local model server. |

Gemini is already integrated. Groq is also integrated, but do not rely on it as a guaranteed free service without checking the account's current plan and limits. A short, expiring trial (for example, a credit offer that requires a payment method) should not be presented as an ongoing free tier. Confirm provider terms, key requirements, data handling, model availability, and quotas before selecting integrations. Free offers and rate limits change.

### 2. Add request-complexity and quality-aware routing

Estimate request needs (for example, simple lookup, summarization, coding, or multi-step reasoning), then route to an eligible lightweight or stronger model. Provide user policies such as **lowest estimated cost**, **balanced**, and **best available quality**, plus an explicit provider/model override. Consider a fallback or escalation when the first model fails or does not meet a configured quality check.

This classification is an estimate, not a guarantee. Keep routing explainable: record the selected provider/model and a concise reason, and test classification errors, latency, and cost impact. Avoid sending a request to a more expensive model solely because the prompt is long; length can be one signal, alongside task type and configured policy.

### 3. Add user-configured custom providers

Allow an administrator to add an OpenAI-compatible endpoint, provider label, model identifier, and optional pricing metadata from a dashboard settings page. Include a connection/test action, enable/disable controls, and routing-order selection. This supports a user's own purchased API account without requiring every service to have a first-party adapter.

Treat API keys as secrets: do not return them to the browser after saving, do not log them, and restrict who can manage them. Prefer environment variables or a documented local secrets store for an early prototype. If persistent dashboard-managed keys are implemented, require encryption at rest and authentication before exposing the feature. Never imply a custom provider is free; its owner is responsible for its billing.

### 4. Improve quota and request controls

- Add configurable per-provider/model rate and daily usage limits, with clear counters and reset times.
- Handle 429 responses using `Retry-After` when available, bounded exponential backoff, and provider failover.
- Add an optional bounded request queue to smooth bursts and define what happens when the queue is full.
- Use provider quota APIs only where officially supported; otherwise label tracked values as CortexGate-observed estimates rather than remaining provider quota.
- Keep concurrency and retry limits explicit so retries do not amplify an outage or consume a free allocation unexpectedly.

### 5. Improve cache correctness and cost accounting

- Track embedding, verification, and completion usage separately.
- Show estimated gross avoided cost and estimated net avoided cost, with exclusions clearly stated.
- Add cache exclusions or configurable bypass for time-sensitive, private, or otherwise unsuitable prompts.
- Add tests for negation, numeric changes, locations, dates, multi-turn conversations, and cache verification failures.
- Evaluate alternative embedding/cache backends only if the current bounded local cache becomes a measured bottleneck; Qdrant or pgvector can remain optional infrastructure.

### 6. Add provider evaluation and dashboard analytics

Build a repeatable prompt set and compare configured providers/models on answer quality, latency, errors, token use, and estimated price. Keep measured outcomes distinct from subjective quality judgments.

Useful dashboard additions:

- Provider/model request volume, success/error rate, latency percentiles, and 429/timeout trend.
- Provider health and circuit-breaker state, with recent failovers and retry counts.
- Configured limits and CortexGate-observed usage by provider, with reset-time information where known.
- Routing decisions: complexity/quality class, selected model, and reason.
- Cache funnel: lookup misses, trusted hits, verified hits, rejected matches, and verifier failures.
- Separate completion, verification, and embedding estimates; estimated net savings should identify what is excluded.
- Evaluation comparison for latency, reliability, quality rubric, and estimated price.
- Custom provider setup/test status, with secrets masked and never returned to the page.

## Suggested delivery phases

1. **Foundation:** add one additional hosted adapter and Ollama support behind the common provider interface; standardize provider errors, timeouts, model metadata, and tests.
2. **Smart control plane:** introduce complexity/quality routing policies, provider quotas and rate controls, explicit manual overrides, and decision logging.
3. **Cost/cache/evaluation:** account separately for chat, verifier, and embedding usage; add the benchmark set and cache correctness tests.
4. **Dashboard:** expose provider and cache analytics, routing decisions, and secure custom OpenAI-compatible endpoint configuration.

Deliver one phase at a time. Agree on the provider shortlist and hosting constraints before implementing integrations; no provider should be described as free without checking its current official terms.

## Stretch goals

- Agent or tool orchestration with bounded permissions and per-step provider/cost limits.
- Multi-user accounts, role-based access control, shared provider configurations, budgets, and alerts.
- A React/WebSocket dashboard or external vector database if usage justifies the added operational complexity.
- Deployment packaging and production hardening (authentication, secret management, audit logs, and operational monitoring).

These goals should follow the core routing, quota, security, and evaluation work rather than displacing it.
