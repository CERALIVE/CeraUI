#!/usr/bin/env bash
set -euo pipefail

# Package-contract test: the ceralive-device .deb MUST stamp BOTH build-time
# facts into /opt/ceralive — the CalVer version the backend promotes, and the
# commit it demotes behind it. A missing `version` file sends the device's
# Versions row back to reporting CeraUI's own build as a bare git short-SHA
# while every neighbouring row shows a real version.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

build_script="scripts/build/build-debian-package.sh"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

# --- Part A: the version source is package.json, executed rather than grepped --

# shellcheck source=scripts/build/shared-build-functions.sh
source scripts/build/shared-build-functions.sh

stamped="$(get_ceraui_version)"
declared="$(bun -p "require('./package.json').version")"

[[ -n "$stamped" ]] || fail "get_ceraui_version produced nothing"
[[ "$stamped" == "$declared" ]] \
  || fail "get_ceraui_version ($stamped) does not match package.json ($declared)"

printf '%s' "$stamped" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' \
  || fail "stamped version is not CalVer-shaped: $stamped"

# --- Part B: static contract on the build script -------------------------------

grep -Fq 'CERAUI_VERSION=$(get_ceraui_version)' "$build_script" \
  || fail "build script does not derive CERAUI_VERSION from get_ceraui_version"

grep -Fq 'printf '"'"'%s\n'"'"' "$CERAUI_VERSION" > "$TEMP_DIR/opt/ceralive/version"' "$build_script" \
  || fail "build script does not stamp \$CERAUI_VERSION into opt/ceralive/version"

# The commit stamp keeps its exact meaning; the version is a SIBLING, not a
# repurposing of `revision` (which the backend still reads as build metadata).
grep -Fq 'printf '"'"'%s\n'"'"' "$COMMIT" > "$TEMP_DIR/opt/ceralive/revision"' "$build_script" \
  || fail "build script no longer stamps \$COMMIT into opt/ceralive/revision"

# --- Part C: the staged tree really carries both files --------------------------
# Replays the two stamping lines against a scratch tree staged exactly as the
# build script stages them, so a typo in either path fails here rather than on a
# device.

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

TEMP_DIR="$work/temp"
mkdir -p "$TEMP_DIR/opt/ceralive"
COMMIT="$(get_commit)"
printf '%s\n' "$COMMIT" > "$TEMP_DIR/opt/ceralive/revision"
printf '%s\n' "$stamped" > "$TEMP_DIR/opt/ceralive/version"

[[ "$(cat "$TEMP_DIR/opt/ceralive/version")" == "$stamped" ]] \
  || fail "staged version stamp does not round-trip"
[[ -s "$TEMP_DIR/opt/ceralive/revision" ]] \
  || fail "staged revision stamp is empty"

printf 'PASS: the .deb stamps package.json CalVer into opt/ceralive/version and keeps the commit in opt/ceralive/revision\n'
