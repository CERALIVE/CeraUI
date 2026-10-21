#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
[[ $(id -u) -ne 0 ]] || fail 'must run unprivileged, including the permission test'
work=$(mktemp -d)
trap 'chmod -R u+w "$work"; rm -rf "$work"' EXIT
postinst=${POSTINST_UNDER_TEST:-$work/postinst}
if [[ -z ${POSTINST_UNDER_TEST:-} ]]; then
    awk '/^cat > dist\/debian\/postinst / { inside=1; next }
        inside && /^EOF$/ { exit } inside { print }' \
        scripts/build/build-debian-package.sh > "$postinst"
fi
[[ -s $postinst ]] || fail 'generated postinst missing'
mkdir "$work/stubs"
for cmd in systemctl deb-systemd-invoke udevadm id useradd chown chmod; do
    cat > "$work/stubs/$cmd" <<'STUB'
#!/bin/bash
printf '%s %s\n' "${0##*/}" "$*" >> "$TEST_COMMAND_LOG"
if [[ $* == 'restart ceralive.service' ]]; then
    if [[ $(readlink -n -- "$CERALIVE_PUBLIC_LINK_TEST_ROOT/opt/ceralive/public"; printf '.') == /var/www/ceralive. ]]; then
        printf 'restart-with-correct-link\n' >> "$TEST_COMMAND_LOG"
    else
        printf 'restart-with-stale-link\n' >> "$TEST_COMMAND_LOG"
    fi
fi
STUB
    chmod +x "$work/stubs/$cmd"
done
cat > "$work/stubs/date" <<'STUB'
#!/bin/bash
printf '20261021T170000Z\n'
STUB
chmod +x "$work/stubs/date"

run_case() (
    local name=$1 root="$work/$1 root" parent public before='' rc=0
    local -a argv=(configure 2026.9.5) backups=()
    parent="$root/opt/ceralive"
    public="$parent/public"
    mkdir -p "$parent" "$root/run"
    # Given: each invocation has its own filesystem and command log.
    case "$name" in
        directory|nested-stale|twice|collision|cap|prune-failure|rename-failure)
            mkdir "$public"
            printf 'old frontend\n' > "$public/index.html"
            ;;
        wrong-link) ln -s /old/frontend "$public" ;;
        newline-link) ln -s $'/var/www/ceralive\n' "$public" ;;
        dangling-link) ln -s /missing/frontend "$public" ;;
        correct)
            ln -s /var/www/ceralive "$public"
            before=$(stat -c '%i:%y:%z' "$public")
            ;;
        file) printf 'old file\n' > "$public" ;;
        fifo) mkfifo "$public" ;;
        socket) perl -MSocket -e 'socket(my $s, PF_UNIX, SOCK_STREAM, 0) or die $!; bind($s, sockaddr_un($ARGV[0])) or die $!' "$public" ;;
        permission) chmod 0555 "$parent" ;;
        fresh) argv=(configure) ;;
        other-action) argv=(abort-upgrade); mkdir "$public" ;;
        missing|link-failure|date-failure|sort-failure) ;;
        *) fail "unknown case $name" ;;
    esac
    case "$name" in
        nested-stale) printf 'keep nested data\n' > "$public/public.stale-20000101T000000Z" ;;
        collision)
            mkdir "$parent/public.stale-20261021T170000Z"
            printf 'previous backup\n' > "$parent/public.stale-20261021T170000Z/keep"
            ln -s /missing "$parent/public.stale-20261021T170000Z-1"
            ;;
        cap|prune-failure)
            for day in 01 02 03 04; do
                mkdir "$parent/public.stale-202601${day}T000000Z"
                # Directory mtimes are not backup creation times.
                touch -t "202001${day}0000" "$parent/public.stale-202601${day}T000000Z"
            done
            mkdir "$parent/public.stale-do-not-delete" "$parent/public.stale-20260101T000000Z-unsafe"
            printf 'file backup\n' > "$parent/public.stale-20250101T000000Z"
            mkdir "$root/outside"
            printf 'outside data\n' > "$root/outside/keep"
            ln -s "$root/outside" "$parent/public.stale-20240101T000000Z"
            ;;
        date-failure) mkdir "$public" ;;
    esac
    mkdir "$root/bin"
    case "$name" in
        rename-failure) printf '#!/bin/sh\nexit 1\n' > "$root/bin/mv" ;;
        link-failure) printf '#!/bin/sh\nexit 1\n' > "$root/bin/ln" ;;
        date-failure) printf '#!/bin/sh\nexit 1\n' > "$root/bin/date" ;;
        prune-failure) printf '#!/bin/sh\nexit 1\n' > "$root/bin/rm" ;;
        sort-failure) printf '#!/bin/sh\nexit 1\n' > "$root/bin/sort" ;;
    esac
    chmod -R u+x "$root/bin"
    # When: run the actual generated configure path with harmless service stubs.
    env PATH="$root/bin:$work/stubs:$PATH" \
        CERALIVE_PUBLIC_LINK_TEST_ROOT="$root" CERALIVE_SYSTEMD_RUN_DIR="$root/run" \
        TEST_COMMAND_LOG="$root/commands" \
        /bin/bash "$postinst" "${argv[@]}" > "$root/out" 2> "$root/err" || rc=$?
    # Then: repair is nonfatal, precedes restart, and preserves displaced data.
    [[ $rc == 0 ]] || fail "$name: install failed ($rc)"
    shopt -s nullglob
    backups=("$parent"/public.stale-*)
    case "$name" in
        permission|rename-failure|link-failure|date-failure|prune-failure|sort-failure)
            [[ $(wc -l < "$root/err") == 1 ]] || fail "$name: expected one warning"
            grep -qi 'warning.*public' "$root/err" || fail "$name: unclear warning"
            grep -q 'restart ceralive.service' "$root/commands" || fail "$name: did not continue"
            ;;
        other-action)
            [[ -d $public && ! -L $public && ${#backups[@]} == 0 ]] || fail 'repair on non-configure action'
            ;;
        *)
            [[ -L $public && $(readlink -n "$public"; printf '.') == /var/www/ceralive. ]] || fail "$name: stale public"
            [[ ! -s $root/err ]] || fail "$name: unexpected warning"
            if [[ $name != fresh ]]; then
                grep -qx 'restart-with-correct-link' "$root/commands" || fail "$name: repair after restart"
            fi
            ;;
    esac
    case "$name" in
        directory|nested-stale|twice)
            [[ ${#backups[@]} == 1 && $(< "${backups[0]}/index.html") == 'old frontend' ]] || fail "$name: data lost"
            ;;
        wrong-link|newline-link|dangling-link|missing|correct|fresh)
            [[ ${#backups[@]} == 0 ]] || fail "$name: unnecessary backup"
            ;;
        file) [[ ${#backups[@]} == 1 && $(< "${backups[0]}") == 'old file' ]] || fail 'file lost' ;;
        fifo) [[ ${#backups[@]} == 1 && -p ${backups[0]} ]] || fail 'fifo lost' ;;
        socket) [[ ${#backups[@]} == 1 && -S ${backups[0]} ]] || fail 'socket lost' ;;
        rename-failure|date-failure) [[ -f $public/index.html || $name == date-failure && -d $public ]] || fail 'failed repair lost original' ;;
    esac
    case "$name" in
        correct) [[ $(stat -c '%i:%y:%z' "$public") == "$before" ]] || fail 'correct link modified' ;;
        nested-stale) [[ $(< "${backups[0]}/public.stale-20000101T000000Z") == 'keep nested data' ]] || fail 'nested file lost' ;;
        collision)
            [[ -f $parent/public.stale-20261021T170000Z/keep && -L $parent/public.stale-20261021T170000Z-1 && -f $parent/public.stale-20261021T170000Z-2/index.html ]] || fail 'collision overwrote backup'
            ;;
        cap)
            [[ ! -e $parent/public.stale-20260101T000000Z && ! -e $parent/public.stale-20260102T000000Z ]] || fail 'old backups retained'
            [[ -d $parent/public.stale-20260103T000000Z && -d $parent/public.stale-20260104T000000Z && -f $parent/public.stale-20261021T170000Z/index.html ]] || fail 'newest three not retained'
            [[ -d $parent/public.stale-do-not-delete && -d $parent/public.stale-20260101T000000Z-unsafe && -f $parent/public.stale-20250101T000000Z && -L $parent/public.stale-20240101T000000Z && -f $root/outside/keep ]] || fail 'pruning escaped exact real directories'
            ;;
        fresh) ! grep -q 'restart ceralive.service' "$root/commands" || fail 'fresh install restarted' ;;
        twice)
            before=$(stat -c '%i:%y:%z' "$public")
            env PATH="$work/stubs:$PATH" CERALIVE_PUBLIC_LINK_TEST_ROOT="$root" \
                CERALIVE_SYSTEMD_RUN_DIR="$root/run" TEST_COMMAND_LOG="$root/commands" \
                /bin/bash "$postinst" configure 2026.9.5 > "$root/out" 2> "$root/err"
            backups=("$parent"/public.stale-*)
            [[ ${#backups[@]} == 1 && $(stat -c '%i:%y:%z' "$public") == "$before" && ! -s $root/err ]] || fail 'second run changed repair'
            ;;
    esac
    printf 'PASS: public-link %s\n' "$name"
)

if [[ $# -gt 0 ]]; then
    run_case "$1"
else
    for name in directory nested-stale wrong-link newline-link dangling-link missing correct file fifo socket permission twice collision cap fresh other-action rename-failure link-failure date-failure prune-failure sort-failure; do
        run_case "$name"
    done
fi
