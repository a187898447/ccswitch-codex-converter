#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# Check node
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install from https://nodejs.org" >&2
  exit 1
fi

# Load .env if present
if [ -f .env ]; then
  set -a; source .env; set +a
fi

PORT="${CONVERTER_PORT:-11888}"
HOST="${CONVERTER_HOST:-127.0.0.1}"

# Kill any existing instance on this port
if command -v lsof &>/dev/null; then
  OLD_PID=$(lsof -ti ":$PORT" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$OLD_PID" ]; then
    echo "[converter] Killing old instance on port $PORT (pid $OLD_PID)"
    kill -9 $OLD_PID 2>/dev/null || true
    sleep 0.5
  fi
fi

echo "[converter] Starting on http://${HOST}:${PORT}"
exec node index.js
