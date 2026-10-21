#!/usr/bin/env bash
# Perl mutation recipes must receive literal shell variable names and backreferences.
# shellcheck disable=SC2016
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
awk '/^cat > dist\/debian\/postinst / { inside=1; next }
    inside && /^EOF$/ { exit } inside { print }' \
    scripts/build/build-debian-package.sh > "$work/postinst"

kill_mutant() {
    local name=$1 scenario=$2 expression=$3 rc=0
    # Given: a single broken branch in the real generated maintainer script.
    perl -0pe "$expression" "$work/postinst" > "$work/$name"
    if cmp -s "$work/postinst" "$work/$name"; then
        printf 'FAIL: mutant %s did not change the script\n' "$name" >&2
        exit 1
    fi
    bash -n "$work/$name"
    # When: exercise the behavior whose implementation was broken.
    POSTINST_UNDER_TEST="$work/$name" bash scripts/build/deb-public-link.test.sh "$scenario" > "$work/output" 2>&1 || rc=$?
    # Then: an observable contract assertion, not a syntax error, must reject it.
    if [[ $rc != 1 ]] || ! grep -q '^FAIL:' "$work/output"; then
        printf 'FAIL: mutant %s survived (rc=%s): %s\n' "$name" "$rc" "$(< "$work/output")" >&2
        exit 1
    fi
    printf 'KILLED: %s (%s): %s\n' "$name" "$scenario" "$(< "$work/output")"
}

kill_mutant directory directory 's/mv -T -- "\$public_path" "\$stale_path"/true/'
kill_mutant nested-data nested-stale 's/mv -T -- "\$public_path" "\$stale_path"/rm -rf -- "\$public_path"/'
kill_mutant wrong-target wrong-link 's/ln -sfnT -- \/var\/www\/ceralive "\$public_path"/true/'
kill_mutant exact-target newline-link 's/public_target=\$\(readlink[^\n]+return 1/public_target="\/var\/www\/ceralive."/'
kill_mutant missing missing 's/ln -s -- \/var\/www\/ceralive "\$public_path"/true/'
kill_mutant correct-noop correct 's/\[ "\$public_target" != [^\n]+return 0/false/'
kill_mutant file file 's/if \[ -e "\$public_path" \]; then/if [ -d "\$public_path" ]; then/'
kill_mutant fifo fifo 's/if \[ -e "\$public_path" \]; then/if [ -f "\$public_path" ]; then/'
kill_mutant socket socket 's/if \[ -e "\$public_path" \]; then/if [ -f "\$public_path" ]; then/'
kill_mutant nonfatal permission 's/>&2 \|\| true/>&2; exit 1/'
kill_mutant warning permission "s/ceralive-postinst: warning: could not fully repair/ceralive-postinst: repair/"
kill_mutant idempotent twice 's/\[ "\$public_target" != [^\n]+return 0/false/'
kill_mutant collision collision 's/while \[ -e "\$stale_path" \] \|\| \[ -L "\$stale_path" \]; do/while false; do/'
kill_mutant dangling-collision collision 's/ \|\| \[ -L "\$stale_path" \]//'
kill_mutant cap cap 's/"\$stale_count" -gt 3/"\$stale_count" -gt 4/'
kill_mutant order cap 's/sort -rV/sort -V/'
kill_mutant exact-pattern cap 's/\[\[ "\$\{stale_path##\*\/\}" =~ \$stale_pattern \]\] \|\| continue/true/'
kill_mutant real-directories cap 's/\[ ! -L "\$stale_path" \]/true/g'
kill_mutant configure fresh 's/if \[ "\$1" = "configure" \]; then/if [ -n "\$2" ]; then/'
kill_mutant action other-action 's/if \[ "\$1" = "configure" \]; then/if true; then/'
kill_mutant restart-order directory 's/(    repair_public_link[^\n]+\n        printf[^\n]+\n    \}\n)(.*)(\nfi\n)/$2\n$1$3/s'
kill_mutant link-error link-failure 's/ln -s -- \/var\/www\/ceralive "\$public_path" \|\| return 1/ln -s -- \/var\/www\/ceralive "\$public_path" || true/'
kill_mutant date-error date-failure 's/stale_stamp=\$\(date -u \+%Y%m%dT%H%M%SZ\) \|\| return 1/stale_stamp=\$(date -u +%Y%m%dT%H%M%SZ) || true/'
kill_mutant prune-error prune-failure 's/rm -rf -- "\$stale_path" \|\| return 1/rm -rf -- "\$stale_path" || true/'
