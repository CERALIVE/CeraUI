<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE CAPABILITY FEATURE-GATE FRAMEWORK [EXISTS]

Seven modules are GATED (band-lock / SMS / 5G-pref / FCC-auto-unlock / GPS / USSD
/ eSIM); FOUR of them ship a probe and a mutation path today
(`IMPLEMENTED_MODEM_CAPABILITY_MODULES` — `five-g-pref`, `band-lock`, `gps`,
`ussd`), and the rest resolve `unavailable` everywhere. What every one of them
routes through is the framework below, whose two halves live in different places
for a reason: the LADDER is `@ceraui/rpc` (`capability-modules.schema.ts` +
`capabilities/capability-matrix.ts`), shared verbatim with the frontend and the
support matrix; the DEVICE BINDING is `modules/modems/capability-gates.ts` +
`capability-mutation.ts`.

**The gates are DEFAULT-ABSENT, and that is a safety property.**
`config.modem_capabilities` (`helpers/config-schemas.ts`) carries one optional
boolean per module and has NO entry in `RUNTIME_CONFIG_DEFAULTS` — the
`modem_provisioning` precedent, for the same reason: every module either mutates
the radio in a way that can cost the bond link or reaches a billable/irreversible
surface, so absent and `false` must be equally inert. Adding a default would
silently enable seven radio-mutating modules on every device in the fleet.

**`capability-gates.ts` is where the gate meets the evidence.** It reads the
persisted gates, asks an injected evidence reader what THIS modem can do, and
resolves the total seven-module claim matrix. The reader has a deliberately empty
default (no module ships yet, so every modem resolves `unavailable` — the honest
answer), it is FAIL-OPEN on a throw (a broken probe is a statement about the READ,
which leaves the ladder at `enabled`: surfaced by nothing, mutated by nothing), and
each of the seven modules registers its own probe when it lands.

**`capability-mutation.ts` is the SHARED helper every mutating module must use.**
It is a WRAPPER over the mutation-safety contract, never a second guard beside it:
`withCapabilityModuleMutation` checks the feature gate and then hands off to
`withModemMutation` / `withJournaledModemMutation`, so the lease, the reciprocal
streaming refusal, the durable journal and the crash-surviving rollback all remain
`mutation-lease.ts`'s.

- **The gate runs FIRST**, on a pure read, before a lease is taken and before
  anything is journaled — the same ordering the USB-mode catalog check follows. An
  operator who has not enabled a module must be told THAT, not that the device is
  busy.
- **Which modules are journaled is enforced by the TYPE SYSTEM.** The request is a
  discriminated union in which a journaled module MUST carry a `preState` and a
  lease-only one cannot, so a module that can cost the bond link has no way to opt
  itself out of a rollback — it would not compile. The split is exactly
  "can this re-register the radio": band-lock / 5G-pref / FCC-unlock / eSIM are
  journaled; GPS and USSD take the lease alone.
- **An UNPROVEN capability fails CLOSED** into `module_unavailable`. A mutation
  nobody can show the hardware supports must not be dispatched at it.
- **The refusals are their own superset** (`capabilityMutationRefusalSchema`), not
  new members of the shared mutation enum — see `packages/rpc/AGENTS.md`.

**The matrix reaches the wire as `modem.capability_modules`**, stamped by
`modem-wire-projection.ts` from an injected resolver (the `usagePolicyFor`
precedent: it is durable state resolved from config, never anything an adapter
observed). It is TOTAL — every module carries an explicit state — because the modem
merge preserves an omitted optional field, so a present-only-when-supported claim
could be raised and never lowered.

Coverage: `tests/modem-capability-framework.test.ts` — the off-by-default matrix,
per-modem capability gating, the throwing-probe degradation, the wire stamp plus a
legacy-wire regression lock and a static producer-wiring lock, and the enforcement
suite: every refusal arm asserts BOTH the typed refusal AND that the effect
provably never ran, with a NEGATIVE CONTROL proving a module that bypasses the
helper mutates freely under identical conditions. Engine-side half:
`modem-stack/control/src/capability/`.

### …AND THE OPERATOR CAN ACTUALLY SET THOSE GATES [EXISTS]

`modems.getCapabilities` / `modems.setCapabilities` are the write path. Before
them `config.modem_capabilities` was default-absent with no RPC and no UI, so
band-lock and GPS told operators to enable a feature "in settings" and pointed at
nothing — a board sweep of `#settings` matched zero relevant testids
(`.omo/evidence/task-49-full-stack-board-validation.md`).

- **They are `authedProcedure`, NOT `modemProcedure`.** The gates belong to the
  DEVICE, so they must answer while the cellular stack is still initializing and
  with no modem attached; the readiness middleware would make the settings surface
  unreachable in precisely the state an operator opens it to fix. They join
  `modems.getAll` / `getSms` / `getUsbModeOptions` as non-entries in the
  mutation-entrypoint inventory: they take no lease and touch no radio.
- **A module absent from `IMPLEMENTED_MODEM_CAPABILITY_MODULES` is REFUSED**
  (`module_not_implemented`) before anything is written. Its gate key is read by
  nothing, so persisting it hands the operator a switch that can never act.
- **Writing a gate proves nothing.** It is one of four `resolveSupportClaim`
  inputs, so an enabled gate on an unprobed modem stops at `enabled`, on a
  positively-absent one stays `unavailable`, and `certified` is unreachable from
  here — band-lock's stricter certification floor included.
- **`broadcastModems()` runs after `saveConfig()`**, so the control the gate
  unblocks moves on the device's own next answer rather than on the reply.
- **A PROBE that changes evidence re-publishes too, change-gated.**
  `noteCapabilityEvidenceChanged` (`capability-gates.ts`) is called by
  `gps.ts`'s `recordCapability` and `band-capability.ts`'s refresh when the stored
  evidence actually MOVES. Without it a read that first proves a capability leaves
  the claim stale until the 30 s poll — the window an operator lands in right
  after enabling the gate. The notifier DEFAULTS TO INERT and is installed at
  module scope by `capability-evidence.ts` through a DYNAMIC `import()` of
  `modem-status.ts`: that module reaches this one via the wire producer, so a
  static edge back would cycle. Re-reading an already-proven modem is silent.

Coverage: `tests/modem-capability-settings.test.ts`. Operator surface and its
render rules: [`../../AGENTS.md`](../../../../AGENTS.md) → THE GATES HAVE AN OPERATOR
SURFACE.

### …AND THE IDENTITY IT GATES ON COMES FROM udev's NET RECORDS [EXISTS]

Every gated module resolves the modem to a `stable_key` FIRST — the USSD session,
the GNSS session and the lease that guards them are all filed under it. That
resolution was `defaultResolveIdentity` (`usb-mode-identity.ts`), which matched
`createUsbEnumerator().enumerate()` on `device.ifname`. **That field is declared
on `UsbDeviceSnapshot` and never populated**, for the reason
`modem-id-path-source.ts` already documents: the enumerator keeps only
`DEVTYPE=usb_device` records and such a record carries no `INTERFACE`.
Re-measured on `ceralive2` (2026-08-18): **24** `usb_device` records, **0** with
one, while **9** net records carry an `INTERFACE` AND an `ID_PATH`.

So this was the SECOND half of a defect that was only ever half-fixed. The wire
producer's `stable_key` map was repaired by reading udev's net records; this
resolver was not, so `stable_key` was correct on the wire while every capability
RPC answered `unknown_modem` **on the same board, in the same second**.
Board-measured before/after on the Quectel RM530N-GL:

| RPC | before | after |
|---|---|---|
| `modems.getUssd` | `unknown_modem` | `{session:{state:"idle"}}` |
| `modems.ussdInitiate` | `unknown_modem` | the carrier's real `*611#` menu |
| `modems.getGps` | `unknown_modem` | the modem's real GNSS capability set |
| `modems.getUsbModeOptions` | `identity_unresolved` | `active:"qmi"`, `uncertified` |

- **`resolveModemIdentityAnchor` (`mutation-identity.ts`) is the ONE resolver the
  capability modules use**, and it is a thin reuse of `modemStableKeyForId` —
  the same fixed source, not a third mechanism. It answers `{stableKey}` and
  nothing else, so a PCIe-attached or momentarily-unenumerable modem is not
  refused for lacking catalog discriminators it never needed.
- **`defaultResolveIdentity` still enumerates USB**, because the catalog
  discriminators (`vid:pid`, model, firmware revision, composition mode) exist
  nowhere else — but it now derives the key from the net records and MATCHES the
  USB snapshot against it. The snapshot's `physicalUid` is the parent
  `usb_device`'s `ID_PATH`, which reduces through the shared
  `deriveModemStableKey` to the SAME key the netdev's interface-level path does,
  so the two sources agree by construction rather than by coincidence.
- **`five-g-pref` was never affected** — `five-g-apply.ts` already resolved
  through `modemStableKeyForId`. That is what makes the split a fix rather than a
  new convention: one module had it right and the rest did not.
- **A capability MUTATION still needs its READ first.** The evidence cache is
  process-local, so on a fresh boot `ussdEvidence` answers `unknown` and the gate
  fails closed with `module_unavailable` until `modems.getUssd` has run once.
  Confirmed live. That is the framework's fail-closed rule working, not a
  regression — but it means an operator surface must probe before it offers.

Coverage: `tests/modem-capability-identity.test.ts`, whose fixtures are VERBATIM
`udevadm info --export-db` records from the board — the `usb_device` one carrying
no `INTERFACE` and its netdev carrying both. That shape is the point: the retired
code passed its suite because its fixtures were hand-built snapshots holding an
`ifname` udev does not put there. `setUsbUdevDatabaseReaderForTest` is the seam.

### THE 5G PREFERENCE IS A RANKING, AND ITS ECHO IS A READBACK [EXISTS — UNCERTIFIED]

`five-g-pref` is the module that ranks 5G against LTE. Its read half is
`modules/modems/five-g-preference.ts` (pure), its write half
`modules/modems/five-g-apply.ts`, and its wire block `modem.five_g_preference`.

**IT EXISTS BECAUSE THE NETWORK-TYPE SELECTOR CANNOT EXPRESS THE QUESTION.** That
selector's vocabulary is the ALLOWED SET, and `mmConvertNetworkTypes` keys its
catalog by allowed-set LABEL — keeping exactly one `preferred` per label and
discarding the rest. So "allow 4G and 5G, prefer 5G" and "allow 4G and 5G, prefer
4G" are ONE entry there, and the second is precisely what an operator on a
marginal 5G cell wants. `Modem.radio_modes` is the same `-K` payload UNFOLDED
(`deriveRadioModeCatalog`, derived beside `deriveNetworkTypes` from the one read,
so the two cannot disagree about what the modem said), and this module reads that
and never the folded map.

**`prefer-5g` and `prefer-4g` emit an IDENTICAL allowed set.** Two consequences
that are easy to lose: nothing may decide "no write is needed" by diffing allowed
sets, and the rollback compares BOTH fields — an allowed-only comparison would
report a `prefer-4g` restore as successful when the radio came back on
`prefer-5g`.

**THE ECHO IS A READBACK, NOT THE REQUEST.** This is the sibling defect to THE
RADIO MODE AN OPERATOR READS MUST BE A LIVE READ, and it is designed out rather
than guarded against: `mmSetNetworkTypes` answering `false`/`undefined` is a
typed `write_failed`, and a write mmcli DID confirm is then re-read and compared,
because MM accepting the call is not the radio taking the mode set. Four typed
failures, none collapsible: `write_failed` (mmcli did not confirm),
`readback_mismatch` (accepted, landed elsewhere — the operator's next action
differs), `readback_failed` (accepted, unreadable, so nothing may be claimed),
`not_offered` (the radio never advertised it, refused BEFORE any lease is taken).
`applied` is present only on success and carries the READ-BACK posture, so a UI
that locks its form to `applied` cannot show a rejected value as selected.

**Absence is honest at three levels.** A posture the radio cannot express resolves
`undefined` and is REFUSED, never substituted with a neighbour. A current pair no
posture names reads `null`, never the nearest one. And the wire block is OMITTED
entirely unless the claim is surfaceable — an empty `offered: []` would be
indistinguishable from a 5G modem that advertised no postures.

**SA/NSA is stated unsupported.** MM 1.24.2 exposes no standalone-vs-non-standalone
selector at all (its only NR member is `Modem3gpp.SetNr5gRegistrationSettings` —
`mico-mode` + `drx-cycle`), and the vendor AT commands that do are uncertified
per-SKU writes this build does not open. `nr_mode` therefore rides every block as
`{supported: false, reason: "not-exposed-by-modemmanager"}`: a missing field reads
as "nobody asked".

The rollback handler is registered at MODULE SCOPE (`usb-mode-rollback.ts`
precedent) and `capability-evidence.ts` installs the live probe reader the same
way — a boot step that must be remembered is one a refactor drops silently, and
here that would answer `unknown` for every probe and withhold every control with
no error anywhere.

**Status: `implemented-but-uncertified`** — the plan's own predicted outcome. No
5G SIM/plan and no verified 5G coverage exist at the bench (todo 2's BLOCKER B3),
so the readback/registration/data/fallback drill on the RM530N-GL has NOT run.
Code, gates and tests are complete; the certification step is hardware-blocked.

Coverage: `tests/modem-five-g-preference.test.ts` (33 tests — the model incl. both
`prefer-*` postures, the gate matrix reaching the wire, every failure arm asserting
BOTH a typed answer and `success: false`, lease/streaming/journal routing, and the
restoration matrix incl. the sibling-posture negative). Rule-E proof captured in
both directions: dropping the readback comparison reddens 2 tests, and comparing
only `allowed` on rollback reddens 1. Frontend half:
`apps/frontend/src/main/dialogs/modem-five-g.ts`.

