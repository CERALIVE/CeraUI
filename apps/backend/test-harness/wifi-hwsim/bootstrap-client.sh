#!/usr/bin/env bash
# Profile creation alone does not establish the station fixture.
set -euo pipefail
[[ "$(id -u)" == 0 && "${HWSIM_REPO:-}" == /repo ]] ||
	{ echo "bootstrap-client: use the disposable guest" >&2; exit 1; }
client=${1:?client interface required}
nmcli connection add type wifi ifname "$client" con-name CeraTest ssid CeraTest \
	wifi-sec.key-mgmt wpa-psk wifi-sec.psk ceratest1234 \
	ipv4.method manual ipv4.addresses 192.0.2.2/24 ipv6.method disabled
nmcli --wait 30 connection up id CeraTest ifname "$client"
