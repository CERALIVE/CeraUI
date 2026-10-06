<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A CLIPPED DISCLOSURE MUST BE HIDDEN, NOT MERELY UNPAINTED [EXISTS]

The Cellular row's per-row disclosure keeps its body MOUNTED and `inert` while
collapsed — that contract (todo 64 rule 3) is unchanged. What was wrong is the
CLIP: `overflow: hidden` on the `min-h-0` wrapper removes the content from the
PAINT, and nothing else. Every control inside keeps a full-size layout box at
its uncollapsed coordinates.

Measured on the bench board, collapsed: `open-router-admin` reported **173×32 at
y=1433** from inside a clipping ancestor that was **0px tall**. That is a control
no pointer can reach which nevertheless advertises itself as reachable, and it
is a hard blocker for automation and a latent one for assistive tech:

- `getBoundingClientRect()` is non-empty, so **Playwright answers "element is
  visible, enabled and stable"** and proceeds to click.
- It then hit-tests the box's centre, which resolves to whichever `modem-row` is
  genuinely painted at those coordinates, and reports
  `<div … data-testid="modem-row" …> intercepts pointer events` — **forever**,
  because nothing about it is transient. This reads exactly like a re-render
  race and is not one: measured over 20 s of idle poll, the section produced
  **zero** childList mutations and every row kept its DOM node.

The wrapper therefore also carries `visibility: hidden` while collapsed. That
one property fixes both halves: `visibility` is INHERITED, it withdraws the
subtree from hit testing, and a browser reports the descendants as not-visible,
so Playwright waits honestly instead of retrying an impossible click.

- **It is transitioned (`transition-[visibility] duration-200`), and that is
  load-bearing.** A `visibility` transition whose start value is `visible` holds
  `visible` for the whole duration, so the close still animates alongside the
  `grid-template-rows` collapse and the open is instant. Do NOT drop the
  transition and do NOT reach for `display: none` (which kills the animation) or
  `content-visibility` (narrower support, and it does not solve the visibility
  report).
- **It stays pure CSS**, so both global motion freezes (`prefers-reduced-motion`
  and the e-ink `transition: none`) still cover it — the same reason the reveal
  itself is a `grid-template-rows` transition rather than a Svelte one.
- **`inert` is NOT redundant with it and must stay.** `inert` governs focus and
  the accessibility tree; `visibility` governs painting and hit testing. Neither
  implies the other.

**AND THE SHARED COLLAPSIBLE NOW CARRIES IT TOO (Phase-C todo 14) [EXISTS].**
`lib/components/custom/CollapsibleSection.svelte` used the identical
`grid-template-rows` + `overflow: hidden` + `inert` shape and therefore carried
the identical escaping layout box — which mattered most on the modem dialog's
own **Advanced** disclosure (`modem-advanced-body`), where four instrument cards
and the USB-composition switch sit. It has the same one-line, transitioned
`visibility` gate now, so every consumer gets it at once: the modem dialog and
the three DevTools panels.

`ModemConfigDialog`'s SMS card (`modem-sms-card`) is the deliberate exception
and needs nothing: its CONTENT is `{#if}`-gated, so a collapsed inbox holds no
element in the DOM at all and there is no box to escape. That gate exists for a
privacy reason (one-time codes) and is what incidentally covers this too — do
not "unify" it with the outer disclosure.

**ONE CONSEQUENCE WORTH KNOWING BEFORE YOU WRITE A TEST.** `visibility: hidden`
is honoured by Testing Library's `isInaccessible`, so a `getByRole` query can no
longer reach into a COLLAPSED disclosure — correctly, since a collapsed body is
`inert` and genuinely inaccessible, and jsdom simply could not see that before
(it never reflects `inert` to an attribute). `getByTestId` is unaffected, which
is why only role/accessible-name assertions needed a step. The unit twin of the
e2e helper is `src/tests/helpers/modem-advanced.ts` (`openModemAdvanced()`,
idempotent, no-ops when there is no disclosure); `ModemConfigDialog.sms.test.ts`
and `.usbmode.test.ts` are its first two callers.

Coverage: `CellularSection.density.test.ts` → "a collapsed disclosure hides its
content from the pointer" (the row's copy); `CollapsibleSection.test.ts` (the
shared component — the guard, its transition, and that it did NOT replace
`inert` or the CSS reveal); `ModemConfigDialog.density.test.ts` → "hides the
collapsed body from the pointer, not only from focus" (the dialog's disclosure);
and `tests/e2e/modem-advanced-disclosure.spec.ts`, which is the only half that
can prove the ESCAPING BOX — jsdom lays nothing out. That spec clicks through
`page.mouse` at coordinates MEASURED from `boundingBox()`, asserts
`document.elementFromPoint` at the trigger's centre AND all four edges, and
proves a collapsed control does not answer a hit test at its own rect. Rule-E
proof: removing the guard reddens 5 unit tests and both e2e tests (the collapsed
`modem-sms-toggle` reports VISIBLE, which is the defect itself).

**A hit-test assertion must distinguish "hit something else" from "hit
nothing".** `elementFromPoint` answers `null` outside the viewport, and
`hit?.closest(sel) !== null` is `true` for `null` — so the obvious boolean form
passes VACUOUSLY. That is not hypothetical: this spec's first run measured an
unscrolled `boundingBox()` for a disclosure below the fold in a scrolling
dialog, and its whole hit-testing section proved nothing while reporting green.
`hitOwner()` returns `"trigger" | "other" | "nothing"`, and every caller
`scrollIntoViewIfNeeded()` first.

