#!/usr/bin/env bash
#
# integration-test.sh — sample nmcli integration test against the hwsim AP.
#
# Runs INSIDE the harness container (invoked by run.sh after the AP is up), but
# can also be run standalone in any environment where nmcli sees the CeraTest AP.
#
# Mirrors the nmcli surface the CeraUI backend uses (see
# apps/backend/src/modules/network/network-manager.ts):
#   - rescan:  nmcli device wifi rescan
#   - list:    nmcli -t -f SSID dev wifi list
#   - connect: nmcli device wifi connect <ssid> password <psk>
#   - status:  nmcli -t -f GENERAL.STATE dev show <wlan>
#
# It prints every step to stdout so a caller can assert on the output, and exits
# 0 only when the client interface reports 'connected'.
#
set -euo pipefail

SSID="${CERATEST_SSID:-CeraTest}"
PSK="${CERATEST_PSK:-ceratest1234}"
CLIENT_IF="${CERATEST_CLIENT_IF:-}"

echo "=================================================================="
echo " CeraUI wifi-hwsim integration test"
echo " SSID=$SSID"
echo "=================================================================="

# Resolve a client interface if none was provided: prefer an NM-managed wifi
# device that is not the AP, falling back to the first wifi device nmcli knows.
if [ -z "$CLIENT_IF" ]; then
	CLIENT_IF="$(
		nmcli -t -f DEVICE,TYPE,STATE device status 2>/dev/null |
			awk -F: '$2=="wifi" && $3!="unmanaged" {print $1; exit}'
	)"
fi
if [ -z "$CLIENT_IF" ]; then
	CLIENT_IF="$(
		nmcli -t -f DEVICE,TYPE device status 2>/dev/null |
			awk -F: '$2=="wifi" {print $1; exit}'
	)"
fi
if [ -z "$CLIENT_IF" ]; then
	echo "RESULT: FAIL — no wifi client interface found via nmcli"
	exit 1
fi
echo "--> Client interface: $CLIENT_IF"

# --- Step 1: rescan (retry; the simulated medium can take a beat) -----------
echo
echo "--> [1/4] Rescanning on $CLIENT_IF"
for attempt in 1 2 3 4 5; do
	nmcli device wifi rescan ifname "$CLIENT_IF" >/dev/null 2>&1 || true
	sleep 2
	if nmcli -t -f SSID device wifi list ifname "$CLIENT_IF" 2>/dev/null | grep -qx "$SSID"; then
		echo "    Found '$SSID' on rescan attempt $attempt"
		break
	fi
	echo "    attempt $attempt: '$SSID' not visible yet"
done

# --- Step 2: list SSIDs -----------------------------------------------------
echo
echo "--> [2/4] Visible SSIDs (nmcli -t -f SSID dev wifi list):"
SSID_LIST="$(nmcli -t -f SSID device wifi list ifname "$CLIENT_IF" 2>/dev/null || true)"
echo "$SSID_LIST" | sed 's/^/    /'

if ! echo "$SSID_LIST" | grep -qx "$SSID"; then
	echo
	echo "RESULT: FAIL — '$SSID' not present in scan results"
	exit 1
fi

# --- Step 3: connect --------------------------------------------------------
echo
echo "--> [3/4] Connecting to '$SSID'"
if nmcli device wifi connect "$SSID" password "$PSK" ifname "$CLIENT_IF"; then
	echo "    nmcli reported connect success"
else
	echo
	echo "RESULT: FAIL — nmcli could not connect to '$SSID'"
	exit 1
fi

# --- Step 4: assert connected state ----------------------------------------
echo
echo "--> [4/4] Device state (nmcli -t -f GENERAL.STATE dev show $CLIENT_IF):"
STATE=""
for _ in $(seq 1 10); do
	STATE="$(nmcli -t -f GENERAL.STATE device show "$CLIENT_IF" 2>/dev/null || true)"
	echo "    $STATE"
	if echo "$STATE" | grep -qi "connected"; then
		break
	fi
	sleep 1
done

echo
if echo "$STATE" | grep -qi "connected"; then
	echo "RESULT: PASS — $CLIENT_IF is connected to '$SSID'"
	exit 0
fi

echo "RESULT: FAIL — $CLIENT_IF never reached 'connected' (last state: ${STATE:-none})"
exit 1
