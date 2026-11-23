#!/usr/bin/env bash
# Stub version commands only; the absolute nmcli call reads its version.
set -euo pipefail
umask 077
harness=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
mkdir "$root/bin"
printf '%s\n' '#!/usr/bin/env bash
case "${0##*/}" in
bun)
	case "$HWSIM_VERSION_CASE" in
	bun-mismatch) echo 1.4.3 ;;
	captured-bun) echo 1.4.4 ;;
	*) echo 1.4.5 ;;
	esac ;;
NetworkManager) [[ "$HWSIM_VERSION_CASE" != daemon-mismatch ]] || { echo 1.52.2; exit; }; echo 1.52.1 ;;
iw) echo "iw version 6.9" ;;
hostapd)
	case "$HWSIM_VERSION_CASE" in
	hostapd-no-banner) echo "loader failure" >&2; exit 1 ;;
	hostapd-error) echo "hostapd v2.10" >&2; exit 2 ;;
	hostapd-zero) echo "hostapd v2.10" >&2; exit 0 ;;
	esac
	echo "hostapd v2.10" >&2; exit 1 ;;
wpa_supplicant) echo "wpa_supplicant v2.10" ;;
dnsmasq) echo "Dnsmasq version 2.91"; [[ "$HWSIM_VERSION_CASE" != dnsmasq-error ]] ;;
esac' >"$root/version-stub"
chmod 700 "$root/version-stub"
for name in bun NetworkManager iw hostapd wpa_supplicant dnsmasq; do
	ln -s "$root/version-stub" "$root/bin/$name"
done
for scenario in good hostapd-zero hostapd-no-banner hostapd-error bun-mismatch captured-bun daemon-mismatch dnsmasq-error; do
	rc=0
	PATH="$root/bin:/usr/bin:/bin" HWSIM_VERSION_CASE="$scenario" \
		bash "$harness/guest-versions.sh" >"$root/$scenario.log" 2>&1 || rc=$?
	case "$scenario" in
	good|hostapd-zero) test "$rc" = 0 ;;
	*) test "$rc" = 1 ;;
	esac
	# Every row must still run, including the last one after an earlier failure.
	test "$(grep -Ec '^HWSIM-VERSION: [A-Za-z_]+ exit=' "$root/$scenario.log")" = 7
	grep -q '^HWSIM-VERSION: dnsmasq exit=' "$root/$scenario.log"
	if [[ "$scenario" == captured-bun ]]; then
		grep -Fxq 'HWSIM-VERSION: bun exit=0 passed=0' "$root/$scenario.log"
		grep -Fxq 'HWSIM-VERSION: bun expected=1.4.5' "$root/$scenario.log"
	fi
	printf 'VERSION-SELFTEST PASS %s\n' "$scenario"
done
