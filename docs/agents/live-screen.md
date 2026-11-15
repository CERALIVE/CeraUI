## LIVE SCREEN: CONTRACT AND DESIGN BRIEF [PARTIAL]

This file is the target structure of the Live destination, written before any
of it was built.

Status: changes 1 to 5 below have landed — the regions, both orders, the Live
bar, the two-column layout and the preview's open state exist as described, the
layout, the opacity and the second input change while live, the Encoder
dialog has the automatic format, the adaptive switch and the route line, the
Audio card has a strip per input, and the second input is placed on the
preview. Change 6 is still to come.

How to read it:

- A sentence that starts with **Today** describes a constant, a document or
  what a test asserts at `origin/main` cf14b600, and cites one `path:line`. If
  the file has moved on since then, find the line again by its symbol name.
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

#### The layout while live [EXISTS]

- While live, the six layout radios, the opacity control
  (`composition-alpha-control`) and the second-input select
  (`composition-secondary`) stay enabled. Each change is sent as
  `streaming.setConfig({ composition, apply_now: true })`, so the backend runs
  it as an apply-now transaction and keeps it only when the engine reports it
  applied. The opacity is sent once, as one change, when the drag is
  released, when the last held adjusting key (arrows, Home, End, PageUp,
  PageDown) comes up, or when focus leaves the slider; never once per step.
  Releasing any other key (Shift, Escape, Enter) neither sends nor ends it.
  A key is released by its physical key (its code), so a keyup that reports a
  different key, such as a shifted Numpad4, still ends the adjustment.
- Until the engine answers, the new value shows as the choice and the controls
  are busy. Any apply-now change in flight, from this card or from the Encoder
  dialog, holds the controls.
- A refused or reverted change puts the previous value back and shows the
  engine's reason, as keyed copy, in an alert below the controls, so a late
  answer never moves a control the operator is touching.
- Turning composition on or off still applies at the next start:
  `composition-enable` stays disabled while live, with `composition-locked`
  beside it.
- Idle, a change is the plain save, without `apply_now`.

#### Idle order, inside the `idle-cockpit` root

1. `program-desk`: the preview (`preview-disclosure`), then `layout-controls`.
2. `source-section`, its source rows shown as tiles, and inside it, after the
   rows, `audio-card`.
3. `stream-setup-chain`, holding `output-card` (the encoder row and the
   destination row), `connections-card` (the network row) and, last,
   `live-bar`.
4. `live-roadmap`.

**Today** a unit test expects the idle order `source-section`,
`preview-disclosure`, `stream-setup-chain`, `live-roadmap`
(`apps/frontend/src/main/live/IdleCockpit.order.test.ts:50-55`). **Today** an
end-to-end test expects `preview-disclosure` and `source-section` to share a
parent element (`apps/frontend/tests/e2e/liveview-preview.spec.ts:166-169`).
The recomposition must change both expectations and list each one before and
after in its pull request.

**Today** an end-to-end test, after it selects a source, expects one
`open-audio-dialog` inside `source-audio` and expects it to open the Audio
Settings dialog (`apps/frontend/tests/e2e/live.spec.ts:76-86`). `audio-card`
must contain the `source-audio` block with its ids unchanged.

#### Live order, inside the `live-cockpit` root

1. The status banners of `LiveCockpit`. This work must not change their content
   or the conditions that show them.
2. `program-desk`, with the preview, `LiveSummaryStrip`, `LiveSourceSwitch` and
   `layout-controls`.
3. `audio-card`, when the engine advertises `audio_mix`. It holds the mixer
   strips. Without `audio_mix`, the live audio line and its level meter must be
   shown in `LiveSummaryStrip`.
4. `telemetry-card`, with `StreamTelemetryStrip` and `IngestStats`.
5. `live-bar`, with `BitrateAdjuster` and the Stop button, or the Done button
   in the post-stream summary window.

#### The Live bar

- `live-bar` must stay fixed to the bottom of the viewport on every screen
  size, directly above the mobile dock when the dock is shown.
- Idle, it must show the first blocking reason from `deriveGoLiveReadiness` as
  visible text, or a ready state, and Start.
- Live, it must show the bitrate control and Stop.

#### Screen sizes

- At 1024 px and wider the screen must have two columns: `program-desk` on the
  left, everything else on the right, and `live-bar` across the bottom.
- Below 1024 px the screen must be one column, in the order above.
- At 1024x600 nothing may overflow horizontally, and Start must be visible
  without scrolling.

**Today** `DESKTOP_CHROME_QUERY` is
`(min-width: 1024px), (min-width: 768px) and (max-height: 600px)`
(`apps/frontend/src/lib/layout.ts:29-30`). **Today** `app.css` sets
`--mobile-dock-height` to 7rem and documents it as the height of the fixed
mobile dock (`apps/frontend/src/app.css:230-235`). The Live bar must sit above
the mobile dock, offset by `--mobile-dock-height`, and the toast stack must sit
above the Live bar.

#### The preview's open state

`preview-disclosure` must be open by default when the viewport is at least
768 px wide and closed by default below that. The operator's last choice must
be kept in `localStorage` under the key `ceraui.live.previewOpen` and must win
over the default.

**Today** end-to-end helpers open the disclosure by clicking its summary
(`apps/frontend/tests/e2e/liveview-preview.spec.ts:119-124`). A click on a
`<details>` summary toggles it, so with an open default on wide viewports the
recomposition must update those helpers.

#### One preview

The Live screen must mount one `PreviewCanvas` and one Start or Stop button at
a time; a dialog opened over it is outside this rule.

#### Dialogs

The Encoder, Audio and Server dialogs must stay dialogs. `output-card` must
open the Encoder dialog (encoder row, bitrate-ceiling chip) and the Server
dialog (destination row); `audio-card` must open the Audio dialog; the network
row must go to the Network destination.

**Today** the federated bundles are `encoder.js`, `audio.js` and `server.js`,
one per config dialog, built from the Encoder, Audio and Server entry points
(`docs/agents/federation-producer-pipeline.md:12-18`). **Today** a unit test
pins the federation ABI version at 1
(`apps/frontend/src/lib/federation/host-contract.test.ts:57`). These dialogs
must keep that ABI.

#### The Encoder dialog's output format [EXISTS]

- The operator never picks an encode mode. The format line
  (`encoder-format-automatic`) reads "Automatic (H.265)" with the codec the
  engine names in `encoder.default_codec`, or just "Automatic" when it names
  none.
- The switch `encoder-format-manual` is on exactly when the saved config has a
  `video_codec`. On, it reveals one radio per codec `intersectCaps` offers
  (`encoder-format-<codec>`); a codec it does not offer has no control. Turning
  it off saves `video_codec: null`, which returns the device to the automatic
  format.
- The switch `encoder-adaptive` ("Adapt bitrate to the network") is on for a
  saved balancer of `adaptive`, `aimd` or none and writes `fixed` or `adaptive`
  only when the operator flips it. It is disabled while live, beside the
  "Applies on next start" text.
- The route line `encoder-route` (`data-route` names the outcome) comes from
  `resolveRoute` in `apps/frontend/src/lib/streaming/outputFormat.ts`: the
  engine's active encode and its `route_reason` while live, the saved
  passthrough, the adaptive switch and the active source before start. The
  encoder row in `output-card` shows the same line.
- A Save writes only the format keys the operator changed. `video_passthrough`
  is never written by Save: a saved `force` or `off` shows the notice
  `encoder-legacy-passthrough` with the button
  `encoder-legacy-passthrough-reset`, which saves `video_passthrough: 'auto'` on
  its own. The federated Encoder bundle reads the host's `balancer` and
  `video_passthrough` and resets through `host.setConfig`; the ABI stays 1.

#### The Audio card's mixer [EXISTS]

- `AudioMixer` (`audio-mixer`) renders only when the capabilities carry
  `audio_mix`; without it the idle `audio-card` is today's picker and meter and
  the live screen has no `audio-card`. Idle, it sits in `audio-card` under
  `source-audio`; live, in the `audio-card` that `LiveCockpit` renders after
  `program-desk`, in the cards column, never in the post-stream summary window.
- One strip per selectable audio device in `status.audio_sources` (no
  pseudo-source, no row with an `unavailable_reason`), plus the embedded audio
  of a network source when the engine routes it, saved under the source id.
  Each strip, `audio-strip-<id>`, holds the switch `audio-strip-enable-<id>`;
  while it is on, the level slider `audio-strip-gain-<id>` (the capability's
  `gain_db_min` to `gain_db_max`, steps of 1) with `audio-strip-gain-reset-<id>`,
  the mute button `audio-strip-mute-<id>` (`aria-pressed`), the delay field
  `audio-strip-delay-<id>` (0 to `delay_ms_max` ms, steps of 10) and one chip
  per track, `audio-strip-track-<id>-<n>` for 1 to `max_tracks`
  (`aria-pressed`). `audio-strip-reason-<id>` says why a switch is disabled and
  `audio-strip-error-<id>` (`role="alert"`, always mounted) shows a refusal.
  Under the strips, `audio-mixer-track-hint` says most receivers play Track 1.
- The main input is the backend's: the picker's input, Auto's resolution, or
  the embedded audio when the picker defers to the source. Its strip is always
  on and its switch disabled with the reason beside it. Without a main input,
  no other strip can be turned on. At `max_inputs` enabled strips, the others
  cannot be turned on and say the mix is full.
- The main input is always in the mix Start sends, decided where it is used,
  never by a follow-up save: the backend's `effectiveAudioInputs` adds a main
  input outside the saved mix first at its defaults on Track 1 (the old main
  input stays an ordinary input), or in a full mix gives it the first entry's
  place and tracks. The strips show the same mix. Opening Live never saves;
  only an edit of an audio control saves, and it saves the mix shown.
- A pick in the audio picker sends only `setConfig({ asrc, audio_pick: true })`.
  The backend decides the membership in the same synchronous write, against its
  own current saved mix and current main input (Auto's resolution included):
  a device outside the mix joins it, and in a full mix it replaces the main
  input it actually replaces and takes its tracks. Quick successive picks and a
  stale second tab therefore compose. A refused mix retries with `asrc` alone,
  so the pick is never lost; a pick already in the mix changes only `asrc`.
- The rule itself is `audioMixWithPrimary` in `@ceraui/rpc/schemas`, shared by
  the backend and the strips.
- Meters: before going live, the main strip carries today's meter (the
  picker's meter moves into it, so the card never shows the same bars twice)
  and every other strip says its level shows once live. Live on a mix session,
  every enabled strip shows that input's own level from the `inputs[]` of the
  `audio-level` message, which reads unavailable when the input has no reading
  or the socket is down; a muted input reads silent. Today's meter stays in
  `LiveSummaryStrip` while live.
- Idle, a change sends only that input's delta to `streaming.setAudioMix`: a
  level, mute or delay value, one track on or off (`track`), or the input in or
  out (`include`). The client never sends a whole `audio_inputs` array: the
  device composes each delta on its own current saved mix in one synchronous
  write (main input first, `audio_inputs` cleared once only the main input is
  left at its defaults), so edits and picks from several tabs never drop one
  another. An unanswered edit shows as the choice; a refused one puts the
  previous state back.
- Live on a session whose status says `audio_mix_active`, level, mute and
  delay call `streaming.setAudioMix` with only the changed field (the level
  at most every 100 ms while dragging and once on release), and the values the
  device applied win. The switches and chips are disabled and described by
  `audio-mixer-next-start` ("Applies on next start"). Live on a session started
  without the mix, every strip control is disabled with that text. While a mix
  session runs, the source picker is read-only with `audio-source-mix-locked`.
- Every refusal shown is the keyed copy of one backend token
  (`live.audioMixer.error.<token>` for `audio_mix_unsupported`,
  `audio_input_unknown`, `audio_inputs_empty`, `audio_input_duplicate`,
  `audio_inputs_too_many`, `audio_tracks_invalid`, `audio_tracks_gap`,
  `audio_gain_range`, `audio_delay_range` and `audio_mix_active`); any other
  token, such as an engine refusal, reads as a generic refusal and never as the
  raw token. The UI refuses a track change or a delay the backend would refuse,
  in the backend's order and with the same copy, and sends nothing.
- The mock backend does not bridge `audio-level` to the main socket (its meter
  bridge is skipped under mocks), so `audio-mixer.spec.ts` injects that frame
  when it checks the per-input meters.

#### The layout designer [EXISTS]

- `LayoutDesigner` draws the inset `layout-inset` over the preview picture in
  `program-desk`, only while composition is on (a saved `composition`), the
  engine advertises `composition-geometry` and `preview-disclosure` is open.
  It covers the picture's letterboxed area (`videoBox`); while the preview is
  off or unavailable, `PreviewCanvas` gives it an empty 16:9 stage, so placing
  never needs the preview to play. Without the capability no designer node
  exists.
- The inset is where the compositor puts the second input: the saved `rect`
  for `custom`, else the preset's own rectangle (`presetRect`: half of each
  axis, a 5% margin for the four insets). It drags with pointer capture,
  resizes from four corners and, focused, moves with the arrow keys by 1%
  (Shift 5%) and resizes
  with Alt and the arrow keys. It is a native button with an accessible name
  and a polite live description of its position, size and keys; during a
  pointer drag the description keeps the starting position. Rectangles are
  fractions of the output frame, so they never mirror right to left.
- Each corner resizes from a 44 px box centred on it
  (`layout-inset-handle-<corner>`, `data-corner`) that sits under the inset,
  plus a cap in the inset's own corner (`data-corner-cap`) of at most 22 px and
  at most a quarter of each side. On a normal inset the corner keeps its whole
  44 px zone; at the smallest size on a 375 px phone (about 30 by 17 px) the
  caps stay small, so most of the inset, its middle included, still moves it.
  The caps and the boxes share one pointer path on the picture-area layer; the
  keyboard path is the focused inset button.
- The rectangle moves locally while a pointer or an arrow key is held and is
  sent once, on release, already clamped (`clampRect`: inside the frame, each
  side at least `COMPOSITION_RECT_MIN`), as
  `streaming.setConfig({ composition_rect })`, with `apply_now: true` while
  live. A press that does not move it sends nothing. Escape during a pointer
  drag or a held key puts it back, lets the pointer go and sends nothing.
- The device decides the composition. `resolveCompositionWrite` composes the
  placement onto the composition it has saved now, in the same synchronous
  write (`layout: 'custom'` and the rectangle; the second input and the
  opacity stay the device's). The layout card sends each of its changes the
  same way, as that one field (`composition_patch`: layout, second input or
  opacity) merged onto the saved composition; only turning composition on or
  off sends the whole `composition`. Quick drags and a stale second tab
  therefore compose with every other change; no client sends its own copy of
  the other fields. A rectangle is accepted only with `custom`, only with
  `composition-geometry` and only when it fits the frame
  (`compositionRectFits` in `@ceraui/rpc/schemas`); a rectangle sent with an
  explicit preset layout is a contradiction and is refused. Every refusal
  happens before anything is written: `composition_geometry_unsupported`,
  `composition_rect_invalid`, `composition_unsupported`, or `composition_off`
  for a change to a composition the device no longer has.
- Every composition write of a tab, from the card and the designer alike,
  goes through one ordered lane (`lib/streaming/compositionWrites.svelte.ts`):
  one write in flight at a time, in the order made. A placement released
  before the answer waits for it and replaces any older waiting placement; any
  newer write (a layout, second input, opacity, on or off) drops a placement
  still waiting, unsent, so an older drag can never undo a newer choice. While
  waiting or in flight, the newest placement is what the inset shows. A
  refused write shows the keyed copy of its token (`live.layout.error.<token>`)
  or the engine's outcome; the designer then falls back to the device's saved
  rectangle, in an alert over the picture that is mounted for the whole
  session.
- Start and Stop go through the same lane (`SystemHelper.startStreaming` and
  `stopStreaming`, which the Live bar, the stop watchdog, its Retry and the
  toast host all use, and `UnconfirmedStreamBand`'s Stop). One rule holds at
  every session change: a Start or a Stop drops nothing; a write made before it
  is sent before it and one made after it is sent after its answer. So a
  placement released just before Start is saved first and Start runs it; one
  released just before Stop changes the running stream first and the next
  Start begins from it. A Start or a Stop waits only for a write, never for an
  earlier Start or Stop, so a redispatched Stop still reaches a device that has
  not answered the first. Only a newer composition write drops a waiting
  placement, the round-2 rule, wherever the transitions fall.
- Whether a write changes the running stream is decided when the lane SENDS
  it: `apply_now: true` while the device reports a live stream
  (`getIsStreaming`) or right after this tab's Start was answered, before that
  status arrives. Callers pass no directive. Sending `apply_now` to an idle
  device only saves; a live write without it would be saved for the next Start
  only, which is the split this rule prevents. A session that ends or starts on
  its own (engine failure, a dropped socket, another tab) reaches the lane
  through the device's status. Only this tab's writes are ordered: a Start from
  another tab or the cloud, or the device's own restart, can still land between
  another write and the engine reading the saved composition.
- With `composition-geometry`, `composition-layout-selector` gains a seventh
  radio, `composition-layout-custom`. Choosing it sends `custom` alone; the
  device takes the rectangle of the preset it has saved. With the preview
  closed the radio is described by `live.layout.openPreviewToPlace`.
- Under mocks, a live layout-only change reaches the mock engine
  (`changeMockComposition`), as `set-audio-mix` does.

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
- **Cloud dashboard user.** Works with the Encoder, Audio and Server dialogs
  through the federated bundles listed under "Dialogs". This screen must open
  those same dialogs and must not change them.

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
  work must refine the screen within that world and must add no token.
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
- **Stream lifecycle.** Idle, starting, live, stopping, the post-stream summary
  window, and a failed start or stop.
- **Live.** Zero or several banners, the source switch shown or not, and the
  post-stream summary window.
- **Audio.** One source picker and its meter without `audio_mix`; up to four
  input strips with a meter each while live with `audio_mix`.
- **Languages.** **Today** `LOCALES` lists ten locales
  (`packages/i18n/src/locale-lifecycle.ts:28-38`). **Today** an end-to-end test
  that runs on the desktop project expects `dir="rtl"` on the document after
  Arabic is chosen in the locale selector
  (`apps/frontend/tests/e2e/locale-parity.spec.ts:114-123`). Every
  locale must render without overflow, and Arabic must mirror the layout.

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
  `packages/i18n/messages/*.json` file, written natively per locale. A change
  must not alter the text of a key it did not add, and nothing may write
  `packages/i18n/tests/fixtures/*.rendered.json`.
- **Open for the final design pass.** Whether the desk column stays pinned while
  the cards column scrolls on wide screens, and the width split between the two
  columns. Until then both columns must scroll with the page.

#### Assumptions made without an interview

The structure above came settled, so no discovery interview ran. These
readings fill gaps in it and can be corrected in a later change:

1. "Left" for the desk column means the inline-start side, mirrored in Arabic.
2. Inside `live-cockpit`, the banners must lead the cards column at 1024 px
   and wider; anything `LiveView` renders above the cockpit must stay full
   width.
3. Regions named "card" inside a host card must be titled groups, not second
   bordered surfaces.
4. `composition-stale-notice` must keep its id and take the place of
   `layout-controls` inside `program-desk` when `composition` is not
   advertised.
5. The 768 px default must be read once, at first render. Resizing later must
   not flip it, and the operator's own toggle is the one choice to store.
6. The stored value must be the string `true` or `false`; any other value must
   be treated as absent.
7. On a short landscape kiosk narrower than 1024 px (for example 800x480) the
   screen must be one column and the Live bar must sit at the viewport bottom,
   because `DESKTOP_CHROME_QUERY` (see "Screen sizes") matches that size.
8. Source tiles and the full-width detail below the selected tile are this
   brief's reading of "rows shown as tiles".
