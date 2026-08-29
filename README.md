# Claude Max Proxy Docker

Docker image for [claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy) — exposes a Claude Max subscription as an OpenAI-compatible API endpoint via the Claude Code CLI.

## How it works

```
Your App  →  :3456/v1/chat/completions  →  Claude Code CLI  →  Anthropic API
```

The proxy receives OpenAI-format requests, pipes them through the authenticated Claude Code CLI, and returns OpenAI-format responses. Any app supporting custom OpenAI-compatible providers (Continue.dev, OpenClaw, etc.) can use this endpoint.

## Prerequisites

- An active **Claude Max** or **Claude Max with Team** subscription
- Docker

## Quick start

```bash
git clone https://github.com/Morveus/claude-max-proxy-docker.git
cd claude-max-proxy-docker

# Start
docker compose up --build -d

# Authenticate Claude Code (first time only — tokens are persisted in a volume)
docker compose exec claude-proxy claude login
```

The proxy is now available at `http://localhost:3456`.

## Configuration

| Environment variable | Default   | Description                              |
|---------------------|-----------|------------------------------------------|
| `HOST`              | `0.0.0.0` | Address the proxy listens on             |
| `PORT`              | `3456`    | Port the proxy listens on                |
| `CLAUDE_MODEL`      | `sonnet`  | Default model (`haiku`, `sonnet`, `opus`) |
| `PROXY_RETRY_DELAYS_MS` | `1000,3000,7000` | Backoff before each retry of a transient CLI failure. The list length sets the retry count; empty disables retries. |

## Persistent volumes

| Mount path           | Purpose                                    |
|----------------------|--------------------------------------------|
| `/home/node/.claude` | Auth tokens, Claude Code config, sessions  |
| `/home/node/.config` | General config                             |
| `/workspace`         | Project files and repos                    |

## Client configuration

Point any OpenAI-compatible client at the proxy:

| Setting      | Value                                              |
|--------------|----------------------------------------------------|
| **Base URL** | `http://localhost:3456/v1` (or your service URL)   |
| **Model**    | `claude-sonnet-4`, `claude-opus-4`, `claude-haiku-4` |

## API endpoints

| Method | Path                     | Description            |
|--------|--------------------------|------------------------|
| POST   | `/v1/chat/completions`   | Chat completions       |
| GET    | `/v1/models`             | List available models  |
| GET    | `/health`                | Health check           |

## Upstream patches

The Dockerfile applies these patches to the `claude-max-api-proxy` npm package at build time:

1. **Bind address** - The upstream server defaults to `127.0.0.1`, making it unreachable inside containers. Patched to read `HOST` env var / CLI arg, defaulting to `0.0.0.0`.
2. **Model name safety** - `normalizeModelName()` crashes when the CLI returns no model field. Patched to fall back to `claude-sonnet-4`.
3. **Vision support** (`patches/openai-to-cli.js`) - accepts OpenAI multimodal content arrays; `data:` URI images are written to `/tmp/vision` and read back by the CLI's Read tool.
4. **Transient failure retries** (`patches/routes.js`) - see below.

### Transient failure retries

When the Claude Code CLI cannot refresh its session it emits a `result` message
carrying `Failed to authenticate: OAuth session expired and could not be
refreshed`, with `is_error: true` and zero token usage. Upstream copied that
string straight into `choices[0].message.content` and answered **HTTP 200**, so
callers could not tell a failure from a real model reply. The failure clears on
its own within seconds.

The patched routes:

- retry the request on a transient failure (default backoff 1s, 3s, 7s), in both
  streaming and non-streaming mode;
- never retry once bytes have been streamed to the client, once the client has
  disconnected, or after a request timeout (retrying a 5-minute timeout would
  strand the caller for 20 minutes);
- never retry a genuine model reply that merely mentions authentication - a
  result that consumed tokens is always passed through untouched;
- answer **502** with an explicit error body when the failure persists, instead
  of a misleading 200.

Run the test suite with `./tests/run.sh` (no container or network needed - it
stubs the CLI subprocess).

## Disclaimer

This setup relies on community-maintained tools. Using Claude Max subscriptions through the CLI is compatible with Anthropic's Terms of Service for personal use. TOS may change — use at your own risk.
