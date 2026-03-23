#!/bin/sh
set -e

echo "==> Starting Claude Max API Proxy..."
echo "    Port: ${PORT:-3456}"
echo "    Model: ${CLAUDE_MODEL:-sonnet}"

# Launch the proxy in the foreground
exec claude-max-api-proxy
