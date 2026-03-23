# Claude Max Proxy Docker

Docker + Kubernetes setup to run [Claude Code CLI](https://github.com/anthropics/claude-code) alongside [claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy) — exposing your Claude Max subscription as an OpenAI-compatible API endpoint.

## How it works

```
Your App  →  :3456/v1/chat/completions  →  Claude Code CLI  →  Anthropic API
```

The proxy receives OpenAI-format requests, pipes them through the authenticated Claude Code CLI, and returns OpenAI-format responses. Any app supporting custom AI providers (Continue.dev, OpenClaw, etc.) can point to this endpoint.

## Prerequisites

- An active **Claude Max** ($100/mo) or **Claude Max with Team** ($200/mo) subscription
- Docker (for local) or a Kubernetes cluster

## Quick start (Docker Compose)

```bash
# Clone
git clone https://github.com/Morveus/claude-max-proxy-docker.git
cd claude-max-proxy-docker

# Start
PROXY_API_KEY=my-secret docker compose up --build -d

# Authenticate Claude Code (first time only — tokens are persisted in a volume)
docker compose exec claude-proxy claude login
```

The proxy is now available at `http://localhost:3456`.

## Kubernetes deployment

```bash
# 1. Edit the secret
vim k8s/secret.yaml   # Set PROXY_API_KEY

# 2. Update the image reference in the deployment
vim k8s/deployment.yaml   # Replace claude-max-proxy:latest with your registry image

# 3. Deploy
kubectl apply -f k8s/

# 4. Authenticate Claude Code (first time only)
kubectl exec -it -n claude-proxy deploy/claude-proxy -- claude login
```

### Manifests included

| File | Description |
|------|-------------|
| `k8s/namespace.yaml` | Dedicated `claude-proxy` namespace |
| `k8s/secret.yaml` | `PROXY_API_KEY` for client authentication |
| `k8s/configmap.yaml` | `PORT` and `CLAUDE_MODEL` settings |
| `k8s/pvc.yaml` | Persistent volumes for config (1Gi) and workspace (10Gi) |
| `k8s/deployment.yaml` | Single-replica deployment with probes and resource limits |
| `k8s/service.yaml` | ClusterIP service on port 3456 |

## Configuration

| Environment variable | Default | Description |
|---------------------|---------|-------------|
| `PROXY_API_KEY` | *(required)* | Key clients must send to authenticate |
| `PORT` | `3456` | Port the proxy listens on |
| `CLAUDE_MODEL` | `sonnet` | Default model (`haiku`, `sonnet`, `opus`) |

## Persistent volumes

| Mount path | Purpose |
|-----------|---------|
| `/home/node/.claude` | Auth tokens, Claude Code config, session data |
| `/home/node/.config` | General config |
| `/workspace` | Project files and repos |

## Client configuration

Point any OpenAI-compatible client at the proxy:

| Setting | Value |
|---------|-------|
| **Base URL** | `http://localhost:3456/v1` (or your K8s service URL) |
| **API Key** | Your `PROXY_API_KEY` value |
| **Model** | `claude-sonnet` (or any string — the proxy uses `CLAUDE_MODEL`) |

## Disclaimer

This setup relies on community-maintained tools. As of early 2025, using Claude Max subscriptions through the CLI is compatible with Anthropic's Terms of Service for personal use. TOS may change — use at your own risk.
