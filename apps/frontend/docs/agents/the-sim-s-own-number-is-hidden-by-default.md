<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE SIM'S OWN NUMBER IS HIDDEN BY DEFAULT [EXISTS]

The detail card carries the SIM's own number (MSISDN) as a masked field with an
explicit reveal (`modem-own-number` / `-toggle` / `-value-<n>`), driven by the
pure `ownNumbers` + `OWN_NUMBER_MASK` in `main/dialogs/modem-detail.ts`.

It takes the CREDENTIAL treatment `PasswordDialog` / `WifiConnectForm` /
`HotspotDialog` already use, and reuses their shape rather than building a
second one: local `$state` boolean, `Eye`/`EyeOff`, an `aria-label` that names
what the control WILL do plus `aria-pressed` for what it currently is.

Four properties are load-bearing:

- **The number is NEVER in the DOM before the reveal.** Not `hidden`, not a CSS
  mask — either would still put it in a screen share, a screenshot and the
  accessibility tree. The value node renders `OWN_NUMBER_MASK` and swaps to the
  number only on reveal, which is asserted against `document.body.textContent`.
- **The mask has a FIXED width.** A mask that tracked the real length would leak
  the digit count, and a phone number is short enough for that to matter.
- **The reveal is per VIEWING.** It re-hides on close and whenever the dialog is
  pointed at a different modem (`lastRevealScope`), so one operator's reveal
  cannot outlive the moment. It is never persisted.
- **ABSENCE RENDERS AS ABSENCE.** A modem whose carrier published none renders
  NO label, NO dash and NO "Unknown" — most SIMs carry none, so a placeholder
  would read as a failed read on the majority of devices. A number ALONE is
  enough to open the detail card (`hasModemDetail`).

Copy: `network.modem.detail.ownNumber{,Show,Hide}` (10 locales). The value is
`dir="ltr"` in the mono face so an RTL locale cannot reorder its runs. Backend
half — including the fact that it is redacted from every log regardless:
`apps/backend/AGENTS.md` → THE SIM'S OWN NUMBER IS DISPLAYED, AND NEVER LOGGED.
Coverage: `modem-detail.test.ts` (the pure helpers),
`ModemConfigDialog.ownnumber.test.ts` (hidden-by-default, the fixed-width mask,
the reveal round trip, the multi-number case, both re-hide scopes, and the three
absence cases), and `tests/e2e/visual/modem-ux.visual.spec.ts` (hidden/revealed/
absent evidence at desktop, 1024x600 kiosk and mobile).

