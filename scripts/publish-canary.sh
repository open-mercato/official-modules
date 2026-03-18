#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/scripts/lib/common.sh"

NPM_REGISTRY_URL="$(normalize_registry_url "${NPM_REGISTRY_URL:-https://registry.npmjs.org}")"
CANARY_DIST_TAG="${CANARY_DIST_TAG:-canary}"
CANARY_OUTPUT_DIR="$REPO_ROOT/.artifacts/packages-canary"
PREPARE_PREVIEW_SCRIPT="$REPO_ROOT/scripts/lib/prepare-preview-tarballs.mjs"

trap cleanup_temp_npmrc EXIT

cd "$REPO_ROOT"
ensure_npm_cache

if ci_mode_enabled && [[ -n "${NODE_AUTH_TOKEN:-}" ]]; then
  configure_registry_auth_from_token "$NPM_REGISTRY_URL"
else
  if ! npm whoami --registry "$NPM_REGISTRY_URL" >/dev/null 2>&1; then
    echo "Error: No npm auth is configured for $NPM_REGISTRY_URL" >&2
    echo "Use npm login for local publishing, or set CI=true with NODE_AUTH_TOKEN." >&2
    exit 1
  fi
fi

"$REPO_ROOT/scripts/build-packages.sh"
"$REPO_ROOT/scripts/pack-packages.sh" "$@"

CANARY_TARBALLS=()
while IFS= read -r tarball_record; do
  CANARY_TARBALLS+=("$tarball_record")
done < <(VERSION_PRERELEASE_LABEL=canary node "$PREPARE_PREVIEW_SCRIPT" "$ARTIFACTS_DIR" "$CANARY_OUTPUT_DIR")

for tarball_record in "${CANARY_TARBALLS[@]}"; do
  IFS=$'\t' read -r package_name canary_version tarball_path <<<"$tarball_record"
  echo "Publishing $package_name@$canary_version to $NPM_REGISTRY_URL with dist-tag $CANARY_DIST_TAG"
  npm publish "$tarball_path" --registry "$NPM_REGISTRY_URL" --tag "$CANARY_DIST_TAG" --access public
  printf '%s\t%s\n' "$package_name" "$canary_version"
done

echo "Published ${#CANARY_TARBALLS[@]} canary package(s) to $NPM_REGISTRY_URL" >&2
