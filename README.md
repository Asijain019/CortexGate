# CortexGate

**An AI gateway and cost-optimization platform for LLM applications.**

CortexGate is a self-hosted gateway that sits between an application and multiple Large Language Model (LLM) providers. The application talks to one OpenAI-compatible endpoint, and CortexGate applies a control plane to every request: semantic caching, provider failover, and cost tracking.

> **Status: mid-term prototype.** The core request path (gateway, two providers, failover, semantic cache, live dashboard) works end to end. Features marked *Planned* below are part of the project design but not yet built. See [PROGRESS_LOG.md](PROGRESS_LOG.md) for the day-by-day record.

*Major Project (PR1107), Institute of Engineering and Technology (IET), JK Lakshmipat University.*

## Why CortexGate

Applications that call LLM APIs run into three recurring problems:

1. **Rising token costs.** The same question, asked in different words, is billed in full every time because exact-match caching cannot detect rewordings.
2. **Poor load handling.** One API key on one provider returns HTTP 429 or times out under load, and the application shows the user a hard error.
3. **No visibility or control.** Teams cannot see what was spent, by which feature, or which provider is degraded.

CortexGate addresses these by inserting a gateway between the application and the providers, so routing, caching, failover and cost accounting are done once, in one place.

## Features

| Feature | Status |
|---|---|
| OpenAI-compatible endpoint (`/v1/chat/completions`) | Implemented |
| Provider adapters: Groq, Gemini | Implemented |
| Automatic failover on 5xx, 429 and timeout | Implemented |
| Semantic cache (embeddings + cosine similarity, in-memory) | Implemented |
| Per-request cost calculation and savings tracking | Implemented |
| Live dashboard (polling) with hit rate, tokens and cost saved, recent requests | Implemented |
| MongoDB request logging with actual vs counterfactual cost | Planned (next) |
| Vector database for the cache (Qdrant / pgvector) | Planned |
| Token-bucket rate limiting with priority queue (Redis, BullMQ) | Planned |
| Model cascading with quality verification and escalation | Planned |
| Free-tier-aware quota scheduler | Planned |
| React + WebSocket dashboard, budgets and alerts | Planned |

## How it works

```mermaid
flowchart TD
    A[Client application] --> B[API Gateway<br/>POST /v1/chat/completions]
    B --> C{Semantic cache<br/>similarity >= 0.92?}
    C -- hit --> H[Return cached answer<br/>cost = 0]
    C -- miss --> D[Provider chain]
    D --> E[Groq]
    E -- error / 429 / timeout --> F[Gemini]
    E -- success --> G[Store answer in cache]
    F --> G
    G --> I[Response to client]
    H --> J[Request log]
    I --> J
    J --> K[Dashboard<br/>/dashboard]
```

1. The gateway embeds the prompt with the Gemini embedding API.
2. It compares the embedding with cached prompts using cosine similarity. At or above the threshold (default 0.92), the stored answer is returned with no provider call and the avoided cost is recorded.
3. On a miss, the request goes to the first provider in the chain. If that provider fails with a retryable error, the next provider is tried automatically.
4. Successful answers are stored in the cache, and every request is written to the request log that feeds the dashboard.

## Tech stack

- **Runtime:** Node.js (18+), Express
- **LLM providers:** Groq, Google Gemini (REST APIs, free tiers)
- **Embeddings:** Gemini embedding API (`gemini-embedding-001`, task type `SEMANTIC_SIMILARITY`)
- **Cache store:** in-memory vector list (Qdrant / pgvector planned)
- **Dashboard:** plain HTML + JavaScript, polling
- **Planned:** MongoDB, Redis, BullMQ, React

## Project structure

```
CortexGate/
├── README.md
├── PROGRESS_LOG.md
└── services/gateway/
    ├── package.json
    ├── .env.example
    ├── public/
    │   └── dashboard.html          # live dashboard
    ├── scripts/
    │   └── tune-threshold.mjs      # similarity threshold evaluation
    └── src/
        ├── index.js                # Express app, /health, /dashboard
        ├── routes/chat.js          # completions route, cache + failover logic
        ├── providers/              # groq.js, gemini.js, index.js (provider chain)
        ├── cache/                  # embedder.js, semanticCache.js
        └── stats/requestLog.js     # in-memory request log
```

## Getting started

### Prerequisites

- Node.js 18 or newer
- A free Groq API key: https://console.groq.com/keys
- A free Gemini API key: https://aistudio.google.com/apikey

### Install and run

```bash
git clone https://github.com/Rakshikagarg/CortexGate.git
cd CortexGate/services/gateway
npm install
cp .env.example .env     # then add your API keys
npm start
```

The gateway listens on `http://localhost:3000`. Open `http://localhost:3000/dashboard` for the live view.

### Try it

```bash
# First request goes to a provider
curl -s localhost:3000/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What is the capital of France?"}]}'

# Same question in different words is served from the cache
curl -s localhost:3000/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Which city is the capital of France?"}]}'
```

The second response has `"provider": "cache"`, `"cost": 0`, and a `cache` block with the similarity score and the cost and tokens saved.

## API

| Method | Path | Description |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI-style chat completion through the gateway |
| GET | `/v1/chat/stats` | Cache statistics: requests, hits, misses, hit rate, tokens and cost saved |
| GET | `/v1/chat/live` | Statistics plus the most recent requests (used by the dashboard) |
| GET | `/dashboard` | Live dashboard page |
| GET | `/health` | Health check |

**Request headers**

- `x-cache: bypass` skips the cache for this request.
- `x-provider: groq | gemini` (or `"provider"` in the body) tries that provider first; the others remain as failover.

**Response additions.** On top of the standard OpenAI fields, responses include `provider` (`groq`, `gemini` or `cache`), `cost` (USD) and a `cache` object.

## Configuration

Set in `services/gateway/.env` (see `.env.example`).

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Gateway port |
| `GROQ_API_KEY` | none | Groq API key |
| `GROQ_MODEL` | `openai/gpt-oss-20b` | Groq model |
| `GEMINI_API_KEY` | none | Gemini API key (also used for embeddings) |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Gemini chat model |
| `PROVIDER_ORDER` | `groq,gemini` | Failover order |
| `EMBEDDING_PROVIDER` | `gemini` | `gemini`, or `mock` for offline tests |
| `EMBEDDING_MODEL` | `gemini-embedding-001` | Embedding model |
| `EMBEDDING_TASK_TYPE` | `SEMANTIC_SIMILARITY` | Embedding task type; the 0.92 threshold was measured with this setting |
| `CACHE_THRESHOLD` | `0.92` | Minimum cosine similarity for a cache hit |
| `CACHE_TTL_MS` | `3600000` | Cache entry lifetime (1 hour) |
| `CACHE_MAX_ENTRIES` | `500` | Maximum cache entries (least-recently-used eviction) |

Never commit `.env`; it holds your API keys.

## Evaluation: choosing the cache threshold

The default of 0.92 was measured, not assumed. `scripts/tune-threshold.mjs` embeds 8 paraphrase pairs (should hit) and 8 different-meaning pairs (must miss, for example "capital of France" vs "capital of Italy") and reports hit rate against wrong hits.

With default embeddings the two groups overlapped (best safe threshold 0.85 gave only 25% paraphrase hits). Using the `SEMANTIC_SIMILARITY` task type separated them: paraphrases scored 0.942 to 0.992, different questions 0.829 to 0.911.

| Threshold | Paraphrase hits | Wrong hits |
|---|---|---|
| 0.85 | 8/8 | 6/8 |
| 0.88 | 8/8 | 6/8 |
| 0.90 | 8/8 | 1/8 |
| **0.92** | **8/8** | **0/8** |
| 0.95 | 6/8 | 0/8 |

Reproduce with `node scripts/tune-threshold.mjs` from `services/gateway`. The sample is small (16 pairs) and a larger set is planned.

## Known limitations

- The cache and request log are in memory and reset on restart (MongoDB and a vector database are planned).
- Only single-turn prompts are cached, since a multi-turn answer depends on earlier messages.
- "Cost saved" is a counterfactual at list price; free-tier calls cost nothing in practice.
- Gemini token accounting currently undercounts hidden reasoning tokens, so Gemini costs are understated until the adapter is fixed.

## Roadmap

1. MongoDB request logging with actual vs counterfactual cost
2. Fix Gemini token counting and pricing table
3. Vector database (Qdrant / pgvector) for the cache
4. Rate limiting and priority queueing (Redis, BullMQ)
5. Model cascading with verification and escalation
6. Free-tier-aware quota scheduler
7. React + WebSocket dashboard with budgets and alerts

## Team

| Name | Roll no. |
|---|---|
| Asi Jain | 2023btech019 |
| Dhruv Purohit | 2023btech025 |
| Rakshika Garg | 2023btech064 |

**Faculty guide:** Dr. Pranab Roy

## Contributing

Work on a feature branch, never directly on `main`. Add one line to [PROGRESS_LOG.md](PROGRESS_LOG.md) with each commit, and never commit `.env` or API keys.
