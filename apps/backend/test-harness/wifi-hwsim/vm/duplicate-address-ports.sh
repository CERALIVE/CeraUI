#!/usr/bin/env bash
# Attach guest-only udev port identities to the two real hwsim radios.
set -euo pipefail
export LC_ALL=C

first_path=platform-hwsim-port-0
vendor=Linux
product=mac80211_hwsim
second_port() {
	case "$1" in
		same) printf '%s\n' "$first_path" ;;
		distinct) printf '%s\n' platform-hwsim-port-1 ;;
		*) return 2 ;;
	esac
}

render_rules() {
	# Label the emulated hardware so normal discovery can enroll it without seeded rows.
	printf 'SUBSYSTEM=="net", SUBSYSTEMS=="mac80211_hwsim", KERNELS=="%s", ENV{ID_PATH}="%s", ENV{ID_VENDOR_FROM_DATABASE}="%s", ENV{ID_MODEL_FROM_DATABASE}="%s"\n' \
		"$1" "$first_path" "$vendor" "$product" "$2" "$3" "$vendor" "$product"
}

if [[ $# == 1 && $1 == --verify-rules ]]; then
	scratch=$(mktemp -d)
	trap 'rm -r -- "$scratch"' EXIT
	for layout in same distinct; do
		render_rules hwsim0 hwsim1 "$(second_port "$layout")" >"$scratch/$layout.rules"
		udevadm verify "$scratch/$layout.rules"
	done
	exit 0
fi

if [[ "$EUID" != 0 || "${HWSIM_REPO:-}" != /repo || ! -f /run/hwsim-client ]] ||
	! systemd-detect-virt --vm --quiet; then
	echo 'B9-PORT-BOOTSTRAP: requires the disposable hwsim VM' >&2
	exit 1
fi

[[ $# == 3 ]] || exit 2
layout=$1 first=$2 second=$3
second_path=$(second_port "$layout")

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
render_rules "$first_parent" "$second_parent" "$second_path" >"$rules"
udevadm verify "$rules"
udevadm control --reload-rules
udevadm trigger --action=change --settle "/sys/class/net/$first" "/sys/class/net/$second"
systemctl restart NetworkManager
nm-online --wait-for-startup --timeout=25 --quiet

# These read-only probes must agree before CeraUI's discovery sees either radio.
probe() {
	local iface=$1 parent=$2 expected=$3 udev_path nm_path nm_labels
	udev_path=$(udevadm info --query=property --property=ID_PATH --value "/sys/class/net/$iface")
	nm_path=$(nmcli --escape no -g GENERAL.PATH device show "$iface")
	nm_labels=$(nmcli --escape no -g GENERAL.VENDOR,GENERAL.PRODUCT device show "$iface")
	printf 'B9-PORT-PROBE layout=%s ifname=%s parent=%s mac=%s udev=%q nm=%q expected=%s labels=%q\n' \
		"$layout" "$iface" "$parent" "$first_mac" "$udev_path" "$nm_path" "$expected" "$nm_labels"
	[[ "$udev_path" == "$expected" && "$nm_path" == "$expected" && "$nm_labels" == "$vendor"$'\n'"$product" ]]
}
rc=0
probe "$first" "$first_parent" "$first_path" || rc=1
probe "$second" "$second_parent" "$second_path" || rc=1
exit "$rc"
