<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A SCAN IS COALESCED, AND FORGET REMOVES THE NETWORK [EXISTS]

Two WiFi defects behind one operator report — *"forgetting a network or
disconnecting from a network is not working"*. Full evidence:
`.omo/notepads/modem-phase-c-quality/evidence/session-amendment-wifi-forget-disconnect.md`.

**`wifiRescan()` COALESCES, because `wifi.scan` is an RPC and nmcli costs a D-Bus
connection.** Every `nmcli` process opens its own connection to the SYSTEM bus,
and root's `max_connections_per_user` (256) is a DEVICE-WIDE resource. Measured on
a Rock 5B+ (2026-08-19): a frontend render loop drove ~50 `wifi.scan` per second,
250-330 concurrent `nmcli device wifi rescan` processes were live, and `busctl`
itself could not list names — after which EVERY nmcli on the box answered
`Could not create NMClient object: …LimitsExceeded`, taking WiFi
connect/disconnect/forget, the gateway election and the modem profile writes with
it. The client that caused it is fixed in `apps/frontend` (`WifiSelectorDialog`'s
periodic scan, see that repo's Async OS-operation entry), but the guard stays: a
device must not be knockable over by a repeated READ RPC, whoever sends it.
Concurrent callers JOIN the in-flight run (their intent is exactly what it
delivers) rather than yielding, and the shared promise SWALLOWS its rejection —
one failed scan must not raise an unhandled rejection per joiner. Same discipline
as `signalRecheckInFlight` in `modules/streaming/sources.ts`.
`setRescanActionForTest` mirrors `setScanRefreshAction` as the counting seam.

**`WifiInterface.savedAll` exists because Forget removes a NETWORK, not a
profile.** `saved` is `Record<SSID, uuid>`, and NetworkManager holds a profile per
CONNECTION — the same board carried `4G-UFI-611A` AND `ufi-recovery`, both
`802-11-wireless.ssid = 4G-UFI-611A`. So Forget deleted one, the sibling kept the
SSID in the map, and the row still read "Saved": indistinguishable, to the
operator, from a Forget that did nothing. `registerSavedWifiConnection` now also
appends to `savedAll` (`rememberSavedUuid`), and `wifiForget` deletes every uuid
`wifiSiblingConnections(uuid)` resolves.

- **`savedAll` is OFF the wire.** No schema change; `saved` still names ONE uuid,
  which is what the frontend acts on.
- **Only FORGET reads it.** Connect and disconnect mean "act on this connection";
  only Forget means "remove this network".
- **A MAC-bound profile records its sibling on ITS adapter only** — a bound
  profile is not another radio's network to remove.
- **`wifiUpdateSavedConns` clears BOTH maps** before the sweep, or a deleted
  profile lingers as a phantom sibling and Forget issues a delete for a uuid that
  no longer exists.

Coverage: `tests/wifi-rescan-coalescing.test.ts`, `tests/wifi-forget-same-ssid.test.ts`.

