#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

# Check node
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install from https://nodejs.org"
  exit 1
fi

# Load .env if present
if [ -f .env ]; then
  set -a; source .env; set +a
fi

echo "[converter] Starting on http://${CONVERTER_HOST:-127.0.0.1}:${CONVERTER_PORT:-11888}"
exec node index.js
