#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
source=deployment/ceralive-nbd-release
builder=scripts/build/build-debian-package.sh
grep -Fq 'cp deployment/ceralive-nbd-release "$TEMP_DIR/usr/libexec/ceralive/ceralive-nbd-release"' "$builder"
grep -Fq 'chmod 0700 "$TEMP_DIR/usr/libexec/ceralive/ceralive-nbd-release"' "$builder"
grep -Fq 'chown root:root /usr/libexec/ceralive/ceralive-nbd-release' "$builder"
grep -Fq 'chmod 0700 /usr/libexec/ceralive/ceralive-nbd-release' "$builder"
perl -c "$source"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/stage/usr/libexec/ceralive"
cp "$source" "$work/stage/usr/libexec/ceralive/ceralive-nbd-release"
chmod 0700 "$work/stage/usr/libexec/ceralive/ceralive-nbd-release"
fpm -s dir -t deb -n ceralive-nbd-release-contract -v 0.0.0 -a all \
    --maintainer contract@ceralive.tv --description 'NBD release contract' \
    --deb-no-default-config-files --package "$work/helper.deb" -C "$work/stage" . >/dev/null
dpkg-deb -x "$work/helper.deb" "$work/extracted"
installed="$work/extracted/usr/libexec/ceralive/ceralive-nbd-release"
[[ -x $installed && $(stat -c '%a' "$installed") == 700 ]]
if grep -Fq 'CERALIVE_NBD_' "$installed"; then
    printf 'FAIL: packaged NBD helper contains production test selectors\n' >&2
    exit 1
fi
dpkg-deb --fsys-tarfile "$work/helper.deb" | tar --numeric-owner -tvf - ./usr/libexec/ceralive/ceralive-nbd-release > "$work/helper-metadata"
read -r mode ownership _ < "$work/helper-metadata"
[[ $mode == -rwx------ && $ownership == 0/0 ]]
cmp "$source" "$installed"
printf 'PASS: fixed NBD helper is packaged byte-identically and root-only executable without test selectors\n'
