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
hotspot radio does not.

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

