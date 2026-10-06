<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

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
[`apps/backend/AGENTS.md`](../../../../apps/backend/AGENTS.md) → THE CAPABILITY
FEATURE-GATE FRAMEWORK; operator surface: [`../../AGENTS.md`](../../../../AGENTS.md) →
THE GATES HAVE AN OPERATOR SURFACE.

