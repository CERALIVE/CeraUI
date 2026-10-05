<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## WIFI AP-vs-CLIENT CLASSIFICATION [EXISTS]

A radio in AP/hotspot mode and a radio associated with somebody else's access
point are DIFFERENT operator states, and the Network page must never confuse
them — an access point cannot be bonded and cannot be "connected to". Found live
on a board: a broadcasting `wlan0` rendered as "Connected · CERALIVE_03f6" with
an ON "In Bond" toggle and a "Connect >" button, then as plain "Disconnected"
one poll later.

**One cause, both symptoms: the classification hung off `conn`.**
`wifiUpdateDevices` nulls `conn` unless the SEPARATELY polled ifconfig cache
(`wifi-device-list.ts`) has already seen an address for the radio. That gate is
right for bonding — a client link with no lease is unusable — but it made an
active hotspot indistinguishable from a disconnected station whenever the two
pollers were momentarily out of step. Worse, NetworkManager lists a radio's OWN
access point in its scan results with IN-USE set, so the station branch then
rendered the hotspot's own SSID as a client association.

- **`activeConn` / `activeMode`** (`wifi-interfaces.ts`) carry NM's active
  connection for the radio WITHOUT the IP gate, plus that connection's
  `802-11-wireless.mode`. The mode is resolved once per UUID and cached;
  `unknown` (an nmcli read that failed) is deliberately NOT cached, or a
  transient failure would pin an AP radio to the client UI for the process
  lifetime.
- **`isApMode(iface)`** (`wifi-hotspot-types.ts`) is the classification every
  operator surface uses: `isHotspot()` OR (hotspot-capable AND
  `activeMode === 'ap'`). `isHotspot()` still requires the adopted hotspot
  profile and stays the predicate for anything that dereferences
  `hotspot.conn` (`wifi-hotspot-config.ts`, `wifi-hotspot-activation.ts`,
  `wifi-hotspot-info.ts`) — do NOT swap those to `isApMode`.
- **`isHotspot()` now also accepts `activeConn === hotspot.conn`**, so a
  confirmed hotspot no longer flickers back to station on a lagging IP poll.
- **AP-mode adoption happens in the device loop.** When NM reports the active
  connection as `ap`, `wifiUpdateDevices` calls `handleHotspotConn` immediately
  rather than waiting for `wifiUpdateSavedConns` (which only runs when a NEW
  adapter appears).
- **`getModeForInterface`** (`state/wifi-state.ts`) and `wifiBuildMsg`'s
  `mode` + `hotspot` block both route through `isApMode`, so the cached mode and
  the broadcast mode can never disagree. An AP-mode radio's `available` scan
  list and `saved` map are omitted from the wire — there is no Connect target to
  render.
- The netif hotspot marker (`setNetifHotspot`, which removes the radio from the
  bonded source-IP list) is likewise keyed on `isApMode`, so an AP radio is
  excluded from bonding before its profile is adopted.

Frontend half: `apps/frontend/src/lib/helpers/wifi-mode-outcome.ts`
(`isApRadio`) — `mode` first, `hotspot` presence only as a pre-`mode` fallback.

Coverage: `tests/wifi-ap-mode-classification.test.ts`.

