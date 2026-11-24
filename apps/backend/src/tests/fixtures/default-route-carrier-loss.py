"""Lower the fixture veth peer and wait for the route device's carrier event."""

import socket
import struct
import subprocess
import time
from typing import Final

# Linux rtnetlink.h / if.h. Filter by the route device's ifindex, not the peer
# whose administrative state is changed by ip link set.
RTMGRP_LINK: Final = 1
RTM_NEWLINK: Final = 16
IFF_UP: Final = 0x1
IFF_LOWER_UP: Final = 0x10000
NLMSG: Final = struct.Struct("=IHHII")
IFINFO: Final = struct.Struct("=BBHiII")


def main() -> None:
    route_device = socket.if_nametoindex("routeb")
    with socket.socket(
        socket.AF_NETLINK, socket.SOCK_RAW, socket.NETLINK_ROUTE
    ) as events:
        events.bind((0, RTMGRP_LINK))
        deadline = time.monotonic() + 5
        subprocess.run(("ip", "link", "set", "peerb", "down"), check=True, timeout=5)
        while (remaining := deadline - time.monotonic()) > 0:
            events.settimeout(remaining)
            packet, sender = events.recvfrom(65536)
            if sender[0] != 0:
                continue
            offset = 0
            while offset + NLMSG.size <= len(packet):
                length, kind, *_ = NLMSG.unpack_from(packet, offset)
                if length < NLMSG.size or offset + length > len(packet):
                    break
                if kind == RTM_NEWLINK and length >= NLMSG.size + IFINFO.size:
                    _, _, _, index, flags, _ = IFINFO.unpack_from(
                        packet, offset + NLMSG.size
                    )
                    if (
                        index == route_device
                        and flags & IFF_UP
                        and not flags & IFF_LOWER_UP
                    ):
                        return
                offset += (length + 3) & ~3
        raise TimeoutError("no carrier-loss RTM_NEWLINK for routeb")


if __name__ == "__main__":
    try:
        main()
    except TimeoutError as error:
        raise SystemExit("timed out waiting for routeb carrier loss") from error
