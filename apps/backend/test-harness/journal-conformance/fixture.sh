#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends systemd systemd-journal-remote jq
fail() { echo "FAIL fixture: $*" >&2; exit 1; }
equal() { [[ "$2" == "$3" ]] || fail "$1: expected [$3], got [$2]"; echo "PASS fixture: $1"; }
version="$(journalctl --version)"
[[ "$version" == "systemd 257 "* ]] || fail "expected systemd 257, got $version"
echo "VERSION: ${version%%$'\n'*}"
mkdir -p /fx
gen() {
	printf '__REALTIME_TIMESTAMP=%s\n__MONOTONIC_TIMESTAMP=%s\n_BOOT_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n_MACHINE_ID=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' "$1" "$2"
	[[ -z "$3" ]] || printf '_SYSTEMD_UNIT=%s\n' "$3"
	printf '_TRANSPORT=%s\nPRIORITY=%s\nMESSAGE=%s\n\n' "$4" "$5" "$6"
}
big="$(printf '%05000d' 0 | tr 0 x)"
{
	gen 1700000000000000 1000000 a.service stdout 6 'm1 a info'
	gen 1700000001000000 2000000 b.service stdout 3 'm2 b error usb.device'
	gen 1700000002000000 3000000 '' kernel 4 'm3 kernel warning'
	gen 1700000003000000 4000000 a.service stdout 7 'm4 a debug'
	gen 1700000003000000 4000001 c.service stdout 6 'm5 c same-timestamp'
	gen 1700000004000000 5000000 a.service stdout 3 "m6 $big"
	gen 1700000005000000 6000000 b.service stdout 6 'm7 b info'
} | /usr/lib/systemd/systemd-journal-remote -o /fx/t.journal -
J=(journalctl --no-pager --file=/fx/t.journal -o json)
ids() { jq -rs 'map(.MESSAGE | split(" ")[0]) | join(" ")'; }
check() {
	local label="$1" expected="$2" actual; shift 2
	actual="$("${J[@]}" --all "$@" | ids)" || fail "$label: journalctl or JSON parsing failed"
	equal "$label" "$actual" "$expected"
}
cursor() { "${J[@]}" --all | jq -r --arg id "$1" 'select(.MESSAGE | startswith($id+" ")) | .__CURSOR'; }
c3="$(cursor m3)"; c4="$(cursor m4)"; c5="$(cursor m5)"
expected='m1 m2 m3'
[[ "${CONFORMANCE_SELFTEST:-0}" != 1 ]] || expected='m3 m2 m1'
check 'oldest three' "$expected" -n +3
check 'newest three' 'm7 m6 m5' -r -n 3
check 'older after cursor' 'm2 m1' -r -n 2 --after-cursor="$c3"
check 'newer after cursor' 'm4 m5' -n +2 --after-cursor="$c3"
check 'inclusive cursor' 'm3 m4' -n +2 --cursor="$c3"
check 'same timestamp order' 'm4 m5' -n +2 --cursor="$c4"
[[ "$c4" != "$c5" ]] || fail 'same timestamp cursors must differ'
equal 'same realtime timestamp' "$("${J[@]}" --all | jq -rs '[.[] | select(.MESSAGE | test("^m[45] ")) | .__REALTIME_TIMESTAMP] | unique | length')" 1
code=0
"${J[@]}" --since=@1700000001 --after-cursor="$c3" >/fx/out 2>/fx/err || code=$?
equal 'since with cursor exit' "$code" 1
grep -q 'Please specify only one of' /fx/err || fail 'since/cursor diagnostic missing'
check 'until with cursor' 'm4 m5 m6' -n +5 --until=@1700000004 --after-cursor="$c3"
check 'since alone' 'm4 m5 m6 m7' -n +9 --since=@1700000003
check 'unit union' 'm1 m2 m4 m6 m7' -u a.service -u b.service
check 'unit and kernel intersection' '' -u a.service _TRANSPORT=kernel
check 'unit or kernel' 'm1 m3 m4 m6' _SYSTEMD_UNIT=a.service + _TRANSPORT=kernel
check 'two units or kernel' 'm1 m2 m3 m4 m6 m7' _SYSTEMD_UNIT=a.service _SYSTEMD_UNIT=b.service + _TRANSPORT=kernel
check 'warning and worse' 'm2 m3 m6' -p 4
check 'severity across both groups' 'm2 m3 m6' -p 4 _SYSTEMD_UNIT=a.service _SYSTEMD_UNIT=b.service + _TRANSPORT=kernel
check 'explicit severity across groups' 'm3 m6' _SYSTEMD_UNIT=a.service PRIORITY=3 PRIORITY=4 + _TRANSPORT=kernel PRIORITY=3 PRIORITY=4
equal 'large message null by default' "$("${J[@]}" -n +6 | jq -rs '.[5].MESSAGE == null')" true
equal 'large message preserved with all' "$("${J[@]}" --all -n +6 | jq -rs '.[5].MESSAGE | length')" 5003
code=0
"${J[@]}" --grep=zzzz >/fx/out 2>/fx/err || code=$?
equal 'no grep match exit' "$code" 1
[[ ! -s /fx/out && ! -s /fx/err ]] || fail 'no grep match must have empty stdout and stderr'
check 'literal case insensitive grep' m2 --case-sensitive=false '--grep=USB\.'
check 'grep reverses plain count' 'm7 m6 m5' --grep=m -n 3
check 'grep ascending plus count' 'm1 m2 m3' --grep=m -n +3
fake="$(printf '%s' "$c3" | sed -E 's/i=[0-9a-f]+/i=fffff/;s/x=[0-9a-f]+/x=1111111111111111/')"
check 'missing inclusive cursor' '' -n +2 --cursor="$fake"
check 'missing after cursor' '' -n +2 --after-cursor="$fake"
code=0
"${J[@]}" --cursor=garbage >/fx/out 2>/fx/err || code=$?
equal 'malformed cursor exit' "$code" 1
grep -q 'Failed to seek to cursor' /fx/err || fail 'malformed cursor diagnostic missing'
"${J[@]}" --list-boots | jq -e 'type == "array" and length == 1 and .[0].boot_id == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" and .[0].first_entry == 1700000000000000 and .[0].last_entry == 1700000005000000' >/dev/null ||
	fail 'boot list JSON did not preserve the fixture boot and timestamp bounds'
equal 'cursor retained with selected fields' "$("${J[@]}" --output-fields=MESSAGE -n +1 | jq 'has("__CURSOR")')" true
journalctl --file=/fx/t.journal --disk-usage | grep -q 'Archived and active journals take up' || fail 'disk usage missing'
for binary in remote gatewayd upload; do
	[[ -x "/usr/lib/systemd/systemd-journal-$binary" ]] || fail "missing journal-$binary"
done
ldd /usr/lib/*/systemd/libsystemd-shared-*.so >/fx/dependencies
grep -q pcre2 /fx/dependencies || fail 'PCRE2 support missing'
{
	gen 1700000000000000 1000000 a.service stdout 6 'm1 a info'
	gen 1700000001000000 2000000 b.service stdout 3 'm2 b error'
	gen 1700000002000000 3000000 '' kernel 7 'm3 kernel debug'
	gen 1700000003000000 4000000 a.service stdout 7 'm4 a debug'
	gen 1699999000000000 4000001 a.service stdout 3 'm5 a error clock-stepped-back'
	gen 1700000004000000 5000000 a.service stdout 3 'm6 a error'
	gen 1700000005000000 6000000 b.service stdout 6 'm7 b info'
} | /usr/lib/systemd/systemd-journal-remote -o /fx/clock.journal -
J=(journalctl --no-pager --file=/fx/clock.journal -o json)
c3="$(cursor m3)"
check 'excluded anchor exists in boot scope' m3 -n +1 --cursor="$c3" _BOOT_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
check 'excluded anchor filtered forward' 'm5 m6' --cursor="$c3" _SYSTEMD_UNIT=a.service PRIORITY=3
check 'excluded anchor any severity' 'm4 m5 m6' --cursor="$c3" _SYSTEMD_UNIT=a.service
check 'excluded anchor filtered reverse' m1 -r --cursor="$c3" _SYSTEMD_UNIT=a.service
check 'clock journal order' 'm1 m2 m3 m4 m5 m6 m7'
check 'clock since forward includes out of range record' 'm3 m4 m5 m6 m7' --since=@1700000002
check 'clock since reverse hides in range records' 'm7 m6' -r --since=@1700000002
check 'clock until forward cuts by position' 'm1 m2 m3 m4 m5' --until=@1700000003
source /conformance/query/replay.sh
echo 'FIXTURE OK systemd 257'
