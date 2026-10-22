#!/usr/bin/env bash
set -euo pipefail

bun_bin="${2:-}"
if [ -z "$bun_bin" ]; then
	bun_bin="$(command -v bun)" || { echo "bun not found on PATH" >&2; exit 1; }
fi
if [[ "$bun_bin" != /* || ! -x "$bun_bin" ]]; then
	echo "bun executable must be an accessible absolute path: $bun_bin" >&2
	exit 1
fi

runner="$(dirname "$0")/update-transport-netns-runner.ts"
mode="${1:-selector}"
if [ "$mode" = pin ]; then runner="$(dirname "$0")/update-transport-pin-netns-runner.ts"; fi
root="$(mktemp -d)"
peer0=""
peer1=""
server0=""
server1=""
cleanup() {
	for pid in "$server0" "$server1" "$peer0" "$peer1"; do
		if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
	done
	for pid in "$server0" "$server1" "$peer0" "$peer1"; do
		if [ -n "$pid" ]; then wait "$pid" 2>/dev/null || true; fi
	done
	rm -rf "$root"
}
trap cleanup EXIT

wait_for_peer() {
	local peer="$1" marker="$2" deadline=$((SECONDS + 10))
	until [ -f "$marker" ]; do
		if ! kill -0 "$peer" 2>/dev/null || (( SECONDS >= deadline )); then
			echo "transport fixture: peer namespace readiness failed: $peer" >&2
			return 1
		fi
		sleep 0.01
	done
}

wait_for_listener() {
	local peer="$1" address="$2" port="$3" deadline=$((SECONDS + 10))
	until nsenter -t "$peer" -n bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$address" "$port" 2>/dev/null; do
		if ! kill -0 "$peer" 2>/dev/null || (( SECONDS >= deadline )); then
			echo "transport fixture: listener readiness failed: $address:$port" >&2
			return 1
		fi
		sleep 0.01
	done
}

if [ "$mode" = selector ]; then "$bun_bin" "$runner" prepare "$root"; fi
ip link set lo up
for index in 0 1; do
	unshare -n -- bash -c 'touch "$1"; exec sleep 120' _ "$root/peer-$index.ready" &
	peer=$!
	if [ "$index" -eq 0 ]; then peer0=$peer; subnet=192.0.2; else peer1=$peer; subnet=198.51.100; fi
	wait_for_peer "$peer" "$root/peer-$index.ready"
	ip link add "eth${index}" type veth peer name "srv${index}"
	ip link set "srv${index}" netns "$peer"
	ip addr add "${subnet}.1/24" dev "eth${index}"
	ip link set "eth${index}" up
	nsenter -t "$peer" -n ip link set lo up
	nsenter -t "$peer" -n ip addr add "${subnet}.2/24" dev "srv${index}"
	if [ "$index" -eq 0 ]; then nsenter -t "$peer" -n ip addr add 192.0.2.3/24 dev srv0; fi
	nsenter -t "$peer" -n ip link set "srv${index}" up
	nsenter -t "$peer" -n "$bun_bin" "$runner" server "$root" "${subnet}.2" "$index" &
	if [ "$index" -eq 0 ]; then server0=$!; else server1=$!; fi
done
if [ "$mode" = pin ]; then ports=(8088); else ports=(80 443); fi
for index in 0 1; do
	if [ "$index" -eq 0 ]; then peer=$peer0; subnet=192.0.2; server=$server0; else peer=$peer1; subnet=198.51.100; server=$server1; fi
	for port in "${ports[@]}"; do wait_for_listener "$server" "${subnet}.2" "$port"; done
	if [ "$mode" = selector ] && [ "$index" -eq 0 ]; then
		for port in "${ports[@]}"; do wait_for_listener "$server" 192.0.2.3 "$port"; done
	fi
done
if [ "$mode" = pin ]; then
	ip route add default via 192.0.2.2 dev eth0 metric 100
	ip route add default via 198.51.100.2 dev eth1 metric 10
fi
"$bun_bin" "$runner" client "$root"
