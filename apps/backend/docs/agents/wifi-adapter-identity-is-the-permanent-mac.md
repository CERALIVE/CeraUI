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
its numeric id while re-keying on recovery. A permanent-MAC-unresolved row still
enters the id map and retains today's hotspot prepare/start behavior.

**A monitor event carries an ifname, never a MAC.** `getWifiInterfaceByIfname()`
(`wifi-connections.ts`) is the bridge; do NOT route a device-state event through
`wifiDeviceListGetMacAddress()` — that returns the operational address and will
miss the registry.

### Hotspot profile ownership [EXISTS; host-tested only]

A replacement adapter no longer inherits another adapter's saved hotspot
credentials when it receives the same interface name. The credential store
arbitrates every current and previous UUID across all entries, including
absent adapters. A UUID recorded for another address cannot be adopted, used
by prepare/start (including the complete in-memory cache and already-active
shortcut), saved through the live editor, or remembered for this adapter.
Existing collisions loaded from disk retain their ownership evidence and
refuse reuse with the existing activation/save errors.

The explicit-MAC active path, saved-profile sweep, interface-name and
`clap-<ifname>` matches, stored UUID hint, permanent-MAC match and persisted-SSID
fallback all apply that check. A pin naming another present or persisted
adapter is conflicting evidence even without a UUID claim. SSID equality
cannot override either kind of conflict. Unowned legacy profiles with stale
scan-time pins still migrate through the existing name or persisted-SSID
evidence. A conflict leaves NetworkManager's active connection and mode
observable, and leaves the foreign profile, credentials and autoconnect
untouched.

Ownership is checked again after awaited lookup, repair, save, activation and
rollback work, using the current cache as well as the selected UUID. An empty
lookup result does not exempt a cache populated while that lookup was pending.
An SSID fallback is checked again after the remaining profiles have been read.
If discovery loses ownership, it removes only the matching rejected UUID and
credential pair from that adapter's cache, leaving NM active-state observations
intact. Replacing that rejected cache invalidates operations already waiting
on it, so clearing a provisional UUID cannot turn a refused prepare into a
successful credential suggestion. This is internal cache invalidation, with
no wire token or identity-resolver change.

This does not consume shadow identity, change registry keys, emit tokens,
introduce limited mode, change NetworkManager targeting or change mode
transitions. Unresolved radios retain prepare/start capability. A radio
returning under a new name or after replug keeps its own credentials.
Same-MAC physical distinction and activation fencing remain outside this
ownership change; G1-G5 are unrun and unclaimed.

Coverage: `wifi-hotspot-ownership.test.ts` exercises O1-O9 through real
discovery, saved-sweep, prepare/start and configure boundaries, all stored
owners, after-await checks, orphan migration and unrelated-profile survival.
`wifi-radio-equivalence.test.ts` retains the recorded main bytes for verified,
rename, replug and unverified prepare/start fixtures. The orphan byte fixture
also runs against unchanged main. The pruning regression loads a legacy
collision from disk because new store writes can no longer create one; its
existing assertions are unchanged.
Deferred race coverage also runs the competing-discovery/empty-lookup schedule,
complete-cache credential returns, repair/save continuations, live rollback,
late SSID selection and new/existing-profile activation against the reviewed
pre-fix head. Single-adapter discovery and verified/unverified prepare/start
controls retain the existing results. These tests prove dispatch and return
behavior at the host boundary; they do not qualify physical NM scheduling.

### Shadow lifetime producer [EXISTS; host-tested only]

`modules/wifi/wifi-radio-identity.ts` computes separate, internal evidence.
The live resolver above, all of its cache tiers, registry keys, numeric ids,
degraded reasons, id-map membership, credential-store keys and `wifiBuildMsg`
output are unchanged. No handler consumes the shadow classification or token.
There is no wire/schema addition or change to hotspot prepare/start/stop,
mode transitions, profile targeting, credentials or mock behavior.

The injectable file reader brackets the permanent address and wiphy index with
the netdev ifindex and resolved `phy80211` path. A reads only these sysfs files
and symlinks; it starts no new external process. `GENERAL.PATH` acquisition and
composite identity are deferred to P/B, where the locator has a consumer.
Only a coherent positive ifindex and nonnegative wiphy index produce a witness;
phy0 is valid. The shadow MAC cache uses the complete `(ifindex, wiphy)` pair,
serves only same-pair read failures, and is pruned to coherent pairs in each run.
It assumes one fixed network namespace, automatic index allocation and no
privileged index reassignment or namespace moves.

All eligible radios are sampled before shadow rows are published. Unique MACs
classify as verified. Shared MACs and coherent but unattributable samples
classify as limited, and incomplete samples
as unverified. Limited/unverified keys are isolated `degraded:<ifname>`
placeholders. These classifications are evidence only; limited hotspot mode is
not implemented here.
An unavailable or operational-MAC-missing row retains a predecessor's shadow
key only with the same coherent witness; a new lifetime gets a placeholder
until NetworkManager is ready, even if its permanent address is readable.

Internal incarnations rotate on a changed witness, classification or degraded
edge. Same-object renames and repeated duplicate runs retain their incarnation.
Discovery and monitor `unavailable` events project incarnation/degraded-reason
changes into the shadow snapshot only, without changing broadcast decisions.
Observation sequences fence publication: an older discovery cannot erase a
later unavailable event or replace a newer completed observation. Canceled
samples cannot commit their cache or snapshot.

`wifiUpdateDevices` retains main's independent per-call legacy discovery,
including overlapping reads, per-call errors, results and broadcast ordering.
The proposed bounded legacy discovery (M1) moves to B, where that observable
scheduling change can be accepted and documented.

`wifi-radio-observation.ts` schedules sysfs sampling in a later task, after
legacy publication and promise completion; legacy callers never await it.
Only this detached work has one active flight and one replaceable latest queued
batch. A 100 ms budget aborts the sample and prevents further reads or publication.
An uncancellable read retains its sole physical slot until it settles, so a hung
read cannot accumulate additional I/O; legacy discovery remains independent.
Both integration boundaries contain shadow exceptions. Read failures, timeouts
and unexpected shadow exceptions increment the internal
`getWifiRadioShadowFailures()` counter without adding error logs.

Coverage: `wifi-radio-identity.test.ts`, `wifi-discovery-single-flight.test.ts`
and `wifi-radio-equivalence.test.ts`. Nine recorded main fixture families cover
the resolver tiers, unavailable/missing-operational rows, duplicates, rename and
replug, public prepare/start results, credentials and broadcast count/order.
The overlapping-call fixture records three independent reads, results
`false,false,true`, three broadcasts and an empty registry; a separate fixture
covers independent errors. An extra real broadcast is a permanent negative
control. Fault tests use fake clocks and capability/command readers to cover
hanging, slow and rejected sampling plus both integration boundaries.
All pre-existing main assertions remain unchanged; locator-only A tests are
removed with the explicitly deferred feature. Owner hardware gates G1-G5 are
unrun and are not claimed;
host evidence does not qualify physical radios or NetworkManager activation.

