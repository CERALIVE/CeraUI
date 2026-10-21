#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
# The mount lives only in a private, unprivileged user/mount namespace.
if [[ ${1:-} == namespace ]]; then
    mount_path=$2; shift 2
    mount -t tmpfs tmpfs "$mount_path"
    printf 'mounted data\n' > "$mount_path/keep"
    "$@"
    [[ $(< "$mount_path/keep") == 'mounted data' ]] || fail 'nested mount emptied'
    exit 0
fi
[[ $(id -u) -ne 0 ]] || fail 'must run unprivileged'
work=$(mktemp -d)
trap 'chmod -R u+w "$work"; rm -rf "$work"' EXIT
postinst=${POSTINST_UNDER_TEST:-$work/postinst}
if [[ -z ${POSTINST_UNDER_TEST:-} ]]; then
    awk '/^cat > dist\/debian\/postinst / { inside=1; next }
        inside && /^EOF$/ { exit } inside { print }' \
        scripts/build/build-debian-package.sh > "$postinst"
fi
mkdir "$work/stubs"
for cmd in systemctl deb-systemd-invoke udevadm id useradd chown chmod; do
    cat > "$work/stubs/$cmd" <<'STUB'
#!/bin/bash
printf '%s %s\n' "${0##*/}" "$*" >> "$TEST_COMMAND_LOG"
STUB
done
printf '#!/bin/bash\nprintf "20261021T170000Z\\n"\n' > "$work/stubs/date"
chmod +x "$work/stubs/"*

run_case() (
    local name=$1 root="$work/$1" parent public rc=0 loc=C.UTF-8 suffix
    parent="$root/opt/ceralive"; public="$parent/public"
    mkdir -p "$public" "$root/run" "$root/bin"
    printf 'original data\n' > "$public/index.html"
    # Given: hostile names, failed creation, races, or retention pressure.
    case "$name" in
        locale)
            if locale -a | grep -qix en_US.utf8; then loc=en_US.UTF-8
            else printf 'SKIPPED: en_US.UTF-8 unavailable; testing explicit non-ASCII names under C.UTF-8\n'; fi
            for suffix in １ ２ ３ ４ ١ ٢ ٣ ٤; do
                mkdir "$parent/public.stale-2020010${suffix}T000000Z"
                printf keep > "$parent/public.stale-2020010${suffix}T000000Z/keep"
            done
            ;;
        restore|restore-failure|race)
            cat > "$root/bin/ln" <<'STUB'
#!/bin/bash
case "$TEST_SCENARIO" in
    restore|restore-failure) exit 1 ;;
    race) mkdir -- "${@: -1}"; printf racer > "${@: -1}/racer"; exec /usr/bin/ln "$@" ;;
esac
STUB
            if [[ $name == restore-failure ]]; then
                cat > "$root/bin/mv" <<'STUB'
#!/bin/bash
[[ $3 == */public ]] || exit 1
exec /usr/bin/mv "$@"
STUB
            fi
            ;;
        clock)
            for suffix in 2030 2031 2032 2033; do mkdir "$parent/public.stale-${suffix}0101T000000Z"; done
            ;;
        suffix|large-suffix)
            for suffix in '' -1 -2 -9 -10; do mkdir "$parent/public.stale-20261021T170000Z$suffix"; done
            if [[ $name == large-suffix ]]; then
                mkdir "$parent/public.stale-20261021T170000Z-999999999999999999999999999999"
            fi
            ;;
        filesystem|nested-mount)
            for suffix in 01 02 03 04; do mkdir "$parent/public.stale-202601${suffix}T000000Z"; done
            mkdir "$parent/public.stale-20200101T000000Z"
            if [[ $name == filesystem ]]; then
                cat > "$root/bin/rm" <<'STUB'
#!/bin/bash
printf '%s\n' "$@" >> "$TEST_COMMAND_LOG.rm"
exec /usr/bin/rm "$@"
STUB
            else mkdir "$parent/public.stale-20200101T000000Z/mnt"; fi
            ;;
        *) fail "unknown hardening case $name" ;;
    esac
    chmod -R u+x "$root/bin"
    local -a command=(env LC_ALL="$loc" PATH="$root/bin:$work/stubs:$PATH"
        TEST_SCENARIO="$name" CERALIVE_PUBLIC_LINK_TEST_ROOT="$root"
        CERALIVE_SYSTEMD_RUN_DIR="$root/run" TEST_COMMAND_LOG="$root/commands"
        /bin/bash "$postinst" configure 2026.9.5)
    # When: execute the generated configure path, not a copy of the function.
    if [[ $name == nested-mount ]]; then
        if unshare -rm true 2>/dev/null; then
            unshare -rm --propagation private /bin/bash "${BASH_SOURCE[0]}" namespace \
                "$parent/public.stale-20200101T000000Z/mnt" "${command[@]}" > "$root/out" 2> "$root/err" || rc=$?
        else
            printf 'SKIPPED: nested mount requires unprivileged unshare -rm; filesystem case checks rm argv\n'
            return 0
        fi
    else "${command[@]}" > "$root/out" 2> "$root/err" || rc=$?; fi
    # Then: configure/restart continue, data stays safe, only real directories count.
    [[ $rc == 0 ]] || fail "$name: configure/namespace failed ($rc)"
    grep -q 'restart ceralive.service' "$root/commands" || fail "$name: restart stopped"
    case "$name" in
        restore|restore-failure|race|nested-mount)
            [[ $(wc -l < "$root/err") == 1 ]] || fail "$name: expected single warning"
            grep -q 'warning.*public' "$root/err" || fail "$name: missing warning"
            ;;
        *) [[ ! -s $root/err ]] || fail "$name: unexpected warning" ;;
    esac
    case "$name" in
        locale)
            for suffix in １ ２ ３ ４ ١ ٢ ٣ ٤; do
                [[ -f $parent/public.stale-2020010${suffix}T000000Z/keep ]] || fail 'locale: non-ASCII directory pruned'
            done
            ;;
        restore) [[ -f $public/index.html && $(< "$public/index.html") == 'original data' ]] || fail 'restore: original not restored' ;;
        restore-failure) [[ -f $parent/public.stale-20261021T170000Z/index.html ]] || fail 'restore failure lost backup' ;;
        race) [[ -d $public && ! -L $public/ceralive && -f $parent/public.stale-20261021T170000Z/index.html ]] || fail 'race: nested link or lost backup' ;;
        clock)
            [[ -f $parent/public.stale-20261021T170000Z/index.html ]] || fail 'clock: fresh backup pruned'
            [[ ! -e $parent/public.stale-20300101T000000Z ]] || fail 'clock: oldest previous retained'
            for suffix in 2031 2032 2033; do [[ -d $parent/public.stale-${suffix}0101T000000Z ]] || fail 'clock: newest previous lost'; done
            ;;
        suffix) [[ -f $parent/public.stale-20261021T170000Z-11/index.html ]] || fail 'suffix: not highest plus one' ;;
        large-suffix) [[ -f $parent/public.stale-20261021T170000Z-1000000000000000000000000000000/index.html ]] || fail 'suffix: overflow' ;;
        filesystem) grep -qx -- --one-file-system "$root/commands.rm" || fail 'filesystem: missing rm boundary' ;;
    esac
    printf 'PASS: public-link hardening-%s\n' "$name"
)
if [[ $# -gt 0 ]]; then run_case "$1"
else
    for name in locale restore restore-failure race clock suffix large-suffix filesystem nested-mount; do run_case "$name"; done
fi
