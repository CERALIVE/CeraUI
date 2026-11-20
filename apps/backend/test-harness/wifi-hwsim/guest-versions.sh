#!/usr/bin/env bash
# Version probes report each result without hiding later failures.
set -uo pipefail
failures=0
version() {
	local name=$1 expected=$2 output rc passed=0
	shift 2
	if output=$("$@" 2>&1); then rc=0; else rc=$?; fi
	printf '%s\n' "$output"
	if [[ "$name" == hostapd ]]; then
		# Debian hostapd 2.10 prints its valid version to stderr and exits 1.
		if ((rc == 0 || rc == 1)) &&
			[[ "$output" =~ ^hostapd[[:space:]]v[0-9]+([.][0-9]+)+([[:space:]]|$) ]]; then
			passed=1
		fi
	elif ((rc == 0)) && [[ -z "$expected" || "$output" == "$expected" ]]; then
		passed=1
	fi
	printf 'HWSIM-VERSION: %s exit=%s passed=%s\n' "$name" "$rc" "$passed"
	if ((passed == 0)); then
		[[ -z "$expected" ]] || printf 'HWSIM-VERSION: %s expected=%s\n' "$name" "$expected"
		failures=$((failures + 1))
	fi
}
version bun 1.4.4 bun --version
version NetworkManager 1.52.1 NetworkManager --version
version nmcli '' /usr/bin/nmcli --version
version iw '' iw --version
version hostapd '' hostapd -v
version wpa_supplicant '' wpa_supplicant -v
version dnsmasq '' dnsmasq --version
exit "$((failures != 0))"
