<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A PERSISTENT NOTICE IS NOT A TOAST [EXISTS]

`LayoutToastHost` renders only NON-persistent notifications. A persistent one
(`is_persistent: true`) renders IN FLOW, in `main/notifications/PersistentNotices.svelte`,
and keeps its archive + unread badge in `NotificationsPanel`.

It used to ride the same sonner stream with
`duration: Number.POSITIVE_INFINITY`, which is a permanent card on an overlay
layer at **z-index 999999999**. Board-measured on `ceralive2` (task 41's fleet
drill), that card's box was:

| Viewport | Toast box | What it covered |
|---|---|---|
| 375x812 | `16,665 328x132` | the fixed dock's Settings tab (`144,708 72x56`) |
| 768x900 | `373,745 356x132` | the same tab (`301,796 151x56`) |
| 1024x600 | `629,445 356x132` | an 85svh dialog's footer (`249,490 512x65`) |

The operator-visible failure was a Settings tap that timed out for 30 s, and it
was NOT recoverable by waiting: an infinite toast has no expiry, and the Toaster
ships `closeButton` off, so `netif_dup_ip` had no dismiss control on screen even
though the wire marks it `is_dismissable: true`.

Five rules carry the fix, and each was measured rather than reasoned:

- **THE DISCRIMINATOR IS PERSISTENCE, NOT SEVERITY OR DISMISSABILITY.** A toast
  overlapping a dialog's corner for four seconds is what a toast IS; the same
  card there forever is an occlusion. So the split is on `isPersistent`, and it
  is applied at the ONE place that talks to sonner.
- **THE BAND IS ON NO STACKING LAYER.** No `fixed`, no `z-*`, no positioned
  ancestor with a numeric z-index — verified in-browser as an empty layer chain
  against the dialog's `z=50`. That is what makes "it can push content down, it
  can never cover it" a structural property rather than a promise.
- **A HIT TEST CANNOT SEE THE DIALOG CASE.** bits-ui sets
  `pointer-events: none` on `<body>` while a modal is open (board-verified), so
  `document.elementFromPoint` skips the toast and returns the button under it.
  The dialog occlusion was therefore VISUAL — a Save button behind an opaque
  permanent card — and only a stacking-layer comparison detects it. Do not
  "simplify" that assertion into an `elementFromPoint` check; it passes on the
  broken tree.
- **THE TOAST LAYER STAYS ABOVE THE DIALOG, and must.** Lowering the toaster
  below `z-50` would bury the "Copied" / "Saved" / typed-refusal toasts that
  `HotspotDialog`, `PasswordDialog`, `SshDialog`, `CloudRemoteDialog`,
  `NetifDialog`, `SimUnlockDialog` and `async-operation.svelte.ts` fire WHILE a
  dialog is open, under a `bg-black/10` + `backdrop-blur` scrim.
- **TRANSIENT TOASTS STILL CLEAR THE DOCK.** The mobile layout parks a fixed
  dock on the bottom edge and the stack is anchored to the same edge, so
  `LayoutToastHost` passes an `offset`/`mobileOffset` of
  `calc(var(--mobile-dock-height) + env(safe-area-inset-bottom, 0px) + 1rem)`.
  It is keyed on `DESKTOP_CHROME_QUERY` — the query `MainView` mounts the dock
  with — NOT on sonner's own `max-width: 600px` rule, which does not fire at
  768x900 where the dock is still mounted. `--mobile-dock-height` (`app.css`) is
  the SINGLE source for that clearance and for the padding `<main>` reserves.
- `[data-sonner-toaster]` is `pointer-events: none` with `[data-sonner-toast]`
  `auto`, so the container never answers a hit test for pixels it does not
  paint. Events still BUBBLE to the `<ol>`, so sonner's expand/swipe handlers
  are unaffected.

`notification-presentation.ts` holds the ONE icon vocabulary and the ONE dismiss
action both surfaces use — a warning that draws a triangle in the band and a
circle in the panel is the drift it prevents. The band adds NO i18n keys: each
notice carries its own resolved `text`, and the dismiss control reuses
`notifications.panel.dismiss`.

Coverage: `src/tests/persistent-notice-surface.test.ts` (the toast-layer split,
the no-stacking-layer lock, the dock clearance, and the dismiss/withheld-dismiss
pair) + `tests/e2e/notification-overlap.spec.ts` (the geometry half — hit-test
ownership of the dock at 375/768, the stacking-layer comparison at 1024/768/375,
the `<main>`-reserves-the-dock lock, a SCOPED axe run on the band, and a
non-vacuity leg that lifts the band onto sonner's own layer and proves the probe
reports it). The axe leg is scoped rather than folded into `a11y.spec.ts`
because that gate is page-BASELINED — it can only say "no new rule" — and it
never raises a notice, so the band would be unmeasured there.
Rule-E proof captured in both directions: reverting the fix reddens 7 of 7 e2e
legs and 3 of 10 unit tests.

