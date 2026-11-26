# Deploying CortexGate

The gateway ships as one Docker image (`services/gateway/Dockerfile`, `node:24-alpine`,
runs as the non-root `node` user, listens on container port **3003**, state in **/data**).
The same image runs the BullMQ worker (`node src/workers/requestWorker.js`).

## 1. Local / single host with Docker Compose

```bash
cp services/gateway/.env.example services/gateway/.env   # then fill in provider keys
# or: cortexgate init   (CLI writes ADMIN_TOKEN, CORTEX_SECRET_KEY, CORTEXGATE_BOOTSTRAP_KEY)
docker compose up -d --build            # gateway + worker + redis + ollama
docker compose ps                       # gateway should become "healthy"
curl http://127.0.0.1:3003/health
```

| Service   | Container            | Notes |
|-----------|----------------------|-------|
| `gateway` | `cortexgate_gateway` | Published on `${CORTEXGATE_BIND:-127.0.0.1}:${CORTEXGATE_PORT:-3003}`; healthcheck `wget /health`; waits for redis healthy |
| `worker`  | `cortexgate_worker`  | Same image, processes the rate-limit queue |
| `redis`   | `cortexgate_redis`   | `redis:7`, host port 6380, volume `redis_data`, healthcheck `redis-cli ping` |
| `ollama`  | `cortexgate_ollama`  | Local free model; `docker exec cortexgate_ollama ollama pull qwen2.5:0.5b` |
| `mongo`   | `cortexgate_mongo`   | Only with `docker compose --profile mongo up -d`; set `MONGODB_URI=mongodb://mongo:27017/cortexgate` in `.env` |

Volumes: `gateway_data` (cache, request history, provider health/stats, encrypted provider
keys, client keys, `.secret`), `redis_data`, `ollama_data`, `mongo_data`. The compose project
name is the folder name (`cortexgate`), so the volumes are `cortexgate_*`; run compose from the
repo root (or pass `-p cortexgate`) to keep using them.

Compose forces the container-network addresses, whatever `.env` says:
`REDIS_URL=redis://redis:6379`, `OLLAMA_BASE_URL=http://ollama:11434/v1`, `DATA_DIR=/data`,
`PORT=3003`, `NODE_ENV=production`, `CLIENT_AUTH=${CLIENT_AUTH:-required}`.
Everything else comes from `services/gateway/.env` via `env_file` (never baked into the image:
`.env*` and `data/` are in `.dockerignore`). `.env` hot-reload does not apply inside the
container; run `docker compose up -d` (recreates the container) after editing `.env`.

Upgrading from the old redis/ollama-only compose file: the first `docker compose up -d`
recreates `cortexgate_redis` once (a healthcheck was added). Its data volume is kept.

Useful variants:

```bash
CORTEXGATE_PORT=3013 docker compose up -d gateway worker   # other host port
docker compose logs -f gateway
docker compose stop gateway worker
```

### Authentication inside Docker (important)

Requests from the host reach the container from the Docker bridge IP, **not loopback**, so:

- Client calls (`/v1/chat/*`, `/v1/models`) need a client key: `Authorization: Bearer cg-...`
  (or `x-api-key`). Set `CORTEXGATE_BOOTSTRAP_KEY=cg-...` in `.env` to have a first key
  imported on startup, then create more on the dashboard or with `cortexgate keys create`.
- The dashboard's admin/monitoring APIs need **`ADMIN_TOKEN`** set in `.env`; enter it in the
  dashboard (sent as `x-admin-token`, and as `?token=` for the WebSocket). Without it the
  dashboard page loads but its data panels and key management are refused.

### Exposing the port: `CORTEXGATE_BIND=0.0.0.0`

By default the port is published on `127.0.0.1` only. `CORTEXGATE_BIND=0.0.0.0` publishes it on
every interface (Docker-published ports bypass ufw/firewalld rules). **Only do this with
`CLIENT_AUTH=required` and a long random `ADMIN_TOKEN`**, preferably still behind a TLS reverse
proxy. Never expose with `CLIENT_AUTH=off` or `auto`: anyone could spend your provider quota.

## 2. VPS (Ubuntu/Debian) with TLS via a reverse proxy

1. Install Docker Engine + the compose plugin, clone the repo, create `services/gateway/.env`
   (`chmod 600`).
2. Keep the default `CORTEXGATE_BIND=127.0.0.1` and run `docker compose up -d --build`.
3. Point DNS (`gateway.example.com`) at the VPS and terminate TLS on the host.

**Caddy** (automatic Let's Encrypt), `/etc/caddy/Caddyfile`:

```caddy
gateway.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:3003
}
```

WebSockets (`/ws/metrics`) and streamed responses work through `reverse_proxy` unchanged.

**Nginx** + certbot (`certbot --nginx -d gateway.example.com`):

```nginx
server {
    server_name gateway.example.com;
    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;       # /ws/metrics
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;                          # streamed completions
        proxy_read_timeout 120s;
    }
    listen 443 ssl;   # managed by certbot
}
```

Behind a proxy every request comes from the proxy, so treat everything as remote: keep
`CLIENT_AUTH=required` and use `ADMIN_TOKEN` for the dashboard. Open only 80/443 in the
firewall. Ollama on a small VPS is CPU-only and slow (the first request after start also pays a
model load); drop the `ollama` service and unset `OLLAMA_BASE_URL` if you only use hosted
providers. Back up the `cortexgate_gateway_data` volume: it holds the client-key hashes and the
encrypted provider keys.

## 3. PaaS (Render / Railway / Fly.io)

These run a single container from `services/gateway/Dockerfile`; there is no compose, so
provide Redis (and optionally MongoDB) as managed add-ons and set env vars in the platform UI.
They terminate TLS and route traffic from their edge (never loopback), so
`CLIENT_AUTH=required` + `ADMIN_TOKEN` are mandatory. Ollama is normally unavailable; leave
`OLLAMA_BASE_URL` unset.

- **Render**: New Web Service, runtime Docker, root directory `services/gateway`. The app reads
  `PORT` (Render injects it; or set `PORT=3003`). Health check path `/health`. Add a persistent
  disk mounted at `/data` (paid plans), otherwise file state resets on each deploy. Redis:
  Render Key Value, copy its URL to `REDIS_URL`. Worker: a Background Worker from the same repo
  with start command `node src/workers/requestWorker.js`.
- **Railway**: New service from the repo, root directory `services/gateway` (Dockerfile is
  detected). Add the Redis plugin and set `REDIS_URL` to its reference variable; add a volume
  mounted at `/data`. Railway injects `PORT`, which the app honours. Duplicate the service for
  the worker with the start command above.
- **Fly.io**: `fly launch --dockerfile services/gateway/Dockerfile --no-deploy`, then in
  `fly.toml` set `internal_port = 3003`, an http check on `/health`, and a mount
  `source = "cortexgate_data"`, `destination = "/data"` (`fly volumes create cortexgate_data`).
  Redis: `fly redis create` (Upstash), set `REDIS_URL`. Secrets: `fly secrets set ADMIN_TOKEN=...`.
  Run the worker as a second process group (`worker = "node src/workers/requestWorker.js"`).

Non-root note: the image runs as uid 1000 (`node`). If a platform mounts the volume as root,
make `/data` writable for uid 1000.

## 4. Environment reference

Set in `services/gateway/.env` (Compose) or in the platform's env settings. Never commit it.

| Variable | Purpose |
|----------|---------|
| `CLIENT_AUTH` | `required` (Docker default) / `auto` (key needed except from loopback) / `off` |
| `ADMIN_TOKEN` | Admin/dashboard API token (`x-admin-token`); required for remote admin |
| `CORTEXGATE_BOOTSTRAP_KEY` | `cg-...` client key imported (hashed) on startup if absent |
| `CORTEX_SECRET_KEY` | Master key for encrypting dashboard-added provider keys; set it explicitly in production (otherwise one is generated into `/data/.secret`) |
| `PORT` | Listen port (container: 3003) |
| `DATA_DIR` | State directory (container: `/data`) |
| `REDIS_URL` | Redis for rate limiting and the queue (Compose: `redis://redis:6379`) |
| `MONGODB_URI` | Request-log store (Atlas `mongodb+srv://...` or `mongodb://mongo:27017/cortexgate`) |
| `DNS_SERVERS` | Optional resolvers for Atlas SRV lookups, e.g. `8.8.8.8,1.1.1.1` |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | Local Ollama (Compose: `http://ollama:11434/v1`) |
| `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `SAMBANOVA_API_KEY`, `MISTRAL_API_KEY`, `HUGGINGFACE_API_KEY`, `GITHUB_TOKEN`, `CLOUDFLARE_API_KEY`, `OPENAI_API_KEY` (+ matching `*_MODEL`) | Provider credentials; see `.env.example` |
| `PROVIDER_ORDER`, `CACHE_THRESHOLD`, `EMBEDDING_MODEL`, ... | Routing / cache tuning; see `.env.example` |

Compose-only variables (shell or a repo-root `.env`, not the gateway `.env`):
`CORTEXGATE_PORT` (host port, default 3003), `CORTEXGATE_BIND` (host interface, default
`127.0.0.1`), `CLIENT_AUTH` (overrides the compose default `required`).
