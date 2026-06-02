#!/usr/bin/env bash
#
# run.sh — local-only mac80211_hwsim Wi-Fi harness orchestrator.
#
# What it does:
#   1. Verifies the host can run the harness (check-env.sh; best-effort skip).
#   2. Loads mac80211_hwsim on the HOST: `modprobe mac80211_hwsim radios=2`.
#   3. Detects the two virtual radios' wlan interfaces on the host and releases
#      them from any host-side NetworkManager (best-effort) so they are free.
#   4. Builds + runs the harness container with:
#         --privileged --net=host -v /sys:/sys -v /lib/modules:/lib/modules
#      Inside the container it:
#         - serves a hostapd AP (SSID=CeraTest, WPA2-PSK ceratest1234) on radio 0
#         - exposes nmcli (NetworkManager) on radio 1 as the client
#         - runs integration-test.sh (default) or drops to a shell (--shell)
#   5. Cleans up on ANY exit: stops the container and unloads the module (unless
#      it was already loaded before we started, or --keep-module is given).
#
# This is best-effort, LOCAL-ONLY infrastructure. It is NOT a CI gate and must
# not be required for any unit/integration test to pass.
#
# Usage:
#   ./run.sh            # bring up AP + run integration-test.sh
#   ./run.sh --shell    # bring up AP, then drop into an interactive container shell
#   ./run.sh --keep-module   # do not rmmod mac80211_hwsim on exit
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Tunables (override via env) --------------------------------------------
SSID="${CERATEST_SSID:-CeraTest}"
PASSPHRASE="${CERATEST_PSK:-ceratest1234}"
RADIOS="${HWSIM_RADIOS:-2}"
IMAGE="${HWSIM_IMAGE:-ceraui-wifi-hwsim:latest}"
CONTAINER="${HWSIM_CONTAINER:-ceraui-wifi-hwsim}"

MODE="test"
KEEP_MODULE=0

for arg in "$@"; do
	case "$arg" in
	--shell) MODE="shell" ;;
	--keep-module) KEEP_MODULE=1 ;;
	-h | --help)
		grep -E '^#( |$)' "$0" | sed 's/^#\s\?//'
		exit 0
		;;
	*)
		echo "run.sh: unknown argument '$arg' (try --help)" >&2
		exit 2
		;;
	esac
done

# --- root / sudo helper -----------------------------------------------------
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
	if command -v sudo >/dev/null 2>&1; then
		SUDO="sudo"
	else
		echo "run.sh: must run as root (modprobe + privileged docker), and sudo is not available." >&2
		exit 1
	fi
fi

# --- 1. environment check (best-effort) -------------------------------------
echo "==> Checking host environment"
if ! env_out="$(bash "$SCRIPT_DIR/check-env.sh" 2>&1)"; then
	echo "$env_out"
	echo "run.sh: host cannot run the hwsim harness; nothing to do (best-effort, exiting 0)."
	exit 0
fi
echo "$env_out"

# Track whether the module was already present (so we don't unload someone
# else's instance on cleanup).
MODULE_PREEXISTING=0
[ -d /sys/module/mac80211_hwsim ] && MODULE_PREEXISTING=1

# Interfaces we released from host NM, so cleanup can hand them back.
HOST_RELEASED_IFS=()

cleanup() {
	local rc=$?
	set +e
	echo "==> Cleanup"
	$SUDO docker rm -f "$CONTAINER" >/dev/null 2>&1

	# Hand host interfaces back to host NetworkManager if we took them.
	if command -v nmcli >/dev/null 2>&1; then
		for ifc in "${HOST_RELEASED_IFS[@]:-}"; do
			[ -n "$ifc" ] && $SUDO nmcli device set "$ifc" managed yes >/dev/null 2>&1
		done
	fi

	if [ "$KEEP_MODULE" -eq 0 ] && [ "$MODULE_PREEXISTING" -eq 0 ]; then
		echo "==> Unloading mac80211_hwsim"
		$SUDO modprobe -r mac80211_hwsim 2>/dev/null
	else
		echo "==> Leaving mac80211_hwsim loaded (pre-existing or --keep-module)"
	fi
	exit "$rc"
}
trap cleanup EXIT INT TERM

# --- 2. load mac80211_hwsim on the host -------------------------------------
if [ "$MODULE_PREEXISTING" -eq 1 ]; then
	echo "==> mac80211_hwsim already loaded; reusing existing radios"
else
	echo "==> Loading mac80211_hwsim radios=$RADIOS"
	$SUDO modprobe mac80211_hwsim radios="$RADIOS"
fi

# Give the kernel a moment to register the netdevs.
sleep 1

# --- 3. detect the hwsim wlan interfaces on the host ------------------------
HWSIM_IFS=()
for netpath in /sys/class/net/*; do
	ifc="$(basename "$netpath")"
	drv="$(basename "$(readlink -f "$netpath/device/driver" 2>/dev/null)" 2>/dev/null || true)"
	if [ "$drv" = "mac80211_hwsim" ]; then
		HWSIM_IFS+=("$ifc")
	fi
done

if [ "${#HWSIM_IFS[@]}" -lt 2 ]; then
	echo "run.sh: expected >=2 mac80211_hwsim interfaces, found ${#HWSIM_IFS[@]} (${HWSIM_IFS[*]:-none})." >&2
	echo "       Try: $SUDO modprobe -r mac80211_hwsim && $SUDO modprobe mac80211_hwsim radios=2" >&2
	exit 1
fi

AP_IF="${HWSIM_IFS[0]}"
CLIENT_IF="${HWSIM_IFS[1]}"
echo "==> Virtual radios: AP=$AP_IF  CLIENT=$CLIENT_IF (all: ${HWSIM_IFS[*]})"

# Release the hwsim interfaces from any HOST NetworkManager so the container
# (and hostapd) can own them. Without --net=host this would not be needed, but
# the task requires --net=host, so we share the host's network namespace.
if command -v nmcli >/dev/null 2>&1; then
	for ifc in "$AP_IF" "$CLIENT_IF"; do
		if $SUDO nmcli device set "$ifc" managed no >/dev/null 2>&1; then
			HOST_RELEASED_IFS+=("$ifc")
			echo "==> Host NetworkManager releasing $ifc"
		fi
	done
fi

# --- 4. build the harness image ---------------------------------------------
echo "==> Building image $IMAGE"
$SUDO docker build -t "$IMAGE" "$SCRIPT_DIR"

# In-container orchestration. Quoted heredoc => no host-side expansion; the
# container reads everything from the environment we pass with -e.
BOOTSTRAP="$(
	cat <<'BOOT'
set -euo pipefail

SSID="${CERATEST_SSID:-CeraTest}"
PSK="${CERATEST_PSK:-ceratest1234}"
AP_IF="${HWSIM_AP_IF:?AP interface not provided}"
CLIENT_IF="${HWSIM_CLIENT_IF:?client interface not provided}"
MODE="${HARNESS_MODE:-test}"

echo "[container] AP=$AP_IF CLIENT=$CLIENT_IF SSID=$SSID MODE=$MODE"

# Unblock any soft/hard rfkill on the virtual radios.
rfkill unblock all 2>/dev/null || true

# Keep NetworkManager off the AP interface so hostapd can own it; let it manage
# the client interface.
mkdir -p /etc/NetworkManager/conf.d
cat >/etc/NetworkManager/conf.d/00-hwsim.conf <<EOF
[keyfile]
unmanaged-devices=interface-name:${AP_IF}
EOF

# NetworkManager needs a system D-Bus inside the container's mount namespace.
mkdir -p /run/dbus
if [ ! -S /run/dbus/system_bus_socket ]; then
	dbus-daemon --system --fork
fi

echo "[container] Starting NetworkManager"
NetworkManager &
NM_PID=$!

# In-container cleanup.
cleanup() {
	set +e
	[ -n "${HOSTAPD_PID:-}" ] && kill "$HOSTAPD_PID" 2>/dev/null
	[ -n "${NM_PID:-}" ] && kill "$NM_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

# Wait for NM to come up (best-effort, bounded).
for _ in $(seq 1 20); do
	if nmcli general status >/dev/null 2>&1; then break; fi
	sleep 0.5
done
nmcli device set "$CLIENT_IF" managed yes >/dev/null 2>&1 || true

# Bring up the AP interface and start hostapd (WPA2-PSK).
ip link set "$AP_IF" up 2>/dev/null || true
cat >/tmp/hostapd.conf <<EOF
interface=${AP_IF}
driver=nl80211
ssid=${SSID}
hw_mode=g
channel=6
wpa=2
wpa_passphrase=${PSK}
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
ignore_broadcast_ssid=0
EOF

echo "[container] Starting hostapd on $AP_IF"
hostapd -t /tmp/hostapd.conf >/tmp/hostapd.log 2>&1 &
HOSTAPD_PID=$!

# Wait for the AP to enable.
ap_up=0
for _ in $(seq 1 20); do
	if grep -q "AP-ENABLED" /tmp/hostapd.log 2>/dev/null; then
		ap_up=1
		break
	fi
	if ! kill -0 "$HOSTAPD_PID" 2>/dev/null; then
		echo "[container] hostapd exited early; log follows:" >&2
		cat /tmp/hostapd.log >&2
		exit 1
	fi
	sleep 0.5
done
if [ "$ap_up" -ne 1 ]; then
	echo "[container] hostapd did not reach AP-ENABLED in time; log follows:" >&2
	cat /tmp/hostapd.log >&2
	exit 1
fi
echo "[container] AP '$SSID' is up on $AP_IF"

export CERATEST_CLIENT_IF="$CLIENT_IF"
export CERATEST_SSID="$SSID"
export CERATEST_PSK="$PSK"

if [ "$MODE" = "shell" ]; then
	echo "[container] AP is up. Dropping into a shell. nmcli is on $CLIENT_IF."
	echo "[container] Try: nmcli -t -f SSID dev wifi list ifname $CLIENT_IF"
	exec bash -i
else
	exec bash /harness/integration-test.sh
fi
BOOT
)"

# --- 5. run the container ---------------------------------------------------
echo "==> Running container $CONTAINER"
$SUDO docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

TTY_FLAGS=()
if [ "$MODE" = "shell" ] && [ -t 0 ]; then
	TTY_FLAGS=(-it)
fi

$SUDO docker run --rm --name "$CONTAINER" \
	"${TTY_FLAGS[@]}" \
	--privileged \
	--net=host \
	-v /sys:/sys \
	-v /lib/modules:/lib/modules:ro \
	-v "$SCRIPT_DIR":/harness \
	-e CERATEST_SSID="$SSID" \
	-e CERATEST_PSK="$PASSPHRASE" \
	-e HWSIM_AP_IF="$AP_IF" \
	-e HWSIM_CLIENT_IF="$CLIENT_IF" \
	-e HARNESS_MODE="$MODE" \
	-e BOOTSTRAP="$BOOTSTRAP" \
	"$IMAGE" \
	bash -c 'eval "$BOOTSTRAP"' # shellcheck disable=SC2016 -- $BOOTSTRAP must expand inside the container, not here

echo "==> run.sh finished"
