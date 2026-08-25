#!/usr/bin/env bash
set -euo pipefail

ruleset=$1
commands=$2
unshare -n -- sleep 15 & client_pid=$!
unshare -n -- sleep 15 & wan_pid=$!
cleanup() {
	kill "$client_pid" "$wan_pid" 2>/dev/null || true
	wait "$client_pid" "$wan_pid" 2>/dev/null || true
}
trap cleanup EXIT

ip link set lo up
ip link add client0 type veth peer name client_peer
ip link add wan0 type veth peer name wan_peer
ip link set client_peer netns "$client_pid"
ip link set wan_peer netns "$wan_pid"
ip addr add 10.42.0.1/24 dev client0
ip addr add 192.0.2.1/24 dev wan0
ip link set client0 up
ip link set wan0 up
nsenter -t "$client_pid" -n ip link set lo up
nsenter -t "$client_pid" -n ip addr add 10.42.0.2/24 dev client_peer
nsenter -t "$client_pid" -n ip link set client_peer up
nsenter -t "$client_pid" -n ip route add default via 10.42.0.1
nsenter -t "$wan_pid" -n ip link set lo up
nsenter -t "$wan_pid" -n ip addr add 192.0.2.2/24 dev wan_peer
nsenter -t "$wan_pid" -n ip link set wan_peer up
ip route add 203.0.113.10/32 via 192.0.2.2 dev wan0
ip route add default via 192.0.2.2 dev wan0
sysctl -q -w net.ipv4.ip_forward=1
sysctl -q -w net.ipv4.conf.all.rp_filter=0
sysctl -q -w net.ipv4.conf.default.rp_filter=0
sysctl -q -w net.ipv4.conf.client0.rp_filter=0
sysctl -q -w net.ipv4.conf.wan0.rp_filter=0
nft --check --file "$ruleset"
nft --file "$ruleset"
python3 - "$commands" <<'PY'
import json, subprocess, sys
for argv in json.load(open(sys.argv[1], encoding="utf-8")):
    subprocess.run(["tc", *argv], check=True)
PY

read -r -d '' SEND <<'PY' || true
import socket, sys
source = sys.argv[1]
for index in range(20):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((source, 0))
    sock.sendto(bytes(512), ("203.0.113.10", 9000 + index))
    sock.close()
PY
nsenter -t "$client_pid" -n python3 -c "$SEND" 10.42.0.2
python3 -c "$SEND" 192.0.2.1

tc -s qdisc show dev wan0 | python3 -c '
import json, re, sys
text = sys.stdin.read()
def packets(handle):
    match = re.search(r"qdisc \S+ " + re.escape(handle) + r"[^\n]*\n Sent \d+ bytes (\d+) pkt", text)
    return int(match.group(1)) if match else 0
print(json.dumps({"localPackets": packets("ca10:"), "clientPackets": packets("ca30:")}))
'
