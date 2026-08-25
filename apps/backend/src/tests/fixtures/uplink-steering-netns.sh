#!/usr/bin/env bash
set -euo pipefail

weighted=$1
select_wan0=$2
transition_wan1=$3
final_wan1=$4
log0=$5
log1=$6
mark0=$7
mark1=$8
shift 8

unshare -n -- sleep 25 & client_pid=$!
unshare -n -- sleep 25 & wan0_pid=$!
unshare -n -- sleep 25 & wan1_pid=$!
server0=""
server1=""
cleanup() {
	[ -z "$server0" ] || kill "$server0" 2>/dev/null || true
	[ -z "$server1" ] || kill "$server1" 2>/dev/null || true
	kill "$client_pid" "$wan0_pid" "$wan1_pid" 2>/dev/null || true
	wait "$server0" "$server1" "$client_pid" "$wan0_pid" "$wan1_pid" 2>/dev/null || true
}
trap cleanup EXIT

ip link set lo up
ip link add client0 type veth peer name client_peer
ip link add wan0 type veth peer name wan0_peer
ip link add wan1 type veth peer name wan1_peer
ip link set client_peer netns "$client_pid"
ip link set wan0_peer netns "$wan0_pid"
ip link set wan1_peer netns "$wan1_pid"

ip addr add 10.42.0.1/24 dev client0
ip addr add 192.0.2.1/24 dev wan0
ip addr add 198.51.100.1/24 dev wan1
ip link set client0 up
ip link set wan0 up
ip link set wan1 up

nsenter -t "$client_pid" -n ip link set lo up
nsenter -t "$client_pid" -n ip addr add 10.42.0.2/24 dev client_peer
nsenter -t "$client_pid" -n ip link set client_peer up
nsenter -t "$client_pid" -n ip route add default via 10.42.0.1

nsenter -t "$wan0_pid" -n ip link set lo up
nsenter -t "$wan0_pid" -n ip addr add 192.0.2.2/24 dev wan0_peer
nsenter -t "$wan0_pid" -n ip addr add 203.0.113.10/32 dev lo
nsenter -t "$wan0_pid" -n ip link set wan0_peer up
nsenter -t "$wan0_pid" -n ip route add default via 192.0.2.1

nsenter -t "$wan1_pid" -n ip link set lo up
nsenter -t "$wan1_pid" -n ip addr add 198.51.100.2/24 dev wan1_peer
nsenter -t "$wan1_pid" -n ip addr add 203.0.113.10/32 dev lo
nsenter -t "$wan1_pid" -n ip link set wan1_peer up
nsenter -t "$wan1_pid" -n ip route add default via 198.51.100.1

ip route add default via 192.0.2.2 dev wan0
ip route add default via 192.0.2.2 dev wan0 table 100
ip route add default via 198.51.100.2 dev wan1 table 101
ip rule add priority 110 fwmark "$mark0/0xffffff00" lookup 100
ip rule add priority 110 fwmark "$mark1/0xffffff00" lookup 101
sysctl -q -w net.ipv4.ip_forward=1
sysctl -q -w net.ipv4.conf.all.rp_filter=0
sysctl -q -w net.ipv4.conf.default.rp_filter=0
sysctl -q -w net.ipv4.conf.client0.rp_filter=0
sysctl -q -w net.ipv4.conf.wan0.rp_filter=0
sysctl -q -w net.ipv4.conf.wan1.rp_filter=0

nft -f - <<'NFT'
table inet ceralive_ingest_fw {
	chain input {
		type filter hook input priority -10; policy accept;
	}
}
NFT
nft --check --file "$weighted"
nft --file "$weighted"

read -r -d '' SERVER_CODE <<'PY' || true
import selectors, socket, sys
selector = selectors.DefaultSelector()
for port in (9000, 9001, 9002, 9003, 9100, 9101, 9200):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("203.0.113.10", port))
    selector.register(sock, selectors.EVENT_READ, port)
with open(sys.argv[1], "a", buffering=1) as output:
    while True:
        for key, _ in selector.select():
            data, peer = key.fileobj.recvfrom(2048)
            text = data.decode()
            output.write(f"{text}|{peer[0]}|{peer[1]}|{key.data}\n")
            if text == "reply-probe":
                key.fileobj.sendto(b"reply-ok", peer)
PY
nsenter -t "$wan0_pid" -n python3 -u -c "$SERVER_CODE" "$log0" & server0=$!
nsenter -t "$wan1_pid" -n python3 -u -c "$SERVER_CODE" "$log1" & server1=$!
sleep 0.2

read -r -d '' WEIGHTED_SEND <<'PY' || true
import socket, time
for index in range(200):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.sendto(f"weighted-{index}".encode(), ("203.0.113.10", 9000))
    sock.close()
    time.sleep(0.001)
PY
nsenter -t "$client_pid" -n python3 -c "$WEIGHTED_SEND"
sleep 0.3

read -r -d '' SEND_ONE <<'PY' || true
import socket, sys
payload, source_ip, source_port, dest_port = sys.argv[1:]
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind((source_ip, int(source_port)))
sock.sendto(payload.encode(), ("203.0.113.10", int(dest_port)))
sock.close()
PY

nft --file "$select_wan0"
nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" sticky-before 10.42.0.2 39001 9001
sleep 0.1

nft --file "$transition_wan1"
nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" sticky-after 10.42.0.2 39001 9001
nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" new-after 10.42.0.2 39002 9002
nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" drain-new 10.42.0.2 39004 9003
python3 -c "$SEND_ONE" local 192.0.2.1 39003 9100
python3 -c "$SEND_ONE" overlap-local 10.42.0.1 39006 9101

read -r -d '' REPLY_PROBE <<'PY' || true
import socket
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.settimeout(2)
sock.bind(("10.42.0.2", 39005))
sock.sendto(b"reply-probe", ("203.0.113.10", 9200))
try:
    data, _ = sock.recvfrom(1024)
    print("true" if data == b"reply-ok" else "false")
except TimeoutError:
    print("false")
PY
reply_round_trip=$(nsenter -t "$client_pid" -n python3 -c "$REPLY_PROBE")
sleep 0.3

flush_backend="conntrack"
if command -v conntrack >/dev/null 2>&1; then
	conntrack --delete --mark "$mark0/0xffffff00" >/dev/null
else
	flush_backend="ctnetlink"
	python3 - "$mark0" <<'PY'
import socket, struct, sys

mark = int(sys.argv[1], 16)
mask = 0xffffff00

def nla(kind, value):
    size = 4 + len(value)
    padded = (size + 3) & ~3
    return struct.pack("=HH", size, kind) + value + bytes(padded - size)

payload = struct.pack("!BBH", socket.AF_INET, 0, 0)
payload += nla(8, struct.pack("!I", mark))
payload += nla(21, struct.pack("!I", mask))
sequence = 1
message_type = (1 << 8) | 2
header = struct.pack("=IHHII", 16 + len(payload), message_type, 1 | 4, sequence, 0)
sock = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 12)
sock.bind((0, 0))
sock.send(header + payload)
while True:
    response = sock.recv(65535)
    _, response_type, _, response_sequence, _ = struct.unpack_from("=IHHII", response)
    if response_sequence != sequence:
        continue
    if response_type != 2:
        raise SystemExit(f"unexpected netlink response type {response_type}")
    error = struct.unpack_from("=i", response, 16)[0]
    if error != 0:
        raise SystemExit(f"ctnetlink delete failed: {-error}")
    break
PY
fi

ip rule del priority 110 fwmark "$mark0/0xffffff00" lookup 100
nft --file "$final_wan1"
nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" sticky-post-flush 10.42.0.2 39001 9001
sleep 0.5

for golden in "$@"; do
	nft --check --file "$golden"
done
nft list table inet ceralive_ingest_fw >/dev/null

python3 - "$log0" "$log1" "$reply_round_trip" "$flush_backend" \
	"$(sysctl -n net.ipv4.conf.all.rp_filter)" \
	"$(sysctl -n net.ipv4.conf.default.rp_filter)" \
	"$(sysctl -n net.ipv4.conf.wan0.rp_filter)" \
	"$(sysctl -n net.ipv4.conf.wan1.rp_filter)" <<'PY'
import json, pathlib, sys

def read(path):
    file = pathlib.Path(path)
    return file.read_text().splitlines() if file.exists() else []

rows = {"wan0": read(sys.argv[1]), "wan1": read(sys.argv[2])}

def tagged(prefix):
    return [(name, row) for name, values in rows.items() for row in values if row.startswith(prefix + "|")]

def uplink(tag):
    matches = tagged(tag)
    return matches[0][0] if len(matches) == 1 else None

def source(tag):
    matches = tagged(tag)
    return matches[0][1].split("|")[1] if len(matches) == 1 else None

weighted0 = sum(row.startswith("weighted-") for row in rows["wan0"])
weighted1 = sum(row.startswith("weighted-") for row in rows["wan1"])
weighted_nat = all(
    row.split("|")[1] == expected
    for name, expected in (("wan0", "192.0.2.1"), ("wan1", "198.51.100.1"))
    for row in rows[name]
    if row.startswith("weighted-")
)

print(json.dumps({
    "weightedWan0": weighted0,
    "weightedWan1": weighted1,
    "weightedTotal": weighted0 + weighted1,
    "weightedNatScoped": weighted_nat,
    "stickyBefore": uplink("sticky-before"),
    "stickyAfter": uplink("sticky-after"),
    "newAfterReweight": uplink("new-after"),
    "drainNew": uplink("drain-new"),
    "stickyPostFlush": uplink("sticky-post-flush"),
    "localUplink": uplink("local"),
    "localSource": source("local"),
    "overlapLocalSource": source("overlap-local"),
    "replyProbeUplink": uplink("reply-probe"),
    "replyRoundTrip": sys.argv[3] == "true",
    "flushBackend": sys.argv[4],
    "rpFilter": {
        "all": int(sys.argv[5]),
        "default": int(sys.argv[6]),
        "wan0": int(sys.argv[7]),
        "wan1": int(sys.argv[8]),
    },
    "foreignTablePresent": True,
}))
PY
