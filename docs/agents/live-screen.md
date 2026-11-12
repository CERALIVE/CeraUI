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

Every statement about today's code below cites `path:line` at `origin/main`
918665c9. If a file has moved on since then, find the cited line again by its
symbol name.

- **Sources.** Rows come in four origins: `capture`, `coarse`, `virtual` (the
  test pattern) and `network`
  (`packages/rpc/src/schemas/sources.schema.ts:112,148,155,162`;
  `apps/frontend/src/lib/components/custom/SourceSection.svelte:251`). The
  states are:
  - None: the `source-empty` state (`SourceSection.svelte:1212`).
  - One capture source and no saved `config.source`: the sole-camera
    auto-select line `sole-camera-auto`
    (`apps/frontend/src/main/live/StreamSetupChain.svelte:406-413`). It writes
    no config until Start (`StreamSetupChain.svelte:183-188`).
  - Several.

  Expected ranges, which are not code facts: typically two to four sources
  (HDMI, USB cameras, a network ingest, the test pattern), occasionally many
  on a USB hub. Names run from short ("HDMI") to long camera names, and German
  and Hindi labels are the overflow probes.
- **Layout.** Absent: there is no node unless the engine advertises
  `composition` (`apps/frontend/src/main/live/IdleCockpit.svelte:137,193`). A
  saved composition that the engine no longer supports shows
  `composition-stale-notice` instead (`IdleCockpit.svelte:143-144,200-203`).
  Today `CompositionCard` is mounted only by `IdleCockpit`
  (`IdleCockpit.svelte:194`; `LiveCockpit` does not import it), and it
  disables its controls whenever `isStreaming` is true
  (`apps/frontend/src/main/live/CompositionCard.svelte:97,184`). Target: the
  recomposition puts `layout-controls` into the live desk, and the
  live-layout change removes the lock.
- **Preview.**
  - Closed: today's only default
    (`apps/frontend/src/main/live/PreviewDisclosure.svelte:35`). The 768 px
    rule above replaces it.
  - Open but not started: `PreviewCanvas` starts with `enabled` false
    (`apps/frontend/src/lib/components/preview/PreviewCanvas.svelte:135`), and
    only the operator's toggle turns it on (`PreviewCanvas.svelte:860-861`).
    Opening by default therefore dials nothing.
  - Running: the canvas reports `connecting`, `waiting`, `live`,
    `reconnecting`, `unsupported` or `error` (`PreviewCanvas.svelte:81-88`).
  - Paused by the 30 s unwatched auto-stop (`PreviewCanvas.svelte:111,935-939`).
    The disclosure's `open` is the canvas's `hostActive`
    (`PreviewDisclosure.svelte:48`), so a collapsed disclosure counts as
    unwatched (`PreviewCanvas.svelte:904`). Resume clears the pause
    (`PreviewCanvas.svelte:873-876`).
  - Unavailable, when the engine's preview availability says so
    (`PreviewCanvas.svelte:885-888`).
- **Readiness.** The gates are checked in a fixed order: source, network,
  destination, engine
  (`apps/frontend/src/lib/streaming/go-live-readiness.ts:148`).
  - Ready: no gate is blocked.
  - Blocked: Start is disabled, and its reason is the first blocked gate in
    that order (`go-live-readiness.ts:320-321`;
    `StreamSetupChain.svelte:171-181`).
  - Warned: a warning never blocks (`go-live-readiness.ts:320-321`), so Start
    stays enabled. Where the warning shows depends on the gate:
    - The destination row shows its warning reason
      (`StreamSetupChain.svelte:238-240,248-252`).
    - The encoder row takes the warning tone when its config row flags one,
      with no reason line (`StreamSetupChain.svelte:226-237,245-247`).
    - An engine warning (engine starting, schema mismatch) has no row and
      shows in `CapabilityTierBanner` (`StreamSetupChain.svelte:169-170`;
      `go-live-readiness.ts:279-296`).
    - The source and network gates never warn: they are either ok or blocked
      (`go-live-readiness.ts:174-205,214-223`).
  - Starting: Start is disabled with the starting reason while the optimistic
    start is in flight (`StreamSetupChain.svelte:171-174`).
  - Engine unavailable, or control channel down: the engine gate blocks
    (`go-live-readiness.ts:279-289`).
- **Live.**
  - Banners: none, one or several at once, each with its own condition:
    - Capture bands: standby, composition suspended, passthrough suspended
      and rate adapted
      (`apps/frontend/src/main/live/LiveCockpit.svelte:186,218`).
    - Source lost (`LiveCockpit.svelte:191,262`).
    - Video signal lost, hidden while the source-lost banner or standby shows
      (`LiveCockpit.svelte:208-209`).
    - Audio lost (`LiveCockpit.svelte:202`).
    - All links down (`LiveCockpit.svelte:195,308`).
  - Source switch (`apps/frontend/src/main/live/LiveSourceSwitch.svelte`):
    - When the engine reports a session roster (`activeEncode.switch_targets`,
      `LiveSourceSwitch.svelte:76`), the roster is authoritative. The card
      shows when the roster names at least two distinct inputs
      (`LiveSourceSwitch.svelte:108-111`), and an input may be a capture, a
      synthetic test pattern or a network leg
      (`apps/frontend/src/lib/streaming/live-switch-rows.ts:33-62`). So one
      capture plus one synthetic leg is a switchable pair, with no second
      discovered capture
      (`apps/frontend/src/main/live/LiveSourceSwitch.test.ts:106-131`).
    - An empty roster shows no card and never falls back to the discovered
      sources. Instead a status line says no source switches are available
      in this session (`LiveSourceSwitch.svelte:77-78,270-272`).
    - Only when there is no roster does the legacy rule apply: at least two
      capture sources, and the running source is a capture or the source-lost
      state is up (`apps/frontend/src/lib/streaming/live-source-state.ts:75-82`;
      `LiveSourceSwitch.svelte:108-110`). A status line then says the engine
      does not report switch targets (`LiveSourceSwitch.svelte:77,270-272`).
  - The post-stream summary window: the live controls hide
    (`LiveCockpit.svelte:324`), `IngestStats` stays mounted and shows the
    session summary (`LiveCockpit.svelte:385`), and Done replaces Stop
    (`LiveCockpit.svelte:387-394`).
- **Audio.**
  - Today, idle: the Source card's `source-audio` block holds one source
    picker and a meter for the source picked above it. The block shows once a
    source is in effect (`SourceSection.svelte:245,1233,1504`).
  - Today, live: the audio line and its meter sit in `LiveSummaryStrip`
    (`apps/frontend/src/main/live/LiveSummaryStrip.svelte:131-155`).
  - Target, with `audio_mix`: up to four input strips, each with its own meter
    while live. Nothing in today's code reads `audio_mix`.
- **Languages.** There are ten catalogs: `ar`, `de`, `en`, `es`, `fr`, `hi`,
  `ja`, `ko`, `pt-BR` and `zh` (`packages/i18n/messages/*.json`).
  - Arabic sets `dir="rtl"` on the document
    (`packages/i18n/src/locale-lifecycle.ts:48,69-70`;
    `apps/frontend/src/main/Layout.svelte:219`).
  - Japanese, Korean and Chinese fall back to system fonts, because Space
    Grotesk has no CJK glyphs (`apps/frontend/tailwind.config.ts:103-105`).

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
