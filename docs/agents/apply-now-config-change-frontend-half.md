<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## APPLY-NOW CONFIG CHANGE (frontend half) [EXISTS]

Changing resolution/framerate while a stream is LIVE now asks the operator when
to apply it instead of silently deferring. The backend contract (transaction,
`reconfiguring` state, queued stop, staged persistence, marker-only crash
reconciliation) is documented in
[`apps/backend/AGENTS.md`](../../apps/backend/AGENTS.md) → APPLY-NOW CONFIG CHANGE.

- **One predicate drives the badge AND the choice.** `restartChoiceRequired`
  (`lib/streaming/appliesNextStart.ts`) is defined in terms of the existing
  `appliesOnNextStart`, so the `⟳ Applies on next start` badge and the timing
  choice can never disagree. `EncoderDialog` renders the choice as a fieldset
  (`data-testid="encoder-apply-choice"`) pre-selected to `nextStart` — the
  unchanged default, so Save alone never restarts a live broadcast.
- **`apply_now` is a directive, not config.** It rides `buildEncoderSetConfig`'s
  payload but is filtered out of `LiveView`'s pending-field lock, because the
  server never echoes it back.
- **Phases are fenced on `attemptId`.** `reduceConfigChange`
  (`lib/streaming/configChangePhase.ts`) drops a terminal phase that contradicts
  a KNOWN current attempt, but ADOPTS one for an unknown attempt — a client that
  connected mid-transaction never saw `applying`, and swallowing its only outcome
  is the "event fired before anyone was listening" defect class. The `applying`
  banner therefore always clears.
- **Engine reasons are NEVER rendered raw.** `configChangeReport`
  (`lib/streaming/configChangeCopy.ts`) maps the machine-stable reason tokens to
  keyed copy in all 10 locales and falls back to a log pointer, so an unmapped
  token can never leak an ALSA path or unit name to an operator with no console.
  `change_rejected` is one of those tokens: an engine that REFUSES the parameters
  never began the transaction, so it renders as a `reverted` warning naming the
  refusal — never the `rollback_failed` "and the stream stopped" sentence, which
  would describe a healthy live stream as dead. Backend contract:
  [`apps/backend/AGENTS.md`](../../apps/backend/AGENTS.md) → "THE ENGINE SPEAKS PIXELS".
- **Device-UI reachability caveat:** `EncoderDialog` is mounted above the
  idle/live cockpit switch, but the `open-encoder-dialog` row lives in
  `IdleCockpit` only. So on the device the choice is reachable when the dialog is
  already open as the stream goes live, via the federated platform-dashboard
  mount, or via a direct RPC — `LiveCockpit` has no encoder affordance. Adding
  one is a deliberate UX decision, not part of this contract.

