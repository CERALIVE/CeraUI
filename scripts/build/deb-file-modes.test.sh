#!/usr/bin/env bash
# Variables and stub functions are consumed by the dynamically extracted builder.
# shellcheck disable=SC2034,SC2317
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
export LC_ALL=C

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
command -v fpm >/dev/null || fail 'fpm not on PATH (required build dependency)'
command -v dpkg-deb >/dev/null || fail 'dpkg-deb not on PATH (required package inspection tool)'

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Execute the real staging block, not a copy of its permission policy. Only the
# compiled recovery binary is a fixture; compilation is outside this contract.
awk '/^# Create directory structure$/ { emit=1 }
     emit { print }
     emit && /^cd \.\.\/\.\.$/ { exit }' scripts/build/build-debian-package.sh > "$work/stage.sh"
[[ -s "$work/stage.sh" ]] || fail 'package staging block not found'

for mask in 077 022; do
  (
    umask "$mask"
    cd "$work"
    mkdir -p "$mask/dist/public/assets" "$mask/dist/debian" "$mask/apps/backend"
    cd "$mask"
    ln -s "$repo_root/deployment" deployment
    cp "$repo_root/apps/backend/ceralive-addon-helper" apps/backend/
    cp "$repo_root/apps/backend/ceralive-addon-helper.sudoers" apps/backend/
    cp "$repo_root/apps/backend/setup.json" apps/backend/
    cp "$repo_root/deployment/"{ceralive.service,98-ceralive-audio.rules,99-ceralive-check-usb-devices.rules,override-ceralive.sh,reset-to-default.sh} dist/
    printf '#!/bin/sh\nexit 0\n' > dist/ceralive
    printf '{}\n' > dist/config.json
    printf '<html>fixture</html>\n' > dist/public/index.html
    printf 'fixture asset\n' > 'dist/public/assets/with space.js'
    # Copied artifacts can carry unrelated executable bits even with umask 022.
    chmod 0777 'dist/public/assets/with space.js'
    ln -s index.html dist/public/index-link.html
    TEMP_DIR="$PWD/dist/debian/temp"
    PACKAGE_NAME=ceralive-device-modes
    VERSION=0.0.0
    ITERATION='test'
    MAINTAINER=contract@ceralive.tv
    DESCRIPTION='payload mode contract'
    URL=https://ceralive.tv
    IPC_VPKG=cerastream-ipc-1
    COMMIT=fixture
    CERAUI_VERSION=2026.9.5
    ARCHITECTURE=arm64
    log_step() { :; }
    log_error() { fail "$1"; }
    bun() {
      [[ "$*" == 'build apps/backend/src/modules/system/update-orchestrator/recovery-cli.ts --compile --target=bun-linux-arm64 --outfile='* ]] \
        || fail 'unexpected compilation command'
      local outfile="${!#}"
      printf '#!/bin/sh\nexit 0\n' > "${outfile#--outfile=}"
    }
    # shellcheck source=/dev/null
    source "$work/stage.sh" > "$work/$mask-fpm.log" 2>&1
    dpkg-deb --fsys-tarfile dist/debian/ceralive-device-modes_0.0.0-test_arm64.deb > "$work/$mask.tar"
    tar -tvf "$work/$mask.tar" | sed -E 's/^(.{10}) [^ ]+ +[0-9]+ [0-9-]+ [0-9:]+ /\1 /' | sort > "$work/$mask.modes"
    cut -d ' ' -f1 "$work/$mask.modes" | sort | uniq -c > "$work/$mask.histogram"
    mkdir extracted
    dpkg-deb -x dist/debian/ceralive-device-modes_0.0.0-test_arm64.deb extracted
    (
      cd "$TEMP_DIR"
      find . -type f -print0 | sort -z | xargs -0 sha256sum > "$work/$mask.hashes"
    )
    (cd extracted && sha256sum -c "$work/$mask.hashes" > /dev/null)
  )
done

diff -u "$work/022.histogram" "$work/077.histogram" || fail 'mode histograms depend on builder umask'
diff -u "$work/022.modes" "$work/077.modes" || fail 'per-path modes depend on builder umask'
diff -u "$work/022.hashes" "$work/077.hashes" || fail 'payload content depends on builder umask'

while read -r mode path; do
  [[ "$(stat -c '%a' "$work/077/extracted/$path")" == "$mode" ]] || fail "wrong mode for $path (expected $mode)"
done << 'EOF'
755 usr/local/bin/ceralive
755 usr/local/bin/override-ceralive.sh
755 usr/local/bin/reset-to-default.sh
755 usr/bin/ceralive-addon-helper
700 usr/sbin/ceralive-update-recover
700 usr/libexec/ceralive/ceralive-update-recover
700 usr/libexec/ceralive/ceralive-os-stage-guard
700 usr/libexec/ceralive/ceralive-nbd-release
440 etc/sudoers.d/ceralive-addon-helper
644 var/www/ceralive/index.html
644 var/www/ceralive/assets/with space.js
755 var/www/ceralive/assets
EOF
[[ "$(readlink "$work/077/extracted/opt/ceralive/public")" == /var/www/ceralive ]] || fail 'public symlink changed'
[[ "$(readlink "$work/077/extracted/var/www/ceralive/index-link.html")" == index.html ]] || fail 'asset symlink changed'
printf 'PASS: umask 077 and 022 produce identical per-path modes, histograms and payload hashes; executable, private-helper and 0440 sudoers modes preserved\n'
