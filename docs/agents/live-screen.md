## LIVE SCREEN: CONTRACT AND DESIGN BRIEF [GREENFIELD]

This file is the target structure of the Live destination, written before any
of it is built. It is not a description of today's screen.

How to read it:

- A sentence that starts with **Today** describes the code at `origin/main`
  cf14b600 and cites one `path:line`. If the file has moved on since then, find
  the line again by its symbol name.
- Every other sentence is a requirement ("must") or a design decision for the
  changes below.

The changes that implement this file, in order. Each must flip the label of the
part it builds to `[EXISTS]` in the same change.

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
settled. The changes above must implement them and must not reopen them.
Design work covers hierarchy, spacing, typography, color within the design
tokens, motion, copy tone and states.

#### Regions

| Test id | Must hold | Must render |
| --- | --- | --- |
| `program-desk` | The preview (`preview-disclosure`) and, after it, `layout-controls`. While live, also `LiveSummaryStrip` and `LiveSourceSwitch`. | In both cockpits. |
| `layout-controls` | The controls of `CompositionCard`. | When the engine advertises the `composition` feature. |
| `audio-card` | Idle: the `source-audio` block. Live: the mixer strips. | Idle: when the `source-audio` block renders. Live: when the engine advertises `audio_mix`. |
| `output-card` | The encoder row and the destination row of the stream setup, with the bitrate-ceiling chip and the destination traffic light. | Idle, when those rows render. |
| `connections-card` | The network row. | Idle. |
| `telemetry-card` | `StreamTelemetryStrip` and `IngestStats`. | Live, and in the post-stream summary window. |
| `live-bar` | Idle: the first blocking reason or a ready state, and Start. Live: `BitrateAdjuster` and Stop. Summary window: Done. | In both cockpits. |

These test ids must keep their names and meaning: `idle-cockpit`,
`live-cockpit`, `source-section`, `source-audio`, `open-audio-dialog`,
`stream-setup-chain`, `setup-row`, `preview-disclosure`, `composition-card`,
`composition-stale-notice`, `live-roadmap`, `live-summary-strip` and
`summary-done`. No region or test id may be added beyond the table above.

**Today** `IdleCockpit` mounts `CompositionCard` when the engine's capability
features include `composition`
(`apps/frontend/src/main/live/IdleCockpit.svelte:137-194`). **Today**, when a
composition is saved but the engine does not advertise the feature,
`IdleCockpit` shows `composition-stale-notice` instead
(`apps/frontend/src/main/live/IdleCockpit.svelte:143-203`).

#### Idle order, inside the `idle-cockpit` root

1. `program-desk`: the preview (`preview-disclosure`), then `layout-controls`.
2. `source-section`, its source rows shown as tiles, and inside it, after the
   rows, `audio-card`.
3. `stream-setup-chain`, holding `output-card` (the encoder row and the
   destination row), `connections-card` (the network row) and, last,
   `live-bar`.
4. `live-roadmap`.

**Today** a unit test pins the idle order as `source-section`,
`preview-disclosure`, `stream-setup-chain`, `live-roadmap`
(`apps/frontend/src/main/live/IdleCockpit.order.test.ts:50-55`). **Today** an
end-to-end test asserts that `preview-disclosure` and `source-section` share a
parent element (`apps/frontend/tests/e2e/liveview-preview.spec.ts:166-169`).
The recomposition changes both expectations and must list each one before and
after in its pull request.

**Today** the Source card's `source-audio` block contains the
`open-audio-dialog` button, which opens the Audio dialog
(`apps/frontend/tests/e2e/live.spec.ts:82`). `audio-card` must contain that
block with its ids unchanged.

#### Live order, inside the `live-cockpit` root

1. The banners that `LiveCockpit` mounts before `LiveSummaryStrip` (see
   below), unchanged.
2. `program-desk`, with the preview, `LiveSummaryStrip`, `LiveSourceSwitch` and
   `layout-controls`.
3. `audio-card`, when the engine advertises `audio_mix`. It holds the mixer
   strips. Without `audio_mix`, the live audio line and its meter must stay in
   `LiveSummaryStrip`.
4. `telemetry-card`, with `StreamTelemetryStrip` and `IngestStats`.
5. `live-bar`, with `BitrateAdjuster` and the Stop button, or the Done button
   in the post-stream summary window.

**Today**, outside the summary window, `LiveCockpit` mounts after its banners
`LiveSummaryStrip`, `LiveSourceSwitch`, `PreviewDisclosure`,
`StreamTelemetryStrip` and `BitrateAdjuster`, then `IngestStats` and Stop
(`apps/frontend/src/main/live/LiveCockpit.svelte:218-407`). **Today**
`summary-done` renders in the summary window and is absent outside it
(`apps/frontend/src/main/live/LiveCockpit.test.ts:79-96`). **Today**
`LiveSummaryStrip` holds the live audio line, when there is one, and an audio
level meter under it (`apps/frontend/src/main/live/LiveSummaryStrip.svelte:131-155`).

#### The Live bar

- `live-bar` must stay fixed to the bottom of the viewport on every screen
  size, directly above the mobile dock when the dock is shown.
- Idle, it must show the first blocking reason from `deriveGoLiveReadiness` as
  visible text, or a ready state, and Start.
- Live, it must show the bitrate control and Stop.

**Today**, while a start is in flight, Start's disabled reason is the starting
text; otherwise it is the reason of the first blocked gate that
`deriveGoLiveReadiness` reports
(`apps/frontend/src/main/live/StreamSetupChain.svelte:172-181`). **Today** a
disconnected control channel blocks both the network and the engine gate, and
`deriveGoLiveReadiness` reports the network gate first
(`apps/frontend/src/lib/streaming/go-live-readiness.test.ts:533-543`). **Today** the Start
button carries that reason in its `title` attribute
(`apps/frontend/src/main/live/StreamSetupChain.test.ts:259-261`).

#### Screen sizes

- At 1024 px and wider the screen must have two columns: `program-desk` on the
  left, everything else on the right, and `live-bar` across the bottom.
- Below 1024 px the screen must be one column, in the order above.
- At 1024x600 nothing may overflow horizontally, and Start must be visible
  without scrolling.

**Today** desktop chrome applies at 1024 px wide and above, or at 768 px wide
and above when the height is 600 px or less
(`apps/frontend/src/lib/layout.ts:29-30`). **Today**, when desktop chrome does
not apply, `MainView` shows a fixed bottom dock and pads the page by
`--mobile-dock-height` (`apps/frontend/src/main/MainView.svelte:98-108`).
**Today** the toast stack is offset above the dock by the same variable
(`apps/frontend/src/tests/persistent-notice-surface.test.ts:129-137`). The Live
bar must sit above the dock using that variable, and the toast stack must sit
above the bar.

#### The preview's open state

`preview-disclosure` must be open by default when the viewport is at least
768 px wide and closed by default below that. The operator's last choice must
be kept in `localStorage` under the key `ceraui.live.previewOpen` and must win
over the default.

**Today** `preview-disclosure` starts closed when it mounts
(`apps/frontend/src/main/live/PreviewDisclosure.svelte:35`). **Today** the
preview canvas stays off until the operator enables it with its own toggle
(`apps/frontend/src/lib/components/preview/PreviewCanvas.test.ts:144-154`), so
an open disclosure does not by itself start a preview. **Today** end-to-end
helpers open the disclosure by clicking its summary
(`apps/frontend/tests/e2e/liveview-preview.spec.ts:119-124`). A click on a
`<details>` summary toggles it, so with an open default on wide viewports the
recomposition must update those helpers.

#### One cockpit, one preview

**Today** `LiveView` mounts `LiveCockpit` or `IdleCockpit` through one if/else
branch (`apps/frontend/src/main/LiveView.svelte:1043-1107`). The Live screen
must mount one `PreviewCanvas` and one Start or Stop button at a time; a
dialog opened over it is outside this rule.

#### Dialogs

The Encoder, Audio and Server dialogs must stay dialogs. `output-card` must
open the Encoder dialog (encoder row, bitrate-ceiling chip) and the Server
dialog (destination row); `audio-card` must open the Audio dialog; the network
row must go to the Network destination.

**Today** the federated bundles are `encoder.js`, `audio.js` and `server.js`,
built from the Encoder, Audio and Server entry points
(`docs/agents/federation-producer-pipeline.md:16-18`). **Today** a test pins
the federation ABI version at 1
(`apps/frontend/src/lib/federation/host-contract.test.ts:57`). These dialogs
must keep that ABI.

### 1. Job and audience

- **Operator, before going live.** Sets up a bonded stream on a phone in the
  field, a tablet at an event, a laptop or desktop in a studio, or the 1024x600
  kiosk touchscreen, often under time pressure (`PRODUCT.md`, Users). The job
  is to pick what to stream, see it, set the picture layout, check the audio,
  confirm where it goes and over which links, then press Start.
- **Operator, while live.** Watches the picture and the telemetry and reacts:
  switches the source, changes the layout or the audio, nudges the bitrate,
  stops. The screen must give status at a glance and one obvious control for
  each action.
- **Cloud dashboard user.** Edits the Encoder, Audio and Server dialogs
  remotely. This screen opens those same dialogs and must not change them.

### 2. Outcome and proof

- **Primary action.** Start when idle, Stop when live. It must stay on screen
  in the Live bar, on every size, without scrolling.
- **Success.** Every concept must be one hop away on one screen: the picture
  and its layout in the desk, the source and its audio in the Source card, the
  encoder and the destination in the Output card, the links in the Connections
  card.
- **Product truth.** The engine decides what is possible. A control the engine
  cannot honor must contribute no DOM node (`DESIGN.md` section 1, CT-1 to
  CT-5). The Live bar must take readiness from `deriveGoLiveReadiness` and must
  not derive its own.
- **Proof the changes must show.**
  - Order tests for the idle order, the live order and the preview's open
    state, with each changed expectation listed before and after.
    `StreamSetupChain.test.ts` and `LiveView.idle-order.test.ts` must pass
    unedited.
  - Screenshots on the mock stack at 375x812, 768x1024, 1280x900 and 1024x600,
    in dark and light, in English, Spanish and Arabic.
  - At 1024x600, `document.documentElement.scrollWidth <= 1024` and the Start
    button's bounding box inside the viewport without scrolling.

### 3. Selected direction

- **Visual authority.** The Ground Control world of `.impeccable.md`. This
  work refines the screen within that world and must add no token.
- **Structural thesis: desk, cards, bar.** The picture is the instrument's
  display, so it leads, in the desk. Configuration follows in cards ordered the
  way the signal flows: source and its audio, then output, then connections.
  The one consequential action must live in a bar that does not scroll away.
- **References, structure only.** The owner named
  [eirl-encoder](https://github.com/enhanced-irl/eirl-encoder) (program
  preview, sources, layout buttons, an audio strip per source) and
  [irl4you-pip](https://github.com/IRL4YOU/irl4you-pip) (task-ordered cards
  with a Live bar at the bottom). Their look must not be borrowed.
- **Focal moment.** Idle: the Live bar's readiness line and Start. Live: the
  program picture with the summary of what is on air.
- **Implementation consequence.** A `ProgramDesk` wrapper must host the preview
  and the layout controls. `StreamSetupChain` must group its rows into the
  Output and Connections cards and host the Live bar. `LiveCockpit` must
  regroup its children into the desk, the telemetry card and the bar. No
  component may move state, RPC calls or handlers to another component.

### 4. Scope and boundaries

- **In scope.** The regions, their order, the Live bar, the two-column layout,
  the preview's default open state, and the states below.
- **Fidelity.** Production. Each change must ship behind its own tests.
- **Must not change.** `deriveGoLiveReadiness` and its gate order; the Encoder,
  Audio and Server dialogs as surfaces; anything `LiveView` renders above the
  cockpit roots; the HUD; the Network and Settings destinations; the design
  tokens; any deprecation shim registered in `docs/TECHNICAL_DEBT.md`; the test
  ids listed above.
- **Anti-goals.**
  - No inline mega-form: configuration complexity must stay in focused
    dialogs (`PRODUCT.md`, principle 3).
  - No bordered card inside another bordered card. `audio-card`, `output-card`
    and `connections-card` must render as titled groups separated by a hairline
    divider inside their host card.
  - No hero metric, no gradient text, no side-stripe accent, no per-section
    uppercase eyebrow label (`PRODUCT.md`, anti-references).

### 5. States and ranges

The screen must handle each of these states:

- **Sources.** None, one, several, and many on a USB hub, with names from
  "HDMI" to long camera names. German and Hindi labels must serve as the
  overflow probes.
- **Layout.** No `composition` feature, the stale notice, idle, and live.
- **Preview.** Closed, open but not started, playing, paused after it goes
  unwatched, and unavailable.
- **Readiness.** Ready, blocked, warned (which must not block Start), starting,
  and engine unavailable or channel disconnected.
- **Live.** Zero or several banners, the source switch shown or not, and the
  post-stream summary window.
- **Audio.** One source picker and its meter without `audio_mix`; up to four
  input strips with a meter each while live with `audio_mix`.
- **Languages.** **Today** ten locales ship
  (`packages/i18n/src/locale-lifecycle.ts:28-38`). **Today** choosing Arabic
  sets `dir="rtl"` on the document
  (`apps/frontend/src/main/Layout.svelte:219`). Every locale must render
  without overflow, and Arabic must mirror the layout.

### 6. Interaction and layout

- **Hierarchy.** Idle: the picture, then what feeds it and its audio, then
  where it goes and over which links, then the roadmap. Live: alerts first,
  then the picture and what is on air, then audio, then telemetry.
- **Two columns.** The desk column must be the wider one, because the preview
  is 16:9. "Left" means the inline-start side. Inside `live-cockpit` the
  banners must lead the cards column.
- **Source tiles.** Each source must be a compact tile with its name, its kind
  badge and its state, keeping the row's test ids and selection semantics.
  Tiles must wrap in a grid and stay readable on two lines, so a phone shows
  one or two per row. A tile's detail must open below it across the card's full
  width, so the tiles keep one height.
- **Live bar content.** The reason or ready line must be words, not color
  alone, must wrap to at most two lines, and must not change the bar's height.
- **Focus order.** In the DOM the bar must sit where the order lists it, so
  keyboard and screen-reader order follows reading order.
- **Motion.** Any motion added must respect `prefers-reduced-motion`
  (`DESIGN.md`, RM-1).
- **Touch.** In touch mode, targets must be at least 44 px with 8 px between
  neighbors, through the token layer that `DESIGN.md` TT-3 requires (`DESIGN.md`,
  TT-1 to TT-3).

### 7. Constraints and open decisions

- **Platform.** The work must reuse `Card`, `Button`, `AppDialog`,
  `StreamControlButton`, `BitrateAdjuster` and the design tokens, with no new
  dependency.
- **Accessibility.** WCAG AA in dark and light, logical properties for
  right-to-left, and the 1024x600 kiosk fit (`PRODUCT.md`, Accessibility).
- **Localization.** Every new string must be a new key in each
  `packages/i18n/messages/*.json` file, written natively per locale. Keys that
  are already there must keep their text, and nothing may write
  `packages/i18n/tests/fixtures/*.rendered.json`.
- **Open for the final design pass.** Whether the desk column stays pinned while
  the cards column scrolls on wide screens, and the width split between the two
  columns. Until then both columns must scroll with the page.

#### Assumptions made without an interview

The structure above came settled, so no discovery interview ran. These
readings fill gaps in it and can be corrected in a later change:

1. "Left" for the desk column means the inline-start side, mirrored in Arabic.
2. Inside `live-cockpit`, the banners lead the cards column at 1024 px and
   wider; anything `LiveView` renders above the cockpit stays full width.
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
   that size gets desktop chrome without a dock (see "Screen sizes").
8. Source tiles and the full-width detail below the selected tile are this
   brief's reading of "rows shown as tiles".
