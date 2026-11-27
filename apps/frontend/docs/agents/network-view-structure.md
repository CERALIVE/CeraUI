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
hotspot radio does not. The pushed Wi-Fi row's `observed_mode` takes precedence
over cached `getAdapterModes` mode in either direction. It does not change the
pull's offered choices or the physical `mode` used for bonding. An explicit
`null` withholds the mode badge and selector choice until the device can verify
the mode; an omitted field preserves older-device behavior, where a visible AP
outranks a cached Station. During a local mode change the initiating control
keeps its prior mode from `WifiModeRequest.from`. Other clients can use the
adapter row's `leaving` witness even if they missed the pending event and never
received `getAdapterModes`. `leaving: null` means the prior mode is unknown.
Older rows without that witness keep the existing fallbacks.

The Wi-Fi row and Hotspot Setup use the same transition lock. Setup remains
readable, but start, stop, save and mode changes are disabled with the existing
localized reason. A terminal event alone does not unlock a row still reporting
a transition; the settled adapter row does.

**THE CREDENTIAL QUESTION HAS TWO WITNESSES [EXISTS].** The label can outlive the
access point it names, so it does not decide alone whether the name and password
are shown before one starts. Choosing Hotspot or Hybrid asks whenever the label
OR the radio's own row says it would start from a station (`startsApFromStation`).
The row says so when it states `mode: "station"` and carries no `hotspot`; a row
that states no `mode` (an older device) is not a witness. The check runs wherever a
start leaves the control: the rung, the inline uplink confirmation, and the one
automatic retry of a change that was sent without the question. The cost is one
extra question on a working hotspot whose legacy row reads
Station, for example after a backend restart until the connection is read, or after
a failed first mode read.

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

**AN UNCONFIRMED MODEM CHANGE HAS A WAY OUT, SAVE THE SEVEN CASES THE BACKEND
CONTRACT NAMES [EXISTS].** A `failed` mutation
journal entry refuses every stream start and every change to that modem and
survives a reboot, so its recovery is on this destination and nowhere else.
`MutationBlockNotice.svelte` renders one block in the modem's own `NetworkRow`
(`reasons`), matched by `stable_key` equality alone; a block whose modem is not
listed leads the Cellular card. For display only, the unlisted notice and
confirmation show the USB port with its full controller prefix, or the raw key
if there is no USB port label. `main/network/mutation-recovery.svelte.ts` is
the one owner of the list, the pending action and every answer. Seven rules
are load-bearing.

0. **Keep and Gone are the guaranteed ways out; Check again is optional per
   block.** It is offered only on an entry whose list row says `checkable: true`,
   and hidden, never disabled, otherwise; no other copy names it. The generic
   acknowledgement compares four USB descriptor fields that only a `usb-mode` entry
   stores, so a check offered on any other kind could only ever refuse.
1. **The device's list decides.** Nothing is dropped from the screen on a local
   guess; only a `success: true` reply, or a re-read, removes a block. A failed read
   keeps the last answer, and an older read never overwrites a newer one.
2. **No timer.** The list is a pull with no push behind it. `NetworkView` re-reads it
   on the socket and session edges, the cellular stack finishing, the set of modem
   ports, a stream starting or stopping, a modem/dongle/SIM dialog opening or
   closing, the tab becoming visible, and after every action. While
   `replayComplete` is false the next `netif` push re-reads too, and that stops
   with the replay. A clear made by another browser is therefore learned at the
   next of these, or from the refused action itself.
3. **One press is one call.** `decommissionMutation` accepts `failed` and
   `device-absent-quarantine` for every kind and judges the port itself, so "Gone"
   sends only that and shows its answer. No acknowledgement goes first: its answer
   is to a different question, and a passing one would read as resolved.
4. **An answer ends with its state.** A success is about a settled port, a refusal
   about the block pressed or the state that refusal put it in, and either is dropped
   when the list shows anything else. Only an unanswered action says so then, and a
   reply that comes after its bound is followed by a re-read. `journal_write_failed` is never read as done.
   An absent modem can be kept once it is back or let go; only the check is gone. A
   modem the device can neither read nor prove absent is an ANSWER, not a state
   (`read_failed`): the notice says to unplug it and say it's gone, and every
   action stays live.
5. **Keep covers the returned port.** `recommission-pending` is cleared only by
   `rebaselineMutation`; without it, "gone" would be a new lockout.
6. **The confirmation and the focus outlive the row.** `CellularSection` owns both,
   because the modem can leave its row while either is open. A settled answer
   stays where the block was until the operator leaves Network, and the Start
   refusal's Open Network focuses the first notice (`mutation-block-reveal.ts`).

Coverage: `src/main/NetworkView.mutationBlocks.test.ts`,
`tests/e2e/mutation-block-recovery.spec.ts`, and `stream-start-failure.spec.ts` →
"Open Network lands on the modem change that refused the start".

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

