#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIST_SCRIPT="$REPO_ROOT/scripts/lib/list-publishable-packages.mjs"
ARTIFACTS_DIR="$REPO_ROOT/.artifacts/packages"

cd "$REPO_ROOT"

rm -rf "$ARTIFACTS_DIR"
mkdir -p "$ARTIFACTS_DIR"

PACKAGES=()
while IFS= read -r package_record; do
  PACKAGES+=("$package_record")
done < <(node "$LIST_SCRIPT" "$@")

for package_record in "${PACKAGES[@]}"; do
  IFS=$'\t' read -r package_dir package_name package_version archive_file <<<"$package_record"

  if [[ ! -d "$package_dir/dist" ]]; then
    echo "Error: Missing build output for $package_name. Expected $package_dir/dist to exist. Run ./scripts/build-packages.sh first." >&2
    exit 1
  fi

  package_main="$(node -p "require(process.argv[1]).main ?? ''" "$package_dir/package.json")"

  if [[ -n "$package_main" && ! -f "$package_dir/$package_main" ]]; then
    echo "Error: Missing main entry for $package_name at $package_dir/$package_main" >&2
    exit 1
  fi

  echo "Packing $package_name@$package_version"
  yarn workspace "$package_name" pack --out "$ARTIFACTS_DIR/$archive_file" >/dev/null

  if [[ ! -f "$ARTIFACTS_DIR/$archive_file" ]]; then
    echo "Error: Expected tarball $ARTIFACTS_DIR/$archive_file was not created." >&2
    exit 1
  fi
done

echo "Packed ${#PACKAGES[@]} package(s) into $ARTIFACTS_DIR"
