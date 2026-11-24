<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## NETWORK VIEW STRUCTURE [EXISTS]

The destination uses a compact card/row rhythm. Ethernet states bond membership
once, in `BondToggle`, rather than repeating it as Connected/Off beside the IP.
`NetworkView` still applies the shared marker-plus-modem-claim handover before
passing `wiredEntries` into `EthernetSection`; there is no second component-local
filter. A consolidated `usb_modem_net` interface keeps its name and address in
the owning Cellular row's mounted Details body (`modem-net-interface`). The
default mock scenario now supplies the same marker as production. Every disabled
dongle-control reason remains inline, including on the touch kiosk.

The Network destination deliberately separates operator identity from transient
enumeration detail. `WifiSection.svelte` derives one `modeView` per radio and
uses it for the row badge, status line, hotspot setup, and mode popover; the
station/hotspot/hybrid identity is therefore stated once beside the radio name,
while mode selection and capability details remain available on request. A
station or hybrid radio retains its connection and bond actions; an exclusive
hotspot radio does not. The device's `getAdapterModes` answer is a pull, re-read
only when the radio set changes or the mode control confirms, so an AP that the
pushed interface snapshot shows up outranks a stale `station` answer
(`wifi-adapter-mode-view.ts`): a hotspot started from its own dialog reads
Hotspot (or Hybrid beside a station link) at once. That correction is for an idle
radio only: while a mode change is pending, the selector keeps the prior mode
until the matching terminal arrives. The control records that mode in its
request (`WifiModeRequest.from`) as it begins, and the device's own pending echo
keeps it, so it holds even when the device never answered `getAdapterModes`. A
change begun on another client carries no record and falls back to the device's
preference, then its cached answer.

Wi-Fi rows, the Wi-Fi selector, Ethernet rows and Bonded Links use the same
inventory label projection as Live/HUD. For example, a MAC-named radio with
no active SSID reads "Wi-Fi (2f27)"; the last four hex digits are a hint, not a
unique identity or a port number. The kernel ifname is unchanged. Radios on
the same SSID add a radio hint, falling back to their ifnames if the hints
collide. Cellular inventory still leads with the hardware name (owner decision
2026-11-23, D1: it keeps the title, and the carrier rides the status line). An
isolated dongle has no hardware name, only its `dongle<N>` slot token, so every
surface names it "Router dongle N" (`isolatedDongleLabel`, `link-names.ts`).
Identical bonded modem labels get a distinct port hint or fall back to the ifname.
Both views keep the visible ifname for correlation when a twin leaves.
The backend's eligibility, including its hotspot exclusion, is independent
of naming.

**ONE ROW ANATOMY [EXISTS].** Wi-Fi, Cellular and Ethernet rows, an active hotspot
and each Bluetooth device render through `main/network/NetworkRow.svelte`; the
sections pass content into named slots (`heading`, `identity`, `indicator`,
`status`, `bond`, `meta`, `reasons`, `actions`, `details`) and the row owns the
layout (`DESIGN.md` IH-6, TT-6). Five rules carry it, each removing a measured
defect: the dot is anchored to the title's first line (`0.5lh`), so it cannot
strand (Ethernet at ≤ 390 px); the title wraps and the identity pill drops below
it, so it never collapses or truncates (Wi-Fi was 0 px wide at 412 px in English);
the bond switch trails the status line and drops below it, still trailing, when
both do not fit, so all switches share one x; the actions own the last line, and
from 36rem of row width they MOVE in the DOM to the title line, so Tab follows the
reading order at every width (the row's container query decides, and a
zero-height sentinel reports it to the row; a focused action keeps focus across
the move, and focus elsewhere is never pulled in); and the row is a
`data-touch-region`. Every device is listed once with one switch: a modem-claimed
interface leaves Ethernet when it carries `router_cellular`, `usb_modem_net` or
`dongle` (`section-assignment.ts`), and a Cellular row reads and toggles its
interface only through `modemRowEntry`, the same rule, so a stale modem frame
cannot arm a second switch on an unmarked interface that reuses a retired veth's
name. Names wrap across the whole destination, Bonded Links' `LinkBadge` row
included, and a Network switch adds `RTL_SWITCH_THUMB`
(`lib/components/custom/rtl-switch.ts`) so its checked thumb stays inside the
track in Arabic; the switch primitive itself is CLI-managed and never edited.
The row hooks `data-net-row`, `data-net-row-title`, `data-net-row-dot`,
`data-net-row-status`, `data-net-row-bond`, `data-net-row-body`,
`data-net-row-actions` and `data-net-row-wide` are what
`tests/e2e/network-row-anatomy.spec.ts` measures.

`EthernetSection.svelte` treats a `shared-lan` port as a client-zone row rather
than an uplink: one combined role/zone pill names what the port is and whether
the zone is serving or starting, while the bond-exclusion reason moves into the
adjacent info popover and remains the toggle's accessible reason. It does not
render the shared port as connected/off uplink state.

`SharingSection.svelte` derives one headline as the card's state authority.
Per-uplink status is muted when it merely repeats that headline; probe details,
subordinate bands, shaping priority, coexistence diagnostics, and the DNS note
are folded into the Diagnostics disclosure, while each uplink's own probe data
stays behind its row disclosure. These structures de-noise transient interface
enumeration churn from operator-visible state without dropping diagnostic facts.

**…AND THE CARD IS QUIET UNTIL SOMETHING IS ACTUALLY SHARED [EXISTS].** With no
client zone — no hotspot, no `shared-lan` port — `SharingSectionView.quiet` is
true and the card renders ONE unframed "Sharing is off" hint row and nothing
else: no uplink health, no client zones, no Diagnostics disclosure, and so
neither the shaping priority nor the DNS limitation line inside it. Four
instruments stacked under "Sharing is off" measure a path no traffic takes and
read as a fault report about a feature nobody switched on. Three rules are
load-bearing. **The card is never hidden** — the hint row is how an operator
discovers sharing exists and it names what to switch on, so this is a quieter
card, not a conditional one. **The predicate is `zones.active`**, the
client-zone presence already on the wire, and NOT `headline.kind ===
"sharing-off"`: headline precedence is a display order that may be reordered,
while "is anything being shared" is a fact about the device — and it needs no
new RPC. **`quiet` gates RENDERING only**; every row, band and instrument stays
derived, so a zone appearing mid-session is the same code path as one present at
first paint. Coverage: `sharing-section-view.test.ts` → "the quiet card",
`SharingSection.test.ts` → "quiet when sharing is off" (which also proves the
full card returns for a hotspot alone and for a shared-LAN port alone), and
`tests/e2e/sharing-surface.spec.ts` → "quiet when sharing is off", whose fixture
must be the wire's INITIAL one because the synthetic client zone is patched into
the device's own `netif` frame.

