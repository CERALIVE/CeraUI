#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
source=deployment/ceralive-os-stage-guard
builder=scripts/build/build-debian-package.sh
grep -Fq 'cp deployment/ceralive-os-stage-guard "$TEMP_DIR/usr/libexec/ceralive/ceralive-os-stage-guard"' "$builder"
grep -Fq 'chmod 0700 "$TEMP_DIR/usr/libexec/ceralive/ceralive-os-stage-guard"' "$builder"
bash -n "$source"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/stage/usr/libexec/ceralive"
cp "$source" "$work/stage/usr/libexec/ceralive/ceralive-os-stage-guard"
chmod 0700 "$work/stage/usr/libexec/ceralive/ceralive-os-stage-guard"
fpm -s dir -t deb -n ceralive-os-guard-contract -v 0.0.0 -a all \
    --maintainer contract@ceralive.tv --description 'OS guardian contract' \
    --deb-no-default-config-files --package "$work/guard.deb" -C "$work/stage" . >/dev/null
dpkg-deb -x "$work/guard.deb" "$work/extracted"
installed="$work/extracted/usr/libexec/ceralive/ceralive-os-stage-guard"
[[ -x $installed && $(stat -c '%a' "$installed") == 700 ]]
if grep -Fq 'CERALIVE_OS_GUARD_TEST' "$installed"; then
    printf 'FAIL: packaged guardian contains production test selectors\n' >&2
    exit 1
fi
dpkg-deb --fsys-tarfile "$work/guard.deb" | tar --numeric-owner -tvf - ./usr/libexec/ceralive/ceralive-os-stage-guard > "$work/helper-metadata"
read -r mode ownership _ < "$work/helper-metadata"
[[ $mode == -rwx------ && $ownership == 0/0 ]]
cmp "$source" "$installed"
printf 'PASS: fixed OS guardian is packaged byte-identically and root-only executable\n'
