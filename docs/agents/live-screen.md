## LIVE SCREEN: CONTRACT AND DESIGN BRIEF [GREENFIELD]

This file is the target structure of the Live destination, written before any
of it is built.

How to read it:

- A sentence that starts with **Today** describes the code at `origin/main`
  3e1ff5ea and cites `path:line` for each fact. If a file has moved on since
  then, find the cited line again by its symbol name.
- Every other sentence is a requirement or a design decision for the later
  changes listed below. "Must" marks a requirement.

**Today** the contract for the shipped screen is
[device-first-source-model-go-live-card.md](device-first-source-model-go-live-card.md).
Parts of it are older than the code. It lists the idle order as source, setup,
preview, roadmap (`docs/agents/device-first-source-model-go-live-card.md:76-81`),
while `IdleCockpit` renders `SourceSection`, `PreviewDisclosure`, the
composition card or its notice, `StreamSetupChain` and the roadmap, in that
order (`apps/frontend/src/main/live/IdleCockpit.svelte:165,188,193,218,249`).
Where the two differ, the code is the truth.

Each later change that builds a part of this file must flip that part's label
to `[EXISTS]` in the same change. The changes, in order:

1. Recompose the Live screen into the program desk, the cards and the Live bar.
2. Let the layout, the opacity and the second input change while live.
3. Replace the Passthrough and Codec selectors in the Encoder dialog with an
   automatic format, one adaptive-bitrate switch and one line that says what
   the device will do.
4. Show an audio strip per input in the Audio card.
5. Place the second picture input on the preview.
6. Do a final design pass on the Live screen and the Encoder dialog.

Design authority: [`.impeccable.md`](../../.impeccable.md) for the look and
[`DESIGN.md`](../../DESIGN.md) for truthfulness and structure, the split that
`DESIGN.md:8-11` states, and [`PRODUCT.md`](../../PRODUCT.md) for users and
principles. The surface mode is **Operate**: the operator completes a task, so
scanability, consistency and the real usage scene come before expression.

### The fixed structure

Everything in this section is a requirement. The regions, their order, their
test ids and what each control does are settled; the later changes implement
them and do not reopen them. Design work covers hierarchy, spacing, typography,
color within the existing tokens, motion, copy tone and states.

#### Regions

| Test id | Must hold | Rendered when |
| --- | --- | --- |
| `program-desk` | The preview (`preview-disclosure`) and, after it, `layout-controls`. While live, also `LiveSummaryStrip` and `LiveSourceSwitch`. | In both cockpits. |
| `layout-controls` | The picture layout controls that `CompositionCard` renders today. | Only when the engine advertises the `composition` feature. |
| `audio-card` | Idle: the content of today's `source-audio` block. Live: the mixer strips. | Idle: under the same condition as today's `source-audio` block. Live: only when the engine advertises `audio_mix`. |
| `output-card` | The encoder row and the destination row of the stream setup, with the bitrate-ceiling chip and the destination traffic light. | Idle, whenever those rows render. |
| `connections-card` | The network row. | Idle. |
| `telemetry-card` | `StreamTelemetryStrip` and `IngestStats`. | Live, and in the post-stream summary window, where only `IngestStats` shows. |
| `live-bar` | Idle: the first blocking reason or a ready state, and Start. Live: `BitrateAdjuster` and Stop. Summary window: Done. | In both cockpits. |

What the regions reuse:

- **Today** none of the seven region ids and none of the key
  `ceraui.live.previewOpen` appears in `apps/frontend/src` (a search for each
  returns no match).
- **Today** `CompositionCard` renders an enable switch, a second-input picker,
  six layout radios and an opacity control
  (`apps/frontend/src/main/live/CompositionCard.svelte:151,190,221,234,247`).
  The six layouts are the producer schema's options without its seventh,
  `custom` (`packages/rpc/src/schemas/streaming.schema.ts:44-48`).
- **Today** the `source-audio` block holds the audio source picker
  (`apps/frontend/src/lib/components/custom/SourceSection.svelte:1392`), the
  "Codec & delay" button, which opens the Audio dialog and shows only while
  idle (`apps/frontend/src/lib/components/custom/SourceSection.svelte:1250-1259`;
  `packages/i18n/messages/en.json:757`), and a level meter that reads the
  backend's audio-level broadcast
  (`apps/frontend/src/lib/components/custom/SourceSection.svelte:1504`;
  `apps/frontend/src/lib/components/preview/LiveAudioMeter.svelte:5,71`). The
  block renders once a source is in effect
  (`apps/frontend/src/lib/components/custom/SourceSection.svelte:245,1232`).
- **Today** the encoder and destination rows render only when `LiveView`
  supplies their config rows
  (`apps/frontend/src/main/live/StreamSetupChain.svelte:429,439`). Each row is
  a `setup-row` (`apps/frontend/src/main/live/StreamSetupChain.svelte:285`),
  the network row is the `setup-row` with `data-row="network"`
  (`apps/frontend/src/main/live/StreamSetupChain.svelte:453-454`), and the
  destination traffic light and the bitrate-ceiling chip sit on their rows
  (`apps/frontend/src/main/live/StreamSetupChain.svelte:340,364`).
- **Today**, in the summary window, `LiveCockpit` hides the telemetry strip, the
  bitrate control and Stop, keeps `IngestStats`, and shows Done
  (`apps/frontend/src/main/live/LiveCockpit.svelte:324,360,371,385,387-394,400`).

Every existing test id must keep its name and meaning. These include:
`idle-cockpit` (`apps/frontend/src/main/live/IdleCockpit.svelte:163`),
`live-cockpit` (`apps/frontend/src/main/live/LiveCockpit.svelte:217`),
`source-section` (`apps/frontend/src/lib/components/custom/SourceSection.svelte:619`),
`source-audio` (`apps/frontend/src/lib/components/custom/SourceSection.svelte:1233`),
`stream-setup-chain` (`apps/frontend/src/main/live/StreamSetupChain.svelte:399`),
`setup-row` (`apps/frontend/src/main/live/StreamSetupChain.svelte:285,453`),
`preview-disclosure` (`apps/frontend/src/main/live/PreviewDisclosure.svelte:42`),
`composition-card` (`apps/frontend/src/main/live/CompositionCard.svelte:136`),
`live-roadmap` (`apps/frontend/src/main/live/IdleCockpit.svelte:249`),
`live-summary-strip` (`apps/frontend/src/main/live/LiveSummaryStrip.svelte:85`)
and `summary-done` (`apps/frontend/src/main/live/LiveCockpit.svelte:394`). No
region or test id may be added beyond the table above.

#### Idle order, inside the existing `idle-cockpit` root

1. `program-desk`: the preview (`preview-disclosure`), then `layout-controls`.
2. `source-section`, its source rows shown as tiles, and inside it, after the
   rows, `audio-card`.
3. `stream-setup-chain`, holding `output-card` (the encoder row and the
   destination row), `connections-card` (the network row) and, last,
   `live-bar`.
4. `live-roadmap`.

**Today** the source rows are a list
(`apps/frontend/src/lib/components/custom/SourceSection.svelte:781`).

#### Live order, inside the existing `live-cockpit` root

1. The existing banners, unchanged.
2. `program-desk`, with the preview, `LiveSummaryStrip`, `LiveSourceSwitch` and
   `layout-controls`.
3. `audio-card`, only when the engine advertises `audio_mix`. It holds the
   mixer strips. Without `audio_mix`, the live audio line and its meter stay in
   `LiveSummaryStrip`.
4. `telemetry-card`, with `StreamTelemetryStrip` and `IngestStats`.
5. `live-bar`, with `BitrateAdjuster` and the Stop button, or the Done button
   in the post-stream summary window.

**Today** the banners are the four capture bands, which are standby,
composition suspended, passthrough suspended and rate adapted
(`apps/frontend/src/main/live/LiveCockpit.svelte:219,227,237,247`), plus
source lost (`apps/frontend/src/main/live/LiveCockpit.svelte:262`), video
signal lost (`apps/frontend/src/main/live/LiveCockpit.svelte:276`), audio lost
(`apps/frontend/src/main/live/LiveCockpit.svelte:292`) and all links down
(`apps/frontend/src/main/live/LiveCockpit.svelte:308`). **Today** the live
audio line and its meter are in `LiveSummaryStrip`
(`apps/frontend/src/main/live/LiveSummaryStrip.svelte:131-155`). **Today**
`LiveCockpit` renders, after the banners, `LiveSummaryStrip`,
`LiveSourceSwitch`, `PreviewDisclosure`, `StreamTelemetryStrip`,
`BitrateAdjuster`, `IngestStats`, and then Stop or Done
(`apps/frontend/src/main/live/LiveCockpit.svelte:327,343,358,360,371,385,390,400`).

#### The Live bar

- `live-bar` must stay fixed to the bottom of the viewport on every screen
  size, directly above the mobile dock when the dock is shown.
- Idle, it shows the first blocking reason from `deriveGoLiveReadiness`, or a
  ready state, and Start.
- Live, it shows the bitrate control and Stop.

**Today** there is no fixed bar. Start is the last item of `StreamSetupChain`
(`apps/frontend/src/main/live/StreamSetupChain.svelte:496`) and Stop the last
item of `LiveCockpit` (`apps/frontend/src/main/live/LiveCockpit.svelte:400`).
**Today** Start's disabled reason is the starting text or the first blocked
gate's reason (`apps/frontend/src/main/live/StreamSetupChain.svelte:172-181`),
and the button shows it only as a `title` tooltip
(`apps/frontend/src/main/live/StreamControlButton.svelte:58`).

#### Screen sizes

- At 1024 px and wider the screen has two columns: `program-desk` on the left,
  everything else on the right, and `live-bar` across the bottom.
- Below 1024 px the screen is one column, in the order above.
- At 1024x600 nothing overflows horizontally and Start is visible without
  scrolling.

**Today** both cockpits are a single column
(`apps/frontend/src/main/live/IdleCockpit.svelte:163`;
`apps/frontend/src/main/live/LiveCockpit.svelte:217`).

#### The preview's open state

`preview-disclosure` must be open by default when the viewport is at least
768 px wide and closed by default below that. The operator's last choice is
kept in `localStorage` under the key `ceraui.live.previewOpen` and wins over
the default. **Today** the disclosure starts closed
(`apps/frontend/src/main/live/PreviewDisclosure.svelte:35`).

#### Dialogs

The Encoder, Audio and Server dialogs must stay dialogs. `output-card` opens
the Encoder dialog (encoder row, bitrate-ceiling chip) and the Server dialog
(destination row); `audio-card` opens the Audio dialog; the network row goes to
the Network destination. They must keep federation ABI 1.

- **Today** the encoder row's edit button opens the Encoder dialog and the
  destination row's opens the Server dialog
  (`apps/frontend/src/main/live/StreamSetupChain.svelte:385`;
  `apps/frontend/src/main/LiveView.svelte:974-975,983-984`).
- **Today** the bitrate chip opens the Encoder dialog
  (`apps/frontend/src/main/live/StreamSetupChain.svelte:364-365`;
  `apps/frontend/src/main/LiveView.svelte:1126`), and the network row's button
  calls `onGoNetwork` (`apps/frontend/src/main/live/StreamSetupChain.svelte:486`).
- **Today** the "Codec & delay" button opens the Audio dialog
  (`apps/frontend/src/lib/components/custom/SourceSection.svelte:1250-1254`;
  `apps/frontend/src/main/LiveView.svelte:1136`).
- **Today** the three dialogs are also the federated entries
  (`apps/frontend/src/lib/federation/encoder-entry.ts:27`;
  `apps/frontend/src/lib/federation/audio-entry.ts:15`;
  `apps/frontend/src/lib/federation/server-entry.ts:15`), and the federation ABI
  version is 1 (`apps/frontend/src/lib/federation/host-contract.ts:10`).

### 1. Job and audience

- **Operator, before going live.** Sets up a bonded stream on a phone in the
  field, a tablet at an event, a laptop or desktop in a studio, or the 1024x600
  kiosk touchscreen, often under time pressure (`PRODUCT.md:9,52`). The job is
  to pick what to stream, see it, set how the picture is laid out, check the
  audio, confirm where it goes and over which links, then press Start.
- **Operator, while live.** The target job: watch the picture and the
  telemetry and react by switching the source, changing the layout or the
  audio, nudging the bitrate or stopping, with status at a glance and one
  obvious control for each action. **Today** the live screen offers the source
  switch when it applies, the preview, the bitrate control and Stop
  (`apps/frontend/src/main/live/LiveCockpit.svelte:343,358,371,400`); it
  imports no layout or audio control
  (`apps/frontend/src/main/live/LiveCockpit.svelte:35-48`).
- **Cloud dashboard user.** **Today** the federated bundles are the Encoder,
  Audio and Server entries
  (`docs/agents/federation-producer-pipeline.md:16-18`), so the dashboard
  loads those dialogs and not this screen. This screen opens the same dialogs
  and must not change them.

### 2. Outcome and proof

- **Primary action.** Start when idle, Stop when live. It must stay on screen
  in the Live bar, on every size, without scrolling.
- **Success.** Every concept is one hop away on one screen: the picture and its
  layout in the desk, the source and its audio in the Source card, the encoder
  and the destination in the Output card, the links in the Connections card.
  **Today** these concepts are spread across the Source card
  (`apps/frontend/src/lib/components/custom/SourceSection.svelte:619`), the
  Audio dialog (`apps/frontend/src/main/LiveView.svelte:1148-1149`), a
  composition card that renders only with `composition`
  (`apps/frontend/src/main/live/IdleCockpit.svelte:193`), the Encoder dialog
  (`apps/frontend/src/main/LiveView.svelte:1162`), the Server dialog
  (`apps/frontend/src/main/LiveView.svelte:1145`), the setup rows
  (`apps/frontend/src/main/live/StreamSetupChain.svelte:429-454`) and a
  preview that starts closed
  (`apps/frontend/src/main/live/PreviewDisclosure.svelte:35`).
- **Product truth.** The engine decides what is possible.
  - **Today** layout controls render only when the engine advertises
    `composition` (`apps/frontend/src/main/live/IdleCockpit.svelte:137-139,193`).
  - Mixer strips must render only when the engine advertises `audio_mix`.
    **Today** no code in `apps` or `packages` reads `audio_mix` (a search
    returns no match).
  - A control the engine cannot honor must contribute no DOM node
    (`DESIGN.md:47`, rules CT-1 to CT-5 at `DESIGN.md:47-62`).
  - The Live bar must take readiness from `deriveGoLiveReadiness` and must not
    derive its own. **Today** `StreamSetupChain` consumes it
    (`apps/frontend/src/main/live/StreamSetupChain.svelte:156-157`).
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

- **Visual authority.** **Today** `.impeccable.md` defines the world:
  warm near-black graphite, phosphor lime as the primary accent and the live
  signal color, amber for standby and coral for errors, Space Grotesk for UI
  labels and JetBrains Mono for data values (`.impeccable.md:20-21`). This
  work refines the existing screen within that world and must add no token.
- **Structural thesis: desk, cards, bar.** The picture is the instrument's
  display, so it leads, in the desk. Configuration follows in cards ordered the
  way the signal flows: source and its audio, then output, then connections.
  The one consequential action lives in a bar that does not scroll away.
- **References, structure only.** From
  [eirl-encoder](https://github.com/enhanced-irl/eirl-encoder): the program
  preview with the sources below it, layout buttons, and an audio strip per
  source, as its README describes them. From
  [irl4you-pip](https://github.com/IRL4YOU/irl4you-pip): cards ordered by task
  with a "Live" bar at the bottom, as its README describes them. Neither one's
  look is borrowed.
- **Focal moment.** Idle: the Live bar's readiness line and Start, which
  answer "can I go live, and if not, why". Live: the program picture with the
  summary of what is on air.
- **Implementation consequence.** A `ProgramDesk` wrapper hosts the preview and
  the layout controls. `StreamSetupChain` groups its existing rows into the
  Output and Connections cards and hosts the Live bar. `LiveCockpit` regroups
  its existing children into the desk, the telemetry card and the bar. No
  state, RPC call or handler may move between components: each keeps what it
  owns today. **Today** the ownership is:
  - `LiveView` owns the dialog open flags
    (`apps/frontend/src/main/LiveView.svelte:509-511`), the post-stream summary
    flag (`apps/frontend/src/main/LiveView.svelte:230`) and the bitrate-drag
    flag (`apps/frontend/src/main/LiveView.svelte:737`). It also owns the
    handlers it passes down as props: start
    (`apps/frontend/src/main/LiveView.svelte:889`), stop
    (`apps/frontend/src/main/LiveView.svelte:946`), the live input switch
    (`apps/frontend/src/main/LiveView.svelte:343,360`), the live audio switch
    (`apps/frontend/src/main/LiveView.svelte:383,388`), the encoder save
    (`apps/frontend/src/main/LiveView.svelte:568,581`), the audio source pick
    (`apps/frontend/src/main/LiveView.svelte:648,660`) and the bitrate
    (`apps/frontend/src/main/LiveView.svelte:765`).
  - `SourceSection` owns its pending input mode and its network QR images
    (`apps/frontend/src/lib/components/custom/SourceSection.svelte:345,524`) and
    writes `input_mode` and `source` itself
    (`apps/frontend/src/lib/components/custom/SourceSection.svelte:365,488-491`).
  - `CompositionCard` owns its saving flag
    (`apps/frontend/src/main/live/CompositionCard.svelte:99`) and writes
    `composition` itself through `write`, `toggle` and `patch`
    (`apps/frontend/src/main/live/CompositionCard.svelte:105-133`).
  - `PreviewDisclosure` owns its open flag
    (`apps/frontend/src/main/live/PreviewDisclosure.svelte:35`).
    `PreviewCanvas` owns the preview connection state
    (`apps/frontend/src/lib/components/preview/PreviewCanvas.svelte:129-170`)
    and mints the preview token
    (`apps/frontend/src/lib/components/preview/PreviewCanvas.svelte:463`).
    `PreviewEncodeControl` writes `previewEncode`
    (`apps/frontend/src/main/live/PreviewEncodeControl.svelte:53`).
  - `IngestStats` owns its link history, its session rollup and its export
    error (`apps/frontend/src/lib/components/custom/IngestStats.svelte:93,138,192`).
  - `IdleCockpit`, `LiveCockpit`, `StreamSetupChain`, `LiveSourceSwitch`,
    `LiveSummaryStrip`, `BitrateAdjuster`, `StreamControlButton` and
    `StreamTelemetryStrip` declare no `$state` and make no RPC call (a search
    of those eight files returns no match). They render props and values
    derived from them.

### 4. Scope and boundaries

- **In scope.** The regions, their order, the Live bar, the two-column layout,
  the preview's default open state, and the states listed below.
- **Fidelity.** Production. Each change listed at the top ships behind its own
  tests.
- **Untouched.** These must not change:
  - `deriveGoLiveReadiness` and its gate order. **Today** that order is source,
    network, destination, engine
    (`apps/frontend/src/lib/streaming/go-live-readiness.ts:148-153`).
  - The Encoder, Audio and Server dialogs as surfaces, and federation ABI 1.
  - Everything above the cockpit roots in `LiveView`. **Today** that is
    `LiveHeader` (`apps/frontend/src/main/LiveView.svelte:991`),
    `CapabilityTierBanner` (`apps/frontend/src/main/LiveView.svelte:995`), the
    config-change applying banner
    (`apps/frontend/src/main/LiveView.svelte:1000-1010`), the stop-stuck banner
    (`apps/frontend/src/main/LiveView.svelte:1012-1031`),
    `UnconfirmedStreamBand` (`apps/frontend/src/main/LiveView.svelte:1037`)
    and, when idle, `UpdateRefusalBand`
    (`apps/frontend/src/main/LiveView.svelte:1104-1106`).
  - The HUD, the Network and Settings destinations, the design tokens, every
    existing test id, and the unmounted deprecation shims. **Today** those
    shims are registered as `TD-unmounted-source-shims`
    (`docs/TECHNICAL_DEBT.md:485`).
- **Anti-goals.**
  - No inline mega-form: configuration complexity stays in focused dialogs
    (`PRODUCT.md:42`). **Today** some controls are already inline, for example
    the source list, the audio picker and the composition card
    (`apps/frontend/src/lib/components/custom/SourceSection.svelte:781,1392`;
    `apps/frontend/src/main/live/CompositionCard.svelte:136`).
  - No bordered card inside another bordered card (`PRODUCT.md:33`).
    `audio-card` inside `source-section`, and `output-card` and
    `connections-card` inside `stream-setup-chain`, must render as titled
    groups separated by a hairline divider inside their host card. **Today**
    `source-audio` sits in the Source card that way, with a top border
    (`apps/frontend/src/lib/components/custom/SourceSection.svelte:1233`).
  - No hero metric, no gradient text, no side-stripe accent and no
    per-section uppercase eyebrow label (`PRODUCT.md:30-34`).
  - The Live screen must mount at most one `PreviewCanvas` and one Start or
    Stop button at a time. **Today** each cockpit mounts one
    `PreviewDisclosure`
    (`apps/frontend/src/main/live/IdleCockpit.svelte:188`;
    `apps/frontend/src/main/live/LiveCockpit.svelte:358`) and one
    `StreamControlButton`
    (`apps/frontend/src/main/live/StreamSetupChain.svelte:496`;
    `apps/frontend/src/main/live/LiveCockpit.svelte:400`), and `LiveView`
    renders one cockpit at a time
    (`apps/frontend/src/main/LiveView.svelte:1043,1099`). The Encoder dialog
    mounts its own compact `PreviewCanvas`
    (`apps/frontend/src/main/dialogs/EncoderDialog.svelte:639`).

### 5. States and ranges

- **Sources.** **Today** rows come in four origins: `capture`, `coarse`,
  `virtual` (the test pattern) and `network`
  (`packages/rpc/src/schemas/sources.schema.ts:112,148,155,162`;
  `apps/frontend/src/lib/components/custom/SourceSection.svelte:251`). The
  states are:
  - None: **today** the `source-empty` state
    (`apps/frontend/src/lib/components/custom/SourceSection.svelte:1212`).
  - One capture source and no saved `config.source`: **today** the sole-camera
    auto-select line `sole-camera-auto`
    (`apps/frontend/src/main/live/StreamSetupChain.svelte:406-413`), which
    folds the camera into the Start request rather than saving it first
    (`apps/frontend/src/main/live/StreamSetupChain.svelte:183-188`).
  - Several.

  Expected ranges, which are assumptions and not code facts: typically two to
  four sources (HDMI, USB cameras, a network ingest, the test pattern),
  occasionally many on a USB hub. Names run from short ("HDMI") to long camera
  names, and German and Hindi labels are the overflow probes.
- **Layout.**
  - Absent: **today** there is no node unless the engine advertises
    `composition`
    (`apps/frontend/src/main/live/IdleCockpit.svelte:137-139,193`), and a
    saved composition that the engine no longer supports shows
    `composition-stale-notice` instead
    (`apps/frontend/src/main/live/IdleCockpit.svelte:143-144,200-203`).
  - Idle and live: **today** `CompositionCard` is mounted by `IdleCockpit`
    (`apps/frontend/src/main/live/IdleCockpit.svelte:194`) and not by
    `LiveCockpit` (`apps/frontend/src/main/live/LiveCockpit.svelte:35-48`).
    It disables its four controls while `isStreaming` is true or a save is in
    flight (`apps/frontend/src/main/live/CompositionCard.svelte:97,152,195,235,263`).
  - Required: the recomposition puts `layout-controls` into the live desk, and
    the live-layout change lets them write while live.
- **Preview.**
  - Closed: **today** the disclosure starts closed
    (`apps/frontend/src/main/live/PreviewDisclosure.svelte:35`). The 768 px
    rule above replaces that default.
  - Open but not started: **today** `PreviewCanvas` starts with `enabled` false
    (`apps/frontend/src/lib/components/preview/PreviewCanvas.svelte:135`), and
    the operator's toggle is the one place that sets it
    (`apps/frontend/src/lib/components/preview/PreviewCanvas.svelte:860-861`),
    so opening the disclosure by default dials nothing.
  - Running: **today** the canvas reports `idle`, `connecting`, `waiting`,
    `live`, `reconnecting`, `unsupported` or `error`
    (`apps/frontend/src/lib/components/preview/PreviewCanvas.svelte:81-88`).
  - Paused: **today** an unwatched preview stops after 30 s
    (`apps/frontend/src/lib/components/preview/PreviewCanvas.svelte:111,935-939`).
    The disclosure's `open` is the canvas's `hostActive`
    (`apps/frontend/src/main/live/PreviewDisclosure.svelte:48`), so a
    collapsed disclosure counts as unwatched
    (`apps/frontend/src/lib/components/preview/PreviewCanvas.svelte:904`), and
    resume clears the pause
    (`apps/frontend/src/lib/components/preview/PreviewCanvas.svelte:873-876`).
  - Unavailable: **today** when the engine's preview availability is not
    `available` (`apps/frontend/src/lib/components/preview/PreviewCanvas.svelte:885-888`).
- **Readiness.** **Today** the gates are checked in the order source, network,
  destination, engine
  (`apps/frontend/src/lib/streaming/go-live-readiness.ts:148-153`).
  - Ready: no gate is blocked.
  - Blocked: **today** Start is disabled and its reason is the first blocked
    gate in that order
    (`apps/frontend/src/lib/streaming/go-live-readiness.ts:320-321`;
    `apps/frontend/src/main/live/StreamSetupChain.svelte:171-181`).
  - Warned: **today** a warning does not block
    (`apps/frontend/src/lib/streaming/go-live-readiness.ts:320-321`), so Start
    stays enabled. Where the warning shows depends on the gate:
    - The destination row shows its warning reason
      (`apps/frontend/src/main/live/StreamSetupChain.svelte:238-240,248-252`).
    - The encoder row takes the warning tone when its config row flags one,
      with no reason line
      (`apps/frontend/src/main/live/StreamSetupChain.svelte:226-237,245-247`).
    - An engine warning (engine starting, schema mismatch) has no row and
      shows in `CapabilityTierBanner`
      (`apps/frontend/src/main/live/StreamSetupChain.svelte:169-170`;
      `apps/frontend/src/main/live/CapabilityTierBanner.svelte:52,76`;
      `apps/frontend/src/lib/streaming/go-live-readiness.ts:279-296`).
    - The source and network gates return only ok or blocked
      (`apps/frontend/src/lib/streaming/go-live-readiness.ts:174-205,214-223`).
  - Starting: **today** Start is disabled with the starting text while the
    optimistic start is in flight
    (`apps/frontend/src/main/live/StreamSetupChain.svelte:171-174`).
  - Engine unavailable, or control channel down: **today** the engine gate
    blocks (`apps/frontend/src/lib/streaming/go-live-readiness.ts:279-289`).
- **Live.**
  - Banners: **today** zero, one or several at once, each with its own
    condition. The capture bands are derived only while streaming outside the
    summary window (`apps/frontend/src/main/live/LiveCockpit.svelte:186`); the
    others are source lost
    (`apps/frontend/src/main/live/LiveCockpit.svelte:191,262`), video signal
    lost, which is hidden while the source-lost banner or standby shows
    (`apps/frontend/src/main/live/LiveCockpit.svelte:208-209`), audio lost
    (`apps/frontend/src/main/live/LiveCockpit.svelte:202`) and all links down
    (`apps/frontend/src/main/live/LiveCockpit.svelte:195,308`).
  - Source switch, **today**:
    - When the engine reports a session roster (`activeEncode.switch_targets`,
      `apps/frontend/src/main/live/LiveSourceSwitch.svelte:76`), the roster
      decides. The card shows when the roster names at least two distinct
      inputs (`apps/frontend/src/main/live/LiveSourceSwitch.svelte:108-111`),
      and an input may be a capture, a synthetic test pattern or a network leg
      (`apps/frontend/src/lib/streaming/live-switch-rows.ts:33-62`). So one
      capture plus one synthetic leg is a switchable pair, with no second
      discovered capture
      (`apps/frontend/src/main/live/LiveSourceSwitch.test.ts:106-131`).
    - An empty roster shows no card, and its rows come from the roster rather
      than from the discovered sources. A status line says no source switches
      are available in this session
      (`apps/frontend/src/main/live/LiveSourceSwitch.svelte:77-78,270-272`).
    - With no roster, the legacy rule applies: at least two capture sources,
      and the running source is a capture or the source-lost state is up
      (`apps/frontend/src/lib/streaming/live-source-state.ts:75-82`;
      `apps/frontend/src/main/live/LiveSourceSwitch.svelte:108-110`). A status
      line then says the engine does not report switch targets
      (`apps/frontend/src/main/live/LiveSourceSwitch.svelte:77,270-272`).
  - Post-stream summary window: **today** the live controls hide
    (`apps/frontend/src/main/live/LiveCockpit.svelte:324`), `IngestStats` stays
    mounted and shows the session summary
    (`apps/frontend/src/main/live/LiveCockpit.svelte:385`), and Done replaces
    Stop (`apps/frontend/src/main/live/LiveCockpit.svelte:387-394`).
- **Audio.**
  - Idle: **today** the Source card's `source-audio` block holds one source
    picker and a level meter, and renders once a source is in effect
    (`apps/frontend/src/lib/components/custom/SourceSection.svelte:245,1232,1392,1504`).
  - Live: **today** the audio line and its meter sit in `LiveSummaryStrip`
    (`apps/frontend/src/main/live/LiveSummaryStrip.svelte:131-155`).
  - Required, with `audio_mix`: up to four input strips, each with its own
    meter while live. **Today** no code in `apps` or `packages` reads
    `audio_mix` (a search returns no match).
- **Languages.** **Today** there are ten catalogs: `ar`, `de`, `en`, `es`,
  `fr`, `hi`, `ja`, `ko`, `pt-BR` and `zh` (`packages/i18n/messages/*.json`).
  - **Today** Arabic sets `dir="rtl"` on the document
    (`packages/i18n/src/locale-lifecycle.ts:48,69-70`;
    `apps/frontend/src/main/Layout.svelte:219`).
  - **Today** Japanese, Korean and Chinese fall back to system fonts, because
    Space Grotesk has no CJK glyphs (`apps/frontend/tailwind.config.ts:103-105`).

### 6. Interaction and layout

- **Hierarchy.** Idle: the picture the audience will see, then what feeds it
  and its audio, then where it goes and over which links, then the roadmap.
  Live: alerts first, then the picture and what is on air, then audio, then
  telemetry.
- **Two columns, 1024 px and wider.** The desk column is the wider one, because
  the preview is 16:9 and is the screen's display. The cards column holds the
  rest in order. "Left" means the inline-start side, so in Arabic the desk sits
  on the right. Inside `live-cockpit`, the banners lead the cards column.
- **One column, below 1024 px.** The order above, top to bottom. Under the
  768 px rule a phone starts with the preview closed, so the source tiles come
  first after the desk's disclosure line.
- **Source tiles.** Each source must be a compact tile with its name, its kind
  badge and its state, keeping the row's test ids and its selection semantics.
  Tiles wrap in a grid and do not shrink below the width that keeps a name
  readable on two lines, so a phone shows one or two per row. Detail that
  expands inside a row must open below the selected tile across the card's
  full width, so the tiles stay the same height. **Today** that detail is the
  input modes (`apps/frontend/src/lib/components/custom/SourceSection.svelte:1000`),
  the coarse suggestions
  (`apps/frontend/src/lib/components/custom/SourceSection.svelte:1072`) and the
  network-ingest instructions and QR
  (`apps/frontend/src/lib/components/custom/SourceSection.svelte:1157,1163`).
- **Live bar placement.**
  - **Today** desktop chrome means at least 1024 px wide, or at least 768 px
    wide and at most 600 px tall (`apps/frontend/src/lib/layout.ts:29-30`).
    Below that, `MainView` shows a fixed bottom dock
    (`apps/frontend/src/main/MainView.svelte:106-108`) and pads the content by
    `--mobile-dock-height` (`apps/frontend/src/main/MainView.svelte:100`). That
    variable is 7rem and also sets the toast stack's offset
    (`apps/frontend/src/app.css:230-235`).
  - Required: on mobile chrome the bar sits directly above the dock; on
    desktop chrome it sits at the viewport bottom and spans the content area,
    not the navigation rail. The page reserves bottom space equal to the bar's
    height so the last card is not hidden under it, and toasts sit above the
    bar.
- **Live bar content.** The reason or ready line must be words, not color
  alone. It wraps to at most two lines, and the bar's height must not jump when
  the line changes.
  - **Today** the source, destination and network gates also show their
    reasons in their setup rows
    (`apps/frontend/src/main/live/StreamSetupChain.svelte:245-255`).
  - **Today** the engine gate has no setup row. A blocking engine gate shows in
    `CapabilityTierBanner` and as Start's disabled reason
    (`apps/frontend/src/main/live/CapabilityTierBanner.svelte:38`;
    `apps/frontend/src/main/live/StreamSetupChain.svelte:172-181`). An engine
    warning shows only in `CapabilityTierBanner`
    (`apps/frontend/src/main/live/CapabilityTierBanner.svelte:52,76`).
- **Focus order.** In the DOM the bar must sit where the order lists it (last
  in `stream-setup-chain`, last in `live-cockpit`), so keyboard and
  screen-reader order follows reading order even though the bar is fixed on
  screen.
- **Feedback.**
  - **Today** Start shows a spinner while the optimistic start runs
    (`apps/frontend/src/main/live/StreamControlButton.svelte:61-62`;
    `apps/frontend/src/main/live/StreamSetupChain.svelte:171-174`).
    `LiveView` switches to the live cockpit on that optimistic edge
    (`apps/frontend/src/main/LiveView.svelte:164-166,273`), so the screen does
    not fall back to idle mid-launch.
  - **Today** Start's disabled reason is only a `title` tooltip
    (`apps/frontend/src/main/live/StreamControlButton.svelte:58`). Required:
    the Live bar shows the reason as visible text next to Start (rule CT-2,
    `DESIGN.md:49`).
- **Motion.** **Today** the preview disclosure has no transition
  (`apps/frontend/src/main/live/PreviewDisclosure.svelte:38-51`). No motion is
  to be added beyond today's, and any motion added to it must respect
  `prefers-reduced-motion` (rule RM-1, `DESIGN.md:223`).
- **Touch.** Required (rules TT-1 to TT-3, `DESIGN.md:201-207`): 44 px targets
  in touch mode and at least 8 px between neighbors, through the existing token
  layer. **Today** that token is 0 px by default and 44 px in touch mode
  (`apps/frontend/src/app.css:227,238-239`), and lifts button-like controls
  through `min-height` (`apps/frontend/src/app.css:261`).

### 7. Constraints and open decisions

- **Platform.** **Today** the frontend is Svelte 5.57.0, Tailwind 4 and
  `vite-plugin-pwa` (`apps/frontend/package.json:49,70,75`), and the primitives
  to reuse exist: `Card` and `Button`
  (`apps/frontend/src/lib/components/ui/card/index.ts`;
  `apps/frontend/src/lib/components/ui/button/index.ts`), `AppDialog`
  (`apps/frontend/src/lib/components/dialogs/AppDialog.svelte`),
  `StreamControlButton` and `BitrateAdjuster`
  (`apps/frontend/src/main/live/StreamControlButton.svelte`;
  `apps/frontend/src/main/live/BitrateAdjuster.svelte`). The work must use
  them and the existing tokens, with no new dependency.
- **One preview.** The Live screen must mount one `PreviewCanvas` at a time.
  **Today** the canvas mints a single-use token over RPC and dials the backend
  `/preview` proxy
  (`apps/frontend/src/lib/components/preview/PreviewCanvas.svelte:460-463`), and
  it owns the 30 s viewer auto-stop
  (`apps/frontend/src/lib/components/preview/PreviewCanvas.svelte:107-111`).
- **One Start.** `StreamControlButton` must be mounted once per cockpit, inside
  `live-bar`. **Today** it is mounted once per cockpit
  (`apps/frontend/src/main/live/StreamSetupChain.svelte:496`;
  `apps/frontend/src/main/live/LiveCockpit.svelte:400`).
- **Accessibility.** Required: WCAG AA in dark and light, logical properties for
  right-to-left, and the 1024x600 kiosk fit (`PRODUCT.md:48-52`), plus reduced
  motion and the 44 px touch layer above.
- **Localization.** Every new string must be a new key in all ten
  `packages/i18n/messages/*.json` files, written natively per locale. Existing
  keys keep their text, and nothing may write
  `packages/i18n/tests/fixtures/*.rendered.json`. **Today** that directory holds
  ten rendered fixtures (`packages/i18n/tests/fixtures/`).
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
   screen is one column and the Live bar sits at the viewport bottom. **Today**
   desktop chrome covers that size and shows no dock there
   (`apps/frontend/src/lib/layout.ts:29-30`;
   `apps/frontend/src/main/MainView.svelte:106`).
8. Source tiles and the full-width detail below the selected tile are this
   brief's reading of "rows shown as tiles".
