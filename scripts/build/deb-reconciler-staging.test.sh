#!/usr/bin/env bash
set -euo pipefail

# Package-contract test: the post-boot add-on reconciler oneshot
# (ceralive-addon-reconciler.service) MUST be staged into the ceralive-device .deb
# and enabled by the maintainer postinst. Regression guard for the T29 reconciler
# (a dropped unit means add-on state is never reconciled after an OTA).

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

build_script="scripts/build/build-debian-package.sh"
unit="deployment/ceralive-addon-reconciler.service"
unit_basename="ceralive-addon-reconciler.service"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

# --- Part A: static contract on the source artifact + build script --------------

[[ -f "$unit" ]] || fail "reconciler unit missing from source of truth: $unit"

grep -Fq 'systemctl enable ceralive-addon-reconciler.service' "$build_script" \
  || fail "postinst does not enable ceralive-addon-reconciler.service"

# The unit must be staged into the packaged systemd system dir from deployment/
# (not dist/) so packaging never depends on smart_build's deployment/*->dist/ mirror.
staging_line="$(grep -E "cp[[:space:]]+deployment/${unit_basename}[[:space:]]+\"\\\$TEMP_DIR/etc/systemd/system/\"" "$build_script" || true)"
[[ -n "$staging_line" ]] \
  || fail "build script does not stage $unit_basename from deployment/ into etc/systemd/system/"

# --- Part B: real fpm round-trip — the unit survives into a scratch .deb ---------
# Builds a minimal package from a tree staged EXACTLY as build-debian-package.sh
# stages the reconciler, then lists the .deb payload (ar + tar; no dpkg-deb needed).

command -v fpm >/dev/null 2>&1 || fail "fpm not on PATH (required build dependency)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

stage="$work/temp"
mkdir -p "$stage/etc/systemd/system" "$stage/usr/local/bin"
cp "$unit" "$stage/etc/systemd/system/$unit_basename"
printf '#!/bin/sh\ntrue\n' > "$stage/usr/local/bin/ceralive"
chmod +x "$stage/usr/local/bin/ceralive"

(
  cd "$work"
  fpm -s dir -t deb \
    -n ceralive-device-recontract \
    -v 0.0.0 \
    -a all \
    --iteration test \
    --maintainer 'contract@ceralive.tv' \
    --description 'reconciler staging contract' \
    --deb-no-default-config-files \
    -C temp \
    . >/dev/null
)

shopt -s nullglob
deb_candidates=("$work"/*.deb)
[[ ${#deb_candidates[@]} -gt 0 ]] || fail "fpm did not emit a .deb"
deb="${deb_candidates[0]}"

listing_dir="$work/listing"
mkdir -p "$listing_dir"
( cd "$listing_dir" && ar x "$deb" )
data_candidates=("$listing_dir"/data.tar.*)
[[ ${#data_candidates[@]} -gt 0 ]] || fail "no data.tar.* member in the built .deb"
data_tar="${data_candidates[0]}"

# GNU tar auto-detects the compression on read.
if ! tar tf "$data_tar" | grep -Eq "(^|\\./)etc/systemd/system/${unit_basename}\$"; then
  fail "reconciler unit is NOT present in the scratch .deb payload"
fi

printf 'PASS: ceralive-addon-reconciler.service is staged from deployment/, enabled in postinst, and lands in the .deb\n'
