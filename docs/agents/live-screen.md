## LIVE SCREEN: CONTRACT AND DESIGN BRIEF [EXISTS]

This file is the target structure of the Live destination, written before any
of it was built.

Status: all six changes below have landed — the regions, both orders, the Live
bar, the two-column layout and the preview's open state exist as described, the
layout, the opacity and the second input change while live, the Encoder
dialog has the automatic format, the adaptive switch and the route line, the
Audio card has a strip per input, the second input is placed on the preview,
and the final design pass has set the rules in "The final design pass" below.

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
| `output-card` | The encoder row and the destination row of the stream setup, with the bitrate-ceiling chip (the bitrate in the encoder summary, tappable) and the destination traffic light. | Idle, when those rows render. |
| `connections-card` | The network row. | Idle. |
| `telemetry-card` | `StreamTelemetryStrip` and `IngestStats`. | Live, and in the post-stream summary window. |
| `live-bar` | Idle: the first blocking reason or a ready state, and Start. Live: `BitrateAdjuster` and Stop. Summary window: Done. | In both cockpits. |

These test ids must keep their names and meaning: `idle-cockpit`,
`live-cockpit`, `source-section`, `source-audio`, `open-audio-dialog`,
`stream-setup-chain`, `setup-row`, `preview-disclosure`, `composition-card`,
`composition-stale-notice`, `live-roadmap`, `live-summary-strip` and
`summary-done`. No region may be added beyond the table above. The Live bar
and its portaled confirmation also expose `live-bar-stop`, `live-stop-confirm`,
`live-stop-keep` and `live-stop-end` for locale-independent test drivers.

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
2. `source-section`, its source rows shown as framed options, and inside it,
   after the rows, `audio-card`.
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

**Stream-first Live layout [EXISTS].** Below 1024 px, the order while live is
alerts → Stream glance → program desk → Audio (when supported) → engineering
telemetry → fixed Live bar. At 1024 px and wider, the glance is hidden and the
two-column layout above is unchanged. The width rule includes landscape
phones, 768 px tablets and the 800×480 kiosk; the kiosk still uses its rail
chrome and bottom-aligned bar. Alerts and Stop must fit at all these sizes.
Below 1024 px on landscape screens 420 px tall or shorter, the live glance
uses two columns and tighter spacing to clear the fixed bar.
The glance chunk is requested only for confirmed Live below 1024 px. The
bitrate sheet body loads on first open through the dialog registry; the inline
adjuster and the phone's trigger stay in the fixed bar.

The Stream glance and IngestStats share rows named by `getLinkNames()`, the
same projection the HUD and Network use. Row identity uses the published
`link_id`; colors reserve the current HUD slots before assigning any remaining
slots in stable identity order. Link bars show
shares of reported, measured SRTLA wire traffic (`bitrate_bps`); measured zero
has no fill. Allocation weight is a separate diagnostic, not a traffic reading.
A fresh positive rate means sending; fresh zero means idle; missing rate is
unknown. Waiting for a watcher's first snapshot, an explicit empty roster,
stale sender data (the whole feed, not a single link), telemetry unavailable
(including non-bonded transports) and a lost device connection have distinct
copy. A replaced control socket must deliver new evidence before readings can
look fresh again. Even after reconnect, the producer expires a silent sender's
cached measurements at the stats-file age limit. Stale readings raise an
observation warning, not an outage; only fresh sender connection state can
raise All bonded links down. The headline stays Sending for a fresh aggregate
(including zero), otherwise Target or a dash. Session Summary peak and average
use fresh measured samples only, never Target. With no measurement both
display a dash. Below 640 px the summary uses two columns with wrapping labels.

The health HUD shows Unknown when bond activity is unknown and no other
observation establishes a fault. Bond detail clears even if another fault keeps
the health verdict unchanged. Loss of observation never announces recovery;
the recovery toast waits for a confirmed Healthy verdict after a confirmed fault.
The sender's `stats.update` normally arrives once per second. An explicit loss
of the control subscription invalidates activity immediately; silence expires
it at the existing five-second limit. After a gap in an otherwise healthy
bond, require two all-up pushes no more than two seconds apart (the normal
interval plus one missed push) to restore Healthy. A fresh report showing a
link down still applies immediately, and one fresh all-up report after a
confirmed link fault restores Healthy. This does not change rate freshness,
the stats-file fallback or the sender wire format.

`telemetry-card` keeps `StreamTelemetryStrip` and `IngestStats` mounted in
Details while live. It starts folded below 1024 px and remembers the choice in
`ceraui.live.detailsOpen`. At 1024 px and wider and in the post-stop summary,
Details opens without a toggle, without overwriting that choice or remounting
the session sampler. Below 640 px **while confirmed live only**, the header
title and subtitle are visually hidden, not removed from the heading outline.
Idle and unconfirmed headers retain both. Below 640 px the bitrate-limit
button opens one adjuster in a bottom sheet. At 640 px and wider it is inline
beside Stop; resizing an open sheet closes it and focuses the inline slider
because the trigger is no longer present. Ordinary dismissal restores the
trigger; resizing back with focus on the inline control transfers it to the
trigger. Both use the same live RPC and draft.

`telemetry-stop.spec.ts` must exercise the real Live entry: header states,
truthful glance, 639/640 and 1023/1024 transitions, sheet edit/refusal/focus,
Stop and alert fit including short landscape/kiosk, and the real session
rollup visible after Stop even if Details was never opened.

#### The Live bar

- `live-bar` must stay fixed to the bottom of the viewport on every screen
  size, directly above the mobile dock when the dock is shown.
- Idle, it must show the first blocking reason from `deriveGoLiveReadiness` as
  visible text, or a ready state, and Start.
- Live, it must show the bitrate control and Stop.
- At every width (phone, kiosk and desktop), the Live bar's Stop opens
  "End the stream?" with Keep streaming (initial focus, the bottom button
  on a phone) and End stream. End stream immediately requests Stop once,
  only for the still-live session that opened the dialog. Stop cannot open
  the question based on status from a previous connection. A current-link
  live boolean counts whether it came from a push, reconnect hydrate or
  watchdog read, once the connection is up. A newer live flag can precede the
  lifecycle update at the start edge, and live reconfiguration can still be
  stopped. A reported lifecycle other than streaming, including stopping
  before the live flag clears, or a connection drop invalidates an open
  question. Keep streaming and
  Escape close it without stopping and return focus to Stop, or to the
  main content landmark if Stop is gone or unavailable. A backdrop tap
  does nothing. The recovery/unconfirmed band's Stop and the stop watchdog's
  Retry remain one tap, without confirmation.
- While it is mounted, the document's `scroll-padding-bottom` is the bar's
  height (plus the mobile dock below desktop chrome), so a control reached with
  Tab or scrolled into view stops above the bar, never under it (WCAG 2.4.11).

#### Link names

Live, the HUD and Network's Bonded Links use one label projection from
`getModems()` and `getWifi()`, not the aggregate `getStatus()` inventory. A
standalone modem update must change all three. A modem reads "carrier · short
model", or just the model when no carrier is reported. Roster order, modem id,
and the interface suffix do not identify a SIM slot. Only an explicit device
slot label can name a slot. An otherwise identical modem gets a distinct
hardware-port hint where available, or its ifname when the hint is missing or
shared. After seeing a collision, the tab keeps the shown discriminator and
Network correlation when a sibling is unplugged. The cache retains all present
qualified modem identity/name pairs and up to 256 recently seen absent pairs.
Stable hardware keys are compared verbatim; when a row has only an ifname, the
UI cannot establish continuity across a rename.

A joined radio reads "Wi-Fi · network", with a radio hint for a shared SSID.
Ethernet and MAC-named adapters use their inventory labels, `usb<N>` reads
"USB tether (usb<N>)", and unrecognized names stay literal. Naming does not
decide bond membership. Live shows a distinct ifname beneath a name; the
session summary uses the observed names and identity as described in
[Ingest hardening](ingest-hardening.md).

#### Start refusals end in an action

A Live Start refusal and its device notice share one presentation per attempt.
If the RPC cannot present the failure, the device notice remains available.
Other clients and the device's logs and event history are unchanged.

Try again uses the Live bar's readiness projection (including an implicit sole
camera), plus a settled idle lifecycle and the current refusal's identity. It
is not offered for post-connect timeout, unresolved Stop, or a known engine
state conflict. If conditions change after the toast appears, a blocked tap
keeps both the toast and View logs. Network opens the modem controls; Stream
setup focuses the card heading. Retry uses the refused Start's original
payload. At the tap and before dispatch it checks the accepted config
generation and resolved destination against that Start, even if settings
changed before the refusal arrived. A changed destination requires a fresh
Start from the bar; the refusal and View logs stay available. The update
refusal retains its wait message.

Layout: the actionable refusal has its own toast stack above the Live bar and
dock. On short phones the reason scrolls independently, with a line visible
above the single row of actions. Later device notices cannot push it away.

A repeat belongs only to the retry's generation and must arrive less than two
minutes from dispatch on the monotonic clock. A fresh Start, observed running
stream, or proven non-dispatch clears that record. Restart box opens the
existing Power sheet only; reboot still needs its own confirmation.

#### Screen sizes

- At 1024 px and wider the screen must have two columns: `program-desk`, then
  `stream-setup-chain` and `live-roadmap`, on the left; `source-section` (with
  its audio) on the right; and `live-bar` across the bottom. Grid placement
  moves them, so the DOM, reading and Tab order stay the idle order above.
  The first version put everything but the desk on the right, which left about
  two thirds of the left column empty under the preview on a desktop.
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
  no other strip can be turned on. At `max_inputs` inputs in the mix (a saved
  input with no strip, gone or unavailable, still counts), the others cannot be
  turned on and say the mix is full.
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
  device applied win. A level still queued when the mix session ends (Stop, or
  the session stops mixing) or the mixer unmounts is dropped, never sent. The switches and chips are disabled and described by
  `audio-mixer-next-start` ("Applies on next start"). Live on a session started
  without the mix, every strip control is disabled with that text. While a mix
  session runs, the source picker is read-only with `audio-source-mix-locked`.
- Every refusal shown is the keyed copy of one backend token
  (`live.audioMixer.error.<token>` for `audio_mix_unsupported`,
  `audio_input_unknown`, `audio_input_primary`, `audio_inputs_empty`, `audio_input_duplicate`,
  `audio_inputs_too_many`, `audio_tracks_invalid`, `audio_tracks_gap`,
  `audio_gain_range`, `audio_delay_range` and `audio_mix_active`); any other
  token, such as an engine refusal, reads as a generic refusal and never as the
  raw token. The UI refuses a track change or a delay the backend would refuse,
  in the backend's order and with the same copy, and sends nothing. The track
  check reads the whole mix, saved inputs with no strip included.
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
  exists. The canvas renders `compact`: the disclosure supplies the card chrome.
- The inset is where the compositor puts the second input: the saved `rect`
  for `custom`, else the preset's own rectangle (`presetRect`: half of each
  axis, a 5% margin for the four insets). It drags with pointer capture,
  resizes from four corners and, focused, moves with the arrow keys by 1%
  (Shift 5%) and resizes
  with Alt and the arrow keys. It is a native button with an accessible name
  and a polite live description of its position, size and keys, including
  that Escape before letting go puts it back; during a
  pointer drag the description keeps the starting position. Rectangles are
  fractions of the output frame, so they never mirror right to left.
- Each corner resizes from a 44 px box centred on it
  (`layout-inset-handle-<corner>`, `data-corner`) that sits under the inset,
  plus a cap in the inset's own corner (`data-corner-cap`) of at most 22 px and
  at most a quarter of each side. Each cap extends across the inset's 2 px
  border, so the border at a corner resizes rather than moving the inset.
  On a normal inset the corner keeps its whole
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

#### The final design pass [EXISTS]

An audit of the screen as changes 1 to 5 left it, idle and live, at the four
sizes, in both themes and in English, Spanish and Arabic. It changed no region,
order or test id, reworded no string (it added one, the Escape hint) and changed
no control's effect; it set these rules, each pinned by
`apps/frontend/tests/e2e/live-design-a11y.spec.ts`:

- Every slider on the screen and in the Encoder dialog is a `LabeledSlider`
  (`apps/frontend/src/lib/components/custom/LabeledSlider.svelte`): its name,
  description and value text sit on the thumb, the element that takes focus,
  and it runs with the reading direction, so in Arabic the maximum is on the
  left like the Live bar's plus button. The shadcn `Slider` primitive put the
  name on its root and drew no track or fill (its `data-horizontal:` classes
  never match bits-ui's `data-orientation`).
- In touch layout a slider thumb keeps its 12 px dot and reaches 44 px through
  its `::after` hit area, the switch mechanism in `app.css`; an info button
  does the same through `data-touch-target="hit-area"`.
- Below 640 px (`sm`) every control in the Audio card, the layout controls
  and the Live bar is at least 44 px on its shorter side in the default layout
  too: those regions carry `data-touch-region`, which sets
  `--touch-target-min` to 44 px there, and the touch-layout rules in `app.css`
  (button `min-height`, switch and slider-thumb `::after`) apply to them.
  Spacing keeps its default scale; no component hard-codes 44 px.
- Text meets AA in dark and light: the preview encoding helper, the target
  bitrate in the telemetry card, the encoder cell's "not reported" text and a
  muted strip's Mute label use full
  `text-muted-foreground` or `text-foreground`; a muted strip keeps its warning
  tint and icon.
- At phone width the Output card's Edit buttons keep their words for screen
  readers, and the destination check shows its words, not only its dot. Setup
  values and reasons wrap instead of being cut. A source tile's name wraps to
  two lines.
- Under `prefers-reduced-motion: reduce` nothing on the screen keeps animating;
  the live dot in the summary stays lit and still.

Deliberately left, with reasons, in `docs/DESIGN-FOLLOWUPS.md` section 5.

#### The Source and Stream setup pass [EXISTS]

The owner read both cards on a phone as unorganized and the desktop as two
thirds empty. This pass changed no readiness, selection, capability gate,
disabled state, audio meter rule or dialog, and added no string or test id. It
set these rules:

- **One option pattern.** Every source option is a framed tile in one column:
  the kind icon, the name, one subtitle line (the capture kind, unless the
  name already says it, so "HDMI Input" shows no "HDMI" under it; or the ingest
  service state; then the chips: Selected first, then Lost, Degraded, No
  signal, Not connected or Includes audio, each wrapping on its own when the
  line is full) and, when it has one, its help at the inline end, inside the
  frame. Every chip is the same pill; only its tone changes. Anything more (the
  summary, capture formats, warnings, reasons and How to publish) sits under
  them, inside the same frame. The selected option is outlined (its
  border plus a one-pixel ring in the primary colour), never tinted: muted text
  inside a lime-tinted frame measured 4.23:1 in dark, below AA.
  Every "?" inside an option (its help, the capture-format help and the
  summary's help) is a real 44 px box at every width, kept 8 px from every other
  control in the option (`DESIGN.md` TT-2), so its hit area is its box: the
  touch layout's `::after` overlay on the old 24 px icon reached 10 px into the
  select button at 1024x600, so a tap meant for Select opened Help. The
  capture-format "?" follows its heading's words: that line is the help's
  44 px, 8 px from the select button above and the choices below, so on a
  390x844 phone's first screen the heading and the "?" are above the Live bar
  (the owner asked for that). Against main, on the first screen at 320, 375 and
  390 px, nothing selected and with HDMI selected, in en, de and ar, the "?"'s
  whole 44 px target sits nearer the top here in every case; main shows it
  whole only at 390 px in ar with nothing selected, and so does this layout
  (in en and de its target ends 1 px under the bar, where main's ended 12 px
  under). The summary's "?" sits at the inline end of its
  Source max line, reaching only into the space above it where nothing can be
  tapped. The 8 px rule is for a help beside another control; the
  capture-format choices keep their 6 px gap. An option with no help or switch beside its select renders no
  slot and no gap there, so the select keeps the header's whole width (a longer
  title still wraps, up to two lines).
- **The summary belongs to the selected option.** `source-active-config` sits
  inside the selected option and names its settings ("Automatic", the Encoder
  dialog's word, while no format is saved) and the hardware ceiling, never the
  source again: the old panel above the list repeated the option
  ("srt", a raw id) and said "Audio source" for what the option already called
  "Includes audio". It stands alone above the list only while no option on
  screen is the selection.
- **Vertical rhythm, measured against main.** Matched captures of main and
  this layout, in en, de and ar at 320x640, 375x812, 390x844, 768x1024,
  1280x800 and 1024x600 touch, on the first screen (nothing selected) and with
  the first enabled source selected; a help counts as shown when its icon is
  painted above the Live bar. At 375 and 390 px the Source card is between
  51 px shorter and 14 px taller than main, and nothing main's first screen
  showed falls under the bar, in any locale, the capture-format heading and its
  "?" included. With a source selected and the cockpit in view, the RØDE
  camera's format note ends 44 px above the bar at 375 px in en and de and
  60 px in ar (main: 27, 1 and 17), and 86 to 102 px above it at the kiosk
  (main: 57 to 95). At 320 px the card is 46 px taller on the first screen and
  7 px taller with a source selected, where the Source max line, now inside
  the selected option, falls under the bar. From 768 px the options sit one per
  line where main tiled them two across (the owner chose one per line), so the
  card is up to 144 px taller and a wide first screen shows fewer options: at
  1280x800 SRT Ingest (and, on the first screen in en and ar, the Test Pattern
  title), at 768x1024 with a source selected the Audio heading and the Test
  Pattern title, and at the kiosk with the cockpit in view SRT Ingest's title
  (in ar also its state and help). Each is reached by scrolling: every idle
  region's last control scrolls whole above the bar and takes a tap at
  390x844, 1024x600 touch and 1280x800. The growth that remains is intended:
  the selected option holds the summary the removed panel above the list held,
  a framed option adds its border and 12 px of bottom padding, and the kind is a
  subtitle line under the name.
- **One audio box.** The Audio heading carries the help and "Codec & delay";
  the picker and its level meter share one box under it; notices about the
  pick follow the box.
- **One setup row pattern.** Every Stream setup row is a status dot, the title,
  one summary line and one trailing action at the same inline end (the words
  and a chevron, the chevron alone below 640 px). The encoder row says the
  bitrate once, at the end of its summary, and that figure is the
  bitrate-ceiling chip (`bitrate-ceiling-chip`): it was a separate pill that
  repeated the summary. It still opens the Encoder dialog while Edit waits for
  a source, so the bitrate stays editable before a pick. Its text is one line
  tall, so an `::after` overlay 12 px past each edge makes the target 44 px at
  every width, and the summary line pads 12 px and gives it back as a negative
  margin so the overlay stays inside the line's own box. The destination check is a
  chip beside the title, and the dot follows it: a destination that passes the
  gate but was never checked shows a hollow dot (`data-tone="unchecked"`),
  because green claimed a check that never happened.
- **One type scale.** Card titles `text-base` semibold (Preview, Source,
  Stream setup), group headings (Output, Connections, Audio) `text-sm`
  semibold in the foreground colour, row titles `text-sm` medium, summaries in
  the UI face. Nothing on these rows is monospace; the meter's status lines
  use the UI face too.
- **Two balanced columns** from 1024 px, as "Screen sizes" states.

Pinned by `StreamSetupChain.test.ts` ("one row pattern" and "keeps the
bitrate editable while Edit waits for a source"), `SourceSection.test.ts` ("one
option pattern"), the column and fold checks in
`apps/frontend/tests/e2e/visual/live.visual.spec.ts` (at 375 px and 1024x600
touch the capture-format note sits whole between the header and the Live bar),
its Live page baselines (the first screen at 1280x800 and 390x844, as on main,
and beside it the whole page, which keeps every option the first screen leaves
below the bar), the idle snapshot in
`apps/frontend/tests/e2e/visual/audio-mixer.visual.spec.ts` (the whole Audio
card between the sticky header and the Live bar, failing first if anything
covers the heading, its help or Codec & delay), and
`apps/frontend/tests/e2e/live-design-a11y.spec.ts`, whose 44 px gates now
measure the Output card too and which scrolls each idle region (Preview, the
source options, Audio, Output, Connections, Roadmap) to its end at 390x844,
1024x600 touch and 1280x800 and requires its last control named, enabled, whole
above the bar and under a tap at its centre, and
`apps/frontend/tests/e2e/source-option-targets.spec.ts` (in en, ar and de, in the
default layout at 320, 375, 768 and 1280 and in touch at those and 1024x600, with
the selected option's How to publish open: no help hit area overlaps or comes
within 8 px of another control, every help and select is at least 44 px, the
RTMP and SRT options carry a help and the test pattern none; a tap beside the
help selects and a tap on it opens it, by touch at 1024x600 and 375 in touch
and by mouse at 375; and on a 390x844 phone's first screen, in en, de and ar,
the capture-format heading and its help's icon end above the Live bar and a tap
at the help's centre reaches it; in ar, where main shows the help's whole
target, the whole 44 px target ends above the bar, with nothing selected and
with HDMI selected).

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
  cockpit roots except the confirmed-live compact header; the HUD;
  the Network and Settings destinations; the design
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
  then the Stream glance below 1024 px, the picture and what is on air,
  audio, then engineering telemetry.
- **Two columns.** The desk column must be the wider one, because the preview
  is 16:9. "Left" means the inline-start side. Inside `live-cockpit` the
  banners must lead the cards column.
- **Source tiles.** Each source must be a framed tile with its name, its kind
  and its state, keeping the row's test ids and selection semantics. Tiles
  stand in one column at every width, so every frame has one width and every
  slot sits in the same place; a tile's detail opens inside its own frame (see
  "The Source and Stream setup pass").
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
- **Decided in the final design pass.** Both columns scroll with the page and
  the split stays three fifths for the desk (now with the stream setup under
  it), two for the source card. Pinning the desk
  was rejected: live at 1024x600 the desk (preview, now-streaming summary, source
  switch, layout controls) is taller than the space between the header and the
  Live bar, so a pinned desk would hold its own lower controls out of reach
  until the cards column ended.

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
8. Framed tiles in one column, each holding its own detail, are this brief's
   reading of "rows shown as tiles".
