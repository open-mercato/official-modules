#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$REPO_ROOT/scripts/lib/common.sh"
VERDACCIO_URL="${VERDACCIO_URL:-http://localhost:4873}"
VERDACCIO_URL="${VERDACCIO_URL%/}"

ensure_npm_cache
"$SCRIPT_DIR/ping.sh"

if [[ "${CI:-}" == "true" || "${CI:-}" == "1" ]]; then
  echo "Skipping interactive Verdaccio login because CI mode is enabled."
  exit 0
fi

npm adduser --registry "$VERDACCIO_URL"
