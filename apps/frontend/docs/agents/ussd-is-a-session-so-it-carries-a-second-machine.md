<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## USSD IS A SESSION, SO IT CARRIES A SECOND MACHINE [EXISTS]

`main/dialogs/ModemUssdSection.svelte` + the pure `lib/modem/ussd-session.ts`
are the USSD dialogue — the one gated capability whose backend was complete
(four procedures, a seven-state machine, a ten-member refusal taxonomy) and
whose UI was a capability-gate row in a comment and nothing else.

**THE FOUR-STATE LADDER IS NECESSARY AND NOT SUFFICIENT.** Every other gated
module here is a SETTING, so the ladder answers "may this control be offered"
and the control is a switch. A USSD dialogue is a NETWORK-side resource — the
subscriber gets ONE slot — and the ladder has no vocabulary for "the carrier
asked a question and is holding that slot until you answer". `ussd-session.ts`
is that second machine, kept pure so every phase and refusal is testable
without mounting anything.

Six decisions carry weight:

- **`ussdCapabilityView` answers THREE states, never `blocked`.**
  `CapabilitySection` SUPPRESSES `children` at `blocked` and here the children
  ARE the dialogue, so a `blocked` view would take the session off screen at
  exactly the moment the operator needs to read why it stopped. This is the
  documented third pattern (route available/absent, put the warning inside
  `children`) applied verbatim. The gate that matters is unchanged and is still
  the primitive's: **a modem with no `ussd` claim renders ZERO nodes.**
- **Five operator phases, folded from seven device states.**
  `initiating`/`responding`/`cancelling` all fold to `working` — they differ
  only in which verb is outstanding, which an operator does not need to know.
  What they must never see is a spinner with no end, and `working` is always
  followed by a terminal phase because the device closes an unanswered dialogue
  at its own bound.
- **The three verb mirrors refuse a doomed dispatch LOCALLY.**
  `canInitiateUssd` / `canRespondUssd` / `canCancelUssd` reproduce the device's
  own accept sets, so a second `initiate` against a live dialogue never leaves
  the browser — its only possible answer is `session-busy`, and dispatching it
  spends a round-trip to be told so. They are NARROWER than the device's
  authority, never wider: every admitted verb is still re-judged by the machine
  that owns the session, so a mirror that drifts optimistic costs a refusal
  rather than a double-open.
- **`timed-out` maps onto the `unknown` outcome band, and that is the point.**
  That band's contract is "accepted, and the confirming read never arrived
  inside its bound" — exactly a dialogue nobody answered. It is neither a
  success nor a failure, it announces assertively, and it is what stops the
  surface ending in a spinner. There is deliberately **no auto-retry**: a retry
  would open a SECOND dialogue against a slot whose state nobody knows. The
  other three outcomes ride the same single band (`completed`/`cancelled` →
  `applied`, `failed` → `refused` with the device's OWN refusal sentence), so
  one fact is never announced twice.
- **`lte-only-unsupported` gets its own band, copy and marker.** It is the one
  refusal that says nothing about the hardware: USSD is circuit-switched, and a
  modem attached PS-only can only carry it where the operator deployed USSI.
  Rendered as a generic failure it sends an operator hunting for a firmware fix
  for a carrier decision, so it renders as `modem-ussd-policy` /
  `data-ussd-policy`, states that the modem is fine, and never doubles as the
  generic `modem-ussd-reason` line.
- **The carrier's text is held in ONE component and dropped on unmount.** Both
  directions carry subscriber content (a voucher code out, a balance or a
  one-time code back), so this section owns its own session state and its own
  RPC — a deliberate deviation from `ModemGpsSection`/`ModemFccUnlockSection`,
  which are presentational with state in the dialog. `AppDialog` mounts
  children only while open, so closing the dialog drops both: the retention
  bound is a property of the mount rather than of a cleanup somebody has to
  remember. **Do not hoist that state into `ModemConfigDialog` for consistency**
  — the mount site says so too. The reply renders in exactly one marked node
  (`modem-ussd-reply`) and the command is cleared BEFORE the await, so it can
  never be echoed into a heading, a toast title or a retry affordance.

**It READS on mount, and that read is load-bearing rather than cosmetic.** The
device's USSD capability evidence is filled BY `getUssd`, and every verb is
gated on it — so without the read the first dialogue on a fresh boot is refused
`module_unavailable` whatever the hardware can do. The backend half of that is
`recordUssdCapability` (`apps/backend/.../ussd.ts`), added with this surface:
the module cached evidence without ever calling `noteCapabilityEvidenceChanged`,
so a read that first PROVED the capability left the claim stale for up to 30 s —
landing on the operator immediately after they opened the section.

Coverage: `lib/modem/ussd-session.test.ts` (66 — the phase fold, the three
mirrors as exhaustive state sweeps, the four outcomes, and completeness gates
that derive the required refusal/copy keys FROM the wire enums across all ten
catalogs), `main/dialogs/ModemUssdSection.test.ts` (18 — the zero-DOM gate, the
full dialogue, the timeout band, the policy band's textual distinctness, the
no-RPC second initiate asserted by call count, and the containment grep with a
non-vacuity control), and `tests/e2e/modem-ussd.spec.ts` (4 `@functional` legs,
including a real-browser console grep).

**Honest status:** fixture-proven only. modem-stack records USSD as
`implemented-but-uncertified` — no bench modem can open a session (BLOCKER B4) —
so the live carrier drill has not run from this surface.

