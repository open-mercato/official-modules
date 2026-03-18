#!/usr/bin/env bash

COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$COMMON_DIR/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/.artifacts/packages"
NPM_CACHE_DIR="$REPO_ROOT/.artifacts/.npm-cache"
TEMP_NPMRC=""

ci_mode_enabled() {
  case "${CI:-}" in
    1|true|TRUE|yes|YES)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

normalize_registry_url() {
  local registry_url="${1%/}"
  printf '%s\n' "$registry_url"
}

cleanup_temp_npmrc() {
  if [[ -n "$TEMP_NPMRC" && -f "$TEMP_NPMRC" ]]; then
    rm -f "$TEMP_NPMRC"
  fi
}

configure_registry_auth_from_token() {
  local registry_url
  registry_url="$(normalize_registry_url "$1")"

  if [[ -z "${NODE_AUTH_TOKEN:-}" ]]; then
    echo "Error: NODE_AUTH_TOKEN is required for token-based publishing." >&2
    return 1
  fi

  TEMP_NPMRC="$(mktemp "${TMPDIR:-/tmp}/official-modules-npmrc.XXXXXX")"

  local registry_host="${registry_url#http://}"
  registry_host="${registry_host#https://}"

  {
    printf 'registry=%s/\n' "$registry_url"
    printf '@open-mercato:registry=%s/\n' "$registry_url"
    printf '//%s/:_authToken=%s\n' "$registry_host" "$NODE_AUTH_TOKEN"
    printf 'always-auth=true\n'
  } > "$TEMP_NPMRC"

  export npm_config_userconfig="$TEMP_NPMRC"
  export NPM_CONFIG_USERCONFIG="$TEMP_NPMRC"
}

ensure_npm_cache() {
  mkdir -p "$NPM_CACHE_DIR"
  export npm_config_cache="${npm_config_cache:-$NPM_CACHE_DIR}"
  export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$npm_config_cache}"
}
