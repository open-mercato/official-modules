#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/scripts/lib/common.sh"

VERDACCIO_URL="$(normalize_registry_url "${VERDACCIO_URL:-http://localhost:4873}")"
PREVIEW_DIST_TAG="${PREVIEW_DIST_TAG:-preview}"
PREVIEW_OUTPUT_DIR="$REPO_ROOT/.artifacts/packages-preview"
PREPARE_PREVIEW_SCRIPT="$REPO_ROOT/scripts/lib/prepare-preview-tarballs.mjs"

trap cleanup_temp_npmrc EXIT

cd "$REPO_ROOT"
ensure_npm_cache

"$REPO_ROOT/scripts/registry/ping.sh"

if ci_mode_enabled && [[ -n "${NODE_AUTH_TOKEN:-}" ]]; then
  configure_registry_auth_from_token "$VERDACCIO_URL"
else
  "$REPO_ROOT/scripts/registry/whoami.sh" >/dev/null
fi

"$REPO_ROOT/scripts/build-packages.sh"
"$REPO_ROOT/scripts/pack-packages.sh" "$@"

PREVIEW_TARBALLS=()
while IFS= read -r tarball_record; do
  PREVIEW_TARBALLS+=("$tarball_record")
done < <(node "$PREPARE_PREVIEW_SCRIPT" "$ARTIFACTS_DIR" "$PREVIEW_OUTPUT_DIR")

for tarball_record in "${PREVIEW_TARBALLS[@]}"; do
  IFS=$'\t' read -r package_name preview_version tarball_path <<<"$tarball_record"
  echo "Publishing $package_name@$preview_version to $VERDACCIO_URL with dist-tag $PREVIEW_DIST_TAG"
  npm publish "$tarball_path" --registry "$VERDACCIO_URL" --tag "$PREVIEW_DIST_TAG" --access public
done

echo "Published ${#PREVIEW_TARBALLS[@]} preview package(s) to $VERDACCIO_URL"
