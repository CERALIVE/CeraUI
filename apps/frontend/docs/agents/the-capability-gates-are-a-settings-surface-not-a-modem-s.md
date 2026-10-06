<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE CAPABILITY GATES ARE A SETTINGS SURFACE, NOT A MODEM SECTION [EXISTS]

`main/dialogs/ModemCapabilitiesDialog.svelte` (Settings → System → **Cellular
Features**) is where an operator turns a capability module on. It exists because
the band-lock and GPS controls in `ModemConfigDialog` were telling operators to
enable a feature "in settings" while a board sweep of `#settings` matched ZERO
testids against `modem|cellular|location|gps|band|capab`
(`.omo/evidence/task-49-full-stack-board-validation.md`) — the copy pointed at
nothing, and both controls were unreachable on every board.

- **It is Settings BECAUSE the gates are device-wide.** `config.modem_capabilities`
  is one object every modem's claim resolves against, so a section inside
  `ModemConfigDialog` would imply the switch is scoped to the row in front of the
  operator while arming the module on every other modem too. Do not move it there.
- **CT-1 — an unimplemented module renders ZERO nodes.** Not a disabled switch:
  below `capable` nobody has shown there is a capability to withhold, and the
  device REFUSES the write anyway. `implemented` therefore comes from
  `modems.getCapabilities` and is never inferred from the modem rows, which
  resolve "not built" and "this hardware lacks it" both to `unavailable`.
- **Row ORDER is `CAPABILITY_MODULES`' own, filtered** — never the wire's arrival
  order — so two devices shipping the same set list them identically.
- **The switch is PESSIMISTIC** (the `NetworkIngestDialog` shape): it moves to the
  `applied` record the device persisted, never to what was clicked, and only the
  spinner is optimistic.
- **A `module_not_implemented` refusal is a device FACT, not a failure** — it
  renders the calm `modem-capabilities-refused` band and does NOT toast, so
  `classify` keeps it `ok`. A failed READ renders its own distinct band and must
  never be collapsed into the empty state: "we could not ask" and "this build
  ships nothing" have different fixes.
- **The honesty note is load-bearing copy, not decoration.** The gate is a
  precondition and cannot promote a module past `enabled` on an unprobed modem, so
  `modem-capabilities-honesty` says on screen that each modem is still checked on
  its own. Without it an enabled switch reads as a promise the device never made.

Entry rows in `SettingsView` carry `data-testid="settings-entry-<key>"` — added
here because the audit's detection method WAS a testid sweep, so a surface that
cannot be found that way is a surface the next audit will miss again.

Coverage: `ModemCapabilitiesDialog.test.ts`,
`src/tests/modem-capability-copy-completeness.test.ts` (all seven modules × 10
locales, derived from the wire enum so an eighth fails until its copy lands), and
`tests/e2e/modem-capabilities-settings.spec.ts`. Device half:
[`../backend/AGENTS.md`](../../../backend/AGENTS.md) → …AND THE OPERATOR CAN ACTUALLY
SET THOSE GATES.

