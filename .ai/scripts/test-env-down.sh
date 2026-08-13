#!/bin/sh
# om-prepare-test-env: generated teardown (contract v2)
# regenerate with: om-prepare-test-env --regenerate
# history:
#   2026-08-06 generated; stops only the official-modules sandbox and preserves named QA volumes
#   2026-08-06 repair: terminate the recorded detached screen session before PID fallback
#   2026-08-06 repair: signal the recorded screen process group so dev-runner grandchildren cannot survive
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
ENV_DESCRIPTOR=.ai/qa/test-env.json
LOCK_DIR=.ai/qa/test-env.lock
STATE_HELPER=.ai/scripts/test-env-state.mjs

if [ -f "$ENV_DESCRIPTOR" ]; then
  STARTED=$(node "$STATE_HELPER" field "$ENV_DESCRIPTOR" startedByThisRepo 2>/dev/null || true)
  APP_PID=$(node "$STATE_HELPER" field "$ENV_DESCRIPTOR" app.pid 2>/dev/null || true)
  APP_SESSION=$(node "$STATE_HELPER" field "$ENV_DESCRIPTOR" app.session 2>/dev/null || true)
  if [ "$STARTED" = true ] && [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM -"$APP_PID" 2>/dev/null || kill -TERM "$APP_PID" 2>/dev/null || true
    for attempt in $(seq 1 30); do
      kill -0 "$APP_PID" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$APP_PID" 2>/dev/null; then
      kill -KILL -"$APP_PID" 2>/dev/null || kill -KILL "$APP_PID" 2>/dev/null || true
    fi
  fi
  if [ "$STARTED" = true ] && [ -n "$APP_SESSION" ] && command -v screen >/dev/null 2>&1; then
    screen -S "$APP_SESSION" -X quit >/dev/null 2>&1 || true
  fi
fi

docker compose -f apps/sandbox/docker-compose.yml --env-file apps/sandbox/.env stop >/dev/null 2>&1 || true
node "$STATE_HELPER" mark-stopped "$ENV_DESCRIPTOR"
rm -rf "$LOCK_DIR"
rm -f .ai/qa/test-env-runtime.pid
echo "TEST_ENV_STATUS=stopped"
echo "TEST_ENV_DESCRIPTOR=$ENV_DESCRIPTOR"
