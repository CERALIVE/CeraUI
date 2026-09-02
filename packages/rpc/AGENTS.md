# @ceraui/rpc — Agent Knowledge Base

Parent: [`../../AGENTS.md`](../../AGENTS.md)

## OVERVIEW

Shared oRPC contract + Zod schema layer. The single source of truth for the WebSocket RPC surface between frontend and backend. Both consumers import from here — never define contracts inline.

## STRUCTURE

```
src/
├── contracts/     # oRPC oc.router() defs — auth, streaming, modems, wifi, network, system, status, notifications
│   └── index.ts   # appContract root router + AppContract type
├── schemas/       # Zod v4 schemas mirroring contracts/ + common.schema.ts, relay.schema.ts
└── capabilities/  # pure, browser-safe capability helpers (intersectCaps, device-mode-truth)
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add a new RPC procedure | `contracts/{domain}.contract.ts` → wire into `contracts/index.ts` |
| Add/change input or output shape | `schemas/{domain}.schema.ts` |
| Shared-client steering status/refusal + transient hard-down reset | `schemas/network.schema.ts` → `uplinkSteeringStatusSchema` / `uplinkFlowsResetEventSchema` |
| Name the DEVICE behind an uplink-health row without renaming the row | `schemas/network.schema.ts` → `uplinkHealthRecordSchema.displayName`; section below → AN UPLINK ROW CARRIES A NAME, NOT A SECOND IDENTITY |
| Streaming-first shaper mode/algorithm + priority degradation | `schemas/network.schema.ts` → `uplinkShaperStatusSchema` |
| Correlate a modem across a USB-mode transition | `schemas/modems.schema.ts` → `deriveModemStableKey()` / the `stable_key` field |
| A ModemManager reading that may be absent, WITHOUT losing why | `schemas/modems.schema.ts` → `modemMetricUnknownReasonSchema` + `modemNumberMetricSchema` / `modemFlagMetricSchema` / `modemTextMetricSchema`; section below → AN ABSENT READING STILL SAYS SOMETHING |
| Extended MM signal detail (rsrp/rsrq/snr/sinr) + measurement recency | `schemas/modems.schema.ts` → `modemSignalDetailSchema` (the `signal_detail` field) |
| Which network / which cell the radio registered on | `schemas/modems.schema.ts` → `modemRegistrationContextSchema` (the `registration_context` field) |
| WHICH FACT decided `sim_presence` | `schemas/modems.schema.ts` → `modemSimPresenceEvidenceSchema` (the `sim_presence_evidence` field) |
| The shared modem MUTATION-SAFETY wire vocabulary (journal states, refusals, ack modes, the three operator procedures) | `schemas/modems.schema.ts` → `modemMutation*Schema`; section below → THE MUTATION-SAFETY VOCABULARY IS SHARED |
| What a modem OPERATION did once it was admitted (completion/result/unknown-outcome + the 8 ModemManager refusals, and whether a retry could help) | `schemas/modems.schema.ts` → `modemOperation*Schema` / `modemManagerRefusalReasonSchema` / `MODEM_MANAGER_REFUSAL_RETRYABLE`; section below → AN OPERATION'S OWN WORDS SURVIVE THE BOUNDARY |
| Identify a bonded LINK across a SIGHUP reload (`link_id` / `port_label` / `serial` on a telemetry row) + the one normalized bind-map disposition (`bond_mapping`) | `schemas/status.schema.ts` → `linkTelemetryEntrySchema`, `bondMappingSchema`; `conn_id` is a FILE POSITION and must never be a row identity |
| Say that a link's device could NOT be identified (`identity_state: 'unmappable'`) | `schemas/status.schema.ts` → `bondLinkIdentityStateSchema` on `linkTelemetryEntrySchema`; section below → AN UNIDENTIFIABLE LINK SAYS SO |
| Whether a capability module may be offered, mutated, or claimed | `schemas/capability-modules.schema.ts` + `capabilities/capability-matrix.ts` → `resolveSupportClaim` / `resolveCapabilityMatrix` / `mayRenderModule` / `mayClaimSupport`; section below → THE CAPABILITY FEATURE-GATE FRAMEWORK LIVES HERE, ONCE |
| Read-only SMS inbox shapes (`modems.getSms`) | `schemas/modems.schema.ts` → `smsMessageSchema` / `modemSmsOutputSchema` / `SMS_INBOX_CAP`; section below → THE SMS INBOX SCHEMAS ARE READ-ONLY BY DESIGN |
| Bluetooth wire surface (device/adapter rows, the shared mutation refusals, the BT capability claims) | `schemas/bluetooth.schema.ts` + `contracts/bluetooth.contract.ts`; section below → THE BLUETOOTH DOMAIN REUSES THE LADDER WITHOUT JOINING THE REGISTRY |
| The engine audio-backend enum + the capability block a selector may offer from | `schemas/streaming.schema.ts` → `audioBackendSchema` / `streamingConfigInputSchema.audio_backend` / `capabilitiesMessageSchema.audio_backends`; ABSENT is never a default — see [`../../apps/backend/AGENTS.md`](../../apps/backend/AGENTS.md) → THE AUDIO BACKEND IS AN OVERRIDE |
| Effective caps for a platform/source/mode | `capabilities/intersect-caps.ts` → `intersectCaps()` (pure) |
| Whether a device can DELIVER a resolution/framerate pairing | `capabilities/device-mode-truth.ts` → `evaluateDeviceMode()` / `nearestDeliverableMode()` (pure) |
| Root router type (client inference) | `contracts/index.ts` → `AppContract` |
| The engine's declared `change-config` worst-case bound (DERIVED, never a literal) | `schemas/config-change.schema.ts` → `CHANGE_CONFIG_WORST_CASE_BOUND_MS` |
| New domain (e.g. `audio`) | New `audio.contract.ts` + `audio.schema.ts`, add to `appContract` router |

## IMPORT PATHS

```typescript
import { appContract, type AppContract } from '@ceraui/rpc';           // root router
import { streamingContract } from '@ceraui/rpc/contracts';             // granular
import { loginInputSchema } from '@ceraui/rpc/schemas';                // validation
```

## UPLINK STEERING WIRE STATE IS SHARED [EXISTS]

`schemas/network.schema.ts` owns both steering channels. The persistent
`uplinkSteeringStatusSchema` is a discriminated union: `available`, or
`steering_unavailable` with one of the six machine-stable reasons and an optional
diagnostic detail. The transient `uplinkFlowsResetEventSchema` is exactly
`{iface, linkId}` — physical identity, never a route-table position or mark.

The backend parses both shapes before broadcast. Only `uplink-steering` is sent in
the post-login snapshot; `uplink-flows-reset` describes a hard-down action that
already happened and must never be replayed to a later session. Do not duplicate
either type under `apps/` or widen the reset event into persisted state.

## AN UPLINK ROW CARRIES A NAME, NOT A SECOND IDENTITY [EXISTS]

`uplinkHealthRecordSchema.displayName` is additive-optional DISPLAY metadata —
the device's own operator-facing name (`Huawei E3372`, `Quectel RM530N-GL`, an
hwdb/vendor label), resolved by the device from the SAME USB-descriptor markers
the `netif` projection stamps.

Three shape decisions carry weight:

- **`iface` remains the row's identity, and nothing may key or join on the
  name.** Two units of one SKU legitimately publish the SAME name — the bench
  HiLink twins do — so a name-keyed consumer collapses two links into one. That
  is `conn_id`'s lesson (`status.schema.ts`) restated for a different field.
- **Absent is the honest common case, so it must cost nothing.** A PCIe modem, a
  plain wired port and a backend that predates the field all carry no name, and
  the consumer then renders the raw `iface` byte-identically to before. A
  placeholder or an id-shaped stand-in would be the fabrication the rest of this
  wire refuses everywhere else.
- **`.min(1)` is what keeps `""` from becoming a third state.** An empty name is
  neither a name nor an absence, and a consumer would render it as a blank line
  where a device should be.

Device contract: [`apps/backend/AGENTS.md`](../../apps/backend/AGENTS.md) →
…AND AN UPLINK'S KIND COMES FROM THE DEVICE, NOT FROM ITS NAME.

`uplinkShaperStatusSchema` is the sibling persistent state. Available states name
the lifecycle mode and realized algorithm (`cake` or `htb-fq_codel`). Unavailable
states carry one typed ownership/apply reason and the literal
`priorityDegraded: true`, making it impossible for a consumer to render an
unshaped shared uplink as protected. It does not alter steering availability.

## DEVICE-TOKEN CLAIM CONTRACT (canonical, single source)

`src/schemas/pairing.schema.ts` → `deviceTokenClaimsSchema` (Zod) + `DeviceTokenClaims` (inferred type) is the **single source of truth** for the PASETO v4.public device-token payload (ADR-0006). Both consumers reference these exact field names — no divergent duplicate definition:

- Device: `apps/backend/src/modules/pairing/device-token.ts` (mint/verify stub) imports the schema.
- Platform: `ceralive-platform/apps/api/lib/claim.ts` references it by name in `issueDeviceToken`'s TODO (cross-repo, not a build dep).

Canonical claims (field names fixed by the ADR-0006 claim table — snake_case `device_id`, `sub_status`, **not** `deviceId`/`sub`):

| Claim | Type | Required | Source |
|-------|------|----------|--------|
| `device_id` | string | yes | device serial → `DeviceConnection.serialNumber` |
| `sub_status` | `SUBSCRIPTION_STATUSES` enum | yes | platform `Billing.status` at issuance |
| `iat` | int (epoch s) | yes | platform clock — issued-at |
| `exp` | int (epoch s) | yes | platform clock — expiry; channel rejects expired |
| `tenantId` | string | no | platform-issued binding (absent on device stub) |
| `serial` | string | no | platform-issued binding (absent on device stub) |

`tenantId`/`serial` are optional because the device-side stub mints a token before tenant binding; the platform-issued (real) token carries all six. When changing this contract, update the ADR-0006 claim table, both consumers above, and this section in the same change (Rule A).

## THE EXACT-CAPABILITY RULE LIVES HERE, ONCE

`capabilities/device-mode-truth.ts` is cerastream ADR-0008 §10 in code: a device's
per-`media_type` mode ladder is the ONLY truth, and a consumer "may filter and it
may display, but it may not construct a mode the engine did not report, and it may
not merge two media types' ladders into one list."

That clause names TWO consumers, which is why the rule lives in this package rather
than in either of them:

- the frontend `ValidationAdapter` decides what the operator is OFFERED;
- the backend `streaming.setConfig` decides what may be PERSISTED.

They must agree BY CONSTRUCTION. An offering the save path would reject is a lie
told to the operator; a save the offering would have disabled is a bypass of the
rule. Two implementations of one rule drift — the frontend #244 defect (unioned
ladders offering a pairing the device could not deliver, failing `not-negotiated`
at the leg) was exactly that class, one layer up. Do NOT fork a per-consumer copy.

`evaluateDeviceMode` answers the SAVE-TIME verdict; `nearestDeliverableMode` answers
the LOAD-TIME clamp target. Both fail OPEN on an unknown — an absent ladder, an
un-normalizable rung, or a kind naming no advertised format never subtracts,
because refusing on an unknown blocks a save the hardware can honour.

## THE CHANGE-CONFIG BOUND IS MIRRORED HERE, WITH ITS DERIVATION

`schemas/config-change.schema.ts` carries cerastream's declared worst-case
`change-config` transaction bound (65 000 ms). The published
`@ceralive/cerastream` bindings deliberately do NOT ship this constant — it lives
in the engine's `bin` crate, not `cerastream-ipc` — so CeraUI has to carry it.

It is reproduced as the DERIVATION (`3 × teardown + 2 × start`, per
`cerastream/docs/adr/schema.md` §11), not as a literal, and
`config-change.schema.test.ts` asserts the total. Shrinking an engine phase
budget therefore reddens a test rather than silently invalidating the number the
device sizes its timeout from. The test also pins that it is NOT 60 000 — the
intuitive `attempt × 2` reading, which a healthy transaction can legitimately
exceed.

It lives in this package, like the device-mode-truth rule, because BOTH consumers
must agree by construction: the backend orchestrator sizes its `reconfiguring`
deadline from it and the frontend renders `applying` progress against it.

The same file also carries the config-change REASON tokens. `change_rejected`
(`CONFIG_CHANGE_REASON_REJECTED`) is the one CeraUI raises when the engine
refuses the parameters: the engine returns a JSON-RPC error ONLY when the
transaction never began, so that outcome is `reverted` (nothing was torn down)
and must never be reported as `rollback_failed`. It is a wire-stable token, keyed
to operator copy on the frontend — never rendered raw.

## A MODEM IS CORRELATED BY `stable_key`, AND BY NOTHING ELSE [EXISTS]

`schemas/modems.schema.ts` carries the Phase-B additive-optional modem delta. Ten
of the eleven new fields are ordinary read-only observations (`device_class`,
`availability_reason`, `slot_label`, `recovery_state`, `usb_mode`,
`recommended_usb_mode`, `data_usage`, `firmware_revision`, `esim`, `cell_info`).
The eleventh, `stable_key`, is a contract in its own right.

**Every other identifier a modem carries is unstable across the one moment a
consumer most needs to follow it.** A USB-composition switch re-enumerates the
device, so the legacy numeric id — a ModemManager index — is re-issued; the switch
also moves the device BETWEEN adapter classes (router-ethernet ↔ mm-managed), so
any per-adapter derivation changes at exactly that instant; and the ifname is no
better, because the bench holds two physically distinct HiLink units shipping ONE
factory MAC, which makes their predictable names race. `stable_key` is the only
identifier a consumer may use to say "this is the same device as before".

**`deriveModemStableKey(idPath)` is ONE rule for every adapter**, and that is the
point rather than a tidiness preference — three adapters (mmcli, D-Bus, router)
observe the same physical device, and a device that crosses between them mid-
transition must keep its key. The rule reduces a udev `ID_PATH` to the `usb_device`
PARENT path every interface of one physical unit shares. The fallbacks are STATED,
not invented: no usb parent (a PCIe FM350) ⇒ the device's own `ID_PATH` verbatim;
no `ID_PATH` at all ⇒ `undefined`, and the optional field is OMITTED rather than
faked. It lives beside the field it produces so the two cannot drift, and it is
emitted verbatim (no prefix, no hash) so no adapter can disagree about a
formatting step — the key is opaque BY CONTRACT (equality only), not by encoding.

**…and "one rule" now covers the INPUT, not only the reduction.** The adapters do
not all observe an `ID_PATH`: ModemManager publishes `Modem.Physdev` as a raw
sysfs DEVPATH. Board-measured on `ceralive2` (todo 24, 2026-08-18), ONE socket was
keyed two ways at the same instant — `platform-xhci-hcd.0.auto-usb-0:1.4.1` from
the udev-sourced rows, `/sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.4/1-1.4.1`
from the ModemManager row — so the authoritative row could never retire the
optimistic udev row for its own device and the wire carried two rows for one stick
on 10 of 10 power cycles. `sysfsDevpathToIdPath` closes it AT THE DERIVATION:
`deriveModemStableKey` normalizes its input first, so both encodings MINT the same
key rather than being fuzzy-matched at compare time. It is a transformation, not a
heuristic — udev's own `path_id` USB rule (nearest `usb_device` component →
`usb-0:<port-chain>`, its controller → `platform-…`/`pci-…`) — and a path it
cannot confidently convert is returned UNCHANGED, which is the pre-existing
behaviour. `canonicalModemIdPath` is the same conversion exported for an adapter
that STORES an observed path rather than only keying on it (the D-Bus fold does).

**The provisioning gate is echoed READ-ONLY, as a TRISTATE.**
`configMessageSchema.modem_provisioning` (`schemas/streaming.schema.ts`) is a
one-way projection of the backend runtime key `modems.setUsbMode` gates on. It is
deliberately NOT on `streamingConfigInputSchema` — there is no UI write path, and
adding one is a separate decision. `false` means the device SAID provisioning is
off (the switch pre-renders disabled-with-reason), `true` means it is on, and
ABSENT means a backend that does not publish the key at all, which must keep the
control OFFERED so the device's own typed `provisioning_disabled` refusal is what
withdraws it. Collapsing absent into `false` hides a working control on every
older device. `streaming.getConfig` echoes it too — the pull and the broadcast
must not disagree.

**`own_numbers` is an ARRAY that cannot be empty, and that is the contract.**
The SIM's own number (MSISDN) is `z.array(z.string().min(1)).min(1).optional()`,
so the schema can express "these numbers" and "not reported" — and deliberately
NOT "an empty list", which a consumer would render as a finding rather than as
silence. Most SIMs carry no MSISDN at all, so absence is the common case. It
stays an ARRAY because MM's `Modem.OwnNumbers` is `as` and a dual-number SIM is
expressible; collapsing to a first element would silently drop the tail. It is
SENSITIVE — the device redacts it from every log (`helpers/logger.ts`
`isOwnNumberSensitiveKey`) even though the UI displays it behind an explicit
reveal; nothing about it being rendered makes it loggable.

**`sim_presence` is `no_sim`'s INPUT, not its replacement.** `no_sim` answers a
BOND question — a link either may join the pool or may not — so the device folds
`absent` and `unknown` onto one `true` (`claimsNoSim` is `presence !== "present"`).
Right for bonding, lossy for reporting: an unreadable slot became indistinguishable
from an empty one. `simPresenceSchema` publishes the pre-fold reading beside the
claim so a consumer can tell them apart. Three rules: the two fields TRAVEL
TOGETHER (a device emitting one emits the other, or neither when its slot is
opaque); `absent` is reachable only from a device-stated fact, so everything not
`present` is `unknown`; and the bond gate still reads `no_sim` alone, which is
what keeps this additive — `isSimlessForBond` is unchanged, and routing it through
`sim_presence` would change which links bond.

**A network scan is an attempt, not a changed list.** `modem.network_scan`
carries a monotonic `generation` and `scanning | completed | failed` phase, with
the typed terminal failure where applicable. `modems.scan` returns the admitted
`scanGeneration`; completion arrives later on the modem broadcast. This is what
lets a consumer confirm a successful scan whose operator list is byte-identical,
and fence a late older result across the independent `status` and `modems`
sequence domains. Absence remains legacy-compatible.

**`modems.configure` deliberately carries NO usage-policy write.**
`modemDataUsageSchema` REPORTS `cycle_day` / `threshold_bytes`; the matching input
fields are absent because `@ceralive/modem-control@0.2.0` publishes no
usage-policy setter to map them onto. Declaring inert input fields would let the
device accept and echo a policy it silently drops, and a UI built on that would
show the operator's setting reverting with no explanation. Adding them once the
package ships the setter is purely additive. Do NOT add them before it does.

**`setUsbModeInputSchema` is `.strict()` with `confirm: z.literal(true)`, and both
halves are load-bearing.** The mutation re-enumerates a modem and drops its bond
link, so an unknown extra key must be REJECTED rather than ignored and an omitted
or falsy `confirm` must never reach the handler. The SIX refusals
(`provisioning_disabled` / `streaming_active` / `unavailable_in_emulated_mode` /
`uncertified` / `transition_in_progress` / `transition_failed`) each name a
different thing the operator can do about it and are never collapsed into a generic
error. `transition_in_progress` is distinct from `streaming_active` because the
lifecycle interlock has TWO holders: an admission answers "stop the stream", another
transition answers "wait".

**`transition_failed` additionally carries a typed `reason`**
(`setUsbModeFailureReasonSchema`: `identity_unresolved` / `engine_unavailable` /
`preconditions_refused` / `postcondition_mismatch` / `transaction_error`). `error`
names what the operator asked for and did not get; `reason` names WHY, and the last
two are deliberately not collapsed — "the device came back as something else" and
"the transaction blew up" call for different actions. It is additive-optional and
present ONLY alongside `transition_failed`.

Coverage: `schemas/modems.schema.test.ts` — the legacy-payload byte-compat fixture
(a pre-Phase-B entry parses to a byte-identical payload and gains no defaulted
field), the `stable_key` derivation table incl. the same-unit/different-port/
non-USB/absent arms, and the strict-input negatives.

## AN ABSENT READING STILL SAYS SOMETHING [EXISTS]

`@ceralive/modem-control@1.3.0` normalizes every ModemManager reading as a
`NormalizedMetric<T>` — a value, or an `unknown` carrying one of SEVEN reasons.
`modemMetricUnknownReasonSchema` plus the three value-typed unions
(`modemNumberMetricSchema` / `modemFlagMetricSchema` / `modemTextMetricSchema`)
are the wire form of that, and they exist so the REASON survives the trip.

**A bare `null` would destroy the only information worth carrying.**
`unsupported` is a durable claim about the SOURCE, `not-reported` is about ONE
reading, and `not-observed` is about US — three different operator actions (hide
the control / wait for the next sample / prime the read) that a single `null`
renders identical. This is the same distinction `routerSignalMetricSchema`
already draws for the dongle dialects.

**It is NOT `routerSignalMetricSchema` re-used, and that is deliberate.** Its
five reasons are the router-admin dialects' own vocabulary and carry no
`not-observed` or `refused`; a ModemManager reading genuinely reaches both,
because the extended `Modem.Signal` dicts stay empty until `Signal.Setup` primes
them. Widening the router union instead would tell a dongle consumer that two
reasons its dialects cannot produce are now possible.

Three blocks consume it, all additive-optional on `modemSchema`:

| Field | Carries |
|---|---|
| `signal_detail` | `quality_recent` + `rsrp` / `rsrq` / `snr` / `sinr` |
| `registration_context` | `operator_name` / `operator_code` / `cell_id` / `tac` |
| `sim_presence_evidence` | WHICH FACT decided `sim_presence` |

Four shape decisions carry weight:

- **Inside a present block every metric is REQUIRED.** The modem merge preserves
  an omitted optional field, so a metric published only when known could be
  raised and never lowered (the `policy_route_missing` latch, exactly). The
  BLOCK is optional because only a backend that reads the interface can answer
  at all — the mmcli path omits all three rather than publishing metrics it
  never looked for.
- **`sinr` is `not-reported` on an LTE/NR modem, never `unsupported`.**
  ModemManager 1.24.2's own introspection gives `sinr` to `Signal.Evdo` and to
  no other dict, while `Lte`/`Nr5g` publish `snr` — a different quantity. So
  ModemManager CAN express SINR, and a capability claim it disproves would be
  the invented reading this layer exists to prevent.
- **`operator_name` is deliberately DUPLICATED with `status.network`.** `status`
  is byte-locked against the pre-Phase-B builder and OMITS the field when the
  modem reported none, which destroys "not registered yet" vs "never looked".
  The metric keeps the reason; `status.network` keeps the legacy shape.
- **There is no EARFCN, and there cannot be one from these sources.** MM
  publishes no generic ARFCN on `Modem` / `Modem3gpp` / `Location`; the only one
  is per-cell, under two DIFFERENT keys for two DIFFERENT quantities (`earfcn`
  LTE, `nrarfcn` 5GNR). One slot would have to merge them or pick a RAT.

`modemSimPresenceEvidenceSchema` is a `kind` union whose whole purpose is
auditability: `absent` is reachable through exactly ONE member
(`state-failed-reason`), which turns "never inferred from a blank field" into a
property a consumer can VERIFY. `no-evidence` names the fields that were
inspected. Its `value` fields carry D-Bus object paths and MM's own
failed-reason token — never a subscriber identifier, and they must never be
widened to carry one.

Device contract: [`apps/backend/AGENTS.md`](../../apps/backend/AGENTS.md) →
THE EXTENDED SIGNAL READING IS A METRIC, NOT A NUMBER.

## AN UNIDENTIFIABLE LINK SAYS SO, RATHER THAN BEING RENAMED

`bondLinkIdentityStateSchema` (`resolved | unmappable`) is the wire vocabulary
for "could the writer resolve which PHYSICAL device this bonded link is". It
lives here rather than in the backend for the usual reason: the backend produces
it and the operator surface renders it, and a second spelling of "unknown" is how
a device that cannot be identified comes to look like one that simply has no
telemetry yet.

Two shape decisions carry weight:

- **`identity_state` is emitted ONLY as `'unmappable'`.** `resolved` is proven by
  the `link_id` beside it, and a legacy-`conn_id`-rung row makes no claim in
  either direction — so absence means "nothing is being asserted here", never
  "identified". Emitting `resolved` on every row would put a second, redundant
  source of truth next to `link_id` for them to disagree on.
- **It is a SIBLING of `link_id`, never a value of it.** The retired backend
  fallback minted `lnk_<ifname>` for exactly this case: an id-shaped string keyed
  on an interface name, which two same-model dongles swap on a replug. A state is
  the honest answer; a plausible id is not.

## THE MUTATION-SAFETY VOCABULARY IS SHARED, NOT PER-PROCEDURE

Every path that mutates a modem answers the SAME refusal set
(`modemMutationRefusalSchema`), because the seven members each name a different
operator action and collapsing any of them into a per-procedure generic error is
what makes a blocked device indistinguishable from a broken one.

Three shape decisions carry weight:

- **`setUsbModeRefusalSchema` GAINED the four states rather than flattening them.**
  A USB-mode switch is a mutation like any other, so `recovery_pending` /
  `mutation_blocked` / `device_decommissioned` / `rebaseline_required` are
  first-class refusals there; `identity_unresolved` and `mutation_in_progress`
  map onto that procedure's own older vocabulary
  (`transition_failed{identity_unresolved}` / `transition_in_progress`), which a
  test pins.
- **`mutationRefusal` is ADDITIVE-OPTIONAL on the SIM / scan / router outputs.**
  Those carry terminal `state`/`error` enums a frontend already renders, so the
  refusal rides beside `state: 'error'` — a consumer that does not know the field
  still renders the legacy terminal, one that does can say why nothing was
  submitted. `modemConfigRefusalSchema`, which already had a refusal slot, gained
  the members outright.
- **`modemMutationAckInputSchema` is `.strict()` with `confirm: z.literal(true)`,
  and the `mode` is REQUIRED.** That is the wire-level half of "a bare
  alert-dismiss never unblocks a failed mutation": a mode-less acknowledgement
  cannot even be expressed, so the rule cannot be bypassed by a client that
  simply omits it.

`MODEM_MUTATION_JOURNAL_VERSION` is exact-matched, never upgraded in place: a
mutation record the device cannot read is precisely the case fail-closed exists
for. Device-side contract: [`apps/backend/AGENTS.md`](../../apps/backend/AGENTS.md)
→ THE MODEM MUTATION-SAFETY CONTRACT.

## AN OPERATION'S OWN WORDS SURVIVE THE BOUNDARY [EXISTS]

`@ceralive/modem-control` classifies a modem operation in three frozen
vocabularies, and CeraUI threw all three away at the RPC boundary. The four enums
in `schemas/modems.schema.ts` — 5 completion statuses + 4 result statuses + 3
unknown-outcome reasons + 8 ModemManager refusal reasons, **20 values** — are the
wire form of them, and `modemOperationOutcomeSchema` is the shape they ride in.

**They are DISTINCT from `modemMutationRefusalSchema`, and that is the point.**
That set answers "may this device be mutated at all" (a lease is held, a journal
entry blocks it, a stream is live). These answer "what did the operation do once
it WAS admitted". Folding them together would oblige every mutating surface to
declare refusals it cannot produce — the same argument that keeps
`capabilityMutationRefusalSchema` a superset rather than new members.

Four shape decisions carry weight:

- **The COMPLETION status rides beside the RESULT status, not instead of it.**
  `timed-out` classifies as `unknown-outcome` on a WRITE and as plain `failed` on
  a READ, so a single field cannot hold both facts — a consumer would be unable
  to tell an unanswered write from a stale generation.
- **`unknown-outcome` is neither a success nor a failure**, carries a TYPED
  reason (not a free string) and is the only arm carrying
  `requires_reconciliation: true`. The mutation may have landed, so it belongs on
  the existing mutation-block/reconciliation surface — rendering it as either
  outcome is a lie in one direction or the other.
- **`retryable` rides EVERY arm explicitly.** Absent-means-false is the
  `policy_route_missing` latch in miniature: a merging consumer could raise a
  retry hint and never lower it. `MODEM_MANAGER_REFUSAL_RETRYABLE` is a TOTAL
  record so a ninth refusal fails `tsc` rather than defaulting to "do not retry",
  which would tell an operator to give up on a transient condition.
- **`refusal` is present ONLY when the reason really came from
  `mapModemManagerError`.** A CeraUI-authored refusal string is a real reason
  too, so `reason` stays a free string there; minting the package's `failed`
  fallback arm for a CeraUI-side decision would put a daemon verdict on screen
  for something the daemon never said.

Every value is a MIRROR of the package's own frozen list, re-read from
`control/src/domain/operation.ts` and
`control/src/providers/modem-manager/errors.ts` — never invented. A reason the
package cannot emit is a state no device reaches, and operator copy written for
one is dead copy. Device contract:
[`apps/backend/AGENTS.md`](../../apps/backend/AGENTS.md) → A GENERIC FAILURE IS
NOT AN ANSWER.

## THE SMS INBOX SCHEMAS ARE READ-ONLY BY DESIGN

`smsMessageSchema` / `modemSmsInputSchema` / `modemSmsOutputSchema` back
`modems.getSms`, and there is deliberately no compose, send, or delete counterpart
— not "not yet", but permanently. The backend enforces this with a grep gate that
also scans THIS package's modem schema and contract, so adding a write schema here
turns that suite red.

Three shape decisions carry weight:

- **`state` uses `.catch('unknown')`**, like `connectionStatusSchema`. This is
  OUTPUT-validated, so one unrecognised `MMSmsState` token from a future
  ModemManager would otherwise reject the entire inbox rather than one field.
- **`from` is a free string, and optional.** A real board's inbox is mostly
  shortcodes and alphanumeric sender IDs (`CLARO`, `85573`), so a phone-number
  type would reject legitimate traffic; mmcli prints `--` when there is no
  originator at all. `timestamp` is likewise optional and passed VERBATIM —
  re-zoning a timestamp the carrier stamped is a lie about when it was sent.
  `text` is required but MAY be empty: a data-only WAP/PDU message has no text.
- **A refusal must never be an empty array.** `{success: true, messages: []}`
  means "this modem has an inbox and it is empty". `unsupported` / `not_enabled`
  / `unknown_modem` / `read_failed` are four distinct operator facts and are
  reported as such. `messages` is capped by the schema at `SMS_INBOX_CAP` (50),
  so an over-long inbox fails validation instead of reaching a consumer.

Coverage: the `read-only SMS inbox schemas` block in `schemas/modems.schema.test.ts`.

## THE CAPABILITY FEATURE-GATE FRAMEWORK LIVES HERE, ONCE

`schemas/capability-modules.schema.ts` + `capabilities/capability-matrix.ts` carry
the seven gated capability modules (band-lock / SMS / 5G-pref / FCC-auto-unlock /
GPS / USSD / eSIM), the FIVE-STATE support-claim taxonomy, and the resolver that
turns a config gate plus a per-modem probe into a claim.

It lives here, like the device-mode-truth rule, because THREE consumers must agree
by construction: the backend decides what may be MUTATED, the frontend decides what
is SURFACED, and the support matrix decides what may be CLAIMED. Three copies drift,
and every way they drift is a lie — an offered control the device refuses, a hidden
control the hardware supports, or a documented capability nobody proved.

**The ladder, and why five states rather than a boolean.** `resolveSupportClaim`
answers with the HIGHEST rung reached:

| State | Meaning |
|---|---|
| `unavailable` | not shipped in this build, OR the modem POSITIVELY lacks it |
| `implemented` | shipped, gate OFF — the DEFAULT for all seven, on every device |
| `enabled` | gate ON, capability UNKNOWN. "Not asked" is not "absent" |
| `capable` | gate ON + the modem advertises it — the floor for OFFERING a control |
| `certified` | capable + reviewed evidence for this model+firmware — the ONLY rung a doc may claim |

`mayRenderModule` is `capable | certified`; `mayClaimSupport` is `certified` alone.
Certification governs what may be CLAIMED, not what may be USED — hiding an
uncertified-but-capable control would put working hardware behind a paperwork gate.

Three shape decisions carry weight:

- **`capabilityModuleClaimsSchema` is TOTAL.** Every module is on every row, always
  — never present-only-when-supported. The modem merge preserves an omitted
  optional field, so a claim published only when true can be raised and never
  lowered (the `policy_route_missing` latch, exactly). A `z.record` over the module
  enum enforces it at the schema.
- **The gate refusals are a SUPERSET, not new members of the shared enum.**
  `capabilityMutationRefusalSchema` = every `modemMutationRefusalSchema` member plus
  `module_disabled` / `module_unavailable`. Folding them in would oblige every
  pre-existing mutating surface (a USB-mode switch, an APN write) to declare
  refusals it can never produce — the typecheck rejects exactly that.
- **SMS contributes no mutation kind.** `MUTATING_CAPABILITY_MODULES` omits it, so a
  read-only surface cannot be routed through the journaled mutation helper at all —
  CeraUI's permanent read-only SMS policy made structural rather than conventional.

`IMPLEMENTED_CAPABILITY_MODULES` is the framework's own default registry, and each
module adds itself with its own probe and evidence. A module absent from the list
the DEVICE passes (`IMPLEMENTED_MODEM_CAPABILITY_MODULES`, the backend's explicit
argument) resolves `unavailable` on every modem, which is what stops a config gate
from surfacing a control with nothing behind it.

**The gates have a WRITE, and it cannot fabricate a claim.**
`modemCapabilitiesOutputSchema` / `setModemCapabilityInputSchema` /
`setModemCapabilityOutputSchema` back `modems.getCapabilities` /
`setCapabilities` — the operator surface behind Settings → Cellular Features.
Three shape decisions carry weight:

- **`gates` is a TOTAL record** (`capabilityGateStatesSchema`), never the sparse
  persisted object. The stored shape is default-absent, so an omitted key and a
  `false` are the same thing on disk but indistinguishable from a LOWERED key on
  any consumer that merges — the `policy_route_missing` latch, again.
- **`implemented` rides the answer**, because a modem row resolves "this build
  does not ship it" and "this hardware positively lacks it" both to `unavailable`,
  and the two call for opposite renderings. It is also the only answer available
  on a device with no modem attached.
- **The input is ONE module and `.strict()`.** A whole-object write races itself
  when two toggles are in flight, and an unknown extra key on a gate that arms
  radio-mutating controls must be rejected rather than ignored.

The write is a PRECONDITION, never a claim: it feeds `resolveSupportClaim` as one
of four inputs, so it cannot promote a module past `enabled` on an unprobed modem
and cannot reach `certified` at all. Device contract:
[`apps/backend/AGENTS.md`](../../apps/backend/AGENTS.md) → THE CAPABILITY
FEATURE-GATE FRAMEWORK; operator surface: [`../../AGENTS.md`](../../AGENTS.md) →
THE GATES HAVE AN OPERATOR SURFACE.

## THE BLUETOOTH DOMAIN REUSES THE LADDER WITHOUT JOINING THE REGISTRY [EXISTS]

`schemas/bluetooth.schema.ts` + `contracts/bluetooth.contract.ts` are the wire
half of the BlueZ foundation (`apps/backend/src/modules/bluetooth/`). Ten
procedures: `getStatus` plus `enable` / `disable` / `scanStart` / `scanStop` /
`pair` / `trust` / `forget` / `connect` / `disconnect`.

**`bluetooth` is deliberately NOT a `CAPABILITY_MODULE`, and it uses the
five-state ladder anyway.** `CAPABILITY_MODULES` is a CLOSED, modem-only,
default-OFF-forever enum whose gates live under `config.modem_capabilities` with
no `RUNTIME_CONFIG_DEFAULTS` entry — registering Bluetooth there would make the
whole surface invisible by design, and an operator would have to enable a
*cellular* feature gate to see a headset. What IS reused is
`supportClaimStateSchema` and `resolveSupportClaim`, because the question is the
same one: shipped, switched on, proven on THIS hardware, certified.
`bluetoothCapabilityClaimsSchema` is a SEPARATE registry
(`adapter` / `pairing` / `audio-input` / `battery`) and is TOTAL for the same
reason `capabilityModuleClaimsSchema` is — a claim published only when true can
be raised and never lowered on a consumer that merges. The GATE is the operator's
persisted Bluetooth preference, so "Bluetooth off" resolves `implemented`.

Four shape decisions carry weight:

- **`paired` / `trusted` / `connected` / `blocked` are REQUIRED.** They are
  RECOVERABLE facts, and a present-only-when-true flag is the
  `policy_route_missing` latch: a device that disconnects could never say so.
  `battery` and `rssi` are the opposite case and stay optional — absent means the
  device exposes no battery service / is not advertising, which a `0` would lie
  about.
- **The mutation refusals are ONE shared enum** (`bluetoothMutationRefusalSchema`,
  the `modemMutationRefusalSchema` lesson). Thirteen members, none collapsible:
  `adapter_busy` (wait) is not `pairing_failed` (retry) is not
  `service_start_failed` (the switch did not take) is not `bluetooth_disabled`
  (turn it on), and `bluez_unavailable` / `bus_unreachable` / `no_adapter` send
  someone to three different places.
- **`pairing_agent_unavailable` names a gap this build really has.** The shared
  `DbusTransport` is a CLIENT — no object export, no name ownership — so there is
  no `org.bluez.Agent1` for BlueZ to call back into, and the stack registers
  NOTHING rather than naming a dead path (which would make BlueZ block on every
  callback). The same fact rides `getStatus().agent.reason` as
  `exporter_unavailable`, so it is stated BEFORE an operator taps as well as when
  a pairing is refused. Do not paper over either half.
- **`transport` is positive-evidence-only.** `bredr` is claimed from a
  BR/EDR-only SIG profile the device actually advertises; nothing on a registry
  row proves LE, so `le`/`dual` exist for a future read that can prove them and a
  device that proves nothing reads `unknown`.

Every mutation input is `.strict()`: an unknown extra key on a surface that
powers a radio, opens a pairing window or removes a trusted device must be
REJECTED, never ignored. Coverage: `schemas/bluetooth.schema.test.ts` (the
required-boolean negatives, one strict-input negative per procedure shape, the
exact refusal enum, the claim totality, and the contract↔schema file-name
convention). Device contract: [`apps/backend/AGENTS.md`](../../apps/backend/AGENTS.md)
→ THE BLUETOOTH DOMAIN IS WIRED.

## CONVENTIONS

## ADD-ON `versionId` TRANSITION CONTRACT [EXISTS]

`AddonDescriptorSchema.versionId` accepts the numeric OS identities `'12'`
(Debian bookworm) and `'13'` (Debian trixie) during the platform transition.
This is compatibility for mixed fleets, not a claim that every device runs
trixie: the add-on reconciler still compares the descriptor's materialized OS
identity with the live `/etc/os-release` `VERSION_ID` before reuse. Keep both
values accepted until the bookworm fleet is retired; do not narrow the schema
back to a bookworm-only literal or treat acceptance of `'13'` as an image-suite
migration by itself.

- Contracts use `@orpc/contract` (`oc.*`). No runtime logic here — contracts are pure type/schema declarations.
- Schemas use Zod v4 (`zod@^4`). Import from `zod`, not `zod/v4`.
- One contract file per domain. One schema file per domain. Names must match (`streaming.contract.ts` ↔ `streaming.schema.ts`).
- `appContract` in `contracts/index.ts` is the only router — don't create sub-routers elsewhere.

## ANTI-PATTERNS

- Don't import `@ceraui/rpc` from within this package itself — circular.
- Don't add runtime handlers here. Handlers live in `apps/backend/src/`.
- Don't duplicate schema definitions in `apps/` — always import from this package.
- Don't use Zod v3 APIs (`z.string().nonempty()` etc.) — project is on Zod v4.
- Don't publish a ModemManager reading as a bare `null` or an omitted key when it is absent — `unsupported` / `not-reported` / `not-observed` lead to three different operator actions, and a `null` renders them identical. Use the metric unions, and don't make a metric optional INSIDE a present block: the merge preserves an omitted field, so a known-only metric can be raised and never lowered.
- Don't widen `routerSignalMetricSchema` to carry `not-observed`/`refused` instead of adding the modem unions — those five reasons are the dongle dialects' own vocabulary, and widening tells a dongle consumer two reasons its dialects cannot produce are now possible.
- Don't claim `sinr` off an `Lte`/`Nr5g` dict, and don't report an LTE modem's missing SINR as `unsupported` — MM 1.24.2 gives `sinr` to `Signal.Evdo` alone and `snr` (a different quantity) to the others, so `unsupported` is a capability claim ModemManager itself disproves.
- Don't add an EARFCN to `modemRegistrationContextSchema` — MM exposes none generically, and its two per-cell keys (`earfcn` / `nrarfcn`) are different quantities that one slot could only merge or silently pick between.
- Don't widen a `modemSimPresenceEvidenceSchema` `value` to carry an ICCID, IMSI or MSISDN — the union deliberately carries only D-Bus object paths and MM's own failed-reason token. And don't add a second evidence kind that can answer `absent`: exactly one is what makes "never inferred from a blank field" verifiable.
- Don't publish `identity_state: 'resolved'` on a telemetry row, and don't fold the state INTO `link_id` as a sentinel value — `link_id` is minted by one authority or it is absent, and an id-shaped placeholder keyed on an interface name is the exact defect the state replaced.
- Don't correlate a modem by its numeric id, its ifname, or its MAC — a USB-mode transition re-issues the first, the bench proves the second races on a duplicate factory MAC, and the third IS that duplicate. Use `stable_key` / `deriveModemStableKey()`, don't give an adapter its own derivation, and don't prefix or hash the key.
- Don't feed a raw sysfs DEVPATH (`Modem.Physdev`, `Modem.Device`) anywhere a `stable_key` is compared without normalizing it — it names the same socket as a udev `ID_PATH` in a different vocabulary, and equality is the only operation the key supports, so the two never match (todo 24: two rows for one stick, 10/10 cycles). `deriveModemStableKey` normalizes for you; use `canonicalModemIdPath` when you also STORE the path. And don't "fix" a future instance of this with a fuzzy compare-time match or a third key format — normalize at the derivation, to the `ID_PATH` shape every other adapter already emits.
- Don't route `isSimlessForBond` (or anything else that decides bond membership) through `sim_presence` — that field is `no_sim`'s pre-fold INPUT, published so a consumer can tell an unreadable slot from an empty one, and the gate reading the binary claim alone is what makes it additive. And don't publish `sim_presence` present-only-when-known: the consumer merge preserves an omitted optional field, so a slot that went `present` → `unknown` could never lower the claim.
- Don't publish `own_numbers` as an empty array, and don't collapse it to a single string — the schema's `.min(1)` is what keeps "not reported" and "none" from becoming the same wire value, and MM's property is `as`, so a first-element read silently drops a dual-number SIM's tail.
- Don't promote any Phase-B modem field to required, and don't add `data_usage_cycle_day`/`data_usage_threshold_bytes` to `modemConfigInputSchema` until `@ceralive/modem-control` actually exports a usage-policy setter — an inert input field is a mutation the device accepts and drops.
- Don't collapse a modem operation's classified outcome into a per-procedure generic literal — `write_failed`, `transaction_error` and a bare `error` are three different words for "something failed", and `mapModemManagerError` had already answered whether to wait, re-authenticate, or stop trying. Publish `modemOperationOutcomeSchema` beside the legacy literal; don't replace it (that would break every consumer that renders it today).
- Don't invent a member of any `modemOperation*Schema` / `modemManagerRefusalReasonSchema` — all four are MIRRORS of the package's frozen lists, and a reason it cannot emit is a state no device reaches. Don't merge the completion and result enums either: they share three member names and split on exactly the write-vs-read distinction that makes `unknown-outcome` meaningful.
- Don't make `retryable` optional, and don't turn `MODEM_MANAGER_REFUSAL_RETRYABLE` into a list of the retryable ones — the first re-creates the `policy_route_missing` latch, the second silently defaults a ninth refusal to "do not retry".
- Don't render `unknown-outcome` as a success or a failure, and don't give it a free-string reason — it means the write may have landed, so it routes to the reconciliation surface.
- Don't give a mutating modem procedure its own private refusal vocabulary — `modemMutationRefusalSchema` is shared so a blocked device reads the same on every surface, and a per-procedure generic error is how "waiting on your acknowledgement" becomes indistinguishable from "the transaction broke".
- Don't make `mode` optional on `modemMutationAckInputSchema`, and don't drop its `.strict()`/`confirm` — those are the wire-level enforcement of "only VERIFIED-ROLLBACK or FORCE-REBASELINE may unblock a failed mutation".
- Don't fold `module_disabled`/`module_unavailable` into `modemMutationRefusalSchema` — they are a SUPERSET (`capabilityMutationRefusalSchema`) because a gate refusal is a different fact from a mutation-safety one, and widening the shared enum breaks every consumer that maps from it.
- Don't make `setModemCapabilityInputSchema` take a whole gate object, and don't drop its `.strict()` — one module per call is what stops two in-flight toggles restoring each other's previous value, and an unknown key on a gate that arms radio-mutating controls must be rejected rather than ignored. Don't answer `getCapabilities` with the sparse persisted object either: `capabilityGateStatesSchema` is total for the same reason `capabilityModuleClaimsSchema` is.
- Don't publish a capability claim present-only-when-supported, and don't make `capabilityModuleClaimsSchema` partial — an omitted module is indistinguishable from a lowered claim on a merge that preserves absent fields.
- Don't add a module to `IMPLEMENTED_CAPABILITY_MODULES` without its capability probe AND its certification evidence — listing it there is what makes a config gate able to surface a control.
- Don't give SMS a mutation kind. Its absence from `MUTATING_CAPABILITY_MODULES` is what makes the permanent read-only policy structural.
- Don't add an SMS compose/send/delete schema or contract entry. The inbox is read-only permanently, and a grep gate in the backend suite scans this package's modem schema + contract for exactly those identifiers.
- Don't add `bluetooth` to `CAPABILITY_MODULES` — that enum is closed, modem-only and default-OFF-forever, so registering it there hides the whole Bluetooth surface behind a cellular feature gate. Reuse `supportClaimStateSchema`/`resolveSupportClaim` from the separate `bluetoothCapabilityClaimsSchema` registry instead.
- Don't make a Bluetooth `paired`/`trusted`/`connected`/`blocked` field optional, and don't give a Bluetooth mutation its own refusal strings — the first re-creates the `policy_route_missing` latch on a device that disconnects, the second makes "another mutation holds the radio" indistinguishable from "the pairing failed".
- Don't collapse `pairing_agent_unavailable` into `pairing_failed`, and don't drop `agent.reason` from the status answer — that gap is real on every device today (the shared `DbusTransport` exports no object), and hiding it turns a known missing capability into a pairing that mysteriously never lands.
- Don't give `audio_backend` a schema `.default()` on any of the three shapes that carry it, and don't read an absent value as `alsa` — absent means the operator stated nothing, which the device turns into "send the engine no backend key at all". A default here reverts the shipped engine default for every config in the fleet, none of which carries the key.
