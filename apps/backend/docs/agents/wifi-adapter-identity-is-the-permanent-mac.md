<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## WIFI ADAPTER IDENTITY IS THE PERMANENT MAC [EXISTS]

Every adapter-keyed WiFi structure — the `wifiInterfacesByMacAddress` registry,
the `wifiState` cache, the numeric UI id map, the hotspot credential store, and
the `802-11-wireless.mac-address` pinned into a NetworkManager profile — is keyed
on the radio's **permanent hardware address**, resolved by
`modules/wifi/wifi-permanent-mac.ts` (`resolveWifiPermanentMac`).

**`ifconfig`/`GENERAL.HWADDR` report the OPERATIONAL address, and it moves.**
NetworkManager randomizes a WiFi device's MAC while scanning
(`wifi.scan-rand-mac-address`, on by default) and resets it when it activates a
connection. Confirmed on a Rock 5B+, roughly every 7 minutes:
`device (wlan0): set-hw-addr: set MAC address to 26:C3:93:B6:9C:A7 (scanning)`.
Two things broke while the registry keyed on that value:

- the registry re-keyed itself, so the adapter's adopted hotspot profile, saved
  connection map and id were discarded and rebuilt empty; and
- profiles were pinned to a randomized address. **NetworkManager matches
  `802-11-wireless.mac-address` against the PERMANENT address**, so those
  profiles could never activate again — the board's journal recorded
  `audit: op="connection-activate" result="fail" reason="… device MAC address
  does not match the profile"` on every hotspot start.

**Resolution ladder** (`resolveWifiPermanentMac(ifname, currentMac)`):
`/sys/class/net/<ifname>/phy80211/macaddress` (the cfg80211 `wiphy->perm_addr`,
verified byte-equal to NetworkManager's D-Bus `PermHwAddress` on the reference
board) → the last permanent address read for that interface → the current
address. The cached tier is load-bearing: a transient sysfs failure must not
re-key the registry onto a scan-time address for one poll. `busctl` is
deliberately NOT used — it is not in the `helpers/run.ts` ALLOWED set, and a
single sysfs read needs no spawn at all. `setPermanentMacReaderForTest` is the
test seam.

The cache also correlates the last permanent address through the operational MAC,
so an ifname rename during a transient sysfs failure keeps the same physical
identity. Discovery never drops an adapter merely because NetworkManager reports
`unavailable`, the operational MAC has not landed, or the permanent address cannot
yet be confirmed: the registry retains a row with a typed `degraded_reason`, keeps
its numeric id while re-keying on recovery, and the frontend withholds controls
until identity is trustworthy.

**A monitor event carries an ifname, never a MAC.** `getWifiInterfaceByIfname()`
(`wifi-connections.ts`) is the bridge; do NOT route a device-state event through
`wifiDeviceListGetMacAddress()` — that returns the operational address and will
miss the registry.

