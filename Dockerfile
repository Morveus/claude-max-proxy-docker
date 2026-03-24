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

# Patch upstream npm package bugs:
#   1. standalone.js: accept host as second CLI arg, default to 0.0.0.0
#   2. cli-to-openai.js: guard normalizeModelName against undefined input
#   3. openai-to-cli.js: handle content as array (OpenAI multimodal format)
RUN PROXY_DIR=/usr/local/share/npm-global/lib/node_modules/claude-max-api-proxy/dist && \
  sed -i \
    's/await startServer({ port });/const host = process.argv[3] || process.env.HOST || "0.0.0.0"; await startServer({ port, host });/' \
    "$PROXY_DIR/server/standalone.js" && \
  sed -i \
    's/function normalizeModelName(model) {/function normalizeModelName(model) { if (!model) return "claude-sonnet-4";/' \
    "$PROXY_DIR/adapter/cli-to-openai.js" && \
  sed -i \
    's/export function messagesToPrompt(messages) {/function normalizeContent(c) { if (typeof c === "string") return c; if (Array.isArray(c)) return c.map(p => p.text || "").join(""); return String(c); }\nexport function messagesToPrompt(messages) {/' \
    "$PROXY_DIR/adapter/openai-to-cli.js" && \
  sed -i \
    's/parts\.push(`<system>\\n${msg\.content}/parts.push(`<system>\\n${normalizeContent(msg.content)}/' \
    "$PROXY_DIR/adapter/openai-to-cli.js" && \
  sed -i \
    's/parts\.push(msg\.content);/parts.push(normalizeContent(msg.content));/' \
    "$PROXY_DIR/adapter/openai-to-cli.js" && \
  sed -i \
    's/parts\.push(`<previous_response>\\n${msg\.content}/parts.push(`<previous_response>\\n${normalizeContent(msg.content)}/' \
    "$PROXY_DIR/adapter/openai-to-cli.js"

WORKDIR /workspace

EXPOSE 3456

VOLUME ["/home/node/.claude", "/home/node/.config", "/workspace"]

COPY --chown=node:node entrypoint.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
