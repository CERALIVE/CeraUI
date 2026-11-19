#!/usr/bin/env bash
set -euo pipefail
[[ "${CONFORMANCE_CONTAINER:-}" == 1 && -f /run/systemd/container ]] || {
	echo 'FAIL live: requires CONFORMANCE_CONTAINER=1 inside the disposable container' >&2
	exit 1
}
fail() { echo "FAIL live: $*" >&2; exit 1; }
equal() { [[ "$2" == "$3" ]] || fail "$1: expected [$3], got [$2]"; echo "PASS live: $1"; }
J=(journalctl --no-pager --all -o json)
sync_journal() { journalctl --sync; }
messages() {
	local output
	output="$("${J[@]}" "$@")" || fail 'journal read failed'
	jq -rs 'map(.MESSAGE) | join(" ")' <<<"$output"
}
emit() { systemd-cat -t "$1" echo "$2"; sync_journal; }
start_follow() {
	coproc FOLLOW { exec journalctl --no-pager --all -o json -f "$@"; }
	follow_pid="$FOLLOW_PID"
	exec {follow_fd}<&"${FOLLOW[0]}"
}
next_message() {
	local row
	IFS= read -r -t 45 row <&"$follow_fd" || fail "timed out awaiting follower entry $1"
	equal "follower entry $1" "$(jq -r '.MESSAGE' <<<"$row")" "$1"
}
stop_follow() {
	kill -TERM "$follow_pid"
	local code=0
	wait "$follow_pid" || code=$?
	exec {follow_fd}<&-
	equal 'follower SIGTERM exit' "$code" 143
}
trap 'if [[ -n "${follow_pid:-}" ]] && kill -0 "$follow_pid" 2>/dev/null; then kill -TERM "$follow_pid"; fi' EXIT
version="$(journalctl --version)"
[[ "$version" == "systemd 257 "* ]] || fail "expected systemd 257, got $version"
echo "VERSION: ${version%%$'\n'*}"

if [[ "${1:-suite}" == verify-shutdown ]]; then
	stopped=d93fb3c9c24d451a97cea615ce59c00b
	started=f77379a8490b408bbe5f6940505a777b
	lifecycle() {
		"${J[@]}" "_BOOT_ID=$1" "MESSAGE_ID=$stopped" "MESSAGE_ID=$started" |
			jq -rs 'map(.MESSAGE_ID) | join(" ")'
	}
	clean="$(lifecycle 33333333333333333333333333333333)"
	equal 'clean boot last lifecycle is stopped' "${clean##* }" "$stopped"
	crash="$(lifecycle 44444444444444444444444444444444)"
	equal 'killed boot has no stopped lifecycle' "$crash" "$started"
	restarted="$(lifecycle 55555555555555555555555555555555)"
	equal 'restart then kill ends in started lifecycle' "$restarted" "$started $stopped $started"
	echo "LIFECYCLE clean=$clean crash=$crash restart_then_crash=$restarted"
	exit 0
fi

systemd-run --quiet --wait --unit=pfx sh -c 'printf "<3>err line\n<4>warn line\n<7>debug line\nplain line\n<3>a\nb\n"'
sync_journal
equal 'stdout priority prefixes and per-line reset' \
	"$("${J[@]}" _SYSTEMD_UNIT=pfx.service | jq -rs 'map(select(.MESSAGE | test("^(err line|warn line|debug line|plain line|a|b)$"))) | map([.MESSAGE,.PRIORITY]) | sort | tojson')" \
	'[["a","3"],["b","6"],["debug line","7"],["err line","3"],["plain line","6"],["warn line","4"]]'
for i in 1 2 3; do emit demo "a$i"; done
c1="$("${J[@]}" -t demo -n +1 | jq -r '.__CURSOR')"
start_follow -t demo --cursor="$c1" --lines=all
next_message a1; next_message a2; next_message a3
emit demo a4
next_message a4
stop_follow
# -n 0 defers even cursor backlog until the next journal event. Subscribe to
# stdout's epoll registration before writing, so the test needs no startup sleep.
mkfifo /state/follow-trace
exec {trace_fd}<>/state/follow-trace
coproc FOLLOW {
	exec strace -D -qq -e trace=epoll_ctl -o /state/follow-trace \
		journalctl --no-pager --all -o json -f -t demo --after-cursor="$c1" -n 0
}
follow_pid="$FOLLOW_PID"
exec {follow_fd}<&"${FOLLOW[0]}"
while IFS= read -r -t 20 trace <&"$trace_fd"; do
	[[ "$trace" != *'EPOLL_CTL_ADD, 1,'* ]] || break
done
[[ "${trace:-}" == *'EPOLL_CTL_ADD, 1,'* ]] || fail 'follower never registered stdout'
emit demo a5
next_message a2; next_message a3; next_message a4; next_message a5
stop_follow
exec {trace_fd}<&-
rm /state/follow-trace

emit restart-demo ready
start_follow -t restart-demo --lines=all
next_message ready
emit restart-demo b1
next_message b1
systemctl restart systemd-journald
emit restart-demo b2
next_message b2
stop_follow

boot="$(tr -d '-' </proc/sys/kernel/random/boot_id)"
equal 'anchor exists with boot match alone' \
	"$("${J[@]}" -n +1 --cursor="$c1" "_BOOT_ID=$boot" | jq -r '.MESSAGE')" a1
emit filtered next-matching
equal 'static read excludes start cursor' \
	"$(messages --cursor="$c1" --lines=all SYSLOG_IDENTIFIER=filtered)" next-matching
start_follow --cursor="$c1" --lines=all SYSLOG_IDENTIFIER=filtered
next_message next-matching
emit filtered live-matching
next_message live-matching
stop_follow

equal 'empty unit has no backlog' "$(messages --lines=all _SYSTEMD_UNIT=nothing-yet.service)" ''
start_follow --lines=all _SYSTEMD_UNIT=nothing-yet.service
systemd-run --quiet --wait --unit=nothing-yet echo arrived-after-start
sync_journal
next_message arrived-after-start
stop_follow

# All entries are in an archived file before the tiny size budget is applied.
systemd-run --quiet --wait --unit=fill sh -c 'i=0; while [ "$i" -lt 960 ]; do echo "filler line $i"; i=$((i+1)); done'
sync_journal
equal 'all filler entries stored before vacuum' \
	"$("${J[@]}" _SYSTEMD_UNIT=fill.service | jq -s length)" 960
journalctl --rotate
journalctl --vacuum-size=1
remaining="$("${J[@]}" | jq -s length)"
(( remaining < 10 )) || fail "vacuum-size left $remaining entries"
echo "PASS live: rotate and size vacuum left $remaining entries"

systemd-run --quiet --wait --unit=keep sh -c 'i=0; while [ "$i" -lt 20 ]; do echo "keep $i"; i=$((i+1)); done'
sync_journal
journalctl --rotate
uptime="$(cut -d. -f1 /proc/uptime)"
journalctl --vacuum-time="$((uptime + 3600))s"
equal 'boot-age vacuum retains twenty keep entries' \
	"$("${J[@]}" _SYSTEMD_UNIT=keep.service | jq -s length)" 20

mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nRateLimitIntervalSec=30s\nRateLimitBurst=2000\n' >/etc/systemd/journald.conf.d/conformance.conf
systemctl restart systemd-journald
systemd-run --quiet --wait --collect --unit=flood sh -c 'i=0; while [ "$i" -lt 6000 ]; do echo "flood $i"; i=$((i+1)); done'
sync_journal
count="$("${J[@]}" _SYSTEMD_UNIT=flood.service | jq -s length)"
equal 'observed rate burst stores all six thousand entries' "$count" 6000
systemd-run --quiet --wait --unit=time-fill sh -c 'i=0; while [ "$i" -lt 960 ]; do echo "time filler $i"; i=$((i+1)); done'
sync_journal
equal 'time vacuum starts with 960 entries' \
	"$("${J[@]}" _SYSTEMD_UNIT=time-fill.service | jq -s length)" 960
# Allow the configured rate interval to expire, then inspect the actual journal.
# Free-space burst scaling means this workload does not produce suppression.
journalctl --rotate
start_follow --lines=all SYSLOG_IDENTIFIER=rate-tick
systemd-run --quiet --unit=flood-notice --on-active=31s --timer-property=AccuracySec=1us \
	sh -c 'systemd-run --quiet --wait --unit=flood --collect echo after-limit; systemd-cat -t rate-tick echo interval-ended'
next_message interval-ended
stop_follow
sync_journal
notice_file=/state/suppression.jsonl
code=0
"${J[@]}" --grep='Suppressed' >"$notice_file" || code=$?
equal 'no suppression notice grep exit' "$code" 1
[[ ! -s "$notice_file" ]] || fail 'unexpected suppression notice'
echo "SUPPRESSION stored=$count MESSAGE=null MESSAGE_ID=null (not emitted)"
journalctl --vacuum-time=1s
equal 'time vacuum removed the archived flood' \
	"$("${J[@]}" _SYSTEMD_UNIT=flood.service | jq -rs '[.[] | select(.MESSAGE | startswith("flood "))] | length')" 0
equal 'time vacuum leaves zero of 960 archived entries' \
	"$("${J[@]}" _SYSTEMD_UNIT=time-fill.service | jq -s length)" 0

# Keep the original disk-scaled flood above; this independent unit forces drops.
mkfifo /state/rate-limit-release
exec {rate_release_fd}<>/state/rate-limit-release
start_follow --lines=all _SYSTEMD_UNIT=rate-limited-flood.service PRIORITY=3
systemd-run --quiet --unit=rate-limited-flood \
	-p LogRateLimitIntervalSec=2s -p LogRateLimitBurst=1 -p RuntimeMaxSec=20s \
	sh -ec 'i=0; while [ "$i" -lt 6000 ]; do echo "limited-flood $i"; i=$((i+1)); done
		printf "<3>limited-flood-complete\n"
		read -r release </state/rate-limit-release
		echo limited-after-interval'
next_message limited-flood-complete
stop_follow
equal 'per-unit rate interval' \
	"$(systemctl show rate-limited-flood.service -p LogRateLimitIntervalUSec --value)" 2s
equal 'per-unit rate burst' \
	"$(systemctl show rate-limited-flood.service -p LogRateLimitBurst --value)" 1
sync_journal
limited_count="$("${J[@]}" _SYSTEMD_UNIT=rate-limited-flood.service |
	jq -rs '[.[] | select(.MESSAGE | startswith("limited-flood "))] | length')"
(( limited_count > 0 && limited_count < 6000 )) ||
	fail "per-unit limit stored $limited_count of 6000 entries"
suppression_id=a596d6fe7bfa4994828e72309e95d61e
# Read the readiness marker from the same subscription before releasing the flood.
start_follow --lines=all --grep='(rate-limit-ready|rate-limited-flood\.service)$' \
	"MESSAGE_ID=$suppression_id" + SYSLOG_IDENTIFIER=rate-limit-subscription
emit rate-limit-subscription rate-limit-ready
next_message rate-limit-ready
# The same live unit writes after its interval; that write emits the drop receipt.
systemd-run --quiet --unit=rate-limit-release --on-active=3s --timer-property=AccuracySec=1us \
	sh -ec 'printf "resume\n" >/state/rate-limit-release'
if ! IFS= read -r -t 15 suppression <&"$follow_fd"; then
	"${J[@]}" --grep='Suppressed|limited-flood'
	fail 'timed out awaiting the per-unit suppression MESSAGE_ID'
fi
stop_follow
bash /conformance/assert-suppression.sh rate-limited-flood.service 6000 "$limited_count" \
	<<<"$suppression" || fail 'suppression ID, message or dropped count mismatch'
equal 'one per-unit suppression notice' \
	"$("${J[@]}" "MESSAGE_ID=$suppression_id" --grep='rate-limited-flood\.service$' | jq -s length)" 1
echo "PASS live: suppression MESSAGE_ID $suppression_id"
echo "SUPPRESSION_LIMITED stored=$limited_count written=6000"
echo "SUPPRESSION_LIMITED_JSON $(jq -c . <<<"$suppression")"
exec {rate_release_fd}<&-
rm /state/rate-limit-release

machine="$(tr -d '\n' </etc/machine-id)"
predecessor=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
mkdir -p "/var/log/journal/$predecessor"
usage_before="$(journalctl --disk-usage)"
du_before="$(du -s /var/log/journal | cut -f1)"
cp "/var/log/journal/$machine/system.journal" "/var/log/journal/$predecessor/system.journal"
head -c 1048576 /dev/zero >"/var/log/journal/$predecessor/retained.journal~"
predecessor_hashes="$(sha256sum "/var/log/journal/$predecessor/"*)"
equal 'predecessor bytes absent from journalctl usage' "$(journalctl --disk-usage)" "$usage_before"
du_after="$(du -s /var/log/journal | cut -f1)"
(( du_after > du_before )) || fail 'du did not include predecessor bytes'
journalctl --rotate
journalctl --vacuum-size=1
[[ -f "/var/log/journal/$predecessor/system.journal" && -f "/var/log/journal/$predecessor/retained.journal~" ]] || fail 'vacuum touched predecessor directory'
equal 'predecessor file bytes survive vacuum unchanged' \
	"$(sha256sum "/var/log/journal/$predecessor/"*)" "$predecessor_hashes"
echo "PREDECESSOR journalctl=$usage_before du_before=$du_before du_after=$du_after"

printf '22222222-2222-2222-2222-222222222222\n' >/state/boot-id
systemctl restart systemd-journald
emit boundary first-fake-boot
printf '33333333-3333-3333-3333-333333333333\n' >/state/boot-id
second_started="$(date +%s)"
systemctl restart systemd-journald
emit boundary second-fake-boot
before="$(journalctl --list-boots -o json)"
echo "BOOT LIST BEFORE: $before"
jq -e 'any(.[]; .boot_id == "22222222222222222222222222222222") and any(.[]; .boot_id == "33333333333333333333333333333333")' <<<"$before" >/dev/null ||
	fail 'boot list did not contain both injected boot ids'
journalctl --rotate
age="$(($(date +%s) - second_started + 1))"
journalctl --vacuum-time="${age}s"
after="$(journalctl --list-boots -o json)"
jq -e 'type == "array" and any(.[]; .boot_id == "33333333333333333333333333333333")' <<<"$after" >/dev/null ||
	fail 'boot list after vacuum lost the current boot'
echo "BOOT LIST AFTER: $after"
echo 'LIVE OK systemd 257'
