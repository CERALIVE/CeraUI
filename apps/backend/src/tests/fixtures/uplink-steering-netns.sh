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
nm_shared=$9
shift 9

signals="${log0}.signals"
mkfifo "$signals"
exec 3<>"$signals"
wait_signal() {
	local signal
	if ! IFS= read -r -t 5 signal <&3 || [ "$signal" != "$1" ]; then
		printf 'expected signal %s, received %s\n' "$1" "${signal:-timeout}" >&2
		return 1
	fi
}
namespace_code='import os, signal, sys; os.write(3, f"namespace-{sys.argv[1]}\n".encode()); signal.pause()'
client_pid=""
wan0_pid=""
wan1_pid=""
shared_pid=""
server0=""
server1=""
client_server=""
shared_server=""
cleanup() {
	[ -z "$server0" ] || kill "$server0" 2>/dev/null || true
	[ -z "$server1" ] || kill "$server1" 2>/dev/null || true
	[ -z "$client_server" ] || kill "$client_server" 2>/dev/null || true
	[ -z "$shared_server" ] || kill "$shared_server" 2>/dev/null || true
	kill "$client_pid" "$wan0_pid" "$wan1_pid" "$shared_pid" 2>/dev/null || true
	wait "$server0" "$server1" "$client_server" "$shared_server" \
		"$client_pid" "$wan0_pid" "$wan1_pid" "$shared_pid" 2>/dev/null || true
	exec 3>&-
	rm -f "$signals"
}
trap cleanup EXIT

unshare -n -- python3 -c "$namespace_code" client & client_pid=$!
wait_signal namespace-client
unshare -n -- python3 -c "$namespace_code" wan0 & wan0_pid=$!
wait_signal namespace-wan0
unshare -n -- python3 -c "$namespace_code" wan1 & wan1_pid=$!
wait_signal namespace-wan1
if [ "$nm_shared" = "--nm-shared" ]; then
	unshare -n -- python3 -c "$namespace_code" shared & shared_pid=$!
	wait_signal namespace-shared
fi

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
		udp dport 4001 accept
	}
}
NFT
ingest_before=$(nft list table inet ceralive_ingest_fw)
nft --check --file "$weighted"
nft --file "$weighted"

read -r -d '' SERVER_CODE <<'PY' || true
import os, selectors, socket, sys
selector = selectors.DefaultSelector()
for port in (9000, 9001, 9002, 9003, 9100, 9101, 9200, 9300):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((sys.argv[2], port))
    selector.register(sock, selectors.EVENT_READ, port)
with open(sys.argv[1], "a", buffering=1) as output:
    os.write(3, b"server-ready\n")
    while True:
        for key, _ in selector.select():
            data, peer = key.fileobj.recvfrom(2048)
            text = data.decode()
            output.write(f"{text}|{peer[0]}|{peer[1]}|{key.data}\n")
            key.fileobj.sendto(b"reply-ok" if text == "reply-probe" else b"received", peer)
PY
nsenter -t "$wan0_pid" -n python3 -u -c "$SERVER_CODE" "$log0" 203.0.113.10 & server0=$!
wait_signal server-ready
nsenter -t "$wan1_pid" -n python3 -u -c "$SERVER_CODE" "$log1" 203.0.113.10 & server1=$!
wait_signal server-ready

read -r -d '' WEIGHTED_SEND <<'PY' || true
import socket
for index in range(1000):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(2)
    sock.sendto(f"weighted-{index}".encode(), ("203.0.113.10", 9000))
    assert sock.recvfrom(1024)[0] == b"received", f"weighted-{index} not acknowledged"
    sock.close()
PY
nsenter -t "$client_pid" -n python3 -c "$WEIGHTED_SEND"

read -r -d '' SEND_ONE <<'PY' || true
import socket, sys
payload, source_ip, source_port, dest_port = sys.argv[1:]
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.settimeout(2)
sock.bind((source_ip, int(source_port)))
sock.sendto(payload.encode(), ("203.0.113.10", int(dest_port)))
assert sock.recvfrom(1024)[0] == b"received", f"{payload} not acknowledged"
sock.close()
PY

nft --file "$select_wan0"
nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" sticky-before 10.42.0.2 39001 9001

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
sock.settimeout(2)
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

for golden in "$@"; do
	nft --check --file "$golden"
done
nft list table inet ceralive_ingest_fw >/dev/null

nm_result='null'
if [ "$nm_shared" = "--nm-shared" ]; then
	ip link add shared0 type veth peer name shared_peer
	ip link set shared_peer netns "$shared_pid"
	ip addr add 10.43.0.1/24 dev shared0
	ip link set shared0 up
	sysctl -q -w net.ipv4.conf.shared0.rp_filter=0
	nsenter -t "$shared_pid" -n ip link set lo up
	nsenter -t "$shared_pid" -n ip addr add 10.43.0.2/24 dev shared_peer
	nsenter -t "$shared_pid" -n ip link set shared_peer up
	nsenter -t "$shared_pid" -n ip route add default via 10.43.0.1
	# Route cross-zone probes to the actual peer, even when steering marks them.
	ip route add 10.42.0.0/24 dev client0 table 101
	ip route add 10.43.0.0/24 dev shared0 table 101
	nsenter -t "$client_pid" -n python3 -u -c "$SERVER_CODE" "${log0}.client" 10.42.0.2 & client_server=$!
	wait_signal server-ready
	nsenter -t "$shared_pid" -n python3 -u -c "$SERVER_CODE" "${log0}.shared" 10.43.0.2 & shared_server=$!
	wait_signal server-ready
	for zone in 'client0 10.42.0.0/24' 'shared0 10.43.0.0/24'; do
		read -r ifname prefix <<<"$zone"
		nft -f - <<NFT
table ip nm-shared-$ifname {
	chain nat_postrouting {
		type nat hook postrouting priority srcnat; policy accept;
		ip saddr $prefix ip daddr != $prefix masquerade
	}
	chain filter_forward {
		type filter hook forward priority filter; policy accept;
		ip daddr $prefix oifname "$ifname" ct state { established, related } accept
		ip saddr $prefix iifname "$ifname" accept
		iifname "$ifname" oifname "$ifname" accept
		iifname "$ifname" reject
		oifname "$ifname" reject
	}
}
NFT
	done
	nft -f - <<'NFT'
table inet coexist_observer {
	chain forward {
		type filter hook forward priority -1; policy accept;
		iifname { "client0", "shared0" } udp sport { 42104, 42105, 42200, 42201 } ct state new meta mark 0 ct mark 0 counter comment "fresh-unmarked-cross"
	}
	chain output {
		type filter hook output priority mangle; policy accept;
		ip saddr 192.0.2.1 ip daddr 203.0.113.10 udp sport 42300 meta mark 0 ct mark 0 counter comment "local-unmarked"
	}
}
NFT
	nm_result=$(python3 - "$client_pid" "$shared_pid" "$wan0_pid" <<'PY'
import json, socket, subprocess, sys

client, shared, wan = sys.argv[1:]
probe_code = """
import socket, sys
source, destination, port = sys.argv[1:]
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
    sock.settimeout(2)
    sock.bind((source, int(port)))
    sock.connect((destination, 9300))
    sock.send(b"coexist-probe")
    try:
        data = sock.recv(1024)
        assert data == b"received", f"unexpected reply: {data!r}"
        print("reply")
    except ConnectionRefusedError:
        print("rejected")
"""

def probe(namespace, source, destination, port):
    command = ["python3", "-c", probe_code, source, destination, str(port)]
    if namespace:
        command = ["nsenter", "-t", namespace, "-n", *command]
    return subprocess.check_output(command, text=True, timeout=3).strip()

def phase(base):
    return {
        "hotspotRoundTrip": probe(client, "10.42.0.2", "203.0.113.10", base),
        "sharedLanRoundTrip": probe(shared, "10.43.0.2", "203.0.113.10", base + 1),
        "uplinkToHotspot": probe(wan, "192.0.2.2", "10.42.0.2", base + 2),
        "uplinkToSharedLan": probe(wan, "192.0.2.2", "10.43.0.2", base + 3),
        "hotspotToSharedLan": probe(client, "10.42.0.2", "10.43.0.2", base + 4),
        "sharedLanToHotspot": probe(shared, "10.43.0.2", "10.42.0.2", base + 5),
    }

coexistence = phase(42000)
assert probe(None, "192.0.2.1", "203.0.113.10", 42300) == "reply"
subprocess.run(["nft", "delete", "table", "inet", "ceralive_share"], check=True)
subprocess.run(["nft", "add", "table", "inet", "ceralive_share"], check=True)

cross_routes = []
for source, destination, incoming, outgoing in (
    ("10.42.0.2", "10.43.0.2", "client0", "shared0"),
    ("10.43.0.2", "10.42.0.2", "shared0", "client0"),
):
    route = json.loads(subprocess.check_output([
        "ip", "-j", "route", "get", destination, "from", source,
        "iif", incoming, "mark", "0",
    ]))[0]
    assert route["dev"] == outgoing, route
    cross_routes.append(route["dev"])
floor_only = phase(42100)

# Empty steering means fresh unmarked flows reach the opposing zone. Only the
# NM reject statements change, so a successful flow proves rejection had teeth.
for ifname in ("client0", "shared0"):
    ruleset = json.loads(subprocess.check_output([
        "nft", "-j", "-a", "list", "chain", "ip", f"nm-shared-{ifname}", "filter_forward",
    ]))
    for entry in ruleset["nftables"]:
        rule = entry.get("rule")
        if rule and any("reject" in expr for expr in rule["expr"]):
            subprocess.run([
                "nft", "delete", "rule", "ip", f"nm-shared-{ifname}",
                "filter_forward", "handle", str(rule["handle"]),
            ], check=True)
without_rejects = [
    probe(client, "10.42.0.2", "10.43.0.2", 42200),
    probe(shared, "10.43.0.2", "10.42.0.2", 42201),
]
observer = json.loads(subprocess.check_output([
    "nft", "-j", "list", "table", "inet", "coexist_observer",
]))
counters = {
    entry["rule"]["comment"]: next(
        expr["counter"]["packets"] for expr in entry["rule"]["expr"] if "counter" in expr
    )
    for entry in observer["nftables"] if "rule" in entry
}
print(json.dumps({
    "coexistence": coexistence,
    "floorOnly": floor_only,
    "crossRoutes": cross_routes,
    "withoutRejects": without_rejects,
    "freshUnmarkedCrossPackets": counters["fresh-unmarked-cross"],
    "localUnmarkedPackets": counters["local-unmarked"],
}))
PY
)
fi
ingest_after=$(nft list table inet ceralive_ingest_fw)

python3 - "$log0" "$log1" "$reply_round_trip" "$flush_backend" \
	"$(sysctl -n net.ipv4.conf.all.rp_filter)" \
	"$(sysctl -n net.ipv4.conf.default.rp_filter)" \
	"$(sysctl -n net.ipv4.conf.wan0.rp_filter)" \
	"$(sysctl -n net.ipv4.conf.wan1.rp_filter)" \
	"$ingest_before" "$ingest_after" "$nm_result" <<'PY'
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
    "ingestBefore": sys.argv[9],
    "ingestAfter": sys.argv[10],
    "nmSharing": json.loads(sys.argv[11]),
}))
PY
