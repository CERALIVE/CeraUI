# D-Bus observation contract — the modem event source beneath the wire producer

**Status:** `[EXISTS]` — implemented by `apps/backend/src/modules/cellular/{dbus-backend,dbus-modem-cache,dbus-view-fold}.ts`.
**Audience:** anyone changing the cellular observation path, the wire producer's radio half, or `initCellularStack`.

This document is the written half of the adoption. It is deliberately written
BEFORE the wiring it describes, because the parts that bite (which failure class
has a backstop, what a post-restart empty snapshot means, who owns removal) are
policy decisions, not implementation details — and a reader who only has the code
cannot tell a deliberate rule from an accident.

---

## 0. The honest baseline

`MmDbusObserver` (`@ceralive/modem-control`) is **snapshot reconciliation with
epoch fencing**, not delta ingestion. Every accepted signal — `InterfacesAdded`,
`InterfacesRemoved`, `PropertiesChanged`, a `NameOwnerChanged` that names a new
owner — triggers a full `GetManagedObjects` refresh; the signal body itself is
never merged into a row. An "epoch" is one continuous ownership period of the
`org.freedesktop.ModemManager1` bus name, and a signal whose `sender` is not the
current owner is dropped outright.

That design is what makes the false-removal class dead by construction: a modem
disappears only when a CURRENT-EPOCH authoritative snapshot omits it. Owner loss,
bus disconnect, and old-epoch stragglers can only ever mark rows stale.

What this todo adds is everything above that line: CeraUI had a stub seam
(`dbus-backend.ts` discarded the observations; `modem-wire-producer.ts`'s
`readDbusViews()` returned `[]`), so the observer's output reached nothing.

---

## (a) The snapshot + subscription API between observer and backend

Two channels, both already offered by the package; the backend consumes both and
neither is optional:

| Channel | Shape | Carries | Used for |
|---|---|---|---|
| `observer.start()` → `ObservationList` | `{ok:true, rows}` \| `{ok:false, reason, rows}` | roster + lifecycle dimensions (`identity`, `presence`, `mmState`, `sourceHealth`) | the initial authoritative list; `ok` is the stack's commit test |
| `observer.observe(listener)` | `(list: ObservationList) => void` | same | every subsequent change notification, incl. health transitions |
| `onEpochRefresh({epoch, tree})` | `DecodedManagedObjects` | the WHOLE decoded `GetManagedObjects` payload | the rich per-modem detail (`SignalQuality`, `OperatorName`, modes, ports, SIM, eSIM, revision) |

**The tree is the fold's input; the list is NOT.** Two upstream facts force this
and both are easy to get wrong:

1. `ObservationList` rows are `CellularSnapshot`s, and the package's `mapModem`
   is deliberately conservative: registration is always `unknown`, the RAT set is
   always empty, and there is no signal, operator, model, ifname or mode list at
   all. A wire row folded from `ObservationList` alone would be strictly POORER
   than the mmcli row it replaces.
2. The observer emits a list ONLY when a row's fingerprint changed — and the
   fingerprint deliberately ignores signal quality. A signal-only refresh
   therefore delivers a tree and NO list. A cache driven by list events would
   never publish a signal change, which is the single most frequent update on the
   wire.

So the fold reads the tree, which `onEpochRefresh` delivers on EVERY successful
current-epoch refresh (never for a superseded epoch) whether or not a row
changed. The `ObservationList` is used for exactly two things: `start()`'s `ok`
commit test, and telling the two failure classes of §(d) apart.

---

## (b) The `ObservationList` → `DbusModemView` fold

`dbus-view-fold.ts` is pure: `(tree) → readonly DbusModemView[]`, one entry per
object exposing `org.freedesktop.ModemManager1.Modem`.

| `DbusModemView` field | Source |
|---|---|
| `runtimeId` | trailing integer of the MM object path (`…/Modem/<n>`) |
| `idPath` | `Modem.Physdev` NORMALIZED through `canonicalModemIdPath`, else `Modem.Device` when it is one of our `slot-*` labels |
| `ifname` | the `Modem.Ports` entry whose port type is `net` (MM_MODEM_PORT_TYPE_NET = 2) |
| `mmState` | `Modem.State` (MMModemState), decoded to the same tokens as mmcli's `modem.generic.state` |
| `registration.status` | `Modem3gpp.RegistrationState` (MMModem3gppRegistrationState) |
| `registration.activeRats` | `Modem.AccessTechnologies` bitmask → the same RAT tokens the adapter's `RAT_TO_GENERATION` understands |
| `signal` | `Modem.SignalQuality` (`(ub)` struct — the `u` half, 0-100) |
| `operatorName` | `Modem3gpp.OperatorName` |
| `supportedNetworkTypes` / `activeNetworkType` | `Modem.SupportedModes` / `Modem.CurrentModes` (`a(uu)`), folded to mmcli's own label grammar (`allowed: 4g, 5g` ⇒ `"5g4g"`) |
| `simLockRequired` / `simLockRemainingAttempts` | `Modem.UnlockRequired` / `Modem.UnlockRetries` |
| `model` / `manufacturer` / `equipmentId` / `firmwareRevision` | `Modem.Model` / `.Manufacturer` / `.EquipmentIdentifier` / `.Revision` |
| `esim` | `Sim.SimType` / `Sim.EsimStatus` on the modem's active SIM object |
| `scanning` | `mmState === "searching"` |

**`Modem.Physdev` IS A SYSFS DEVPATH, NOT AN `ID_PATH`, AND IT MUST BE
NORMALIZED.** MM publishes it as `/sys/devices/platform/…/usb1/1-1/1-1.4/1-1.4.1`
while every udev-sourced adapter publishes the same socket as
`platform-xhci-hcd.0.auto-usb-0:1.4.1`. `stable_key` equality is the ONLY
sanctioned correlation operation, so two encodings of one port means the D-Bus row
could never retire the optimistic udev row for its own device — board-measured on
`ceralive2` (todo 24) as two simultaneous rows for one stick, 10 cycles out of 10.
`readIdPath` therefore runs `canonicalModemIdPath` (`@ceraui/rpc`), which converts
a sysfs path with udev's own `path_id` USB rule and leaves an already-canonical
`ID_PATH` untouched. Do NOT store the raw `Physdev`: the anchor is compared with,
and merged against, keys minted by three other adapters.

**Omission means "not observed", never "zero".** Every optional field is omitted
when the property is absent, exactly as `DbusModemView`'s own doc-comment
requires — a `0` signal and an unobserved signal are different facts.

**`config` is NOT folded here.** It is the NetworkManager-owned profile and the
D-Bus observation path is fail-closed read-only against ModemManager only
(`dbus-audit-transport.ts`); manufacturing a profile from MM data would be a
guess. Absent `config` renders `no_sim: true` on the wire, which is why the fold
carries `simVisibility` truthfully through `simLockRequired` instead.

A modem object the tree cannot fully describe — no `Modem` interface, no `net`
port in `Modem.Ports`, or a path with no trailing integer — is SKIPPED rather
than emitted with placeholders: half-observed detail on the wire is worse than
the mmcli row it would replace.

---

## (c) The bounded refresh contract

Two distinct bounds. Conflating them is the mistake this section exists to
prevent.

### c.1 Snapshot bound — owned by the observer, restated here

`MmDbusObserver` allows **at most one in-flight `GetManagedObjects`**, with a
single dirty flag (`#refreshQueued`) for "something happened while we were
reading". A storm of N signals therefore collapses to at most TWO snapshots: the
one already in flight plus one queued re-run. There is no timer.

**The minimum inter-snapshot interval is therefore the duration of one
`GetManagedObjects` round-trip**, measured at 4-20 ms on the reference RK3588
board with 4 modems (todo 16, gates 2 and 4). This is documented rather than
enforced because the dirty-flag design already bounds the work: adding a timer
would only delay the SECOND snapshot of a burst, which is the one that carries
the settled truth.

### c.2 Publication bound — owned by CeraUI (`dbus-modem-cache.ts`)

A refresh that changed nothing an operator can see must not cost a broadcast.
Every fold result is diffed against the published one and classified:

| Class | Trigger | Propagation |
|---|---|---|
| **structural** | a key added or removed; `mmState`, `registration.status`, `simLockRequired`, `availabilityReason`, `ifname`, `activeNetworkType` changed; any authority-state change | **IMMEDIATE** — publish on this turn |
| **cosmetic** | ONLY `signal`, `operatorName`, `cellInfo`, `dataUsage`, `supportedNetworkTypes` changed | **COALESCED** — 150 ms trailing timer (`COALESCE_MS`, inside the 100-250 ms band); a further cosmetic change inside the window extends nothing and re-uses the pending timer |
| **none** | folds are deep-equal | no publish at all |

A structural change that lands while a cosmetic timer is pending cancels the
timer and publishes immediately — the operator sees the plug event and the new
signal in one frame, never a stale frame followed by a redundant one.

### c.3 The mmcli poll stays, as a reconciliation backstop only

`modem-update-loop.ts`'s retained status poll keeps its **30 s cadence with
jitter** (`STATUS_POLL_INTERVAL_MS`). Under the D-Bus backend it is no longer the
mechanism by which an operator learns anything; it is the reconciliation backstop
that keeps `modems-state` warm so a demotion to mmcli (§d) has rows to serve
immediately rather than after a cold discovery. Its rate is unchanged and is
deliberately NOT raised: a backstop that polls faster than the event source
buys nothing and costs a `mmcli` spawn per modem per tick.

`nmcli monitor` is untouched. It reports NM-layer facts (connection activation,
device state) that ModemManager's ObjectManager does not carry at all, so it is
not redundant with this path and is not part of this cutover.

### c.4 Signal cadence — a documented deviation, with evidence

The plan calls for `Signal.SetupThresholds` where supported, else `Signal.Setup`
at 5-10 s. **Neither is called on the shipped path, deliberately.**

`dbus-audit-transport.ts` is fail-closed: exactly three read members reach the
bus, and `org.freedesktop.ModemManager1.Modem.Signal.Setup` is refused BY NAME
(`REFUSAL_NAMED_MUTATION`) because it writes — it turns on periodic extended
signal reporting on the modem. That fail-closed guarantee is the single property
that makes it safe to point the default at a path observing the same daemon
mmcli drives; opening a write member in the very commit that flips the default
would remove the reason the flip is safe.

It costs nothing measurable, because `Modem.SignalQuality` is MM's own polled
property and is published via `PropertiesChanged` **without any `Signal.Setup`
call**: todo 16's board run recorded 66 `PropertiesChanged` signals with
`changedKeys: ["SignalQuality"]` over a session in which no `Setup` was ever
issued. `Signal.Setup` governs the *extended* `Modem.Signal` interface (RSSI,
RSRP, SNR), which `DbusModemView.signal` does not read — it reads the 0-100
`SignalQuality`.

**When this changes:** adopting extended signal metrics means adding
`Modem.Signal.SetupThresholds`/`Setup` to `CELLULAR_READ_ONLY_MEMBERS` with an
explicit rationale and a test, as its own change with its own review — not as a
side effect of an adoption.

---

## (d) Source-unavailable semantics — TWO failure classes, separated

This is the section to read before changing anything about fallback. The two
classes look identical in a log line and have OPPOSITE correct responses.

### d.1 Observer/transport failure while MM is alive → mmcli backstop takes over

Signature: `ObservationList.ok === false` with `reason === "bus-error"` — the
observer holds a current owner but a `GetManagedObjects` call failed.

MM is still answerable, so `mmcli` (which talks to the same live daemon over the
same bus) is a genuine second opinion. The cache demotes itself below mmcli:
`readDbusViews()` returns `[]`, and the wire producer projects mmcli rows exactly
as it does under `modem_backend: "mmcli"`. Retained D-Bus views are kept in
memory for the recovery, not served.

### d.2 MM name-owner lost → there is NO backstop

Signature: `reason === "source-unavailable"` — the bus name has no owner, or the
bus connection dropped.

**`mmcli` talks to the same dead daemon.** Falling back would produce either an
error or, worse, a confident empty list. So:

- rows are **retained and marked stale**: every retained view is served with
  `availabilityReason: "mm-unavailable"` and keeps its last observed values;
- **no fallback-healthy claim is made** — the cache does not demote to mmcli and
  the stack does not report itself recovered;
- on owner return, a **full resnapshot completes BEFORE authority switches
  back** — see §d.3, which is also where the post-restart landmine lives.

### d.3 Owner return: the empty-snapshot landmine

Todo 16, gate 4, on real hardware: the resnapshot fired **18 ms** after MM
re-acquired its bus name and returned `modemCount: 0`. That is the honest D-Bus
answer — the daemon had not re-probed any port yet — and the roster refilled over
the next **~20 s** via `InterfacesAdded` from the new owner.

**A consumer that published that snapshot verbatim would blank the operator's
modem list for ~20 s on every ModemManager restart.** So a new epoch does not
immediately regain authority:

1. On epoch change the cache enters **`settling`** and keeps serving the retained
   views from the previous epoch, each marked `availabilityReason:
   "mm-restarting"`.
2. Each snapshot in `settling` is **merged, never substituted**: modems the new
   epoch has re-probed replace their retained row and become live; modems not yet
   seen keep their retained row and stay marked.
3. `settling` ends at whichever comes first:
   - the new epoch's roster reaches the retained row count (the roster refilled),
     or
   - `EPOCH_SETTLE_MS` (**25 000 ms**, chosen above the measured ~20 s refill)
     elapses.
4. **Only then** does the epoch's snapshot become authoritative. Retained rows
   never re-observed in the new epoch are removed at that moment, and only then.

A genuine "every modem was unplugged during the restart" therefore takes up to
25 s to reach the wire. That is the deliberate trade: a 25 s delay on a rare and
already-visible event, against a guaranteed 20 s false blanking on every restart.

---

## (e) Source precedence, authoritative keys, tombstones

### e.1 Precedence

Highest wins; the wire producer asks the cache and the cache answers with one of
these:

1. **D-Bus authoritative** — an accepted current-epoch snapshot, settled. Serves
   folded views.
2. **D-Bus retained-stale** (`source-unavailable`, §d.2) — serves the retained
   views marked `availabilityReason: "mm-unavailable"`. Still ABOVE mmcli,
   because mmcli cannot answer either and a stale-but-labelled truth beats an
   error.
3. **D-Bus settling** (§d.3) — serves the merged retained+refilled set.
4. **mmcli** — selected when the cache is `initializing` (no authoritative
   snapshot yet) or `demoted` (`bus-error`, §d.1). `readDbusViews()` returns `[]`
   and the existing mmcli projection runs unchanged.

The wire producer's existing rule is unchanged and still load-bearing: it reads
the backend the composition root COMMITTED (`getCellularStack()`), never
`config.modem_backend`. A `dbus` request that fell back at boot projects mmcli
rows.

### e.2 Authoritative keys

- **Within an epoch** the authoritative key is the MM object path
  (`identity.runtimePath`). It is unique and it is what the snapshot reconciles
  on.
- **Across epochs it is worthless.** Todo 16 measured the index renumbering
  twice in one session: a uhubctl cycle moved a SIM7600 `/Modem/12 → /Modem/15`,
  and the MM restart then renumbered the entire roster `11,13,14,15 → 0,1,2,3`.
- So the cache's cross-epoch identity is the **`ID_PATH`-derived key**
  (`idPath`), falling back to `mm:<runtimeId>` only when no `ID_PATH` is
  resolvable — and a row keyed by that fallback is explicitly NOT carried across
  an epoch boundary in the settling merge, because it cannot be matched
  truthfully.
- Wire `stable_key` derivation is untouched: every adapter still calls the shared
  `deriveModemStableKey(idPath)`.

### e.3 Tombstones — the rule is that there are none, and that is deliberate

**Removal is expressed by the authoritative omission itself, and the row is
dropped outright.** A modem disappears exactly when a current-epoch,
non-settling snapshot omits it (or when the settle deadline of §d.3 retires a
carried row). There is NO tombstone map.

The first draft of this cache had one, scoped to "stop a later epoch's settling
merge from re-injecting a row that was authoritatively removed". Writing the test
for it proved it can never fire: a removed row leaves the cache's retained
`views` at the moment it is removed, and the settling merge carries rows only
FROM that set — so there is nothing left for a tombstone to suppress. It was
removed rather than shipped as a documented mechanism that cannot run.

The rule that DOES hold, stated so the next reader does not re-add one:

- a row removed by an authoritative omission is gone immediately;
- it returns only when a current-epoch snapshot reports it again — which is
  exactly what a re-plug must do, so suppression would be a defect, not a
  safeguard;
- a row that cannot be matched across an epoch (no `ID_PATH`, see §e.2) is never
  carried into a settling merge at all, which is what actually bounds the merge.

---

## The cutover

### What flipped

`DEFAULT_MODEM_BACKEND` in `cellular-stack.ts` is now **`"dbus"`**. An absent
`config.modem_backend` — which is every device in the field, since nothing has
ever written the key — now resolves to the D-Bus backend.

The schema is unchanged (`z.enum(["mmcli","dbus"]).optional()`, still no
`RUNTIME_CONFIG_DEFAULTS` entry): absence resolves through the constant, so an
UNMODIFIED production config exercises the new default. That is deliberate —
`tests/cellular-boot-integration.test.ts` boots with the key deleted, not set,
so what CI proves is what a field device does.

### The rollback path

**`"modem_backend": "mmcli"`** in `/etc/ceralive/config.json`, then restart the
service. It is an explicit operator value, it is still a legal schema value, and
it selects the byte-identical pre-cutover path — `initCellularStack` returns
`READY_MMCLI` synchronously, never imports the D-Bus graph, and the wire producer
projects mmcli rows. Nothing about the rollback depends on the D-Bus code being
healthy.

### The automatic rollback (unchanged, now load-bearing for the fleet)

The existing three-rule safety net in `initCellularStack` is what makes the flip
survivable, and it is unchanged in behaviour:

1. a `dbus` start is committed only on an authoritative snapshot (`result.ok`);
2. a rejection, a non-authoritative snapshot, or a start that outlives
   `DEFAULT_INIT_TIMEOUT_MS` (15 s) stops the backend, marks `cellular-stack`
   degraded on `/api/health`, and commits mmcli;
3. boot is never blocked, and the degradation is readable rather than inferred.

### Startup cancellation / generation contract

`withDeadline(backend.start())` **cannot cancel the underlying start** — the race
loses, the work continues — and `MmDbusObserver.start()` has no stopped-generation
checks between connect, subscribe, owner-lookup and snapshot. So a timed-out
start CAN still resolve minutes later, in a process that has already committed
mmcli.

The D-Bus backend therefore owns a generation of its own:

- `stop()` sets `aborted` **synchronously**, before any await. `initCellularStack`
  calls it on every failure arm (`stopQuietly`) before anything else can observe
  the stack.
- Every observer callback (`observe`, `onEpochRefresh`) is wrapped in a
  generation check. Once aborted, a callback is a no-op: **zero cache writes,
  zero authority changes.**
- If `observer.start()` resolves AFTER the abort, the backend discards the result
  and re-issues `observer.stop()` + `transport.disconnect()`.
- **An aborted generation subscribes to NOTHING**, and this is the part that a
  bare abort flag does NOT cover. `MmDbusObserver.stop()` is idempotent — once
  stopped it returns early — while its `start()` has no stopped-check before
  `#subscribeAll()`. So a late-resolving start genuinely re-issues all FOUR match
  rules, and the observer will never tear them down again: they leak onto the bus
  for the process lifetime. The backend therefore wraps `subscribeSignal` and
  unsubscribes any rule created after the abort
  (`refuseSubscriptionsOnceAborted`). This was found by the test below, not
  reasoned about in advance — the first draft asserted only "no cache writes" and
  passed while leaking four rules.
- `start()` on an already-aborted backend resolves `{ok:false}` without touching
  the bus.

This is asserted by releasing delayed connect/subscribe/snapshot promises AFTER
the fallback has been taken and proving the cache never moved
(`tests/cellular-dbus-adoption.test.ts`).

---

## Constants, in one place

| Constant | Value | Where | Why |
|---|---|---|---|
| `COALESCE_MS` | 150 ms | `dbus-modem-cache.ts` | signal/operator burst trailing coalesce (plan band: 100-250 ms) |
| `EPOCH_SETTLE_MS` | 25 000 ms | `dbus-modem-cache.ts` | above the measured ~20 s post-restart roster refill (todo 16 §4b) |
| `STATUS_POLL_INTERVAL_MS` | 30 000 ms | `modem-update-loop.ts` | mmcli reconciliation backstop rate (unchanged) |
| `DEFAULT_INIT_TIMEOUT_MS` | 15 000 ms | `cellular-stack.ts` | boot fallback deadline (unchanged) |

---

## Open, carried forward

**The ≥ 8 h soak is owed.** Todo 16's one-hour board soak was leak-free on file
descriptors and match rules (flat at 14 / 4 across 360 signals) but left an
unresolved ~5.6 MiB/h residual RSS slope that a one-hour window cannot
distinguish from heap-still-warming. That measurement was taken against the raw
transport harness, not this cache, and it should be re-run as `--duration-sec
28800` against a device actually running the flipped default. It is recorded here
because the flip is what makes it matter.
