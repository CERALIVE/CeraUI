#!/usr/bin/env bash
set -uo pipefail
umask 077
cd /repo
printf 'B7_R17_LOSSLESS_GUEST_OS=%s\n' "$(. /etc/os-release; printf '%s' "$PRETTY_NAME")"
printf 'B7_R17_LOSSLESS_GUEST_NM=%s\n' "$(NetworkManager --version)"
test "$(NetworkManager --version)" = 1.52.1 || exit 66
# Framing reads touch only this owned throwaway profile in the disposable guest.
(
set -euo pipefail
umask 077
read -r framing_uuid </proc/sys/kernel/random/uuid
framing_root=$(mktemp -d /var/tmp/b7-framing.XXXXXXXX)
framing_name="B7-framing-$framing_uuid"
framing_cleanup() {
    rc=$?
    trap - EXIT
    if timeout 15 /usr/bin/nmcli connection delete uuid "$framing_uuid" >"$framing_root/cleanup.log" 2>&1; then
        printf 'B7_FRAMING_PROBE_CLEANUP=PASS uuid=%s\n' "$framing_uuid"
    else
        printf 'B7_FRAMING_PROBE_CLEANUP=FAIL uuid=%s\n' "$framing_uuid"
        test "$rc" -ne 0 || rc=69
    fi
    rm -rf "$framing_root"
    exit "$rc"
}
trap framing_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
timeout 15 /usr/bin/nmcli connection add type dummy ifname b7-frame-probe     connection.uuid "$framing_uuid" connection.id "$framing_name"     connection.autoconnect no ipv4.method disabled ipv6.method disabled >/dev/null
timeout 15 /usr/bin/nmcli --mode multiline --terse --escape no     --fields connection.id,connection.autoconnect connection show uuid "$framing_uuid"     >"$framing_root/plain"
printf 'B7_FRAMING_PROBE_OD_BEGIN=plain\n'
od -c "$framing_root/plain"
printf 'B7_FRAMING_PROBE_OD_END=plain\n'
timeout 15 /usr/bin/nmcli connection modify uuid "$framing_uuid" connection.id "$framing_name"$'\n'
timeout 15 /usr/bin/nmcli --mode multiline --terse --escape no     --fields connection.id,connection.autoconnect connection show uuid "$framing_uuid"     >"$framing_root/trailing-lf"
printf 'B7_FRAMING_PROBE_OD_BEGIN=trailing-lf\n'
od -c "$framing_root/trailing-lf"
printf 'B7_FRAMING_PROBE_OD_END=trailing-lf\n'
python3 - "$framing_root" "$framing_name" <<'FRAMING'
from pathlib import Path
import sys
root, name = Path(sys.argv[1]), sys.argv[2].encode()
expected = {
    "plain": b"connection.id:" + name + b"\nconnection.autoconnect:no\n",
    "trailing-lf": b"connection.id:" + name + b"\n\nconnection.autoconnect:no\n",
}
for case, value in expected.items():
    if (root / case).read_bytes() != value:
        print("B7_FRAMING_PROBE_CONTRACT=FAIL case=" + case, flush=True)
        raise SystemExit(69)
    print("B7_FRAMING_PROBE_CONTRACT=PASS case=" + case, flush=True)
FRAMING
) || exit 69
