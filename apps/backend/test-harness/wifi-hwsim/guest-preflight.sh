#!/usr/bin/env bash
# Aggregate cheap environment failures before any native scenario.
set -uo pipefail
umask 077
harness=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
receipts=$(mktemp -d /var/tmp/ceraui-preflight.XXXXXXXX) || exit 1
failures=0
probe() {
	local name=$1 rc
	shift
	timeout --kill-after=1 60 "$@" >"$receipts/$name.log" 2>&1
	rc=$?
	cat "$receipts/$name.log"
	printf 'HWSIM-PREFLIGHT: %s exit=%s\n' "$name" "$rc" | tee -a "$receipts/results"
	((rc == 0)) || failures=$((failures + 1))
	return "$rc"
}
probe guest-boundary bash -c 'test "$(id -u)" = 0 && test "${HWSIM_REPO:-}" = /repo && test "$(pwd -P)" = /repo'
guest=$?
probe os bash -c '. /etc/os-release; printf "OS=%s VERSION=%s\n" "$ID" "$VERSION_ID"; test "$ID:$VERSION_ID" = debian:13'
probe tools bash -c '
rc=0
for name in bun nmcli NetworkManager iw hostapd wpa_supplicant dnsmasq systemctl busctl journalctl udevadm rfkill ip ps stat python3 od flock unshare mount touch readlink timeout findmnt bash id cat tee grep head find sort git tar base64 mktemp rm; do
	command -v "$name" || { printf "MISSING=%s\n" "$name"; rc=1; }
done
exit "$rc"'
probe versions bash -c '
rc=0
test "$(bun --version)" = 1.4.4 || rc=1
test "$(NetworkManager --version)" = 1.52.1 || rc=1
/usr/bin/nmcli --version || rc=1
iw --version || rc=1
hostapd -v 2>&1 || rc=1
wpa_supplicant -v || rc=1
dnsmasq --version >/dev/null || rc=1
exit "$rc"'
probe environment bash -c '
printf "NODE_ENV=%s MOCK_MODE=%s LC_ALL=%s PATH=%s\n" "${NODE_ENV:-}" "${MOCK_MODE:-}" "${LC_ALL:-}" "$PATH"
test "${NODE_ENV:-}" = production && test "${MOCK_MODE:-}" = false && test "${LC_ALL:-}" = C'
probe permissions bash -c '
rc=0
for path in /repo /run /usr/local/bin /etc/NetworkManager/system-connections; do
	stat -c "%n mode=%a uid=%u gid=%g" "$path" || rc=1
	findmnt -T "$path" -o TARGET,FSTYPE,OPTIONS || rc=1
	test -r "$path" && test -w "$path" && test -x "$path" || rc=1
done
test ! -e /usr/local/bin/nmcli && test ! -L /usr/local/bin/nmcli || rc=1
exit "$rc"'
if ((guest == 0)); then
	probe systemd bash -c '
rc=0
for unit in NetworkManager.service dbus.service systemd-journald.service; do
	systemctl is-active "$unit" || rc=1
	systemctl show "$unit" -p LoadState -p ActiveState -p CanStop
done
busctl --system call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus GetId || rc=1
busctl --system call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus GetNameOwner s org.freedesktop.NetworkManager || rc=1
journalctl --sync || rc=1
journalctl -u NetworkManager -n 1 --no-pager -o json --output-fields=MESSAGE || rc=1
exit "$rc"'
	probe audit-json bash -o pipefail -c '
journalctl -b -u NetworkManager --no-pager -o json --output-fields=MESSAGE |
python3 -c '"'"'import json, re, sys
rows = [json.loads(line) for line in sys.stdin if line.startswith("{")]
audit = [row for row in rows if isinstance(row.get("MESSAGE"), str) and "audit: " in row["MESSAGE"]]
assert audit, "No NetworkManager audit records"
for row in audit:
    assert isinstance(row.get("__REALTIME_TIMESTAMP"), str) and row["__REALTIME_TIMESTAMP"].isdigit(), "Missing journal timestamp"
assert any(re.search(r"\bpid=\d+", row["MESSAGE"]) for row in audit), "Missing audited caller PID"
print("HWSIM-AUDIT-JSON: timestamp/message/PID present")
'"'"''
	probe radios bash -c '
rc=0
test -d /sys/module/mac80211_hwsim || rc=1
count=0
for path in /sys/class/net/*/phy80211; do
	case "$(readlink -f "$path")" in
	*/mac80211_hwsim/*)
		count=$((count + 1))
		test -r "$path/macaddress" || rc=1
		printf "RADIO=%s MAC=%s\n" "${path%/phy80211}" "$(cat "$path/macaddress")"
		;;
	esac
done
test "$count" = 4 || rc=1
iw dev || rc=1
rfkill list || rc=1
nmcli --colors no -t -f DEVICE,TYPE,STATE device status || rc=1
exit "$rc"'
	probe bootstrap bash -c '
test -f setup.json && test -f config.json && test -s /run/hwsim-client &&
test -s /run/hwsim-hostapd.pid && kill -0 "$(cat /run/hwsim-hostapd.pid)" &&
grep -q AP-ENABLED /run/hwsim-hostapd.log &&
test "$(nmcli -g GENERAL.CONNECTION device show "$(cat /run/hwsim-client)")" = CeraTest &&
case "$(nmcli -g GENERAL.STATE device show "$(cat /run/hwsim-client)")" in "100 "*) true;; *) false;; esac'
	probe native-runners bash "$harness/native-exec.sh" bun "$harness/checks/guest-preflight.ts" "$receipts"
else
	printf 'HWSIM-PREFLIGHT: guest-actions refused outside /repo root guest\n' | tee -a "$receipts/results"
	failures=$((failures + 1))
fi
python3 - "$receipts" <<'SYNC'
import os
import sys
from pathlib import Path
root = Path(sys.argv[1])
for path in root.iterdir():
    if path.is_file():
        with path.open("rb") as file:
            os.fsync(file.fileno())
fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
SYNC
sync_rc=$?
if ((sync_rc != 0)); then
	printf 'HWSIM-PREFLIGHT: receipt-fsync exit=%s\n' "$sync_rc"
	failures=$((failures + 1))
fi
printf 'HWSIM-PREFLIGHT: failures=%s receipts=%s\n' "$failures" "$receipts"
exit "$((failures != 0))"
