<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A USB-MODE SWITCH IS CONFIRMED BY THE DEVICE, NOT BY THE REPLY [EXISTS]

`lib/rpc/usb-mode-flow.ts` (pure, rune-free) + the USB-mode card in
`main/dialogs/ModemConfigDialog.svelte` own the `modems.setUsbMode` mutation.

It does NOT use the ordinary `osCommand` confirm pattern, and the reason is
timing: `osCommand`'s TTL starts at DISPATCH and expires at
`ASYNC_OP_TTL_MS` (15 s), while this RPC *awaits the whole server-side
transaction* — an NM quiesce, an AT command, a port drop and a full USB
re-enumeration, which the transition engine bounds with its own deadlines and
which can legitimately outlast that TTL. Reusing it would flip every healthy
switch to `timed_out` mid-transaction. Four mechanics carry it instead:

1. **BASELINE BEFORE DISPATCH.** The `modems` feed is read and the pre-switch
   mode recorded BEFORE the RPC goes out, so the confirmation compares against
   what was true when the operator acted, not against a later snapshot.
2. **A MATCH IS ACCEPTED AT ANY POINT AFTER DISPATCH.** The backend fires ONE
   immediate re-discovery + broadcast the moment the transition verifies, and
   that broadcast can legally beat the RPC reply back to the browser. A match
   observed while the RPC is still pending is BUFFERED and consumed at
   resolution — drop it and the only later broadcast may be the 30 s poll.
3. **THE 20 s BOUND STARTS AT RPC RESOLUTION** (`USB_MODE_CONFIRM_WINDOW_MS`),
   never at dispatch, so it covers ONLY re-discovery + broadcast latency.
4. **THE DEVICE IS MATCHED BY `stable_key`, AND BY NOTHING ELSE.** The legacy
   numeric id is the MM index the transition itself re-issues and the ifname
   changes with the composition, so both name a different device — or none — by
   the time the confirming snapshot lands. A modem that publishes no
   `stable_key` is NOT offered the switch at all (`canTrackUsbModeSwitch`):
   dispatching one that could never be honestly confirmed would guarantee an
   "unconfirmed" band on every attempt.

**THE SPINNER IS THE ONLY OPTIMISTIC ELEMENT.** The displayed mode is read from
the live feed (`displayedUsbMode`) and falls back to the recorded baseline —
never to the flow's target — which is what makes RPC success alone structurally
unable to move it. An expired window renders an honest "still transitioning"
band: no flip, and no silent success. A typed refusal renders inline with its
`reason` (`network.modem.usbMode.error.*` + `.reason.*`, 10 locales); the
`uncertified` refusal is a first-class state, because it is what every real
modem answers today.

The card is deliberately OUTSIDE the dialog's `disabled={noSim}` fieldset — the
composition is a property of the USB device, not of the SIM — and is absent
entirely when the device reports neither `usb_mode` nor `recommended_usb_mode`
(additive-tolerant, so an older backend renders nothing rather than "Unknown").

Backend half: [`../backend/AGENTS.md`](../../../backend/AGENTS.md) → USB-COMPOSITION
SWITCH. Coverage: `src/tests/usb-mode-flow.test.ts` (the pure machine),
`src/main/dialogs/ModemConfigDialog.usbmode.test.ts` (the rendered card, incl.
the RPC-success-alone-does-not-flip proof, driven against a RUNE-BACKED feed
double — a plain `vi.fn()` is not reactive and would silently prove the
opposite), and `tests/e2e/modem-usb-mode.spec.ts` (the round-trip).

**A STANDING refusal withdraws the control instead of inviting a retry
(modem-stack Phase B, todo 27) [EXISTS].** `uncertified` and
`provisioning_disabled` are the two refusals the device will answer IDENTICALLY
on every attempt — the first because the certified catalog ships EMPTY pending
real evidence bundles (so it is what every real modem gets today, and the
terminal answer until certification lands, not a stopgap), the second because it
is a device-level setting. `isStandingUsbRefusal` (`main/dialogs/modem-detail.ts`)
names exactly those two, and the card then renders a CALM `role="status"` band —
muted, never the destructive red — carrying the existing typed head plus a
`usbMode.uncertifiedBody` / `usbMode.provisioningBody` line stating that the
active mode above keeps working, AND it hides the switch button. A retry button
beside a permanent refusal misrepresents what pressing it does. Every OTHER
refusal names a condition that can change, so it keeps the red `role="alert"`
band AND keeps the button. The band's `data-testid` stays `modem-usb-mode-error`
for both paths (existing selectors resolve either way); the discriminator is
`data-usb-mode-refusal`. Coverage:
`src/main/dialogs/ModemConfigDialog.detail.test.ts`.

**THE PROVISIONING GATE IS PRE-RENDERED NOW, AND IT IS A TRISTATE (todo 28)
[EXISTS].** `modem_provisioning` used to be a backend-only runtime key, so the
control could only be offered and then withdrawn by the device's own
`provisioning_disabled` refusal. It is now echoed READ-ONLY on
`configMessageSchema` (and by `streaming.getConfig`), which is what lets the
dialog answer before dispatching anything — but the three arms are NOT
interchangeable and collapsing them is the whole hazard:

- **`false`** — the device SAID provisioning is off. `provisioningBlocked`
  renders the switch DISABLED with its reason (`usbMode.provisioningDisabled`)
  both as the control's accessible name and as an on-screen line
  (`modem-usb-mode-provisioning-blocked`), on a wrapper carrying
  `data-usb-mode-gate="provisioning-disabled"`, and no RPC is ever dispatched.
- **`true`** — the real confirm-guarded switch is offered, unchanged.
- **ABSENT** — a backend that does not publish the key. We were told NOTHING, so
  the control stays OFFERED and the standing-refusal path above still withdraws
  it. Reading absent as `false` would hide a working control on every device
  running an older backend, which is the exact dishonesty the pre-echo design
  was avoiding.

It is the AMBER disabled-with-reason treatment, deliberately NOT the calm
standing-refusal band: provisioning is a setting an operator can turn back on, so
the control is temporarily blocked rather than permanently withdrawn. The card
still reports the ACTIVE mode in every arm. `streaming.setConfig` does not accept
the field — there is no UI write path, and adding one is a separate decision.
Coverage: `ModemConfigDialog.usbmode.test.ts` -> "the provisioning gate" (all
three arms, the zero-dispatch proof, and the reason-on-screen lock) +
`tests/e2e/truthfulness.spec.ts`.

**…AND ONLY CERTIFIED MODES ARE OFFERED — `recommended_usb_mode` NEVER CONJURES A
CONTROL (todo 28) [EXISTS].** The card used to derive its single switch target
from `recommended_usb_mode`, which is a per-SKU ADVISORY about which composition
is most stable and carries NO certification claim. So a control rendered for every
modem on every board and the device answered `uncertified` to all of them. The
offered set is now the DEVICE's own answer, read once per open via
`rpc.modems.getUsbModeOptions` — the same catalog `setUsbMode` gates on — and
folded by the pure rune-free `lib/rpc/usb-mode-offer.ts` (`deriveUsbModeOffer` /
`resolveUsbModeTarget` / `usbOfferSuppressionKey`). The recommendation survives
only as a PREFERENCE among certified targets and as a badge on one of them.

FOUR phases, and the two that render nothing are NOT the same fact:

| Phase | When | Renders |
|---|---|---|
| `offered` | the device named certified targets | `modem-usb-mode-targets` radiogroup + the confirm button |
| `settled` | certified SKU, no certified way out of THIS mode | nothing — no control, no band |
| `withheld` | the device said why not | NO control + a calm `modem-usb-mode-unavailable` band |
| `unknown` | never asked, in flight, or the read THREW | nothing — and **no claim about the device** |

- **A withheld offer renders NO control — never a disabled one.** A disabled
  control implies a capability being withheld; here there is no capability, because
  the transition has never been reviewed for this model and firmware. This is the
  deliberate opposite of the provisioning gate above, which IS disabled-with-reason
  because provisioning is a setting the operator can turn back on. Do not unify
  them.
- **`unknown` may never render `uncertified`.** "We could not establish the set" is
  not "the set is empty"; stating a reason there asserts a device fact we do not
  have.
- **The suppression copy key is a TABLE (`usbOfferSuppressionKey`), never an
  interpolation.** The three tokens span TWO enums — `identity_unresolved` is a
  `setUsbModeFailureReasonSchema` member and resolves under `reason.*`, while
  `uncertified`/`unavailable_in_emulated_mode` are `setUsbModeRefusalSchema`
  members under `error.*`. Interpolating one namespace renders the raw dotted path
  for the other, which the modem a11y gate forbids outright.
- **…AND EVERY TOKEN IN BOTH ENUMS HAS COPY, PROVEN BY A GATE (Phase-C todo 14)
  [EXISTS].** `setUsbModeRefusalSchema` grew the four shared mutation-safety
  refusals (`mutation_blocked`, `recovery_pending`, `device_decommissioned`,
  `rebaseline_required`) and no catalog ever gained a
  `network.modem.usbMode.error.<token>` for any of them — so a device that
  refused a switch because an earlier mutation had not been acknowledged printed
  a RAW DOTTED KEY at the operator. The i18n locale-parity gate structurally
  cannot catch this: a key missing from all ten catalogs is perfectly in parity.
  `src/tests/usb-mode-copy-completeness.test.ts` closes it by DERIVING the
  required key list from the wire enums and from `usbOfferSuppressionKey` itself
  — never a re-typed list, so an eleventh refusal fails the gate until its copy
  lands. The check is a pure function over one catalog specifically so its own
  falsifiability is provable: it is handed a clone with a key deleted and must
  report it, for every locale. The four values are the fccUnlock/gps
  translations verbatim, which is the established rule that ONE machine token
  gets ONE operator sentence across every modem-mutation surface — those two
  namespaces have carried all four, byte-identical per locale, since the
  mutation-safety contract landed.
- **A device with no `stable_key` is refused the control AND the list**, because a
  switch that could never be confirmed is not an option to display.
- **A UFI/router-ethernet row gets no USB-composition card at all** — its
  diagnostics dialog remains reachable, but offers no composition switch.
  `sethimiusbtether` is a PERMANENT fence, enforced by a repo-wide
  grep gate (`apps/backend/src/tests/usb-tether-fence.test.ts`), not by a UI state.

Coverage: `src/tests/usb-mode-offer.test.ts` (the pure rule),
`ModemConfigDialog.usbmode.test.ts` -> "ONLY the certified transitions are
rendered" + "an uncertifiable device gets NO control", and
`tests/e2e/modem-usb-mode.spec.ts` -> the four device classes with screenshots.
Backend half: [`../backend/AGENTS.md`](../../../backend/AGENTS.md) → WHICH MODES MAY BE
OFFERED.

