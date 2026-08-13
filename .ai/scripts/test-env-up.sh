#!/bin/sh
# om-prepare-test-env: generated entrypoint (contract v2)
# regenerate with: om-prepare-test-env --regenerate
# history:
#   2026-08-06 generated for the Open Mercato official-modules sandbox; isolates ports and preserves QA data
#   2026-08-06 repair: exclude compiler state from fingerprints and skip init when demo users already exist
#   2026-08-06 repair: use a detached screen session on macOS so the app survives non-interactive shell exit
#   2026-08-06 repair: terminate detached process groups and reject readiness from a stale listener
#   2026-08-06 repair: expose a credential-safe financial-pl regression runner with the isolated DB URL
#   2026-08-06 repair: exclude test-only sources from the application build fingerprint
#   2026-08-06 repair: use localhost so Next 16.3 permits dev assets and client hydration
set -eu

PREFERRED_APP_PORT=3111
PREFERRED_DB_PORT=55433
PREFERRED_REDIS_PORT=56379
PREFERRED_MEILI_PORT=57700
BUILD_INPUTS="package.json yarn.lock tsconfig.base.json apps/sandbox packages scripts"
BUILD_ENV_VARS="NODE_ENV OM_ENABLE_ENTERPRISE_MODULES"
ARTIFACTS=".yarn/install-state.gz packages/financial-pl/dist apps/sandbox/.mercato/generated/entities.ids.generated.ts"
DEFAULT_CACHE_TTL_SECONDS=3600
PREP_INSTALL="corepack yarn install --immutable"
PREP_BUILD="corepack yarn build:packages"
PREP_GENERATE="corepack yarn generate"
LAUNCH_COMMAND="corepack yarn workspace sandbox dev"

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
QA_DIR=.ai/qa
ENV_DESCRIPTOR="$QA_DIR/test-env.json"
BUILD_CACHE="$QA_DIR/test-env-build-cache.json"
LOCK_DIR="$QA_DIR/test-env.lock"
LOCK_OWNER="$LOCK_DIR/owner.json"
STATE_HELPER=.ai/scripts/test-env-state.mjs
LOG_FILE="$QA_DIR/test-env-app.log"
APP_PID_FILE="$QA_DIR/test-env-runtime.pid"
TTL_SECONDS=${TEST_ENV_CACHE_TTL_SECONDS:-$DEFAULT_CACHE_TTL_SECONDS}
FORCE=0
FORCE_REBUILD=0
KEEP_LOCK=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --force-rebuild) FORCE_REBUILD=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$QA_DIR" "$QA_DIR/bin"
corepack enable --install-directory "$QA_DIR/bin" >/dev/null
PATH="$ROOT/$QA_DIR/bin:$PATH"
export PATH

free_port() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'
  elif command -v python >/dev/null 2>&1; then
    python -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'
  elif command -v node >/dev/null 2>&1; then
    node -e 's=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
  else
    awk 'BEGIN{srand();print 20000+int(rand()*20000)}'
  fi
}

port_is_free() {
  PORT_TO_CHECK=$1 node -e '
    const net=require("node:net");
    const port=Number(process.env.PORT_TO_CHECK);
    const client=net.createConnection({host:"127.0.0.1",port});
    client.once("connect",()=>{client.destroy();process.exit(1)});
    client.once("error",()=>{
      const server=net.createServer();
      server.once("error",()=>process.exit(1));
      server.listen(port,"127.0.0.1",()=>server.close(()=>process.exit(0)));
    });'
}

choose_port() {
  if port_is_free "$1"; then printf '%s\n' "$1"; else free_port; fi
}

fp_file() {
  stat -f '%z:%m' "$1" 2>/dev/null || stat -c '%s:%Y' "$1" 2>/dev/null
}

fingerprint() {
  {
    for p in $BUILD_INPUTS; do
      if [ -d "$p" ]; then
        find "$p" -type f \
          ! -path '*/node_modules/*' ! -path '*/.git/*' ! -path '*/dist/*' \
          ! -path '*/.cache/*' ! -path '*/coverage/*' ! -path '*/.next/*' \
          ! -path '*/.mercato/*' ! -path '*/.turbo/*' ! -path '*/data/*' \
          ! -path '*/storage/*' ! -path '*/__integration__/*' ! -path '*/__tests__/*' \
          ! -name '*.spec.ts' ! -name '*.test.ts' ! -name '*.tsbuildinfo' ! -name '.DS_Store'
      elif [ -f "$p" ]; then
        echo "$p"
      fi
    done | LC_ALL=C sort | while IFS= read -r f; do printf '%s:%s\n' "$f" "$(fp_file "$f")"; done
    for v in $BUILD_ENV_VARS; do eval "printf 'env:%s=%s\\n' \"$v\" \"\${$v:-}\""; done
  } | cksum | awk '{print $1"-"$2}'
}

build_needed() {
  [ "$FORCE_REBUILD" = 1 ] && return 0
  [ -f "$BUILD_CACHE" ] || return 0
  CACHED_FP=$(sed -n 's/.*"sourceFingerprint": *"\([^"]*\)".*/\1/p' "$BUILD_CACHE")
  CACHED_ROOT=$(sed -n 's/.*"projectRoot": *"\([^"]*\)".*/\1/p' "$BUILD_CACHE")
  [ "$CACHED_FP" = "$(fingerprint)" ] || return 0
  [ "$CACHED_ROOT" = "$ROOT" ] || return 0
  for artifact in $ARTIFACTS; do
    [ -s "$artifact" ] || [ -d "$artifact" ] || return 0
  done
  return 1
}

probe_environment() {
  BASE_URL=$1
  curl -fsS --max-time 8 -o /dev/null "$BASE_URL/login" 2>/dev/null || return 1
  STATUS=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
    -X POST -H 'content-type: application/x-www-form-urlencoded' \
    --data 'email=superadmin%40acme.com&password=secret' \
    "$BASE_URL/api/auth/login" 2>/dev/null || true)
  [ "$STATUS" = 200 ]
}

print_result() {
  BASE_URL=$1
  REUSED=$2
  echo "TEST_ENV_STATUS=running"
  echo "TEST_ENV_BASE_URL=$BASE_URL"
  echo "TEST_ENV_DESCRIPTOR=$ENV_DESCRIPTOR"
  echo "TEST_ENV_REUSED=$REUSED"
  echo "BROWSER_PROVIDER=playwright"
  echo "BROWSER_INSTALLED=1"
}

SOURCE_FP=$(fingerprint)

descriptor_reusable() {
  [ "$FORCE" = 0 ] || return 1
  [ -f "$ENV_DESCRIPTOR" ] || return 1
  node "$STATE_HELPER" reusable "$ENV_DESCRIPTOR" "$SOURCE_FP" "$TTL_SECONDS" || return 1
  BASE_URL=$(node "$STATE_HELPER" field "$ENV_DESCRIPTOR" baseUrl) || return 1
  probe_environment "$BASE_URL"
}

release_lock() {
  if [ "$KEEP_LOCK" = 0 ] && [ -d "$LOCK_DIR" ]; then rm -rf "$LOCK_DIR"; fi
}
trap release_lock EXIT INT TERM

while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  if descriptor_reusable; then
    BASE_URL=$(node "$STATE_HELPER" field "$ENV_DESCRIPTOR" baseUrl)
    print_result "$BASE_URL" 1
    exit 0
  fi
  if [ ! -f "$LOCK_OWNER" ] || ! node "$STATE_HELPER" owner-alive "$LOCK_OWNER"; then
    rm -rf "$LOCK_DIR"
    continue
  fi
  sh .ai/scripts/test-env-down.sh >/dev/null 2>&1 || true
done
node "$STATE_HELPER" write-owner "$LOCK_OWNER" "$$" bootstrap

if descriptor_reusable; then
  BASE_URL=$(node "$STATE_HELPER" field "$ENV_DESCRIPTOR" baseUrl)
  print_result "$BASE_URL" 1
  exit 0
fi

if [ -f "$ENV_DESCRIPTOR" ]; then
  sh .ai/scripts/test-env-down.sh >/dev/null 2>&1 || true
  mkdir -p "$LOCK_DIR"
  node "$STATE_HELPER" write-owner "$LOCK_OWNER" "$$" bootstrap
fi

if build_needed; then
  echo "Preparing dependencies, generated artifacts, and workspace packages..."
  sh -c "$PREP_INSTALL"
  sh -c "$PREP_BUILD"
  sh -c "$PREP_GENERATE"
  SOURCE_FP=$(fingerprint)
  printf '{ "builtAt": "%s", "sourceFingerprint": "%s", "projectRoot": "%s", "artifactPaths": "%s" }\n' \
    "$(date -u +%FT%TZ)" "$SOURCE_FP" "$ROOT" "$ARTIFACTS" > "$BUILD_CACHE"
else
  echo "Preparation cache is current; skipping install, code generation, and package build."
fi

APP_PORT=$(choose_port "$PREFERRED_APP_PORT")
DB_PORT=$(choose_port "$PREFERRED_DB_PORT")
REDIS_PORT=$(choose_port "$PREFERRED_REDIS_PORT")
MEILI_PORT=$(choose_port "$PREFERRED_MEILI_PORT")
BASE_URL="http://localhost:$APP_PORT"
RAW_DATABASE_URL=$(sed -n 's/^DATABASE_URL=//p' apps/sandbox/.env | tail -1)
if [ -z "$RAW_DATABASE_URL" ]; then RAW_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/open-mercato; fi
DATABASE_URL=$(RAW_DATABASE_URL="$RAW_DATABASE_URL" DB_PORT="$DB_PORT" node -e 'const u=new URL(process.env.RAW_DATABASE_URL);u.hostname="127.0.0.1";u.port=process.env.DB_PORT;process.stdout.write(u.toString())')
export DATABASE_URL
export REDIS_URL="redis://127.0.0.1:$REDIS_PORT"
export EVENTS_REDIS_URL="$REDIS_URL"
export QUEUE_REDIS_URL="$REDIS_URL"
export MEILISEARCH_HOST="http://127.0.0.1:$MEILI_PORT"
export MEILISEARCH_API_KEY=meilisearch-dev-key

echo "Starting isolated sandbox services..."
POSTGRES_PORT="$DB_PORT" REDIS_PORT="$REDIS_PORT" MEILISEARCH_PORT="$MEILI_PORT" \
  MEILISEARCH_MASTER_KEY=meilisearch-dev-key \
  docker compose -f apps/sandbox/docker-compose.yml --env-file apps/sandbox/.env up -d

READY=0
for attempt in $(seq 1 60); do
  if docker inspect --format '{{.State.Health.Status}}' mercato-postgres-module 2>/dev/null | grep -q '^healthy$' \
    && docker inspect --format '{{.State.Health.Status}}' mercato-redis-module 2>/dev/null | grep -q '^healthy$' \
    && docker inspect --format '{{.State.Health.Status}}' mercato-meilisearch-module 2>/dev/null | grep -q '^healthy$'; then
    READY=1
    break
  fi
  sleep 2
done
[ "$READY" = 1 ] || { echo "Sandbox services did not become healthy." >&2; exit 1; }

echo "Applying migrations and ensuring demo QA users exist..."
corepack yarn workspace sandbox db:migrate
if docker exec mercato-postgres-module sh -c \
  'test "$(psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from users" 2>/dev/null | tr -d "[:space:]")" -gt 0' 2>/dev/null; then
  echo "Demo QA users already exist; preserving the initialized sandbox data."
else
  corepack yarn workspace sandbox initialize
fi

: > "$LOG_FILE"
echo "Starting Open Mercato at $BASE_URL..."
APP_SESSION="official-modules-test-env-$$"
if command -v screen >/dev/null 2>&1; then
  rm -f "$APP_PID_FILE"
  NODE_ENV=development PORT="$APP_PORT" APP_URL="$BASE_URL" NEXT_PUBLIC_APP_URL="$BASE_URL" \
    OM_INTEGRATION_TEST=true OM_DEV_AUTO_MIGRATE=0 OM_DEV_SPLASH_PORT=off OM_DEV_AUTO_OPEN=0 \
    MERCATO_DEV_OUTPUT=verbose OM_LOG_DESTINATION=stderr \
    OM_INIT_SUPERADMIN_EMAIL=superadmin@acme.com OM_INIT_SUPERADMIN_PASSWORD=secret \
    screen -dmS "$APP_SESSION" sh -c \
      "ps -o pgid= -p \$\$ | tr -d ' ' >'$APP_PID_FILE'; exec $LAUNCH_COMMAND >>'$LOG_FILE' 2>&1"
  APP_PID=
  for attempt in $(seq 1 50); do
    if [ -s "$APP_PID_FILE" ]; then APP_PID=$(sed -n '1p' "$APP_PID_FILE"); break; fi
    sleep 0.1
  done
  APP_LAUNCHER=screen
else
  APP_SESSION=
  NODE_ENV=development PORT="$APP_PORT" APP_URL="$BASE_URL" NEXT_PUBLIC_APP_URL="$BASE_URL" \
    OM_INTEGRATION_TEST=true OM_DEV_AUTO_MIGRATE=0 OM_DEV_SPLASH_PORT=off OM_DEV_AUTO_OPEN=0 \
    MERCATO_DEV_OUTPUT=verbose OM_LOG_DESTINATION=stderr \
    OM_INIT_SUPERADMIN_EMAIL=superadmin@acme.com OM_INIT_SUPERADMIN_PASSWORD=secret \
    nohup sh -c "exec $LAUNCH_COMMAND" >>"$LOG_FILE" 2>&1 &
  APP_PID=$!
  APP_LAUNCHER=nohup
fi
[ -n "$APP_PID" ] || { echo "Unable to resolve the detached app PID." >&2; exit 1; }
node "$STATE_HELPER" write-owner "$LOCK_OWNER" "$APP_PID" runtime
KEEP_LOCK=1

APP_READY=0
for attempt in $(seq 1 180); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "Sandbox app exited during startup." >&2
    tail -80 "$LOG_FILE" >&2
    exit 1
  fi
  if { grep -q "App runtime at .*:$APP_PORT" "$LOG_FILE" 2>/dev/null \
    || grep -q "Local:.*:$APP_PORT" "$LOG_FILE" 2>/dev/null; } \
    && probe_environment "$BASE_URL"; then
    APP_READY=1
    break
  fi
  sleep 2
done
if [ "$APP_READY" != 1 ]; then
  echo "Sandbox app did not pass authenticated readiness probes." >&2
  tail -80 "$LOG_FILE" >&2
  exit 1
fi

BROWSER_VERSION=$(corepack yarn exec playwright --version | sed 's/^Version //')
TEST_ENV_APP_PORT="$APP_PORT" TEST_ENV_BASE_URL="$BASE_URL" TEST_ENV_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$" \
  TEST_ENV_APP_PID="$APP_PID" TEST_ENV_DB_PORT="$DB_PORT" TEST_ENV_REDIS_PORT="$REDIS_PORT" \
  TEST_ENV_MEILI_PORT="$MEILI_PORT" TEST_ENV_BROWSER_INSTALLED=1 TEST_ENV_BROWSER_VERSION="$BROWSER_VERSION" \
  TEST_ENV_APP_SESSION="$APP_SESSION" TEST_ENV_APP_LAUNCHER="$APP_LAUNCHER" \
  TEST_ENV_SOURCE_FINGERPRINT="$SOURCE_FP" node "$STATE_HELPER" write-descriptor "$ENV_DESCRIPTOR"

print_result "$BASE_URL" 0
