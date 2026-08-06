#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

if [ -d .venv/bin ]; then
  export PATH="$PROJECT_DIR/.venv/bin:$PATH"
fi

exec node src/web_server.mjs
