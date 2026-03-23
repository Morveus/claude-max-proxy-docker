FROM node:20-slim

ARG CLAUDE_CODE_VERSION=latest

# Install essential tools
RUN apt-get update && apt-get install -y --no-install-recommends \
  git \
  curl \
  ca-certificates \
  procps \
  jq \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Create non-root user directories
RUN mkdir -p /home/node/.claude /home/node/.config /workspace && \
  chown -R node:node /home/node/.claude /home/node/.config /workspace

# Ensure node user can write to global npm prefix
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R node:node /usr/local/share/npm-global

USER node

ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Install Claude Code CLI and the Max API proxy
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && \
  npm install -g claude-max-api-proxy

WORKDIR /workspace

# Proxy listens on 3456 by default
EXPOSE 3456

# Volumes for persistent data:
#   /home/node/.claude   - Claude Code config, auth tokens, session data
#   /home/node/.config   - General config (npm, etc.)
#   /workspace           - Project files / repos to work on
VOLUME ["/home/node/.claude", "/home/node/.config", "/workspace"]

COPY --chown=node:node entrypoint.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
