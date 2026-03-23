#!/bin/sh
set -e

PORT="${PORT:-3456}"
HOST="${HOST:-0.0.0.0}"
CLAUDE_MODEL="${CLAUDE_MODEL:-sonnet}"

echo "==> Starting Claude Max API Proxy..."
echo "    Host: ${HOST}"
echo "    Port: ${PORT}"
echo "    Model: ${CLAUDE_MODEL}"

exec claude-max-api "${PORT}" "${HOST}"
