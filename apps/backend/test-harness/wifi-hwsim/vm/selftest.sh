#!/usr/bin/env bash
# Stub-only lifecycle regression checks. No real VM/network tools in PATH.
set -euo pipefail
umask 077
: "${TMPDIR:?set TMPDIR outside /tmp and Git work trees}"
runner=$(realpath "$(dirname "${BASH_SOURCE[0]}")/run-vm.sh")
repo=$(GIT_MASTER=1 git rev-parse --show-toplevel)
root=$(mktemp -d "$TMPDIR/hwsim-selftest.XXXXXXXX")
bin="$root/bin"
fifo=
victim=
cleanup() {
	local rc=$1
	trap - EXIT
	if [[ -n "$fifo" ]]; then printf 'stop\n' >&"$fifo" || true; fi
	if [[ -n "$victim" ]]; then wait "$victim" 2>/dev/null || true; fi
	if [[ -n "${CASE_DIR:-}" && -s "$CASE_DIR/pid" ]]; then
		timeout 3 tail --pid="$(<"$CASE_DIR/pid")" -f /dev/null || true
	fi
	rm -rf -- "$root"
	exit "$rc"
}
trap 'cleanup "$?"' EXIT
mkdir "$bin"
cat >"$root/stub" <<'STUB'
#!/bin/bash
set -euo pipefail
name=${0##*/}
guest_paths() {
	sed -E -e "s@/harness([/ ;\"]|$)@$CASE_DIR/guest/harness\\1@g" -e "s@/repo([/ ;\"]|$)@$CASE_DIR/guest/repo\\1@g" \
		-e "s@/root/@$CASE_DIR/guest/root/@g" -e "s@/usr/local/bin/@$CASE_DIR/guest/usr/local/bin/@g" \
		-e "s@/run/hwsim-client@$CASE_DIR/guest/run/hwsim-client@g"
}
case "$name" in
curl)
	out= url=
	while (($#)); do
		case "$1" in -o) out=$2; shift 2 ;; https:*) url=$1; shift ;; *) shift ;; esac
	done
	if [[ "$url" == */SHA512SUMS ]]; then
		printf '%s  debian-12-generic-amd64.qcow2\n' "$FAKE_DIGEST" >"$out"
	else printf 'fixture\n' >"$out"; fi ;;
qemu-img) : >"${@: -2:1}" ;;
ssh-keygen)
	while [[ "$1" != -f ]]; do shift; done
	: >"$2"; printf 'ssh-ed25519 fixture\n' >"$2.pub" ;;
xorriso)
	while [[ "$1" != -o ]]; do shift; done
	: >"$2" ;;
qemu-system-x86_64)
	printf '%s\n' "$$" >"$CASE_DIR/pid"
	read -r _ <"$CASE_DIR/stop" || true ;;
ssh)
	case "${*: -1}" in
	poweroff) printf 'stop\n' >"$CASE_DIR/stop" ;;
	*cloud-init*) [[ ${FAIL_INIT:-0} == 0 ]] || exit 7 ;;
	'bash -s -- '*)
		cat >"$CASE_DIR/setup"
		if [[ ${BOOTSTRAP:-0} == 1 ]]; then
			sed '/^modinfo /,$d' "$CASE_DIR/setup" | guest_paths >"$CASE_DIR/bootstrap"
			bash "$CASE_DIR/bootstrap"
		fi ;;
	*command.sh*)
		if [[ ${BOOTSTRAP:-0} == 1 ]]; then
			cmp "$CASE_DIR/guest/repo/apps/backend/setup.json" "$CASE_DIR/guest/repo/setup.json"
			python3 -c 'import json,sys; assert json.load(open(sys.argv[1])) == {}' "$CASE_DIR/guest/repo/config.json"
			guest_paths <"$CASE_DIR/guest/root/command.sh" >"$CASE_DIR/command"
			bash "$CASE_DIR/command"
		fi ;;
	esac ;;
scp)
	if [[ ${BOOTSTRAP:-0} == 1 ]]; then
		for file in "$@"; do
			[[ ! -f "$file" ]] || cp "$file" "$CASE_DIR/guest/root/"
		done
	fi ;;
install)
	[[ ${@: -1} == "$CASE_DIR/guest/"* ]]
	cp "${@: -2:1}" "${@: -1}" ;;
bun | stub) [[ "$1" == --version ]]; printf '1.4.4\n' ;;
NetworkManager | iw | wpa_supplicant) printf 'fixture-version\n' ;;
*) echo "unexpected stub: $name" >&2; exit 99 ;;
esac
STUB
chmod 700 "$root/stub"
stubs=(curl qemu-img ssh ssh-keygen scp xorriso qemu-system-x86_64 install bun NetworkManager iw wpa_supplicant)
for name in "${stubs[@]}"; do ln -s "$root/stub" "$bin/$name"; done
for name in bash realpath dirname mkdir mktemp mkfifo ln timeout sha512sum awk flock rm mv cat basename python3 tar tail readlink sleep chmod cp grep git find head env sed cmp uname; do
	ln -s "/usr/bin/$name" "$bin/$name"
done
verify_stubs() {
	local name
	for name in "${stubs[@]}"; do
		[[ -x "$bin/$name" && $(readlink -f "$bin/$name") == "$root/stub" ]]
	done
}
digest=$(printf 'fixture\n' | sha512sum)
export FAKE_DIGEST=${digest%% *}
export PATH="$bin"
awk '/^process_start\(\) \{/,/^# Run foreground/ {print}' "$runner" >"$root/helpers"
new_case() {
	if [[ -n "$fifo" ]]; then exec {fifo}>&-; fi
	export CASE_DIR="$root/$1"
	mkdir -p "$CASE_DIR/tmp"
	mkfifo "$CASE_DIR/stop"
	exec {fifo}<>"$CASE_DIR/stop"
	verify_stubs
}
new_case ppid
"$bin/qemu-system-x86_64" &
victim=$!
if bash -c 'source "$1"; process_start "$2"' _ "$root/helpers" "$victim" >"$CASE_DIR/captured"; then
	echo "FAIL: registered a process belonging to another parent" >&2
	exit 1
fi
printf 'stop\n' >&"$fifo"
wait "$victim"
victim=
echo "PASS: foreign-parent PID registration refused"
cat >"$root/debug" <<'DEBUG'
set -T
trap 'if [[ ${FUNCNAME[0]:-} == cleanup && ${FIRED:-0} == 0 ]]; then FIRED=1; builtin kill -s "$INJECT" "$$"; fi' DEBUG
DEBUG
for mode in explicit automatic; do for sig in TERM INT; do
	new_case "cleanup-$mode-$sig"
	fail=0; [[ "$mode" != automatic ]] || fail=1
	rc=0
	TMPDIR="$CASE_DIR/tmp" BASH_ENV="$root/debug" INJECT="$sig" FAIL_INIT="$fail" bash "$runner" -- true >"$CASE_DIR/log" 2>&1 || rc=$?
	expected=143; [[ "$sig" != INT ]] || expected=130
	[[ "$rc" == "$expected" && -s "$CASE_DIR/pid" ]]
	pid=$(<"$CASE_DIR/pid")
	[[ ! -e /proc/$pid && -z $(find "$CASE_DIR/tmp/hwsim-vm/runs" -mindepth 1 -print -quit) ]] ||
		{ cat "$CASE_DIR/log"; echo "FAIL: $mode cleanup entry $sig leaked state" >&2; exit 1; }
	echo "PASS: $mode cleanup entry $sig leaves no fake QEMU or run directory"
done; done
new_case bootstrap
mkdir -p "$CASE_DIR/guest/root" "$CASE_DIR/guest/usr/local/bin" "$CASE_DIR/guest/run"
printf 'wlan1\n' >"$CASE_DIR/guest/run/hwsim-client"
if ! TMPDIR="$CASE_DIR/tmp" BOOTSTRAP=1 EXPECTED_CWD="$CASE_DIR/guest/repo" bash "$runner" --repo "$repo" --no-install -- \
	bash -c 'test "$PWD" = "$EXPECTED_CWD" && printf "%s\n" "$PWD" >"$CASE_DIR/user-cwd"' >"$CASE_DIR/log" 2>&1; then
	cat "$CASE_DIR/log"; echo "FAIL: repository bootstrap before user command" >&2; exit 1
fi
[[ $(<"$CASE_DIR/user-cwd") == "$CASE_DIR/guest/repo" ]]
echo "PASS: committed setup and fresh config exist before user command; cwd is repo"
new_case symlink
mkdir -p "$CASE_DIR/tmp/hwsim-vm" "$CASE_DIR/target"
ln -s "$CASE_DIR/target" "$CASE_DIR/tmp/hwsim-vm/runs"
rc=0
TMPDIR="$CASE_DIR/tmp" bash "$runner" -- true >"$CASE_DIR/log" 2>&1 || rc=$?
[[ "$rc" == 1 && ! -e "$CASE_DIR/pid" && -z $(find "$CASE_DIR/target" -mindepth 1 -print -quit) ]]
grep -Fq 'state directory must not contain symlinks' "$CASE_DIR/log"
echo "PASS: symlinked state destination refused before writes"
echo "selftest: PASS (stub-only; no real VM)"
cleanup 0
