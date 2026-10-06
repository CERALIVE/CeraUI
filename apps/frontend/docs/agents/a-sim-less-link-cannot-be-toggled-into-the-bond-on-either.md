<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A SIM-LESS LINK CANNOT BE TOGGLED INTO THE BOND, ON EITHER MODEM CLASS [EXISTS]

The two modem classes report an empty SIM slot through DIFFERENT wire fields —
ModemManager's `no_sim` for a directly-managed radio, the dongle's own admin API
as `router_admin.sim` for a `router-ethernet` unit — and `bondDisabledReasonKey`
only ever read the first. So the same physical condition forced one class's
toggle off and left the other's live and freely toggleable.

Board-reported: of four SIM-less router dongles, two showed **In Bond** and two
**Excluded**, and the two that were excluded were excluded by an unrelated rule
(the Huawei pair shares one factory LAN subnet, so `NETIF_ERR_DUPIPV4` had
already disabled them). Three outcomes, one condition.

- **`isSimlessModem(modem)` (`main/network/cellular-row.ts`) is the row's answer**,
  and it delegates to `@ceraui/rpc` `isSimlessForBond` — the SAME rule the device's
  own bond gate applies. That sharing is the point: an offering the device refuses
  and a refusal the device does not apply are both lies. Do NOT re-derive it from
  `modem.no_sim` at a render site.
- **…AND `ModemConfigDialog` READS THAT SAME FUNCTION (Phase-C todo 14) [EXISTS].**
  It carried the last surviving second copy — `modem.no_sim === true ||
  modem.status?.signal == null` — and both halves of it were wrong. The MISSING
  half is `router_admin.sim`, so the dialog could not see a SIM-less dongle at
  all. The EXTRA half is the one an operator meets: a signal reading is a fact
  about the RADIO, not about the slot, so a modem holding a good SIM that had
  not reported a signal yet — one searching, or refused by the network, which is
  exactly when an APN is worth checking — had its whole configuration fieldset
  disabled and drew the shared "No SIM" tag over a populated slot, contradicting
  the row behind it. A modem with no `status` block still cannot crash the
  render: the shared rule reads both fields optionally and answers `false` on
  absence, which is its positive-evidence-only posture. Coverage:
  `ModemConfigDialog.noSim.test.ts` — the delegation is proven by forcing the
  row's predicate to answer AGAINST the wire fields and asserting the dialog
  follows it (a faithful copy cannot, because it never asks), the parity table
  compares rendered output to `isSimlessModem` across both classes and all three
  dongle verdicts, and a comment-stripped source gate gives the "no second copy"
  claim a mechanism instead of a promise. Rule-E proof: restoring the retired
  copy reddens 11 of its 15 tests.
- **The device is authoritative, and the UI agrees with it rather than substituting
  for it.** The backend lowers `enabled` and stamps `NETIF_ERR_NOSIM`, so the link
  leaves `genSrtlaIpList()` AND leaves `BondedLinksSection` on the next state read
  with no operator action. The disabled toggle is the honest RENDER of that, not
  the enforcement — a frontend-only fix would have left the dongle bonded.
- **`unknown` never gates.** An unreachable dongle or an unjustifiable SIM code
  leaves the toggle live, matching the device's own positive-evidence-only rule.

Coverage: `CellularSection.routerCellular.test.ts` → "a SIM-less dongle cannot be
toggled into the bond" (the pure verdict, the DISABLED toggle rendered against a
netif entry that still reads `enabled: true`, "Excluded" rather than "In Bond",
and the unknown-slot negative). Backend half: `apps/backend/AGENTS.md` → "…AND A
SIM-LESS ONE NEVER JOINS THE BOND".

## …AND THE "No SIM" TAG IS ONE COMPONENT [EXISTS]

`lib/components/custom/NoSimBadge.svelte` is the ONLY "No SIM" tag. It replaced
three: the directly-managed modem's lifecycle badge
(`network.cellular.state.noSim`), the router dongle's router-signal chip
(`network.routerCellular.simAbsent`), and the config dialog's banner, which led
with a `SignalZero` glyph that appeared nowhere else. An operator comparing a
SIM-less modem against a SIM-less dongle on one screen saw two colours, two icons
and two words for one fact.

- **The TAG is shared; the surrounding COPY is not.** A dongle keeps its "runs its
  own router" explanation and a modem keeps its "cannot bond" reasoning — those
  describe genuinely different devices. Only the pill is unified, so it cannot
  drift again. Do not unify the explanatory text.
- **Placement still differs, and that is deliberate.** A directly-managed modem
  COLLAPSES no-SIM into its lifecycle badge (`resolveRowState` returns `no-sim`),
  so the tag occupies that slot and keeps `data-testid="modem-state-badge"`. A
  dongle's lifecycle badge is deliberately NOT overwritten — `router_direct` means
  the host really does hold a routable address — so it carries the tag as a second
  pill. The collapse decides WHERE the badge sits, never what it looks like.
- **The PREDICATE behind the tag is shared too, as of Phase-C todo 14.** Unifying
  the pill left the config dialog still deciding for itself WHEN to draw it, so
  the same fact could still wear one face in two places — and did. See the
  `isSimlessModem` bullet in the section above.
- Every instance carries `data-no-sim="true"`.
- **…AND IT IS TRANSLATED, WHICH THE LOCALE-PARITY GATE COULD NOT SEE.**
  `network.view.noSimLink` (this tag) and `network.view.noSimBond` (the bond
  toggle's disabled REASON) shipped in all ten catalogs carrying the IDENTICAL
  English value, which is *perfectly in parity* — the exact mirror of the
  `usb-mode-copy-completeness` trap, in the other direction, and invisible by eye
  because their properly-translated siblings sit right beside them. It surfaced
  only in an RTL capture, as Latin-script "No SIM — cannot bond" inside an
  otherwise fully Arabic surface. `src/tests/no-sim-copy.test.ts` is the detector:
  both keys are DERIVED (the reason out of `bondDisabledReasonKey`, the badge read
  from `NoSimBadge.svelte`) so a rename cannot leave it aimed at dead copy, each
  of the nine non-English values must DIFFER from `en`, `noSimLink` must equal
  that locale's own already-reviewed `network.cellular.state.noSim`, and the
  reason must say strictly more than the badge — it is a disabled control's only
  on-screen explanation, and the kiosk touchscreen cannot hover to reveal one.
  **A copy change also has to move `packages/i18n/tests/fixtures/<locale>.rendered.json`**,
  the frozen reverse-render oracle, in the same commit; patch only the affected
  entries — regenerating the whole fixture would launder unrelated drift, which is
  the reason that gate ships with no allowlist.

Coverage: `CellularSection.noSim.test.ts` — the two classes rendered in ONE
section and compared against EACH OTHER (word, resolved `data-status-badge` tone,
and SVG geometry, so an icon swap cannot pass), plus the "unifying the tag did not
flatten the two classes" block.

## …AND THE BADGE BESIDE IT REPORTS A LINK, NOT A CONNECTION [EXISTS]

A `router-ethernet` row's lifecycle badge said **"Up"**, in the `live` register,
behind the same `Check` glyph `connected` draws. It has only ever described the
USB-Ethernet link the dongle presents to the board — layer 2, the one thing this
stack can observe about a device whose whole class definition is that the modem
inside it is unreachable. Read as a claim about the path, it contradicted the
pill next to it: board-measured, all four bench dongles rendered a green `Up`
beside `No SIM`. The operator's report is the specification — *"we could have
Ethernet connection, but it doesn't mean that we are connected. That kind of
collision in consistencies give a really bad UI UX."*

- **The word NAMES what is up** — `network.cellular.state.routerLinkUp` ("Link
  up"), in the class hint's own vocabulary ("the device sees it as an Ethernet
  uplink"). It no longer borrows `network.dongle.stateUp`: those keys belong to
  the `dg<N>h` veth row in `EthernetSection`, a different link on a different
  surface. `router-acquiring`/`router-down` still share them — neither word can
  make the promise this removes.
- **The tone is `ready`, for the reason `registered` is.** `live` is the register
  the BOND is drawn in, and phosphor-lime beside a `No SIM` pill is the colour
  half of the same contradiction. It is NOT a claim of trouble: a good local link
  with nothing yet behind it is exactly the resting-healthy state. Whether the
  link carries bonded traffic stays `BondedLinksSection`'s question.
- **The glyph is `EthernetPort`, not `Check`.** Sharing `connected`'s tick left
  the two states differing by one word; the row now separates them by word,
  colour AND shape.
- **The SIM never changes this badge.** The link is a fact about the wire, the
  SIM a fact about the radio behind it — a SIM-less and a SIM-bearing dongle read
  IDENTICALLY here, and the `No SIM` pill beside it carries the difference.
  Collapsing the two is what made one pill contradict the other.

**…and Configure now separates dialog access from writable settings.** The
earlier `routerControlsUnverified` refusal blocked a useful diagnostics/login
surface whenever `router_admin.controls` was absent. Router Configure now stays
reachable across link and lock states. Missing controls still withhold their
individual settings, but do not establish rejected credentials or an unreachable
portal. Login outcomes and unconfirmed settings writes retain separate bands.

Coverage: `cellular-row.test.ts` ("the router link-state badge names the LINK…",
the `configureDisabledReasonKey` distinctness block, and the `rowNoteKeys`
supersede table) + `CellularSection.routerCellular.test.ts` ("the router link
badge reports a LINK, not a connection", and the verified-vs-unverified two-row
comparison). Live board evidence:
`.omo/notepads/modem-phase-c-quality/evidence/session-amendment-router-badge-clarity.md`.

