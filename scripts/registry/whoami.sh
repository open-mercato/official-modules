#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$REPO_ROOT/scripts/lib/common.sh"
VERDACCIO_URL="${VERDACCIO_URL:-http://localhost:4873}"
VERDACCIO_URL="${VERDACCIO_URL%/}"

ensure_npm_cache
"$SCRIPT_DIR/ping.sh" >/dev/null

if npm whoami --registry "$VERDACCIO_URL"; then
  exit 0
fi

echo "Error: No npm auth is configured for $VERDACCIO_URL" >&2
echo "Run ./scripts/registry/setup-user.sh locally, or set CI=true with NODE_AUTH_TOKEN for non-interactive publishing." >&2
exit 1
