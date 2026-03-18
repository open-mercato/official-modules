#!/usr/bin/env bash
# Full recreation of apps/sandbox from the create-mercato-app template.
#
# Usage:
#   ./scripts/sync-sandbox.sh           # latest published release
#   ./scripts/sync-sandbox.sh 0.4.9-canary-1f829e1484
#   yarn sandbox:sync
#   yarn sandbox:sync 0.4.9-canary-1f829e1484
#
# Preserved (never overwritten):
#   .env               — your secrets
#   migrations/        — database migrations
#   data/              — SQLite database file
#   storage/           — uploaded files
#
# After the sync:
#   yarn install && yarn generate

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX_DIR="$REPO_ROOT/apps/sandbox"

# ── Build the npx command ─────────────────────────────────────────────────────
VERSION="${1:-}"
if [ -n "$VERSION" ]; then
  CREATE_CMD="npx --yes create-mercato-app@$VERSION"
  echo "Recreating apps/sandbox from create-mercato-app@$VERSION"
else
  CREATE_CMD="npx --yes create-mercato-app"
  echo "Recreating apps/sandbox from create-mercato-app (latest)"
fi
echo ""

# ── Create fresh app in temp dir ─────────────────────────────────────────────
# Name the temp app "sandbox" so package.json gets "name": "sandbox" from the template
TMPDIR=$(mktemp -d)
FRESH_APP="$TMPDIR/sandbox"
BACKUP_DIR="$TMPDIR/backup"

cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

echo "Creating fresh template app..."
echo "1" | $CREATE_CMD "$FRESH_APP"
echo ""

# ── Backup preserved files ────────────────────────────────────────────────────
echo "Backing up preserved files..."
mkdir -p "$BACKUP_DIR"

backup() {
  local rel="$1"
  if [ -e "$SANDBOX_DIR/$rel" ]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
    cp -r "$SANDBOX_DIR/$rel" "$BACKUP_DIR/$rel"
    echo "  backed up: $rel"
  fi
}

backup ".env"
backup "migrations"
backup "data"
backup "storage"

# ── Wipe sandbox (keep node_modules — too large to reinstall mid-script) ──────
echo ""
echo "Clearing apps/sandbox..."
find "$SANDBOX_DIR" -mindepth 1 -maxdepth 1 \
  \( -name "node_modules" -o -name ".git" \) -prune \
  -o -print0 | xargs -0 rm -rf

# ── Copy fresh app wholesale ──────────────────────────────────────────────────
echo "Copying fresh template..."
rsync -a \
  --exclude "node_modules" \
  --exclude "yarn.lock" \
  --exclude ".yarnrc.yml" \
  "$FRESH_APP/" "$SANDBOX_DIR/"

# ── Fix @source paths in globals.css for monorepo node_modules layout ────────
# The template uses "../../node_modules/" which resolves to apps/sandbox/node_modules/
# In this monorepo packages are hoisted to the root, so the correct path is ../../../../node_modules/
GLOBALS_CSS="$SANDBOX_DIR/src/app/globals.css"
if [ -f "$GLOBALS_CSS" ]; then
  echo "Patching globals.css @source paths for monorepo layout..."
  sed -i '' 's|@source "../../node_modules/|@source "../../../../node_modules/|g' "$GLOBALS_CSS"
fi

# ── Restore preserved files ───────────────────────────────────────────────────
echo ""
echo "Restoring preserved files..."
if [ -d "$BACKUP_DIR" ]; then
  while IFS= read -r -d '' src; do
    rel="${src#$BACKUP_DIR/}"
    echo "  restored: $rel"
    cp -r "$src" "$SANDBOX_DIR/$rel"
  done < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
fi

echo ""
echo "Done."
echo ""
echo "Review changes:"
echo "  git diff apps/sandbox"
echo ""
echo "Then:"
echo "  yarn install"
echo "  yarn generate"
