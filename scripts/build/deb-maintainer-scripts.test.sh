#!/usr/bin/env bash
set -euo pipefail

# Package-contract test: the ceralive-device maintainer scripts MUST honour dpkg's
# $1 action argument.
#
# The defect this guards: the old prerm stopped AND disabled ceralive.service on
# EVERY invocation, including `prerm upgrade`. dpkg runs the OLD prerm before
# unpacking the new package, so a self-update left the unit stopped and disabled —
# and `Restart=always` (deployment/ceralive.service:12) is inert after an explicit
# stop, so the device came back with no control plane until someone SSH'd in.
#
# It runs on a developer workstation and NEVER mutates the host: the maintainer
# scripts are extracted from a scratch .deb and executed unprivileged with PATH
# restricted to a stub directory, so every external command they can reach is a
# logging no-op.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

build_script="scripts/build/build-debian-package.sh"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

# --- Part A: safety preconditions ----------------------------------------------

# Running as root would let a stub miss touch the real system. Fail, never skip:
# a silently-skipped safety test is indistinguishable from a passing one.
[[ "$(id -u)" -ne 0 ]] || fail "this test must run unprivileged (id -u is 0)"

# Same dependency posture as deb-reconciler-staging.test.sh: fpm is a required
# build dependency, not an optional one.
command -v fpm >/dev/null 2>&1 || fail "fpm not on PATH (required build dependency)"
command -v dpkg-deb >/dev/null 2>&1 || fail "dpkg-deb not on PATH (required build dependency)"

[[ -f "$build_script" ]] || fail "build script missing: $build_script"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# --- Part B: extract the generated maintainer scripts ---------------------------
# The build script emits each maintainer script from a quoted heredoc and then
# DELETES it (build-debian-package.sh cleanup step), so the only way to test the
# real bytes is to lift them out of the generator.

extract_heredoc() {
    # $1 = maintainer script name
    awk -v marker="cat > dist/debian/$1 << 'EOF'" '
        $0 == marker { inside = 1; next }
        inside && $0 == "EOF" { inside = 0; next }
        inside { print }
    ' "$build_script"
}

src="$work/src"
mkdir -p "$src"
for script in postinst prerm postrm; do
    extract_heredoc "$script" > "$src/$script"
    [[ -s "$src/$script" ]] || fail "could not extract the generated $script from $build_script"
    chmod +x "$src/$script"
done

# --- Part C: INVENTORY FIRST — no external command may escape the stub set ------
# Every command the extracted scripts can invoke must either be a shell
# builtin/keyword or be one of the commands we stub. A command outside that set
# would run for real under the restricted PATH assertions below.

APPROVED_COMMANDS="systemctl deb-systemd-helper deb-systemd-invoke udevadm id useradd userdel chown chmod rm"
SHELL_WORDS="if then else elif fi for while until do done case esac in function
             set unset export local readonly shift return exit eval exec trap
             echo printf read test true false command builtin : time !"

inventory_external_commands() {
    awk -v allowed="$APPROVED_COMMANDS" -v shellwords="$SHELL_WORDS" '
        BEGIN {
            n = split(allowed, a, /[[:space:]]+/);   for (i = 1; i <= n; i++) ok[a[i]] = 1
            m = split(shellwords, b, /[[:space:]]+/); for (i = 1; i <= m; i++) ok[b[i]] = 1
        }
        {
            line = $0
            sub(/^[[:space:]]+/, "", line)
            sub(/[[:space:]]+$/, "", line)
            if (line == "" || line ~ /^#/) next
            if (line ~ /^[A-Za-z_][A-Za-z0-9_]*=/) next          # variable assignment
            if (line ~ /^[A-Za-z0-9_*?|.\-]+\)$/) next           # case pattern
            if (line ~ /^;;$/) next

            gsub(/&&|\|\||[;|]/, "\n", line)
            k = split(line, frags, "\n")
            for (i = 1; i <= k; i++) {
                f = frags[i]
                sub(/^[[:space:]]+/, "", f)
                while (match(f, /^(if|then|else|elif|while|until|for|do|case|!|time)[[:space:]]+/)) {
                    f = substr(f, RLENGTH + 1)
                }
                if (f == "") continue
                split(f, w, /[[:space:]]+/)
                t = w[1]
                if (t == "" || t == ":" || t == "]" || t == "]]") continue
                if (t ~ /=/) continue
                if (t ~ /^[$"'"'"'\[]/) continue
                if (t ~ /^[0-9<>&-]/) continue
                if (t in ok) continue
                print t
            }
        }
    ' "$1" | sort -u
}

for script in postinst prerm postrm; do
    stray="$(inventory_external_commands "$src/$script")"
    if [[ -n "$stray" ]]; then
        fail "$script invokes command(s) outside the approved stub set: $(echo "$stray" | tr '\n' ' ')"
    fi
done

# --- Part D: build the scratch .deb and take the control member back out --------
# Same fpm round-trip shape as deb-reconciler-staging.test.sh, so the bytes under
# test are the bytes dpkg would run.

stage="$work/temp"
mkdir -p "$stage/usr/local/bin"
printf '#!/bin/sh\ntrue\n' > "$stage/usr/local/bin/ceralive"
chmod +x "$stage/usr/local/bin/ceralive"

(
  cd "$work"
  fpm -s dir -t deb \
    -n ceralive-device-maintainer-contract \
    -v 0.0.0 \
    -a all \
    --iteration test \
    --maintainer 'contract@ceralive.tv' \
    --description 'maintainer script contract' \
    --after-install src/postinst \
    --before-remove src/prerm \
    --after-remove src/postrm \
    --deb-no-default-config-files \
    -C temp \
    . >/dev/null
)

shopt -s nullglob
deb_candidates=("$work"/*.deb)
[[ ${#deb_candidates[@]} -gt 0 ]] || fail "fpm did not emit a .deb"
deb="${deb_candidates[0]}"

ctl="$work/ctl"
mkdir -p "$ctl"
dpkg-deb --control "$deb" "$ctl"
[[ -f "$ctl/postinst" ]] || fail "no postinst in the scratch .deb control member"
[[ -f "$ctl/prerm" ]] || fail "no prerm in the scratch .deb control member"

# The extracted scripts are Bash, so they are run under /bin/bash — never `sh`,
# which would silently change their semantics.
head -1 "$ctl/postinst" | grep -Fq '#!/bin/bash' || fail "postinst is not a bash script"
head -1 "$ctl/prerm" | grep -Fq '#!/bin/bash' || fail "prerm is not a bash script"

# --- Part E: stub every approved external command; nothing else is reachable ----

stubdir="$work/stubs"
mkdir -p "$stubdir"
for cmd in $APPROVED_COMMANDS; do
    cat > "$stubdir/$cmd" <<'STUB'
#!/bin/bash
printf '%s %s\n' "${0##*/}" "$*" >> "$CERALIVE_STUB_LOG"
exit 0
STUB
    chmod +x "$stubdir/$cmd"
done

# A command that escapes the stub PATH is a HARD failure, not a warning — and it
# would otherwise be invisible, because every call site is `|| true`. This
# preamble records the miss so absence-of-log is a real assertion.
preamble="$work/preamble.bash"
cat > "$preamble" <<'PREAMBLE'
command_not_found_handle() {
    printf '%s\n' "$1" >> "$CERALIVE_STUB_MISS_LOG"
    return 127
}
PREAMBLE

stub_log="$work/stub.log"
miss_log="$work/miss.log"

run_maintainer() {
    # $1 = script name, $2 = CERALIVE_SYSTEMD_RUN_DIR value, rest = argv
    local script="$1" rundir="$2"; shift 2
    : > "$stub_log"
    : > "$miss_log"
    local rc=0
    env -u CERALIVE_SYSTEMD_RUN_DIR \
        PATH="$stubdir" \
        BASH_ENV="$preamble" \
        CERALIVE_STUB_LOG="$stub_log" \
        CERALIVE_STUB_MISS_LOG="$miss_log" \
        ${rundir:+CERALIVE_SYSTEMD_RUN_DIR="$rundir"} \
        /bin/bash "$ctl/$script" "$@" > "$work/out.txt" 2>&1 || rc=$?
    [[ $rc -eq 0 ]] || fail "$script $* exited $rc:$(printf '\n%s' "$(cat "$work/out.txt")")"
    assert_no_stub_miss "$script $*"
    assert_log_fully_accounted "$script $*"
}

assert_no_stub_miss() {
    [[ ! -s "$miss_log" ]] \
        || fail "$1 reached a command outside the stub PATH: $(tr '\n' ' ' < "$miss_log")"
}

assert_log_fully_accounted() {
    # Every external invocation that happened must be one of the stubs — proof
    # that no real account creation, ownership change, udev reload or systemd
    # mutation occurred on this arm.
    local logged
    while read -r logged _; do
        [[ -n "$logged" ]] || continue
        case " $APPROVED_COMMANDS " in
            *" $logged "*) ;;
            *) fail "$1 logged an unaccounted external command: $logged" ;;
        esac
    done < "$stub_log"
}

log_has() { grep -Fq "$1" "$stub_log"; }
log_lacks() { ! grep -Fq "$1" "$stub_log"; }

# Non-vacuity: prove the stub-miss probe can actually fail. A probe that never
# fires would leave every assertion above silently green.
probe="$work/probe.sh"
printf '#!/bin/bash\nceralive-definitely-not-a-real-command || true\n' > "$probe"
chmod +x "$probe"
: > "$miss_log"
env PATH="$stubdir" BASH_ENV="$preamble" \
    CERALIVE_STUB_LOG="$stub_log" CERALIVE_STUB_MISS_LOG="$miss_log" \
    /bin/bash "$probe" >/dev/null 2>&1 || true
grep -Fq 'ceralive-definitely-not-a-real-command' "$miss_log" \
    || fail "the stub-miss probe never fires — the PATH isolation assertions are vacuous"

rundir_present="$work/run-systemd-system"
mkdir -p "$rundir_present"
rundir_absent="$work/no-such-run-systemd-system"
[[ ! -d "$rundir_absent" ]] || fail "the absent-branch scratch directory must not exist"

# --- Part F: prerm honours $1 ---------------------------------------------------

run_maintainer prerm "$rundir_present" remove
log_has 'systemctl stop ceralive.service' \
    || fail "prerm remove must stop ceralive.service"
log_has 'systemctl disable ceralive.service' \
    || fail "prerm remove must disable ceralive.service"

run_maintainer prerm "$rundir_present" upgrade 2026.8.5
log_lacks 'stop ceralive.service' \
    || fail "prerm upgrade must NOT stop ceralive.service (dpkg runs it before unpacking the new package)"
log_lacks 'disable ceralive.service' \
    || fail "prerm upgrade must NOT disable ceralive.service (Restart=always is inert after an explicit stop)"

run_maintainer prerm "$rundir_present" deconfigure
log_lacks 'stop ceralive.service' || fail "prerm deconfigure must NOT stop ceralive.service"
run_maintainer prerm "$rundir_present" failed-upgrade 2026.8.5
log_lacks 'stop ceralive.service' || fail "prerm failed-upgrade must NOT stop ceralive.service"

# Exactly one action switch, so a future edit cannot add a second, contradictory
# one further down the script.
[[ "$(grep -c 'case "\$1"' "$ctl/prerm")" -eq 1 ]] \
    || fail "prerm must contain exactly one 'case \"\$1\"' action switch"

# --- Part G: the SYSTEMD_RUN_DIR seam, and its unchanged production default ------

grep -Fq 'SYSTEMD_RUN_DIR="${CERALIVE_SYSTEMD_RUN_DIR:-/run/systemd/system}"' "$ctl/postinst" \
    || fail "postinst must declare the SYSTEMD_RUN_DIR seam with the /run/systemd/system default"

seam_line="$(grep -F 'SYSTEMD_RUN_DIR="${CERALIVE_SYSTEMD_RUN_DIR:-/run/systemd/system}"' "$ctl/postinst")"
production_default="$(env -u CERALIVE_SYSTEMD_RUN_DIR /bin/bash -c "$seam_line"'; printf %s "$SYSTEMD_RUN_DIR"')"
[[ "$production_default" == "/run/systemd/system" ]] \
    || fail "with CERALIVE_SYSTEMD_RUN_DIR unset the seam must resolve to /run/systemd/system (got: $production_default)"

grep -Fq '[ -d "$SYSTEMD_RUN_DIR" ]' "$ctl/postinst" \
    || fail "postinst must gate the restart ladder on [ -d \"\$SYSTEMD_RUN_DIR\" ]"

# --- Part H: postinst — fresh install vs upgrade ---------------------------------

# Upgrade configure ($2 = the previously configured version).
run_maintainer postinst "$rundir_present" configure 2026.8.5
log_has 'daemon-reload' || fail "postinst configure must reload the systemd daemon"
log_has 'enable ceralive.service' || fail "postinst configure must (re-)enable ceralive.service"
log_has 'restart ceralive.service' || fail "postinst upgrade configure must restart ceralive.service"
log_lacks 'disable ceralive.service' \
    || fail "postinst must never disable ceralive.service"
# Existing behaviour preserved, in every configure arm.
log_has 'systemctl enable ceralive-addon-reconciler.service' \
    || fail "postinst must still enable ceralive-addon-reconciler.service"
log_has 'systemctl disable --now ceralive.socket' \
    || fail "postinst must still disable the legacy ceralive.socket"
log_has 'udevadm control --reload' || fail "postinst must still reload udev rules"
log_has 'id ceralive' || fail "postinst must still probe for the ceralive account"
grep -q 'action=configure' "$work/out.txt" \
    || fail "postinst must emit the action marker (action=configure)"
grep -q 'upgrade_from_present=yes' "$work/out.txt" \
    || fail "postinst upgrade configure must mark upgrade_from_present=yes"
grep 'upgrade_from_present=' "$work/out.txt" | grep -q '2026.8.5' \
    && fail "the postinst marker must never carry the version value"

# Same upgrade configure, but systemd is not running (chroot / image build).
run_maintainer postinst "$rundir_absent" configure 2026.8.5
log_has 'enable ceralive.service' \
    || fail "postinst must enable ceralive.service even when systemd is not running"
log_lacks 'restart ceralive.service' \
    || fail "postinst must NOT restart ceralive.service when \$SYSTEMD_RUN_DIR is absent"
grep -q 'upgrade_from_present=yes' "$work/out.txt" \
    || fail "the marker must be independent of the systemd-run-dir branch"

# Fresh install configure (no $2) — today's behaviour: enabled, never started.
run_maintainer postinst "$rundir_present" configure
log_has 'enable ceralive.service' || fail "postinst fresh configure must enable ceralive.service"
log_lacks 'restart ceralive.service' \
    || fail "postinst fresh install must NOT restart ceralive.service"
log_has 'systemctl enable ceralive-addon-reconciler.service' \
    || fail "postinst fresh configure must still enable ceralive-addon-reconciler.service"
grep -q 'upgrade_from_present=no' "$work/out.txt" \
    || fail "postinst fresh configure must mark upgrade_from_present=no"

printf 'PASS: prerm stops only on remove; postinst re-enables always and restarts only on an upgrade with systemd running\n'
