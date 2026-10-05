<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## USB-COMPOSITION SWITCH — GATES, THEN CATALOG, THEN THE ENGINE [PARTIAL]

`modems.setUsbMode` (`rpc/procedures/modems.procedure.ts`) switches a modem's USB
composition mode. The switch re-enumerates the device and drops its bond link, so
the gates are the safety contract rather than UI polish — and they live at the
PROCEDURE, so a direct RPC call is refused exactly as a UI one is. Hiding the
control would only hide it from the UI.

Gate order is itself the contract:

1. **`config.modem_provisioning !== true` ⇒ `provisioning_disabled`.**
   DEFAULT-ABSENT, with NO entry in `RUNTIME_CONFIG_DEFAULTS` — absent and `false`
   refuse identically, so the mutation is unreachable on a device nobody
   deliberately provisioned. This runs FIRST and outranks every other condition.
2. **`!isRealDevice()` ⇒ `unavailable_in_emulated_mode`**, ahead of the streaming
   check: there is no hardware to transition either way, and answering
   `streaming_active` on a dev host would be a lie about the reason.
3. **`getIsStreaming()` ⇒ `streaming_active`.**
4. **The `"modem-transition"` lifecycle lease ⇒ `streaming_active` (held by an
   admission) or `transition_in_progress` (held by another transition).** This is
   the reciprocal side the interlock primitive deliberately left unwired. It sits
   ALONGSIDE gate 3, not instead of it, because the two cover DISJOINT windows: a
   stream that has been admitted but has not yet reached PLAYING has already
   spawned its sender against a link list a re-enumeration is about to invalidate,
   and `getIsStreaming()` is false for exactly that window.

Everything past the lease is `modules/modems/usb-mode-transition.ts`
(`runUsbModeTransition`), and **its internal order is the TIER-A guarantee**:

1. **IDENTIFY** — a real `udevadm`/sysfs enumeration
   (`createUsbEnumerator().enumerate()`) resolves the physical device behind the
   modem id: VID:PID, model, firmware revision, current composition mode, the
   `ID_PATH`-derived `stable_key`, and the physical UID needed to re-find the
   device AFTER it re-enumerates. The modem id and ifname are used ONLY as the
   one-instant lookup that finds the device; everything downstream correlates on
   `stable_key`, and a device with no `ID_PATH` is REFUSED rather than transitioned
   into something we could not then recognise.
2. **CERTIFY** — `matchCertifiedEntry` against `@ceralive/modem-control`'s catalog,
   then `findPermittedTransition`. Both are pure reads.
3. **DISPATCH** — and only now is the engine touched at all.

**Nothing may call the transition engine before step 3**, which is what makes the
Phase-A TIER-A rule ("an entry refusal fires ZERO engine calls") spy-provable
rather than a comment. The engine re-checks its own preconditions twice (entry +
in-actor); our catalog check PRECEDES that rather than replacing it, so a doomed
request never queues behind real hardware in the per-modem actor.

**The firmware discriminator is matched by PREFIX, never by truncation.** A
catalog entry certifies a firmware FAMILY, and the length separating a family from
a build is a per-SKU judgement made by whoever reviewed the evidence bundle — a
device cannot compute it. `matchCertifiedEntry` therefore runs `startsWith` against
the device's FULL revision, and the matched entry's own discriminators become the
request's `sku` so the engine's catalog re-check resolves to the SAME entry.

**ON SUCCESS the backend fires EXACTLY ONE re-discovery + `modems` broadcast**
(`discoverModems()` — the `sim-autounlock` precedent). The regular loop broadcasts
only every 30 s, so without this the confirming snapshot lands long after any
reasonable UI bound and a genuinely-successful switch reads as a timeout. Not zero,
and not a loop. A refused/failed transition re-discovers nothing.

**`transition_failed` carries a TYPED reason** (`setUsbModeFailureReasonSchema`):
`identity_unresolved` / `engine_unavailable` / `preconditions_refused` /
`postcondition_mismatch` / `transaction_error`. The last two are deliberately
distinct — "the device came back as something else" and "the transaction blew up"
call for different operator actions.

**A dependency that THROWS is NOT caught inside `runUsbModeTransition`.** The
procedure catches it instead, so `withLifecycleLock`'s `finally` release is
exercised by a real escaping throw. Todo 23 learned this the hard way: a body that
always returns normally never exercises a `finally`, so a release test built on a
merely-FAILING engine proves the ordinary return path and nothing else.

**The transition ENGINE is now WIRED.** `modules/modems/transition-engine.ts`
builds modem-stack's certified `UsbModeTransition` from CeraUI-local ports: the
`NmcliNmPort` adapter, an MM inhibit lease that IS a live
`mmcli --inhibit-device` child (MM scopes an inhibition to the caller's bus
connection, so releasing it is killing that child — a one-shot D-Bus call would
un-inhibit the moment it returned), and a raw AT sender writing to the modem's own
tty (the transaction sends AT only while the modem is inhibited, which is exactly
when ModemManager has RELEASED the port). `TransitionInterlock` — bidirectional by
design — is bridged onto CeraUI's own lifecycle interlock rather than a second
guard, which is what made the wiring possible without a parallel lease. A modem
with NO AT control port yields NO engine and the typed `engine_unavailable`,
never a fabricated transition. The rollback is ARMED before the first
connectivity-losing call and cancelled only after the engine's postcondition AND a
confirmed re-registration with a live data path.

**Re-enumeration is not complete until NetworkManager exposes the returned
connection on a concrete device.** USB composition switches can make the physical
modem visible before its replacement netdev appears in NetworkManager. The engine's
request-scoped enumeration wrapper therefore withholds the returned target snapshot
and polls `GENERAL.CON-UUID,GENERAL.AVAILABLE-CONNECTIONS` for the transaction's NM
connection id. Only after that bounded resolver finds the owning interface is the
snapshot returned with the resolved ifname injected. Expiry throws a transaction
error, leaves the failed journal outcome intact, and never reports a switch as
successful merely because the USB device reappeared. Coverage is split between
`tests/modem-transition-engine.test.ts` (delayed success plus bounded timeout) and
`tests/modem-usb-mode-nm-device.test.ts` (the production NM connection-to-device
resolver).

Historical note (superseded): `UsbModeTransition`
needs MUTATION ports — MM inhibit/uninhibit, an AT sender, an NM quiesce/activate
adapter — and CeraUI's only D-Bus surface is the deliberately mutation-FREE audited
transport (`dbus-audit-transport.ts`), so there is nothing to build them from. The
`createEngine` seam resolves `undefined` and that is reported as the typed
`engine_unavailable` reason — never as a silent success and never as a fake
transition. Every gate, mapping, postcondition path and re-discovery above it is
live; wiring a real engine is a matter of supplying `createEngine`.

**In practice `uncertified` is what every real modem answers today**, and that is
a first-class rendered state rather than a stopgap: the shipped catalog carries one
synthetic bench SKU because no shipping modem has a reviewed evidence bundle yet
(Phase-A Must-NOT-Have 7 — no catalog entry without one).

The RM530N-GL catalog entry remains **BLOCKED-ON-HARDWARE and belongs to Todo 42**.
Do not infer or synthesize its discriminators, commands, or postconditions from model
names: admission requires a captured `certify` bundle and human review. This deferral
does not weaken the generic transition transaction or its post-re-enumeration race
handling.

Wire contract (strict input, `confirm: z.literal(true)`, the six switch-specific
typed refusals plus the four shared mutation-safety ones, and the typed failure
reason): [`packages/rpc/AGENTS.md`](../../../../packages/rpc/AGENTS.md)
→ "A MODEM IS CORRELATED BY `stable_key`". Coverage:
`tests/modem-set-usb-mode-gate.test.ts` (the entry gates + the two strict-input
negatives) and `tests/modem-usb-mode-transition.test.ts` (the TIER-A zero-engine
spy matrix, the catalog table incl. the prefix-vs-truncation contract, the
outcome→reason mapping, the exactly-one re-discovery, and the lease release under
an escaping throw) and `tests/modem-transition-engine.test.ts` (the wired engine
driven over mock transport — the AT-port resolution, the certified command sent
exactly once, an `OK` that re-enumerates wrong FAILING on the postcondition, a
switch that lands but never restores its data path, and the zero-engine-call proof
for an uncertified firmware). Frontend half: [`../frontend/AGENTS.md`](../../../frontend/AGENTS.md)
→ "A USB-MODE SWITCH IS CONFIRMED BY THE DEVICE, NOT BY THE REPLY".

### …AND WHICH MODES MAY BE OFFERED IS ASKED BEFORE ANYTHING IS RENDERED [EXISTS]

`modems.getUsbModeOptions` (`usb-mode-certification.ts`) is the pure-READ half of
the same contract: it resolves the device through `getUsbModeDispatchDeps()` — the
SAME `resolveIdentity` and the SAME catalog `runUsbModeTransition` gates on — and
answers the certified TARGET set for the mode the device is in right now
(`entry.permittedTransitions.filter(t => t.from === currentMode)`).

- **One lookup, not two.** A UI gated on its own certification rule is a UI that
  offers what the device refuses; that is the defect this closes, so there is
  deliberately no second catalog read. `from` is matched on the LIVE mode, never on
  the entry's `canonicalMode` — a device already switched is not in the mode its
  entry was written around.
- **It is a READ: no mutation lease, no engine.** It joins `modems.getAll` /
  `getSms` as a deliberate non-entry in todo 25's mutation-entrypoint inventory,
  and a test asserts zero `createEngine` calls.
- **It does NOT answer the provisioning question.** That gate is a SETTING the
  operator can turn back on, so its control renders disabled-with-reason; folding
  it in here would withdraw a control that is merely blocked and make the two
  states indistinguishable.
- **`certified: []` with NO `suppressed` is its own state** — the SKU is in the
  catalog and this mode simply has no certified exit. Reporting it as `uncertified`
  would tell an operator their model was never reviewed.
- **`identity_unresolved` covers native-PCIe and router-mode dongles**, and
  correctly so: neither has a USB composition a switch could act on.
- **Mocks answer with a fixture** (`getMockUsbModeOptions`), because a dev host has
  no udev device to resolve and would otherwise make the whole switch surface
  unreachable in dev and in every e2e spec.

Coverage: `tests/modem-usb-mode-certification.test.ts` (the target table incl. the
one-character-short firmware negative, the per-mode scoping, the wire answers, the
zero-engine proof, and the two-enum vocabulary containment) +
`tests/usb-tether-fence.test.ts` (the PERMANENT `sethimiusbtether` fence: a
comment-stripped repo-wide walk plus the shipped catalog, with a self-proving
detector and a non-vacuity check on its two fence-file exemptions).

