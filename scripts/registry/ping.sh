#!/usr/bin/env bash

set -euo pipefail

VERDACCIO_URL="${VERDACCIO_URL:-http://localhost:4873}"
VERDACCIO_URL="${VERDACCIO_URL%/}"
PING_URL="$VERDACCIO_URL/-/ping"

if curl --fail --silent --show-error "$PING_URL" >/dev/null; then
  echo "Registry is reachable at $VERDACCIO_URL"
  exit 0
fi

echo "Error: Verdaccio is not reachable at $VERDACCIO_URL" >&2
echo "Start it with: docker compose up -d verdaccio" >&2
exit 1
