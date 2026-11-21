#!/usr/bin/env bash
# Attach guest-only udev port identities to the two real hwsim radios.
set -euo pipefail
export LC_ALL=C
if [[ "$EUID" != 0 || "${HWSIM_REPO:-}" != /repo || ! -f /run/hwsim-client ]] ||
	! systemd-detect-virt --vm --quiet; then
	echo 'B9-PORT-BOOTSTRAP: requires the disposable hwsim VM' >&2
	exit 1
fi

[[ $# == 3 ]] || exit 2
layout=$1 first=$2 second=$3
first_path=platform-hwsim-port-0
case "$layout" in
	same) second_path=$first_path ;;
	distinct) second_path=platform-hwsim-port-1 ;;
	*) exit 2 ;;
esac

hwsim_parent() {
	local phy
	phy=$(realpath -e "/sys/class/net/$1/phy80211") || return 1
	[[ "$phy" =~ /mac80211_hwsim/(hwsim[0-9]+)/ieee80211/phy[0-9]+$ ]] || return 1
	printf '%s\n' "${BASH_REMATCH[1]}"
}
first_parent=$(hwsim_parent "$first")
second_parent=$(hwsim_parent "$second")
[[ "$first_parent" != "$second_parent" ]]
first_mac=$(<"/sys/class/net/$first/phy80211/macaddress")
second_mac=$(<"/sys/class/net/$second/phy80211/macaddress")
[[ "$first_mac" == "$second_mac" ]]

rules=/run/udev/rules.d/99-ceraui-hwsim-test-ports.rules
mkdir -p "$(dirname "$rules")"
printf 'SUBSYSTEM=="net", SUBSYSTEMS=="mac80211_hwsim", KERNELS=="%s", ENV{ID_PATH}:="%s"\n' \
	"$first_parent" "$first_path" "$second_parent" "$second_path" >"$rules"
udevadm verify "$rules"
udevadm control --reload-rules
udevadm trigger --action=change --settle "/sys/class/net/$first" "/sys/class/net/$second"
systemctl restart NetworkManager
nm-online --wait-for-startup --timeout=25 --quiet

# These read-only probes must agree before CeraUI's discovery sees either radio.
probe() {
	local iface=$1 parent=$2 expected=$3 udev_path nm_path
	udev_path=$(udevadm info --query=property --property=ID_PATH --value "/sys/class/net/$iface")
	nm_path=$(nmcli --escape no -g GENERAL.PATH device show "$iface")
	printf 'B9-PORT-PROBE layout=%s ifname=%s parent=%s mac=%s udev=%q nm=%q expected=%s\n' \
		"$layout" "$iface" "$parent" "$first_mac" "$udev_path" "$nm_path" "$expected"
	[[ "$udev_path" == "$expected" && "$nm_path" == "$expected" ]]
}
rc=0
probe "$first" "$first_parent" "$first_path" || rc=1
probe "$second" "$second_parent" "$second_path" || rc=1
exit "$rc"
