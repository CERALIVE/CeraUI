#!/usr/bin/env bash
set -euo pipefail

runner="$(dirname "$0")/update-transport-netns-runner.ts"
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

bun "$runner" prepare "$root"
ip link set lo up
for index in 0 1; do
	unshare -n -- sleep 120 &
	peer=$!
	if [ "$index" -eq 0 ]; then peer0=$peer; subnet=192.0.2; else peer1=$peer; subnet=198.51.100; fi
	ip link add "eth${index}" type veth peer name "srv${index}"
	ip link set "srv${index}" netns "$peer"
	ip addr add "${subnet}.1/24" dev "eth${index}"
	ip link set "eth${index}" up
	nsenter -t "$peer" -n ip link set lo up
	nsenter -t "$peer" -n ip addr add "${subnet}.2/24" dev "srv${index}"
	if [ "$index" -eq 0 ]; then nsenter -t "$peer" -n ip addr add 192.0.2.3/24 dev srv0; fi
	nsenter -t "$peer" -n ip link set "srv${index}" up
	nsenter -t "$peer" -n bun "$runner" server "$root" "${subnet}.2" "$index" &
	if [ "$index" -eq 0 ]; then server0=$!; else server1=$!; fi
done
sleep 0.3
bun "$runner" client "$root"
