# cortexgate CLI

Set up, run and manage a CortexGate gateway from the terminal. It has no runtime dependencies (Node built-ins only) and needs Node 18 or newer. It works on Windows (PowerShell, Git Bash), macOS and Linux.

## Install

From a clone of the repo:

```bash
npm install -g ./cli        # global install from the repo root
# or, for development (edits take effect immediately):
cd cli && npm link
```

Check it:

```bash
cortexgate version
cortexgate doctor
```

You can also run it without installing: `node cli/bin/cortexgate.js <command>`.

## Quick start

```bash
cortexgate init                    # repo, mode (docker|node), port, provider keys, secrets
cortexgate start                   # docker compose up -d, or node src/index.js + worker
cortexgate status
cortexgate test "What is 2+2?"
cortexgate keys create my-app --rpm 60 --budget 5
cortexgate open                    # dashboard
```

## Commands

| Command | What it does |
|---|---|
| `init [--yes] [--mode docker\|node] [--port N] [--repo PATH] [--no-keys]` | Interactive setup. Finds the repo (cwd, then the checkout the CLI lives in, or asks). Asks for the run mode, the port and provider API keys (hidden input). Generates `ADMIN_TOKEN`, `CORTEX_SECRET_KEY` and `CORTEXGATE_BOOTSTRAP_KEY` (a `cg-…` client key) into `services/gateway/.env`. Writes `~/.cortexgate/config.json`. Prints the new client key and admin token **once**. `--yes` runs without prompts. |
| `start [--docker\|--node] [--no-worker] [--build]` | **docker:** runs `docker compose up -d` in the repo, with `CORTEXGATE_PORT` set to the configured port. **node:** starts `node src/index.js` detached, plus the worker when Redis is reachable. Logs go to `~/.cortexgate/logs/*.log` and pids to `~/.cortexgate/run/*.pid`. Then waits for `/health`. |
| `stop [--docker\|--node] [--all]` | **docker:** `docker compose stop gateway worker` (redis and ollama keep running); `--all` runs `docker compose down`, which keeps volumes. **node:** kills the processes this CLI started (`taskkill /T /F` on Windows, SIGTERM then SIGKILL elsewhere). A gateway the CLI did not start is never touched. |
| `restart` | `stop` + `start` in the configured mode. |
| `status [--json]` | Health, URL, mode, uptime, client-auth mode, routing policy, redis/mongo state and a provider summary. Exits 1 when the gateway is down. |
| `logs [-f] [--worker] [-n N]` | Gateway (or worker) logs: `docker compose logs`, or the node-mode log files. `-f` follows them. |
| `open` | Opens `<url>/dashboard` in the default browser. |
| `keys list [--json]` | Lists client keys: id, name, hint, status, usage, spend/budget, limits, last used. |
| `keys create <name> [--rpm N] [--tpm N] [--budget USD] [--expires ISO] [--providers a,b]` | Creates a client key and prints it **once**. |
| `keys disable <id\|name>` / `keys enable <id\|name>` | Turns a key off or back on. |
| `keys revoke <id\|name> [--yes]` | Deletes a key. It asks for confirmation; in a non-interactive shell it needs `--yes`. |
| `test "<prompt>" [--policy cost\|balanced\|quality] [--provider NAME] [--no-cache] [--json]` | Sends one chat completion and prints the answer, then provider, model, tier, task, policy, the attempt trail, latency, tokens, cost and cache result. |
| `doctor` | Checks Node, the config, the repo and its `node_modules`, `.env` (key names only, never values), Docker and Compose, the port, Redis, Ollama, MongoDB and gateway health. Exits 1 on a hard problem. |
| `version`, `help` | |

### Global options

- `--repo PATH`: the CortexGate checkout.
- `--port N`, `--url URL`: where the gateway listens.
- `--docker` / `--node`: override the configured mode.
- `--key cg-…`: the client key for `test`.

## Where settings come from

Settings are resolved in this order: **flags, then environment, then `~/.cortexgate/config.json`, then detection, then defaults.**

| Setting | Sources |
|---|---|
| Config dir | `CORTEXGATE_HOME` (default `~/.cortexgate`). It holds `config.json`, `logs/` and `run/`. |
| Repo | `--repo`, `CORTEXGATE_REPO`, `config.repoPath`, the cwd (walking upwards), then the checkout containing `cli/` |
| Port / URL | `--port` / `--url`, `CORTEXGATE_PORT` / `CORTEXGATE_URL`, config, then `3003` |
| Admin token | `CORTEXGATE_ADMIN_TOKEN`, then `ADMIN_TOKEN` from `services/gateway/.env`. Sent as `x-admin-token`. |
| Client key | `--key`, `CORTEXGATE_API_KEY`, then `CORTEXGATE_BOOTSTRAP_KEY` from `.env`. Sent as `Authorization: Bearer`. |

`config.json` looks like this:

```json
{ "repoPath": "C:\\Users\\me\\CortexGate", "mode": "node", "port": 3003, "url": "http://localhost:3003" }
```

## How `init` edits `.env`

- It makes a backup first: `services/gateway/.env.bak-YYYYMMDD-HHMMSS` (git-ignored by the `.env.*` rule).
- If `.env` does not exist, it is created from `.env.example` and no backup is made.
- Comments, blank lines and key order are preserved. A key that is empty (`KEY=`) is filled in place. A key that only appears commented out (`# KEY=`) gets its assignment on the line below the comment. A key that is missing entirely is appended at the end under a marker comment.
- Existing values are **never overwritten**, unless you typed a new value for that key at the prompt.
- If `.env` has no `CORTEX_SECRET_KEY` but `data/.secret` exists, `init` copies that key into `.env` instead of generating a new one, so provider keys saved from the dashboard stay decryptable.
- Secrets are printed only once, at creation. `doctor` and `status` never print secret values.

## Notes

- **Docker mode** uses Compose v2 (`docker compose`) and falls back to legacy `docker-compose` with a notice. In Docker, host requests are not loopback, so client keys and the admin token are required. Run `cortexgate init` so both exist.
- **Node mode** passes `PORT` to the child process. `.env` is loaded by the gateway itself, from `services/gateway`. Run `npm install` in `services/gateway` once first.
- **Running a second instance:** point `CORTEXGATE_HOME` at another directory with its own `config.json` (another port). Each home tracks its own pids and logs.

## Development

```bash
cd cli && npm test        # node:test; uses temp dirs via CORTEXGATE_HOME, never your real config or .env
```
