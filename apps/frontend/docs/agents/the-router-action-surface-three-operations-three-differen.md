<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE ROUTER ACTION SURFACE — THREE OPERATIONS, THREE DIFFERENT ANSWERS [EXISTS]

`main/dialogs/router-dongle-actions.ts` (pure, rune-free) is the ACTION half of
`RouterDongleDialog`, the way `router-dongle-fields.ts` is its READING half. It
exists because the router family's write surface is not one capability, and
rendering it as one flattens three genuinely different facts.

**A `112008` NET-MODE REFUSAL IS `blocked`, NEVER `absent`.** The firmware
ANSWERED, and what it answered is that it will not name its own mode catalog —
so `netModeSectionView` puts the section on screen with the vendor's own error
code and no control. Hiding it would report a modem that answered as a modem
with no network mode at all. The refusal arm renders no button, input, select or
switch, and that is not a second rule: the chips are `children` (which render at
`available` alone) and the call site passes NO `control` snippet, so `blocked`
gives exactly a heading plus the refusal. The rule moved OUT of the `.svelte` so
"a refusal renders blocked-with-the-code" is assertable without mounting a
dialog.

**WI-FI AND REBOOT ARE STATED, NOT OMITTED — AND THEY ARE EVIDENCE-ONLY.** The
pinned `@ceralive/modem-control`'s Huawei provider exposes EXACTLY four
operations — `status`, `signal`, `mode`, `data` — and the other two dialects
publish no write at all, so there is no Wi-Fi or restart write anywhere in the
stack to gate. `ROUTER_UNAVAILABLE_OPERATIONS` renders each as a sentence and
NOTHING that can be pressed. Three rules carry it:

- **A successful READ is not evidence of a write.** The dongle happily reports
  its SSID and its associated-client count, and `router-dongle-fields.ts` renders
  both — inferring a control from those readings is exactly the hearsay this
  whole surface refuses. The absence sweep in the tests therefore matches on
  CONTROLS, never on text, and is paired with an assertion that the SSID row is
  still rendered.
- **Silence would be the worse answer.** An operator who came looking for the
  Wi-Fi switch the vendor's own page has needs to be told this device will not
  offer one, not left hunting a dialog that never mentions it.
- **This stays true even if a drill later proves a write.** By the time such a
  drill can run, the capability-truth matrix and both dialog migrations are
  sealed, so a control added afterwards would bypass the gate that keeps this
  surface honest. The verdict is recorded as follow-up work, never shipped as a
  late toggle.

**THE LAN-SUBNET REWRITE SHIPS, AND IT IS NOT A TOGGLE.** It is the one write
here that can cost the path to the device receiving it, so:

- **It is offered only where a write was PROVEN.** `subnetRewriteView` gates on
  `router_admin.controls` — published only for the dialect whose writes landed on
  real hardware, which is the same dialect `prepareSubnetRewrite` accepts. That
  gate carries the lock model for free: a signed-out dongle withholds `controls`,
  and withholding a journaled write from a device we have not authenticated
  against is the correct answer rather than a side effect. It answers
  `available`/`absent` and NEVER `blocked`, because the controls ARE the children
  and `blocked` suppresses them.
- **It takes two acts.** The operator names the target (validated by
  `isSubnetTargetValid` — RFC1918, a host octet that is neither `0` nor `255`,
  deliberately NARROWER than the device and never wider), then confirms it
  against a sentence naming the consequence. The confirmation is INLINE rather
  than a modal: a modal inside an already-portalled dialog puts the consequence
  on a layer the kiosk touchscreen must dismiss before it can re-read the address
  it is confirming. Arming the confirmation dispatches nothing.
- **`confirm: true` is built in ONE place.** `subnetRewriteRequest` is the only
  shape a call site can construct, because `setRouterSubnetInputSchema` is
  `.strict()` with a `z.literal(true)` there — the write's TOCTOU boundary rather
  than a formality.
- **`blocked` maps onto the outcome band's `unknown` kind.** The device answered
  at NEITHER address, so nothing about the write can be asserted in either
  direction: `refused` would claim the old settings are intact and `applied`
  would claim the new ones are.
- **The seven shared mutation-safety refusals share ONE sentence here**, a
  recorded narrowing rather than an oversight — the pre-existing router write
  path (`refusalMessage`) already collapses them the same way, and giving the
  subnet rewrite its own taxonomy while its two siblings keep one would make the
  same refusal read differently depending on which control produced it. What the
  shared sentence says truthfully is the part that matters most: nothing was
  written.

Copy: `network.routerCellular.{actions,unavailable,subnet}.*` (27 keys × 10
locales). Coverage: `main/dialogs/router-dongle-actions.test.ts` (the pure rules)
and `main/dialogs/RouterDongleDialog.actions.test.ts` (the rendered DOM — the
blocked-with-code arm and its `available` control, the Wi-Fi control sweep with
its non-vacuity check, and the confirmation/interlock legs). Rule-E proof, four
mutations, all reddened: hiding a refusal instead of blocking it → 8; offering
the rewrite without a proven write → 3; dispatching without the confirmation →
8; giving an unavailability row a pressable affordance → 2. Backend half:
`apps/backend/AGENTS.md` → …AND THE WRITES IT GATES ARE STAGE B.

**Honest status:** fixture-proven only. No subnet rewrite has been run against a
real dongle, and the auto-restore the confirmation describes is proven against
recorded replies alone — which is why the confirmation says so on screen.

