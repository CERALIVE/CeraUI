#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
expected_commit="$(git -C "$repo_root" rev-parse --short HEAD)"
expected_hash="$(git -C "$repo_root" rev-parse HEAD)"
expected_version="$(git -C "$repo_root" describe --tags --abbrev=0 2>/dev/null | sed 's/v//' || printf '1.0.0\n')"
caller_repo="$(mktemp -d "$repo_root/.build-provenance.XXXXXX")"
trap 'rm -rf "$caller_repo"' EXIT

git -C "$caller_repo" init -q
git -C "$caller_repo" config user.name 'Build Provenance Test'
git -C "$caller_repo" config user.email 'build-provenance@invalid'
git -C "$caller_repo" commit --allow-empty -qm 'nested caller fixture'
git -C "$caller_repo" tag v9999.12.34

mapfile -t actual < <({
  cd "$caller_repo"
  unset BUILD_VERSION
  source "$repo_root/scripts/build/shared-build-functions.sh"
  printf '%s\n' \
    "$BUILD_REPO_ROOT" \
    "$CACHE_DIR" \
    "$(get_commit)" \
    "$(get_git_hash)" \
    "$(get_version)"
})

if [[ "${actual[0]}" != "$repo_root" ]]; then
  printf 'expected build root %s, got %s\n' "$repo_root" "${actual[0]}" >&2
  exit 1
fi
if [[ "${actual[1]}" != "$repo_root/.build-cache" ]]; then
  printf 'expected repo-local cache %s, got %s\n' "$repo_root/.build-cache" "${actual[1]}" >&2
  exit 1
fi
if [[ "${actual[2]}" != "$expected_commit" ]]; then
  printf 'expected CeraUI commit %s from a nested caller, got %s\n' \
    "$expected_commit" "${actual[2]}" >&2
  exit 1
fi
if [[ "${actual[3]}" != "$expected_hash" ]]; then
  printf 'expected CeraUI hash %s from a nested caller, got %s\n' \
    "$expected_hash" "${actual[3]}" >&2
  exit 1
fi
if [[ "${actual[4]}" != "$expected_version" ]]; then
  printf 'expected CeraUI version %s from a nested caller, got %s\n' \
    "$expected_version" "${actual[4]}" >&2
  exit 1
fi
