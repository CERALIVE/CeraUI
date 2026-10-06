<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE CELLULAR SUBSYSTEM — ONE COMPOSITION ROOT, ONE WIRE [PARTIAL]

`modules/cellular/` plus the `modem-wire-*` trio under `modules/modems/` are one
subsystem, and this is the section to read before touching any part of it. It
exists because "which backend describes this device's modems" stopped being a
constant: the legacy answer is `mmcli` shelling out per poll, the Phase-B answer
is a read-only `@ceralive/modem-control` D-Bus observer, and a router-mode dongle
is described by NEITHER — it is claimed into a netns by the image and reported
through a metadata file.

```
config.modem_backend ──▶ initCellularStack()        ─┐  boot, guardNonCritical
config.modem_shadow  ──▶ startModemShadowIfEnabled() ─┘  BEFORE initModemUpdateLoop
                                   │
       ┌───────────────────────────┴───────────────────────────┐
       ▼                                                       ▼
  modem-wire-producer.ts  (composition root)          cellular/shadow.ts
       │  mmcli modems + ID_PATH cache                 (mutation-free evidence,
       │  D-Bus views                                   never on the wire)
       │  netns dongles (dongle-metadata.ts)
       ▼
  modem-wire-adapters.ts ──▶ modem-wire-projection.ts ──▶ buildModemsWireMessage()
```

### BOOT ORDER IS A CONTRACT, NOT A PREFERENCE

`main.ts` runs, in this order and no other:

```ts
await guardNonCritical("cellular-stack", initCellularStack);
await guardNonCritical("cellular-shadow", startModemShadowIfEnabled);
void initModemUpdateLoop({ monitor: networkMonitor });
```

- **The stack MUST precede the loop.** `initModemUpdateLoop` runs its first
  discovery and `modems` broadcast immediately, and every modem RPC gates on the
  readiness snapshot the stack commits. A loop that wins that race publishes a
  snapshot built by whichever backend happened to be default and refuses every
  modem procedure with `CELLULAR_STACK_INITIALIZING` until the stack lands.
  That refusal window is REAL and not hypothetical: `initCellularStack` publishes
  `{ready:false}` synchronously and only commits after an awaited backend start.
- **The stack MUST precede shadow.** Shadow snapshots the mmcli side through
  `getModems()`; started first, its first heartbeat window would cover a backend
  selection that had not been made yet.
- **Both are NON-critical, and both stay after the critical WS bind (S6).** The
  dbus→mmcli fallback lives INSIDE `initCellularStack`, so a throw reaching
  `guardNonCritical` means the whole cellular subsystem is unavailable — the
  device must still reach its modem loop and keep its UI.

**AND THE WINDOW IS NOW ON THE WIRE.** That refusal window used to be invisible
to the operator: the roster is legitimately empty while it lasts, so the Network
destination reported "No SIM cards detected" — a claim the device cannot make
about hardware its own modem service has not finished enumerating.
`status.cellular_initializing` (additive-optional, `statusResponseSchema`) is
`!getCellularStack().ready`, emitted by BOTH status producers
(`modules/ui/status.ts` `sendStatus`, `rpc/procedures/status.procedure.ts`
`getStatusProcedure` + `buildInitialStatus`).

It is published as an EXPLICIT boolean on every frame, never present-only-when-
true. The frontend status merge preserves an omitted field, so a true-only flag
could be raised and never lowered — the `policy_route_missing` latch, exactly.
Absence therefore means "an older backend", and the frontend reads it strictly
`=== true`. On the default mmcli backend it is `false` from process start, so a
device that never opts into `dbus` sees the band never once. Frontend half:
`apps/frontend/AGENTS.md` → "A BOOTING cellular stack is a STATE".

**One modem path does NOT run through `cellularReadyMiddleware`:** the remote
`modem.reconfig` command. `command-router.ts` intercepts it at the self_fencing
branch, so it never reaches `modemProcedure`. Its gate lives in
`modules/remote-control/self-fencing.ts` (`isSubsystemReady` /
`READINESS_GATED_TYPES`) and is checked BEFORE `snapshot`/`apply` — see the
control-plane section for the full contract. Gating a modem surface means asking
which of the TWO routes it arrives on.

Pinned two ways in `tests/cellular-boot-order.test.ts`, and neither half is
sufficient alone: a STATIC assertion over `main.ts`'s own source (the device
`udev-rules-sigusr2-scope.test.ts` uses, because a top-level-`await` entry module
cannot be imported and run), plus a behavioural `simulateBoot` model of the
consequences. A behavioural model alone stays green through a reorder inside the
real file.

### THE PROJECTION IS WHAT REACHES THE WIRE — AND THE LEGACY BUILDER IS THE ORACLE

`modem-status.ts` exports TWO builders, and picking the wrong one is silent:

| Function | Role |
|---|---|
| `buildModemsWireMessage()` | what every consumer gets — broadcast, post-login push, `modems.get`, `status.get` |
| `buildModemsMessage()` | the PRE-Phase-B builder. NOT on the wire, deliberately NOT deleted |

The legacy builder is retained because `tests/modem-wire-projection.test.ts`
asserts the projection is byte-identical to it. Rewrite it in terms of the
projection — the obvious "de-duplication" — and that assertion silently starts
comparing the projector to itself. It is also the wire builder's FAIL-SAFE: a
throwing projection serves the legacy message rather than blanking the modem
list, because the additive fields are enrichment and the legacy ones are how an
operator sees their modems at all.

### THE COMPOSITION ROOT OWNS THE THREE THINGS THE PURE MODULES REFUSE TO

`modem-wire-producer.ts` is the only stateful half:

1. **`ID_PATH` resolution is ASYNC; the wire build is SYNC.** `stable_key` needs
   the udev `ID_PATH` behind each modem, and `buildModemsWireMessage` is called
   from a post-login push and a monitor-driven diff — neither can await a
   `udevadm` spawn. So it follows the `policy-route-check.ts` precedent exactly:
   `refreshModemIdPaths()` writes a cache, `getModemIdPath()` reads it. An
   unresolved ifname yields NO `stable_key`, which is the pre-Phase-B wire and the
   honest answer for a device we cannot anchor — never a fabricated key.
   A failed refresh RETAINS the previous map: an unreadable udev database is a
   statement about the read, not about the devices, and clearing it would make
   every row look like new hardware to a frontend correlating a mode switch.

   **THE MAP IS BUILT FROM udev's NET RECORDS** (`modem-id-path-source.ts`
   `readModemIdPaths` / the pure `parseNetIdPaths`), NOT from
   `@ceralive/modem-control`'s `createUsbEnumerator()`. That enumerator's
   `UsbDeviceSnapshot.ifname` is declared on the type and **never populated** —
   `parseUdevDatabase` keeps only `DEVTYPE=usb_device` records, and a
   `usb_device` record does not carry `INTERFACE`; the netdev is a separate child
   record under the `net` subsystem. Board-measured on `ceralive2`
   (2026-08-18): **24** `usb_device` records, **0** of them carrying an
   `INTERFACE`. So the map was EMPTY on every real board, `getModemIdPath()`
   answered `undefined` for every interface, no modem resolved a `stable_key`,
   and the fail-closed mutation contract therefore refused EVERY modem mutation —
   config save, network scan, SIM unlock, USB-mode switch — with
   `identity_unresolved`, on hardware whose modems all publish a good `ID_PATH`.
   The guard was right; its input was dead. A ZERO-length result is now logged at
   `warn`, because "no modem has an identity" and "this board has no modems" were
   otherwise indistinguishable. The netdev's interface-level path
   (`…-usb-0:1.4.4:1.4`) reduces through the unchanged `deriveModemStableKey` to
   the SAME `usb_device` parent MM's sysfs `Modem.Physdev` mints, so the two
   sources still agree by construction. A netdev with no `ID_PATH` (the
   duplicate-MAC HiLink twin, whose rename collides and leaves udev with only
   `ID_RENAMING=1`) is OMITTED — never keyed on its name.
2. **It refreshes on PRESENCE edges only** — `discoverModems()` and
   `handleModemAdded`, never the 30 s status poll. An `ID_PATH` names where a
   device is plugged in, so a poll cannot move it.
3. **It retains `syntheticIds` across snapshots.** `projectModemWire` returns the
   allocation it made and expects it back as `previousSyntheticIds`; drop that
   round-trip and every poll renumbers the dongles under the operator.

4. **It joins the mmcli-side 3GPP SCAN RESULTS onto a D-Bus row**
   (`withScanResults`). A scan is an mmcli operation writing into mmcli state,
   MM publishes no scan-result property for the fold to read, and `"dbus"` is the
   default backend — so a scan ran, succeeded, and reached the operator as an
   unchanged (empty) network list. The composition root is the only place that
   sees both halves. A modem the mmcli side never scanned is left UNCHANGED
   rather than given an empty list, which would claim a scan found nothing.

**Which adapter produces a radio row follows the backend that COMMITTED, never
the config key.** A `dbus` request that fell back to mmcli must project mmcli
rows — advertising the additive detail block would put confident values on the
wire that nothing observed.

**The fold now EXISTS, and it reads the TREE, not the `ObservationList`.**
`readDbusViews()` serves `modules/cellular/dbus-modem-cache.ts`, which is filled
by `dbus-view-fold.ts` from the decoded `GetManagedObjects` payload the observer
hands to `onEpochRefresh`. Two upstream facts force that input choice and both
are easy to get wrong: the package's `mapModem` is deliberately conservative
(registration always `unknown`, empty RAT set, no signal / operator / ifname /
modes at all — a row folded from it would be strictly POORER than the mmcli row
it replaces), and the observer emits a list ONLY when a row FINGERPRINT changed,
a fingerprint that ignores signal quality — so a signal-only refresh delivers a
tree and NO list, and a list-driven cache would never publish the single most
frequent update on the wire. The `ObservationList` is used for exactly two
things: `start()`'s `ok` commit test, and telling the two failure classes apart.

Full contract — snapshot/subscription API, the fold's field-by-field source
table, the bounded refresh + publication coalescing, the two SEPARATED failure
classes, source precedence / authoritative keys, the cutover and its rollback,
and the startup cancellation contract — is
[`docs/DBUS-OBSERVATION-CONTRACT.md`](../../../../docs/DBUS-OBSERVATION-CONTRACT.md).
Read it before changing any part of this path.

### THE POST-RESTART EMPTY SNAPSHOT MUST NEVER REACH THE WIRE

Measured on real hardware (todo 16, gate 4): a ModemManager restart's resnapshot
fires **18 ms** after MM re-acquires its bus name — before the daemon has
re-probed a single port — and legitimately answers `modemCount: 0`. The roster
then refills over the next **~20 s** via `InterfacesAdded` from the new owner.

**A consumer that published that snapshot verbatim would blank the operator's
modem list for ~20 s on every MM restart.** So `dbus-modem-cache.ts` does not
give a new epoch authority immediately: it enters `settling`, keeps serving the
retained rows marked `availabilityReason: "mm-restarting"`, MERGES each partial
refill over them (matching on the `ID_PATH` anchor, because MM renumbers the
whole roster across a restart — measured `11,13,14,15 → 0,1,2,3`), and only
commits when the roster refills or `EPOCH_SETTLE_MS` (25 s, chosen above the
measured ~20 s) elapses. A genuine "everything was unplugged during the restart"
therefore takes up to 25 s to reach the wire — the deliberate trade against a
guaranteed 20 s false blanking on every restart.

### THE TWO FAILURE CLASSES ARE NOT INTERCHANGEABLE

They look identical in a log line and have OPPOSITE correct responses:

| `ObservationList` reason | What it means | Response |
|---|---|---|
| `bus-error` | our client failed while MM stayed answerable | mmcli IS a real second opinion — demote below it, serve `[]`, let the wire producer project mmcli rows |
| `source-unavailable` | the MM bus name has no owner (or the bus dropped) | **mmcli talks to the same dead daemon** — there is NO backstop. Retain the rows, mark them `availabilityReason: "mm-unavailable"`, make NO fallback-healthy claim, and require a full resnapshot to complete (per the settle rule above) BEFORE authority returns |

### SIGNAL CADENCE — A DOCUMENTED DEVIATION, WITH EVIDENCE

The plan called for `Signal.SetupThresholds` (else `Signal.Setup` at 5-10 s).
**Neither is called on the shipped path, deliberately.** `dbus-audit-transport.ts`
is fail-closed and refuses `Modem.Signal.Setup` BY NAME because it WRITES, and
that fail-closed guarantee is the single property that makes it safe to point the
fleet default at a path observing the same daemon mmcli drives — opening a write
member in the very commit that flips the default would remove the reason the flip
is safe. It costs nothing measurable: `Modem.SignalQuality` is MM's own polled
property and is published via `PropertiesChanged` with no `Setup` call at all
(todo 16 recorded 66 such signals in a session that issued none), and
`DbusModemView.signal` reads that 0-100 value, not the extended `Modem.Signal`
interface `Setup` governs. Adopting extended metrics means adding the member to
`CELLULAR_READ_ONLY_MEMBERS` as its own reviewed change, never as a side effect.

### SHADOW MODE IS EVIDENCE, NEVER A SOURCE

`config.modem_shadow === true` starts a mutation-free comparison of the D-Bus
observer against the live mmcli reads (`docs/MMCLI-RETIREMENT-GATE.md`). It never
touches the wire — a boot-integration test asserts the projected message is
byte-identical with shadow on and off. The opt-in is strict: absent, `false`, and
a non-boolean truthy all return BEFORE the D-Bus client is imported.

### DEV MOCK SEAMS (cellular)

`mocks/providers/cellular.ts` makes all three surfaces reachable with no
hardware, and every seam is deliberately placed so the PRODUCTION rule still
runs:

| Seam | Where it enters | What still runs for real |
|---|---|---|
| `getMockModemIdPaths()` | the producer's `ModemIdPathReader` | `deriveModemStableKey`'s parent-`usb_device` strip |
| `listMockDongleFiles` / `readMockDongleFile` | `dongle-metadata.ts`'s OWN deps seam, as file CONTENT | the real schema, staleness and ambiguity rules — and it feeds BOTH the netif marker and the modems row from one place |
| `getMockDbusModemViews()` | `setMockDbusModemViews()`, installed by `main.ts`'s dev block | the full adapter + projection path |
| the mock dbus BACKEND | `loadDbusBackendFactory()` | the same try, `withDeadline` race and `result.ok` commit test |
| `getMockShadowDeps()` | `startModemShadowIfEnabled` | the audit wrapper, classifier, redactor and evidence writer — `startModemShadow` applies the wrapper itself, so the fake stays BELOW the guard |

Two fixture rules are load-bearing and were both learned the hard way:

- **`updated_at_ms` is stamped at READ time.** A frozen timestamp reads as stale
  within 90 s and the dongle rows silently vanish from the dev UI.
- **The mmcli side's `deviceKey` must go through `opaqueDeviceKey`**, because the
  observer side does. A raw ifname produces a matched `only-in-mmcli` +
  `only-in-dbus` PAIR every cycle instead of the one field divergence the fixture
  demonstrates — which is the "the two sides never actually joined" state the
  retirement runbook calls a gate blocker.

The fixtures also reproduce the bench's duplicate-MAC HiLink pair verbatim (two
physically distinct dongles, ONE factory MAC `0c:5b:8f:27:9a:64`): that collision
is the reason identity is `ID_PATH`-keyed, so a fixture that quietly gave them
different MACs would teach the opposite lesson.

Coverage: `tests/cellular-boot-order.test.ts` (the source-order lock + the
fail-soft consequences) and `tests/cellular-boot-integration.test.ts` (the
`bootLikeCellular` parity harness — `stable_key` reaching the wire through the
real composition root, both dongle rows with their honest omissions, synthetic-id
stability, backend selection in BOTH directions, the refusal window, and shadow's
non-interference). The per-module suites from the wave below it are unchanged:
`cellular-stack`, `cellular-audit-transport`, `cellular-gate`,
`cellular-shadow-{divergence,audit,redaction,retention}`,
`modem-wire-projection`, `modem-set-usb-mode-gate`,
`modem-usb-mode-transition`, `streaming-lifecycle-interlock`.

### THE `dbus` PATH IS NOW THE DEFAULT — AND THE FULL PATH IS STILL BOARD-UNPROVEN

`config.modem_backend` (`z.enum(["mmcli","dbus"])`, `.optional()`, still no
`RUNTIME_CONFIG_DEFAULTS` entry) now resolves through `DEFAULT_MODEM_BACKEND`,
which is **`"dbus"`**. Absence is what every board in the field has, so an
UNMODIFIED production config takes the cutover; `"modem_backend": "mmcli"` is the
operator's explicit rollback value and still selects the byte-identical legacy
path (synchronously ready, no D-Bus import). CI proves the cutover the way a
field device experiences it — `tests/cellular-dbus-adoption.test.ts` deletes the
key rather than setting it.

**Read what IS and IS NOT hardware-proven, because they are different claims.**

- **PROVEN on the bench** (`ceralive2`, todo 16, 6/6 gates): the D-Bus TRANSPORT
  under Bun in the real packaged service identity — system-bus connect, a
  `GetManagedObjects` roster identical to `mmcli -L`, all four signal classes
  received AND decoded across a real USB port cycle, survival of a ModemManager
  restart, clean SIGTERM with no orphaned match rules, and a full observed hour
  with zero fd or subscription growth.
- **NOT proven on a board**: everything ABOVE the transport — this cache, the
  fold, the settle guard, the failure-class split, and the flipped default
  serving real `modems` rows to a real operator. Every assertion about them is a
  unit/integration test against a fake bus. That is a gap in HARDWARE EVIDENCE,
  not in coverage, and the two are not interchangeable.

**Two things are owed before this default should be trusted in the field:**

1. **Board-run the flipped default.** Deploy, restart `ceralive` WITHOUT editing
   `/etc/ceralive/config.json`, and confirm: `status.cellular_initializing`
   clears, the `modems` broadcast carries every real modem with `stable_key`
   populated, a `systemctl restart ModemManager` does NOT blank the list (the
   settle guard's whole purpose), and an unplug still removes its row.
2. **The ≥ 8 h soak.** Todo 16's one-hour soak was leak-free on descriptors and
   match rules but left an unresolved ≈5.6 MiB/h residual RSS slope a one-hour
   window cannot distinguish from heap warm-up. It was measured against the raw
   transport harness, not this cache. ~5 MiB/h sustained is ~120 MiB/day on a
   device that runs for weeks.

**And note the tension with the retirement gate below, honestly.** That gate's
condition 5 describes flipping the default away from `"mmcli"` as a later
decision gated on ≥14 days of shadow evidence on ≥2 devices plus a HIL parity
run. **The flip has now shipped ahead of that evidence, by plan decision.** What
that changes is which safety net is load-bearing: it is no longer the shadow
comparison but the runtime fallback — a `dbus` start that rejects, returns a
non-authoritative snapshot, or outlives `DEFAULT_INIT_TIMEOUT_MS` commits mmcli
in a ready-but-degraded state visible at `/api/health`, and the operator rollback
value is one config line. `buildModemsMessage` therefore stays exactly where it
is; condition 5 has NOT been satisfied, it has been overtaken, and deleting the
legacy builder is further away rather than closer.

### THREE PARALLEL MODEM-TOUCHING PATHS NOW EXIST, AND ONLY ONE IS LIVE

This session's audit surfaced that CeraUI's backend now carries three
independent code paths that each talk to modem hardware for a DIFFERENT purpose.
They do not compete for the same job, but they DO overlap in the sense that a
future reader could reasonably ask "why are there three ways this backend talks
to a modem" — so the answer is recorded here rather than left to be
re-discovered:

1. **`modules/modems/` — the original Phase-A direct-`mmcli` path.** This is the
   ONLY one of the three actually exercised on real hardware. Every modem row on
   the wire today (this session's live Quectel/SIMCom/HiLink/ZTE verification, the
   todo 45 PIN2 flow, the todo 43 router-cellular classification) came from this
   path. It shells out to `mmcli`/`qmicli` per poll (`mmcli.ts`,
   `modem-update-loop.ts`, `sim-pin2.ts`, `sim-autounlock.ts`, `sim-secrets.ts`)
   and is what `modem_backend: "mmcli"` (now the operator ROLLBACK value, no
   longer the default) selects inside `initCellularStack`. It also still runs
   under the D-Bus default as the 30 s reconciliation backstop, so a demotion has
   warm rows to serve. Everything it reads from `-K` output passes through
   `mmcliUnescapeValue` — mmcli escapes EVERY value it prints, so this is a
   property of the CLI and not of any one command (SMS INBOX §5).
2. **`modules/cellular/` — the Wave-4 composition root over
   `@ceralive/modem-control`'s D-Bus observer.** `cellular-stack.ts`,
   `dbus-backend.ts`, `dbus-audit-transport.ts`, `shadow.ts`,
   `modem-wire-adapters.ts`, `modem-wire-projection.ts`, plus the observer
   adoption layer (`dbus-modem-cache.ts`, `dbus-view-fold.ts`,
   `dbus-mm-enums.ts`). This is now the DEFAULT path — its transport is
   board-proven (todo 16) but everything above it is still fixture-proven only;
   see the section above for exactly which claim is which.
3. **`modules/modems/sim-pin2.ts` — a direct-`qmicli` path, found this session
   (todo 45), that neither of the other two paths can reach.** Neither `mmcli`
   (ModemManager's own D-Bus API declares exactly five `Sim` methods —
   `SendPin`/`SendPuk`/`EnablePin`/`ChangePin`/`SetPreferredNetworks`, all
   PIN1-only, confirmed against both the MM 1.24.2 source and a live `busctl
   introspect` on `ceralive2`) nor `@ceralive/modem-control`'s D-Bus surface
   exposes SIM **PIN2** submission at all — MM's own maintainers say so
   explicitly ("we really don't care about PIN2 in MM, at least for now"). So
   `sim-pin2.ts` bypasses BOTH modem-facing abstractions and calls `qmicli
   --uim-verify-pin=PIN2,<code>` directly over the shared `qmi-proxy` socket,
   deliberately alongside a live ModemManager rather than through it. This is not
   a design inconsistency to "fix" by routing PIN2 through one of the other two
   paths — as of this writing NEITHER can carry it, so a third, narrower path was
   the only available option for a real operator need (see todo 45's full
   write-up in the session notepad for the PIN2/PIN1 distinction and why boot
   auto-unlock deliberately excludes it).

The three paths are NOT redundant with each other: (1) is the live production
path, (2) is evidence-gathering infrastructure for a FUTURE production path, and
(3) fills one specific real gap neither (1) nor (2) can reach. A future reader
tempted to "consolidate" them should first re-read this paragraph — consolidating
(1) into (2) is exactly what the mmcli-retirement gate below exists to make safe,
and consolidating (3) into either is blocked by an upstream ModemManager
limitation, not a CeraUI design choice.

### WHY `buildModemsMessage` (LEGACY) STAYS ALONGSIDE THE PROJECTION — AND WHEN IT CAN GO

The "PROJECTION IS WHAT REACHES THE WIRE" section above already states the
mechanical reason `buildModemsMessage` is retained: it is the fail-safe a
throwing projection falls back to, and the oracle `modem-wire-projection.test.ts`
asserts against. Restated plainly for anyone weighing whether to delete it: it is
a **byte-compat regression guard for the `mmcli` path** — the path that is
actually running on every real device today (see above). Deleting it would remove
both the safety net AND the only independent check that the new
projection/adapter/wire-producer trio (todo 22) reproduces the pre-Phase-B wire
exactly, for the backend that 100% of the fleet currently uses.

**Retirement condition (dated, measurable — not "someday" or "when ready"):**
`buildModemsMessage` may be deleted only once ALL of the following hold
simultaneously, mirroring the shadow-mode retirement gate's own N-day/
divergence-count mechanism (todo 21, `docs/MMCLI-RETIREMENT-GATE.md`):

1. `config.modem_backend: "dbus"` has actually run in production (not fixtures)
   on **at least one** real CeraLive board for **at least 14 consecutive days**
   (`MIN_HEARTBEATS_PER_COMPLETE_DAY = 72` per the shadow evidence retention
   rule already documented above), collecting shadow evidence the entire time
   via `config.modem_shadow: true`.
2. Zero unexplained divergences recorded in that evidence window — a
   `field-mismatch`/`only-in-*` entry is "explained" only if it is one of the
   already-known, already-documented absent-dimension gaps (see "the observer and
   mmcli do NOT observe the same dimensions" above); any NEW divergence class
   blocks retirement until it is understood.
3. `unjoinable` count in the shadow heartbeat stays at (or returns to) zero for
   that same window — a persistently non-zero `unjoinable` count means parts of
   the fleet were never actually compared, which the runbook already calls a gate
   blocker.
4. The MMCLI-RETIREMENT-GATE runbook's own `distinctModems ≥ 2` criterion is met
   across **separate physical CeraLive units**, not two modems on one board (the
   runbook's own explicit distinction, restated above in "COMPOSITION ROOT").
5. `mmcli` retirement itself (flipping the DEFAULT away from `"mmcli"`) is a
   SEPARATE, later decision gated on a successful HIL parity run and one full
   dbus-default release cycle (per the root plan's binding annex — "mmcli-
   retirement criteria: ≥14 days shadow on ≥2 devices, zero unexplained
   divergences, HIL parity, rollback drill, one dbus-default release"). Deleting
   `buildModemsMessage` may happen only AFTER that flip has shipped and proven
   stable — the legacy builder is the safety net for exactly the transition
   window between "default flipped" and "confidently redundant", not for the
   flip decision itself.

**None of these five conditions have been met as of this session.** Condition 1
alone requires the NEXT STEP two sections above (setting `modem_backend: "dbus"`
on a real board) to have even started, and it hasn't. This todo documents the
condition; it does not — and must not — trigger any part of it.

