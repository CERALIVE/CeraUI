<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE MODEM DIALOG IS THE ADVANCED SURFACE, AND EVERY CARD VANISHES ALONE [EXISTS]

`main/dialogs/ModemConfigDialog.svelte` carries three read-only instrument cards
beside its configuration form, all driven by Phase-B additive-optional wire
fields, all derived by the pure rune-free `main/dialogs/modem-detail.ts`
(`cellMetricRows` / `esimView` / `usageView` / `defaultAutoApn` /
`hasModemDetail` / `isStandingUsbRefusal`). Order is configuration → usage →
detail → USB mode: the operator opened it to configure, so that stays reachable
without scrolling on the 1024×600 kiosk, and the one destructive action is last.

**…AND EVERY ONE OF THEM IS NOW BEHIND ONE "Advanced" DISCLOSURE (todo 64)
[EXISTS].** "Reachable without scrolling" stopped being true: measured on the
bench board at the 1024×600 kiosk viewport, this dialog's body was **783 px of
content in a 363 px window**, so the operator scrolled past four instrument
panels to reach the Save button for the APN they came to change. The dialog now
splits the same way the row does. **PRIMARY** — the status strip, whichever
bands are currently true (`modem-save-refused`, `modem-locked-band`, the no-SIM
banner), and the settings an operator actually opens this dialog to change:
roaming, the operator scan that follows from it, Automatic APN, and the manual
APN + credentials behind it, led by the network-type selector. **SECONDARY** —
ONE `CollapsibleSection` (`modem-advanced-toggle` → `modem-advanced-body`)
holding `modem-usage-card` (counters AND the writable policy controls),
`modem-detail-card`, `modem-sms-card`, and `modem-usb-mode-card`. Four rules:
**(1) Network type is PRIMARY, and it is first.** It briefly lived in Advanced on
the theory that a radio-technology lock is set once per site; operators reported
otherwise — pinning a modem to 4G where 5G is marginal is routine field work, and
it was the only thing in that disclosure anyone ever opened it to CHANGE, the
rest being read-only instruments and device surgery. It now leads the primary
fieldset because it is the coarsest of that section's three decisions (radio →
registration → data session) and every control under it is read in its light. It
is back INSIDE the `disabled={noSim}` fieldset, and it keeps its own explicit
`disabled={noSim}` as well; do not delete that as redundant. Do not move it back
— `ModemConfigDialog.density.test.ts` pins it outside `modem-advanced-body` and
outside every `inert` ancestor (asserted as a PROPERTY walk: jsdom never reflects
`inert` to an attribute, so a `[inert]` selector is vacuous). **(2) The SMS card
keeps its OWN inner fold**, and
that nesting is load-bearing rather than redundant: the outer disclosure keeps
its body MOUNTED (clipped + `inert`), while the SMS fold is `{#if}`-gated
because it gates an expensive per-message mmcli read AND keeps one-time codes
out of the DOM entirely. Collapsing the two would silently undo both. **(3) The
disclosure is collapsed on EVERY open, never remembered** — an operator who
expanded it once to read a cell metric is not asking to reopen every future
modem on the diagnostics panel. **(4) Because the body stays mounted, every
existing unit test that queries these cards by testid is byte-unchanged**; only
Playwright's `toBeVisible()` needed a step, which is why
`tests/e2e/helpers/modem-advanced.ts` exists — `openModemAdvanced(dialog)` is
idempotent and is called from `openTargetModemDialog`, the visual spec's own
`openModemDialog`, `modem-a11y.spec.ts` and `truthfulness.spec.ts`. Add it to any
new spec that asserts one of those five blocks is VISIBLE. **A jsdom `getByRole`
query now needs the same step** (Phase-C todo 14): the collapsed body carries the
`visibility` hit-test guard, which Testing Library's `isInaccessible` honours —
`src/tests/helpers/modem-advanced.ts` is that unit twin. `getByTestId` is still
unaffected. Copy: `network.modem.advanced.{title,description}` (10 locales).
Coverage: `ModemConfigDialog.density.test.ts`.

**ABSENCE RENDERS AS ABSENCE.** The mmcli path reports none of these fields and
an older backend reports none of them either, so each card is absent ENTIRELY
when its field is absent, and each ROW inside a card is absent when its key is.
Never an empty framed section (it reads as a load failure), never a `—`, and
never a `0 B` (which tells the operator they used no data — a MEASURED zero is a
different fact and IS rendered). The pure helpers answer with `[]`/`undefined`
rather than a half-populated shape, so the markup only asks "is there a view".
Pinned by the field-absent matrix in `ModemConfigDialog.detail.test.ts`, which
drops each card independently and then all three at once.

- **Detail card** (`modem-detail-card`) — serving-cell metrics in the JetBrains
  Mono data face, ordered radio → location → quality, each with its OWN unit
  (`rsrp` is dBm, the ratios are dB). `snr` and `sinr` are never folded together:
  LTE reports signal-to-noise and NR reports signal-to-interference-plus-noise,
  so one under the other's label is a number the radio never produced. `tech` is
  keyed copy, never the raw wire token. The card states WHEN the readings were
  taken from `cell_info.provenance.observed_at` (epoch seconds and milliseconds
  are discriminated by magnitude) and says so honestly when the modem reported no
  stamp. **The wire carries `cell_id`, NOT a `pci` field** — the card renders
  `cell_id`; do not invent a PCI row. Firmware and the eSIM badge follow.
- **eSIM badge is READ-ONLY, permanently.** `sim_type` + `esim_status` only. No
  button, no link, no input, no click handler, no positive tabindex — asserted
  against the real DOM, not by reading markup. The EID is a redaction class and
  is not even on the wire, and profile management belongs to the carrier's flow,
  so any affordance here could only lie about what it would do. Do not add one.
- **Usage card** (`modem-usage-card`) — `session_bytes` + `cycle_bytes` via the
  shared `formatBytes`, each stating its OWN scope on screen (since boot / since
  the cycle started) so a cumulative counter is not read as a monthly bill. It is
  staleness-aware through `getIsConnected()`: these counters carry no observation
  timestamp of their own, so a dropped socket dims the figures and says so rather
  than presenting the last frame as live. Each scope hint lives INSIDE its `<dd>`,
  not as a sibling of it: a `<dl>`'s grouping `<div>` may hold only `<dt>`/`<dd>`,
  and a sibling `<p>` there is a serious axe `definition-list` violation (found and
  fixed by the todo-29 gate). Do not "tidy" it back out. `threshold_bytes` draws an ADVISORY bar
  that gates nothing — the bar clamps at full, the over-limit VERDICT does not,
  and a zero limit draws no bar while still reporting being past it.
- **There is deliberately NO cycle-day picker and NO threshold input.**
  `@ceralive/modem-control@0.2.0` publishes no usage-policy setter, so
  `modemConfigInputSchema` declares no matching write fields (todo 17 omitted
  them outright). A control here would be filled in, submitted, and dropped, and
  the operator would watch their setting revert with no explanation. The VALUES
  are reported, so they are DISPLAYED read-only, and the deferral is declared by
  a `ComingSoon` pill bound to `TD-modem-usage-policy-write`. Do not add the
  controls before the package ships the setter.

**Auto-APN defaults to Automatic, but only for a genuinely unconfigured modem.**
`defaultAutoApn` is deliberately NOT `autoconfig ?? true`: a config carrying a
stored manual APN with no explicit flag predates the flag, and opening on
Automatic would discard that APN on the very next Save, silently. An explicit
flag always wins; absent a flag, a stored APN means manual and an empty one means
unconfigured. The recommendation itself is a `Badge` pill
(`modem-autoapn-recommended`), not a parenthetical in the switch's label — which
keeps the control's accessible name and its visible text identical.

## …AND AN ABSENT MEASUREMENT STATES ITS OWN REASON [EXISTS]

`lib/modem/signal-detail.ts` (pure, rune-free) renders the three normalized
blocks the D-Bus backend publishes for a directly-managed radio —
`signal_detail`, `registration_context`, `sim_presence_evidence` — into the
detail card and the no-SIM banner. It is the ModemManager twin of
`main/network/router-signal.ts`, which does the same job for the dongle
dialects, and both exist because a metric on this wire is a VALUE or one of
SEVEN typed reasons, never a nullable number.

**The reasons may not be collapsed.** `unsupported` is a claim about the source,
`not-reported` is about ONE reading, `not-observed` is about US — three
different operator actions, and one em-dash for all three throws away everything
the block adds over a bare `null`. A `0` is worse: it is a measurement the radio
never took. `MODEM_METRIC_REASON_KEYS` is TOTAL over the wire enum, so an eighth
reason fails the typecheck rather than reaching an operator as its own dotted
path.

Six rules carry it:

1. **EVERY metric renders a row, `unsupported` included — the one deliberate
   divergence from the router twin.** `routerSignalMetricRows` DROPS an
   `unsupported` metric because a dongle dialect's metric set genuinely differs
   per vendor (the HiLink strip has no SNR field at all), so a row there would
   report the radio as silent about something it was never asked.
   `modemSignalDetailSchema` is TOTAL — the same four metrics for every modem,
   always, precisely so a metric can be LOWERED again — so a dropped row would
   silently shrink a fixed-shape strip and read as a partial render beside the
   next modem. Do not "unify" the two rules; the wire shapes differ.
2. **A reading and a reason must not share a face.** A value is an instrument
   figure (`font-mono`, `tabular-nums`, full contrast); a reason is a WORD
   (proportional, muted, wrapping). That split is the honesty rule made visual,
   and it is asserted on the rendered class list rather than reviewed.
   `data-metric-state` / `data-metric-reason` carry the machine verdict beside
   the copy so a test names a reason class, never a translated string.
3. **`sinr` reads `not-reported` on every LTE/NR modem, and that is CORRECT.**
   ModemManager 1.24.2 gives `sinr` to `Signal.Evdo` alone; `Lte`/`Nr5g` publish
   `snr`, a different quantity. Rendering it as `unsupported` would be a
   capability claim ModemManager itself disproves.
4. **`cell_id`/`tac` read `not-observed` on every board today, and that is the
   FENCE, not a gap.** The cell property stays masked unless a location source
   is primed, which this device permanently does not do. Do not "fix" it from
   the render side — making them non-null costs a transport and allowlist
   change, and the honest published reason is the whole point.
5. **The normalized block SUPERSEDES the legacy `cell_info` quality rows**
   (`SUPERSEDED_CELL_METRIC_KEYS`). Both can express RSRP/RSRQ/SNR/SINR, and two
   rows under one label carrying different numbers is worse than either alone;
   the normalized block wins because it is the only one that can say WHY a value
   is missing. Same precedence `router-signal` applies to the legacy
   `signal_bars` scalars. `tech`/`band` and the legacy `cell_id` are untouched,
   and a modem with no normalized block renders byte-identically to before.
6. **The no-SIM banner's evidence hint carries the KIND, never the value.** The
   banner is binary because the bond gate it renders is binary, so on its own it
   cannot separate a slot the modem positively reported empty from a slot
   nothing could read — and those ask opposite things of an operator. `absent`
   is reachable through exactly ONE evidence kind (`state-failed-reason`), which
   is what `data-states-empty-slot` publishes. The evidence's own `value` fields
   are D-Bus object paths and ModemManager's failed-reason token; none is
   rendered, because a machine identifier in operator copy is the OL-2 defect.
   `no-evidence` carries the inspected COUNT, not the field names.

**`quality_recent` is about the MODEM's measurement, not our envelope.** Socket
staleness (`getIsConnected()`) already answers the second; without the first a
cached 40% and a live 40% are the same number on screen, which is most of what
diagnosing a marginal link is about.

**The radio power state was already rendered and is UNTOUCHED by this.**
`modem-power-card` reads the already-projected `radio_power` through
`radioPowerReading` (`modem-power-recovery.ts`) and offers nothing pressable —
`@ceralive/modem-control` publishes `power` as a read with no setter beside it.
Do not re-derive or re-fetch it, and do not add a control for it.

**The detail card's gate widened, and only the gate.** `hasNormalizedReading`
joins `hasModemDetail` and the positively-stated SIM, so a modem that published
a radio reading earns the card even with no cell info, eSIM or firmware. The
mmcli path publishes none of the three blocks, so it is unaffected — an absent
block means "this backend did not observe it", never "the modem has none".

Copy: `network.modem.detail.{signalTitle,registrationTitle,operatorName,operatorCode,tac,recency*}`
+ `network.modem.detail.reason.*` (7) + `network.modem.simEvidence.*` (5), all in
10 locales. Coverage: `lib/modem/signal-detail.test.ts` (the pure tables, swept
exhaustively over the seven reasons and the five evidence kinds) and
`main/dialogs/ModemConfigDialog.signalDetail.test.ts` (rendered DOM — the
per-reason distinctness sweep, the never-a-zero/never-a-dash lock, the
supersession pair, the evidence hint with its no-raw-value assertion, and the
power card's zero-affordance sweep with a non-vacuity control). Rule-E proof:
collapsing the seven reason keys onto one reddens 4 tests across the two files.
Wire contract: [`../../packages/rpc/AGENTS.md`](../../../../packages/rpc/AGENTS.md) →
AN ABSENT READING STILL SAYS SOMETHING.

**NONE of this belongs on `CellularSection`.** That row stays QUALITATIVE by
documented house rule — a tier glyph with a word behind it, no digits, no
`data-live-value` — and todo 64's badge budget is FOUR. Every reading above is
dialog-only.

## …AND THE SIM IDENTITY GROUP LEADS WITH THE SHARED PRESENCE BLOCK [EXISTS]

The detail card's SIM identity group (presence → ICCID → own number → eSIM) now
opens with `SimBlock` (`$lib/modem/sections`) resolved by `deriveSim(modem)` —
the SAME component and the SAME derivation `RouterDongleDialog` renders, so the
two modem families state one fact in one register.

**It exists because the banner only ever answered ONE of four states.**
`isSimlessModem` is binary because BONDING is binary — a link either may join
the pool or may not — and the dialog stated SIM presence exclusively through the
warning that predicate raises. So `present` and `unknown` rendered identically
(as nothing), and an operator could not tell a healthy slot from a slot nothing
could read. Both halves are now on screen, and neither replaces the other: the
banner still owns `absent` in the PRIMARY column, where an operator meets it
first, and the block states all four in the SIM group.

- **`unknown` is the absence of an answer, and must never be rendered as one.**
  `deriveSim` reaches `absent` only from a device that positively said so —
  ModemManager's `sim-missing` reason, carried on the wire as `no_sim`, or a
  dongle's own `router_admin.sim` — and anything not positively `present`
  resolves `unknown`. A blank SIM object path is not evidence; `SimBlock` renders
  that state as its own muted `role="status"` line rather than as a pill, because
  "the device did not say" is not a status the device reported.
- **The card OPENS on a positively-stated slot** (`present` / `locked`) even when
  the modem reported nothing else, so a SIM-bearing modem is never mute. `absent`
  is deliberately NOT in that set — it already has the primary banner, and a
  second otherwise-empty card restating it is the density regression todo 64
  removed — and `unknown` is not either, since on its own it has nothing to add.
- **Nothing about the bond gate changed.** `isSimlessModem` still drives the
  banner, the disabled fieldset and the toggle, and still delegates to
  `@ceraui/rpc`'s `isSimlessForBond`. This is a second, richer READING of the
  same wire fields, not a second authority over them.

**…AND THE `unknown`-AS-`absent` ASYMMETRY IS NOW CLOSED, ON THE WIRE.** The
backend's `claimsNoSim` answers `presence !== "present"`, so a modem with no
NetworkManager profile AND an `unknown` slot reading published `no_sim: true` and
the frontend could only render what the device claimed — `absent`, for a slot
nobody had read. Of the two ways out this doc named, the taken one is the ADDITIVE
one: `sim_presence` (`present` / `absent` / `unknown`) now rides `modemSchema`
beside `no_sim`, sourced from the SAME `deriveSimPresence` evidence model the fold
consumes. `claimsNoSim` / `isSimlessForBond` are UNTOUCHED — the second route
would have changed bond MEMBERSHIP, which is still its own change.

`deriveSim` prefers the reading and falls back to the `no_sim` inference for a
backend that publishes none, so a `router-ethernet` dongle (which has no slot
reading of its own and emits no `sim_presence`) is answered by `router_admin.sim`
exactly as before. Two consequences worth stating plainly:

- **The block and the banner may now DISAGREE for one input class, deliberately.**
  On an unreadable slot the SIM block says `unknown` while `isSimlessModem` still
  raises the primary no-SIM banner, the disabled fieldset and the forced-off bond
  toggle — because the device really is refusing that link. The block is the
  richer READING; the predicate is the bond AUTHORITY, and the toggle must not
  offer a link the device refuses. Do not "fix" the divergence by routing
  `isSimlessModem` through `sim_presence`.
- **An OPAQUE device emits neither key**, so nothing changed for the class whose
  slot this host structurally cannot see.

Coverage: `ModemConfigDialog.simSms.test.ts` (the four-state table, the
`unknown`-is-not-absence pair with its `data-no-sim` sweep and its negative
control, the card-opening rule, and the reachability walk through the real
disclosure) + `lib/modem/sections/derive.test.ts` → "the device's own slot
evidence outranks the bond fold" (the preferred reading, the re-asserted bond
predicate on the SAME fixture, the legacy fallback, and the router-class
negative). Rule-E proof both directions: removing the `SimBlock` render reddens
9 of `simSms`'s 21 tests; falling back to `absent` instead of `unknown` reddens 2;
dropping `deriveSim`'s preference for `sim_presence` reddens 1; and making
`isSimlessForBond` positive-evidence-only — the change this one deliberately did
NOT make — reddens 4, including the explicit bond-membership lock.

