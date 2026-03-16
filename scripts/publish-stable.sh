#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/scripts/lib/common.sh"

NPM_REGISTRY_URL="$(normalize_registry_url "${NPM_REGISTRY_URL:-https://registry.npmjs.org}")"
DRY_RUN="${DRY_RUN:-false}"

trap cleanup_temp_npmrc EXIT

cd "$REPO_ROOT"
ensure_npm_cache

if [[ "$DRY_RUN" == "true" ]]; then
  :
elif ci_mode_enabled; then
  configure_registry_auth_from_token "$NPM_REGISTRY_URL"
elif ! npm whoami --registry "$NPM_REGISTRY_URL" >/dev/null 2>&1; then
  echo "Error: No npm auth is configured for $NPM_REGISTRY_URL" >&2
  echo "Use npm login for local publishing, or set CI=true with NODE_AUTH_TOKEN." >&2
  exit 1
fi

"$REPO_ROOT/scripts/build-packages.sh"
"$REPO_ROOT/scripts/pack-packages.sh" "$@"

PACKAGE_TARBALLS=()
while IFS= read -r tarball_path; do
  PACKAGE_TARBALLS+=("$tarball_path")
done < <(find "$ARTIFACTS_DIR" -maxdepth 1 -type f -name '*.tgz' | sort)

if [[ "${#PACKAGE_TARBALLS[@]}" -eq 0 ]]; then
  echo "Error: No packed artifacts were found in $ARTIFACTS_DIR" >&2
  exit 1
fi

for tarball_path in "${PACKAGE_TARBALLS[@]}"; do
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "Dry run: npm publish $tarball_path --registry $NPM_REGISTRY_URL --access public --dry-run"
    npm publish "$tarball_path" --registry "$NPM_REGISTRY_URL" --access public --dry-run
    continue
  fi

  echo "Publishing $tarball_path to $NPM_REGISTRY_URL"
  npm publish "$tarball_path" --registry "$NPM_REGISTRY_URL" --access public
done

echo "Published ${#PACKAGE_TARBALLS[@]} stable package(s) to $NPM_REGISTRY_URL"
