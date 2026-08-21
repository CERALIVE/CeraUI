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
| Correlate a modem across a USB-mode transition | `schemas/modems.schema.ts` → `deriveModemStableKey()` / the `stable_key` field |
| The shared modem MUTATION-SAFETY wire vocabulary (journal states, refusals, ack modes, the three operator procedures) | `schemas/modems.schema.ts` → `modemMutation*Schema`; section below → THE MUTATION-SAFETY VOCABULARY IS SHARED |
| Identify a bonded LINK across a SIGHUP reload (`link_id` / `port_label` / `serial` on a telemetry row) + the one normalized bind-map disposition (`bond_mapping`) | `schemas/status.schema.ts` → `linkTelemetryEntrySchema`, `bondMappingSchema`; `conn_id` is a FILE POSITION and must never be a row identity |
| Say that a link's device could NOT be identified (`identity_state: 'unmappable'`) | `schemas/status.schema.ts` → `bondLinkIdentityStateSchema` on `linkTelemetryEntrySchema`; section below → AN UNIDENTIFIABLE LINK SAYS SO |
| Whether a capability module may be offered, mutated, or claimed | `schemas/capability-modules.schema.ts` + `capabilities/capability-matrix.ts` → `resolveSupportClaim` / `resolveCapabilityMatrix` / `mayRenderModule` / `mayClaimSupport`; section below → THE CAPABILITY FEATURE-GATE FRAMEWORK LIVES HERE, ONCE |
| Read-only SMS inbox shapes (`modems.getSms`) | `schemas/modems.schema.ts` → `smsMessageSchema` / `modemSmsOutputSchema` / `SMS_INBOX_CAP`; section below → THE SMS INBOX SCHEMAS ARE READ-ONLY BY DESIGN |
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

## CONVENTIONS

- Contracts use `@orpc/contract` (`oc.*`). No runtime logic here — contracts are pure type/schema declarations.
- Schemas use Zod v4 (`zod@^4`). Import from `zod`, not `zod/v4`.
- One contract file per domain. One schema file per domain. Names must match (`streaming.contract.ts` ↔ `streaming.schema.ts`).
- `appContract` in `contracts/index.ts` is the only router — don't create sub-routers elsewhere.

## ANTI-PATTERNS

- Don't import `@ceraui/rpc` from within this package itself — circular.
- Don't add runtime handlers here. Handlers live in `apps/backend/src/`.
- Don't duplicate schema definitions in `apps/` — always import from this package.
- Don't use Zod v3 APIs (`z.string().nonempty()` etc.) — project is on Zod v4.
- Don't publish `identity_state: 'resolved'` on a telemetry row, and don't fold the state INTO `link_id` as a sentinel value — `link_id` is minted by one authority or it is absent, and an id-shaped placeholder keyed on an interface name is the exact defect the state replaced.
- Don't correlate a modem by its numeric id, its ifname, or its MAC — a USB-mode transition re-issues the first, the bench proves the second races on a duplicate factory MAC, and the third IS that duplicate. Use `stable_key` / `deriveModemStableKey()`, don't give an adapter its own derivation, and don't prefix or hash the key.
- Don't feed a raw sysfs DEVPATH (`Modem.Physdev`, `Modem.Device`) anywhere a `stable_key` is compared without normalizing it — it names the same socket as a udev `ID_PATH` in a different vocabulary, and equality is the only operation the key supports, so the two never match (todo 24: two rows for one stick, 10/10 cycles). `deriveModemStableKey` normalizes for you; use `canonicalModemIdPath` when you also STORE the path. And don't "fix" a future instance of this with a fuzzy compare-time match or a third key format — normalize at the derivation, to the `ID_PATH` shape every other adapter already emits.
- Don't publish `own_numbers` as an empty array, and don't collapse it to a single string — the schema's `.min(1)` is what keeps "not reported" and "none" from becoming the same wire value, and MM's property is `as`, so a first-element read silently drops a dual-number SIM's tail.
- Don't promote any Phase-B modem field to required, and don't add `data_usage_cycle_day`/`data_usage_threshold_bytes` to `modemConfigInputSchema` until `@ceralive/modem-control` actually exports a usage-policy setter — an inert input field is a mutation the device accepts and drops.
- Don't give a mutating modem procedure its own private refusal vocabulary — `modemMutationRefusalSchema` is shared so a blocked device reads the same on every surface, and a per-procedure generic error is how "waiting on your acknowledgement" becomes indistinguishable from "the transaction broke".
- Don't make `mode` optional on `modemMutationAckInputSchema`, and don't drop its `.strict()`/`confirm` — those are the wire-level enforcement of "only VERIFIED-ROLLBACK or FORCE-REBASELINE may unblock a failed mutation".
- Don't fold `module_disabled`/`module_unavailable` into `modemMutationRefusalSchema` — they are a SUPERSET (`capabilityMutationRefusalSchema`) because a gate refusal is a different fact from a mutation-safety one, and widening the shared enum breaks every consumer that maps from it.
- Don't make `setModemCapabilityInputSchema` take a whole gate object, and don't drop its `.strict()` — one module per call is what stops two in-flight toggles restoring each other's previous value, and an unknown key on a gate that arms radio-mutating controls must be rejected rather than ignored. Don't answer `getCapabilities` with the sparse persisted object either: `capabilityGateStatesSchema` is total for the same reason `capabilityModuleClaimsSchema` is.
- Don't publish a capability claim present-only-when-supported, and don't make `capabilityModuleClaimsSchema` partial — an omitted module is indistinguishable from a lowered claim on a merge that preserves absent fields.
- Don't add a module to `IMPLEMENTED_CAPABILITY_MODULES` without its capability probe AND its certification evidence — listing it there is what makes a config gate able to surface a control.
- Don't give SMS a mutation kind. Its absence from `MUTATING_CAPABILITY_MODULES` is what makes the permanent read-only policy structural.
- Don't add an SMS compose/send/delete schema or contract entry. The inbox is read-only permanently, and a grep gate in the backend suite scans this package's modem schema + contract for exactly those identifiers.
