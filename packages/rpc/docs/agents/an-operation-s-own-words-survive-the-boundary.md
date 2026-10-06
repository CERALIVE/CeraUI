<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

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
[`apps/backend/AGENTS.md`](../../../../apps/backend/AGENTS.md) → A GENERIC FAILURE IS
NOT AN ANSWER.

