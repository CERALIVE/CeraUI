<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE GATES HAVE AN OPERATOR SURFACE [EXISTS]

The seven capability modules are DEFAULT-ABSENT on every device, and for a long
time there was no way to turn one on. The band-lock and GPS controls said so
correctly — *"Band locking is turned off on this device"*, *"Turn on location for
this device in settings first"* — and pointed at a setting that existed nowhere:
board validation swept `#settings` and matched **zero** testids against
`modem|cellular|location|gps|band|capab`
(`.omo/evidence/task-49-full-stack-board-validation.md`). Both controls were
unreachable on every board regardless of what the hardware could do.

`modems.getCapabilities` / `modems.setCapabilities` plus
`apps/frontend/src/main/dialogs/ModemCapabilitiesDialog.svelte` (Settings →
System → **Cellular Features**) are that surface. Five rules carry it:

- **THE GATES ARE DEVICE-WIDE, so this is Settings and NOT a per-modem section.**
  `config.modem_capabilities` is one object every modem's claim resolves against,
  so a section inside `ModemConfigDialog` would imply the switch is scoped to the
  row in front of the operator while silently arming the module on every other
  modem too.
- **A GATE IS A PRECONDITION, NEVER A CLAIM — this bypasses no evidence gate.**
  It is one of four inputs to `resolveSupportClaim`, so an enabled gate cannot
  promote a module past `enabled` on a modem whose probe has not positively
  answered, cannot reach `certified` at all, and leaves band-lock's stricter
  certification floor refusing exactly as before. The dialog SAYS so on screen
  (`modem-capabilities-honesty`) rather than letting an on switch read as a
  promise.
- **ONLY IMPLEMENTED MODULES GET A ROW** (`DESIGN.md` CT-1). A module this build
  does not ship renders ZERO nodes — never a disabled switch, which would imply a
  capability being withheld — and a write for one is REFUSED
  (`module_not_implemented`) rather than persisted, because its key is read by
  nothing. This is why `implemented` rides the wire: a modem row resolves "not
  built" and "this hardware lacks it" both to `unavailable`, and only the device
  can tell them apart.
- **The procedures are `authedProcedure`, deliberately NOT `modemProcedure`.**
  The gates are a property of the DEVICE, so they must be readable and writable
  while the cellular stack is still initializing or with no modem attached —
  gating them behind the cellular readiness middleware would make the settings
  surface unreachable in exactly the state an operator opens it to fix.
- **A PROBE THAT PROVES A CAPABILITY RE-PUBLISHES THE ROSTER, change-gated.**
  The probes fill caches the SYNCHRONOUS wire build reads, so a read that first
  proves a capability would otherwise leave the claim stale until the 30 s poll —
  landing on the operator at the worst moment, having just enabled the gate.
  `noteCapabilityEvidenceChanged` (`capability-gates.ts`) is the seam; it DEFAULTS
  TO INERT and is installed at module scope by `capability-evidence.ts` with a
  DYNAMIC import of `modem-status.ts`, because a static edge back would cycle
  through the wire producer. Re-reading an already-proven modem broadcasts
  nothing.

Coverage: `apps/backend/src/tests/modem-capability-settings.test.ts` (the total
read, the per-module write and its config-key mapping, every refusal arm asserting
the write provably never happened, the four not-a-bypass claims, the change-gated
notifier, and a static wiring lock on the re-broadcast),
`apps/frontend/src/main/dialogs/ModemCapabilitiesDialog.test.ts` (CT-1 both ways,
the pessimistic switch, the calm refusal band, the read-failure band),
`apps/frontend/src/tests/modem-capability-copy-completeness.test.ts` (copy for all
SEVEN modules × 10 locales, derived from the wire enum), and
`apps/frontend/tests/e2e/modem-capabilities-settings.spec.ts` (the audit's own
`#settings` testid sweep, inverted, plus the real RPC round-trip).

