#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

sh .ai/scripts/test-env-up.sh >/dev/null

DESCRIPTOR=.ai/qa/test-env.json
STATE_HELPER=.ai/scripts/test-env-state.mjs
BASE_URL=$(node "$STATE_HELPER" field "$DESCRIPTOR" baseUrl)
DB_PORT=$(node "$STATE_HELPER" field "$DESCRIPTOR" services.0.port)
RAW_DATABASE_URL=$(sed -n 's/^DATABASE_URL=//p' apps/sandbox/.env | tail -1)
if [ -z "$RAW_DATABASE_URL" ]; then
  RAW_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/open-mercato
fi
DATABASE_URL=$(RAW_DATABASE_URL="$RAW_DATABASE_URL" DB_PORT="$DB_PORT" node -e '
  const url = new URL(process.env.RAW_DATABASE_URL)
  url.hostname = "127.0.0.1"
  url.port = process.env.DB_PORT
  process.stdout.write(url.toString())
')

export BASE_URL DATABASE_URL
export PW_CAPTURE_SCREENSHOTS=${PW_CAPTURE_SCREENSHOTS:-1}

# This runner is intentionally scoped to financial-pl. When the first argument is
# an option, prepend the default directory; otherwise a caller-supplied spec/path
# remains the target (useful for a focused re-run).
case "${1-}" in
  '') set -- packages/financial-pl/src/modules/financial_pl/__integration__ ;;
  -*) set -- packages/financial-pl/src/modules/financial_pl/__integration__ "$@" ;;
esac

exec corepack yarn exec playwright test \
  --config .ai/qa/tests/playwright.config.ts \
  "$@"
