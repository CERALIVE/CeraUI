## LIVE SCREEN: CONTRACT AND DESIGN BRIEF [GREENFIELD]

This is the target structure of the Live destination, written before any of it
is built. Today's shipped screen is still described by
[device-first-source-model-go-live-card.md](device-first-source-model-go-live-card.md),
and that contract stays true until the recomposition lands. Each later change
that builds a part of this file flips that part's label to `[EXISTS]` in the
same change.

The changes that implement it, in order:

1. Recompose the Live screen into the program desk, the cards and the Live bar.
2. Let the layout, the opacity and the second input change while live.
3. Replace the Passthrough and Codec selectors in the Encoder dialog with an
   automatic format, one adaptive-bitrate switch and one line that says what
   the device will do.
4. Show an audio strip per input in the Audio card.
5. Place the second picture input on the preview.
6. Do a final design pass on the Live screen and the Encoder dialog.

Design authority: [`.impeccable.md`](../../.impeccable.md) for the look,
[`DESIGN.md`](../../DESIGN.md) for truthfulness and structure, and
[`PRODUCT.md`](../../PRODUCT.md) for users and principles. The surface mode is
**Operate**: the operator completes a task, so scanability, consistency and the
real usage scene come before expression.

### The fixed structure

The regions, their order, their test ids and what each control does are
settled. The later changes implement them and do not reopen them. Design work
covers hierarchy, spacing, typography, color within the existing tokens,
motion, copy tone and states.

#### Regions

| Test id | Holds | Rendered when |
| --- | --- | --- |
| `program-desk` | The preview (`preview-disclosure`) and, after it, `layout-controls`. While live it also holds `LiveSummaryStrip` and `LiveSourceSwitch`. | Always, in both cockpits. |
| `layout-controls` | The picture layout controls (today `CompositionCard`: the six layout presets, opacity and the second input). | Only when the engine advertises the `composition` feature. |
| `audio-card` | Idle: today's `source-audio` content (audio source picker, the "Codec & delay" button that opens the Audio dialog, the idle meter for the main input). Live: the mixer strips. | Idle: whenever the Source card shows audio today. Live: only when the engine advertises `audio_mix`. |
| `output-card` | The encoder row and the destination row of the stream setup (`setup-row` with `data-row="encoder"` and `data-row="destination"`), with the bitrate-ceiling chip and the destination traffic light. | Idle, always. |
| `connections-card` | The network row (`setup-row` with `data-row="network"`). | Idle, always. |
| `telemetry-card` | `StreamTelemetryStrip` and `IngestStats`. | Live and in the post-stream summary window. |
| `live-bar` | Idle: the first blocking reason or a ready state, and Start. Live: `BitrateAdjuster` and Stop. Summary window: Done. | Always, in both cockpits. |

Every existing test id keeps its name and meaning, including `idle-cockpit`,
`live-cockpit`, `source-section`, `source-audio`, `stream-setup-chain`,
`setup-row`, `preview-disclosure`, `composition-card`, `live-roadmap`,
`live-summary-strip` and `summary-done`. No region or test id is added beyond
the table above.

#### Idle order, inside the existing `idle-cockpit` root

1. `program-desk`: the preview (`preview-disclosure`), then `layout-controls`.
2. `source-section`, its source rows shown as tiles, and inside it, after the
   rows, `audio-card`.
3. `stream-setup-chain`, holding `output-card` (the encoder row and the
   destination row), `connections-card` (the network row) and, last,
   `live-bar`.
4. `live-roadmap`.

#### Live order, inside the existing `live-cockpit` root

1. The existing banners (capture standby, composition suspended, passthrough
   suspended, rate adapted, source lost, signal lost, audio lost, all links
   down), unchanged.
2. `program-desk`, with the preview, `LiveSummaryStrip`, `LiveSourceSwitch` and
   `layout-controls`.
3. `audio-card`, only when the engine advertises `audio_mix`. It holds the
   mixer strips. Without `audio_mix`, the live audio line and its meter stay in
   `LiveSummaryStrip` as they are today.
4. `telemetry-card`, with `StreamTelemetryStrip` and `IngestStats`.
5. `live-bar`, with `BitrateAdjuster` and the Stop button, or the Done button
   in the post-stream summary window.

#### The Live bar

- `live-bar` stays fixed to the bottom of the viewport on every screen size,
  directly above the mobile dock when the dock is shown.
- Idle, it shows the first blocking reason from `deriveGoLiveReadiness`, or a
  ready state, and Start.
- Live, it shows the bitrate control and Stop.

#### Screen sizes

- At 1024 px and wider the screen has two columns: `program-desk` on the left,
  everything else on the right, and `live-bar` across the bottom.
- Below 1024 px the screen is one column, in the order above.
- At 1024x600 nothing overflows horizontally and Start is visible without
  scrolling.

#### The preview's open state

`preview-disclosure` is open by default when the viewport is at least 768 px
wide and closed by default below that. The operator's last choice is kept in
`localStorage` under the key `ceraui.live.previewOpen` and wins over the
default.

#### Dialogs

The Encoder, Audio and Server dialogs stay dialogs. `output-card` opens the
Encoder dialog (encoder row, bitrate-ceiling chip) and the Server dialog
(destination row); `audio-card` opens the Audio dialog. The network row still
goes to the Network destination. The dialogs are also the federated bundles
the cloud dashboard mounts, so they keep federation ABI 1.

### 1. Job and audience

- **Operator, before going live.** Sets up a bonded stream on a phone in the
  field, a tablet at an event, a laptop or desktop in a studio, or the 1024x600
  kiosk touchscreen, often in a hurry. The job is to pick what to stream, see
  it, set how the picture is laid out, check the audio, confirm where it goes
  and over which links, then press Start.
- **Operator, while live.** Watches the picture and the telemetry and reacts:
  switches the source, changes the layout or the audio, nudges the bitrate,
  stops. They need status at a glance and one obvious control for each action,
  not configuration menus.
- **Cloud dashboard user.** Never sees this screen. They edit the Encoder,
  Audio and Server dialogs that the platform loads per device version. This
  screen opens those same dialogs and must not change them.

### 2. Outcome and proof

- **Primary action.** Start when idle, Stop when live. It is always on screen in
  the Live bar, on every size, without scrolling.
- **Success.** Every concept is one hop away on one screen: the picture and its
  layout in the desk, the source and its audio in the Source card, the encoder
  and the destination in the Output card, the links in the Connections card.
  Today the same concepts sit across a card, two dialogs, a conditional card and
  a collapsed preview.
- **Product truth.** The engine decides what is possible. Layout controls exist
  only when the engine advertises `composition`, and mixer strips only when it
  advertises `audio_mix`. A control the engine cannot honor contributes no DOM
  node (DESIGN.md section 1, CT-1 to CT-5). Readiness comes from
  `deriveGoLiveReadiness` and is never re-derived.
- **Proof the later changes must show.**
  - Unit order tests: `IdleCockpit.order.test.ts` changes to the idle order
    above and lists the change before and after. New tests pin the live order
    and the preview's open state. `StreamSetupChain.test.ts` and
    `LiveView.idle-order.test.ts` pass unedited.
  - Rendered on the mock stack at 375x812, 768x1024, 1280x900 and 1024x600, in
    dark and light, in English, Spanish and Arabic, with one screenshot per
    viewport.
  - At 1024x600, `document.documentElement.scrollWidth <= 1024` and the Start
    button's bounding box is inside the viewport without scrolling.

### 3. Selected direction

- **Visual authority.** The incumbent Ground Control world (warm graphite,
  phosphor lime reserved for the live signal, amber and coral for state, Space
  Grotesk for labels and JetBrains Mono for values). This is a refinement of
  the existing screen, not a new visual world, and adds no token.
- **Structural thesis: desk, cards, bar.** The picture is the instrument's
  display, so it leads, in the desk. Configuration follows in cards ordered the
  way the signal flows: source and its audio, then output, then connections.
  The one consequential action lives in a bar that never scrolls away.
- **References, structure only.** From
  [eirl-encoder](https://github.com/enhanced-irl/eirl-encoder): the program
  preview with source slots, layout buttons next to the picture, and an audio
  strip per source. From [irl4you-pip](https://github.com/IRL4YOU/irl4you-pip):
  cards ordered by task with a Live bar at the bottom. Neither one's look is
  borrowed.
- **Focal moment.** Idle: the Live bar's readiness line and Start, which
  answer "can I go live, and if not, why". Live: the program picture with the
  summary of what is on air.
- **Implementation consequence.** A `ProgramDesk` wrapper hosts the preview and
  the layout controls. `StreamSetupChain` groups its existing rows into the
  Output and Connections cards and hosts the Live bar. `LiveCockpit` regroups
  its existing children into the desk, the telemetry card and the bar. No
  logic moves between components; `LiveView` keeps owning every piece of state
  and every handler.

### 4. Scope and boundaries

- **In scope.** The regions, their order, the Live bar, the two-column layout,
  the preview's default open state, and the states listed below.
- **Fidelity.** Production. Each change listed at the top ships behind its own
  tests.
- **Untouched.**
  - `deriveGoLiveReadiness` and its gate order (source, network, destination,
    engine).
  - The Encoder, Audio and Server dialogs as surfaces, and federation ABI 1.
  - Everything above the cockpit roots in `LiveView`: `LiveHeader`,
    `CapabilityTierBanner`, the config-change applying banner, the stop-stuck
    banner, `UnconfirmedStreamBand` and `UpdateRefusalBand`.
  - The HUD, the Network and Settings destinations, the design tokens, the
    unmounted deprecation shims, and every existing test id.
- **Anti-goals.**
  - No inline mega-form: configuration stays in dialogs (`PRODUCT.md`
    principle 3).
  - No bordered card inside another bordered card. `audio-card` inside
    `source-section`, and `output-card` and `connections-card` inside
    `stream-setup-chain`, render as titled groups separated by a hairline
    divider inside their host card, the way `source-audio` sits in the Source
    card today.
  - No hero metric, no gradient text, no side-stripe accent, no
    per-section uppercase eyebrow label.
  - No second `PreviewCanvas`, and no second Start or Stop button.

### 5. States and ranges

- **Sources.** None (the existing `source-empty` state), one (the sole-camera
  auto-select line), typically two to four (HDMI, USB cameras, a network
  RTMP or SRT ingest, the test pattern), and occasionally many on a USB hub.
  Names run from short ("HDMI") to long camera names, and German and Hindi
  labels are the overflow probes.
- **Layout.** Absent (no node; a saved composition that the engine no longer
  supports keeps showing `composition-stale-notice`), idle, and live. Live
  changes are locked until the change that unlocks them lands.
- **Preview.** Closed; open but not started; playing; paused by the 30 s
  unwatched auto-stop (collapsing the disclosure counts as unwatched);
  unavailable. Opening by default does not start anything: `PreviewCanvas`
  stays disabled until the operator starts it.
- **Readiness.** Ready; blocked, with the first blocked gate's reason;
  warned (advisory, Start stays enabled and the warning stays on its row);
  starting (the optimistic start state on the button); engine unavailable.
- **Live.** Zero to several banners at once; the source switch present only
  with two or more capture sources; the post-stream summary window, where the
  bar shows Done and the telemetry card shows the session summary.
- **Audio.** Before `audio_mix`: one source picker and the main input's meter,
  as today. With `audio_mix`: up to four input strips, each with its own meter
  while live.
- **Languages.** All ten locales; Arabic is right-to-left; Japanese, Korean and
  Chinese use the system font fallbacks.

### 6. Interaction and layout

- **Hierarchy.** Idle: the picture the audience will see, then what feeds it
  and its audio, then where it goes and over which links, then the roadmap.
  Live: alerts first, then the picture and what is on air, then audio, then
  telemetry.
- **Two columns, 1024 px and wider.** The desk column is the wider one, because
  the preview is 16:9 and is the screen's display. The cards column holds the
  rest in order. "Left" means the inline-start side, so in Arabic the desk sits
  on the right. Inside `live-cockpit`, the banners lead the cards column.
- **One column, below 1024 px.** The order above, top to bottom. On a phone the
  preview starts closed, so the source tiles come first after the desk's
  disclosure line.
- **Source tiles.** Each source is a compact tile with its name, its kind badge
  and its state, keeping the row's test ids and its selection semantics. Tiles
  wrap in a grid and never shrink below the width that keeps a name readable on
  two lines, so a phone shows one or two per row. Detail that today expands
  inside a row (modes, network-ingest instructions and QR, suggestions) opens
  below the selected tile across the card's full width, so the tiles stay the
  same height.
- **Live bar placement.** On mobile chrome (below `DESKTOP_CHROME_QUERY` in
  `apps/frontend/src/lib/layout.ts`) it sits directly above the dock, offset by
  `--mobile-dock-height`. On desktop chrome (1024 px and wider, or a short
  landscape kiosk panel) it sits at the viewport bottom and spans the content
  area, not the navigation rail. The page reserves bottom space equal to the
  bar's height, so the last card is never hidden under it, and toasts stay
  above it.
- **Live bar content.** The reason or ready line is words, not color alone. It
  wraps to at most two lines; the full set of gates stays readable in the
  setup rows. The bar's height does not jump when its line changes.
- **Focus order.** In the DOM the bar sits where the order lists it (last in
  `stream-setup-chain`, last in `live-cockpit`), so keyboard and screen-reader
  order follows reading order even though the bar is fixed on screen.
- **Feedback.** Start uses the existing optimistic `starting` state; the idle
  and live cockpits still switch on the optimistic streaming edge, so Start
  never flickers back. A disabled Start shows its reason next to it (CT-2),
  never only in a tooltip.
- **Motion.** None is added beyond today's. Opening and closing the preview
  respects `prefers-reduced-motion`.
- **Touch.** Every control keeps 44 px in touch mode through the existing
  `--touch-target-min` token layer, with at least 8 px between neighbors.

### 7. Constraints and open decisions

- **Platform.** The Svelte 5 PWA, Tailwind with the existing tokens, the
  existing primitives (`Card`, `Button`, `AppDialog`, `StreamControlButton`,
  `BitrateAdjuster`). No new dependency.
- **One preview.** Exactly one mounted `PreviewCanvas`: it mints the
  single-use token, dials the `/preview` proxy and owns the 30 s viewer
  auto-stop.
- **One Start.** `StreamControlButton` is mounted once per cockpit, inside
  `live-bar`.
- **Accessibility.** WCAG AA in dark and light, logical properties for
  right-to-left, reduced motion, and the 44 px touch layer.
- **Localization.** Every new string is a new key in all ten
  `packages/i18n/messages/*.json` files, written natively per locale. Existing
  keys keep their text, and nothing writes
  `packages/i18n/tests/fixtures/*.rendered.json`.
- **Open for the final design pass.** Whether the desk column stays pinned while
  the cards column scrolls on wide screens, and the exact width split between
  the two columns. Builders before that pass keep both columns scrolling with
  the page.

#### Assumptions made without an interview

The structure above came settled, so no discovery interview ran. These
readings fill gaps in it and can be corrected in a later change:

1. "Left" for the desk column means the inline-start side, mirrored in Arabic.
2. Inside `live-cockpit`, the banners lead the cards column at 1024 px and
   wider; the `LiveView` banners above the cockpit stay full width.
3. Regions named "card" inside a host card are titled groups, not second
   bordered surfaces.
4. `composition-stale-notice` keeps its id and takes the place of
   `layout-controls` inside `program-desk` when `composition` is not
   advertised.
5. The 768 px default is read once, at first render. Resizing later does not
   flip it, and only the operator's own toggle is stored.
6. The stored value is the string `true` or `false`; any other value is
   treated as absent.
7. On a short landscape kiosk narrower than 1024 px (for example 800x480) the
   screen is one column and the Live bar sits at the viewport bottom, because
   desktop chrome shows no dock there.
8. Source tiles and the full-width detail below the selected tile are this
   brief's reading of "rows shown as tiles".
