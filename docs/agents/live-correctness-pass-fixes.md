<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## LIVE-CORRECTNESS-PASS FIXES [EXISTS]

A follow-up pass (`live-correctness-pass` plan) tightened the Live destination and
a few surrounding surfaces after the device-first source model shipped. The
sections below are the durable implementation record.

**Truthful device-max pair (Todo #2/#3).** `axisCeiling({offered, deviceModes})`
(`ValidationAdapter.ts`) now returns the ACHIEVABLE resolution×framerate pair when
Tier-2 `deviceModes` are present — intersecting the top rung's own modes with the
offered framerates — instead of the old independent-axes max (which could claim a
fictional pairing, e.g. 1080p/60 when 60fps only actually exists at 720p). One
implementation, two consumers: EncoderDialog's `axis-device-max` chip and
SourceSection's "SOURCE MAX" capability chip both read this same ceiling.
`framerateAvailableAt(axes, fps, excludeResolution)` drives the per-option
"available at Nx" hint on a disabled framerate option, keyed on the candidate fps
(never the resolution — a resolution-keyed hint would falsely stamp the same hint
onto every disabled rate at that resolution). The modes-absent (coarse) branch is
byte-identical to the pre-fix behavior (golden test).

**Destination traffic-light validation (Todo #5).**
`apps/frontend/src/lib/streaming/destination-validation.svelte.ts` is a
session-only (never persisted to `config.json`) rune store that fingerprints the
destination-defining config keys (`ENDPOINT_FINGERPRINT_KEYS`: `relay_server`,
`relay_account`, `relay_streamid_override`, `relay_protocol`, `srtla_addr`,
`srtla_port`, `srt_streamid`, `selected_ingest_endpoint` — `srt_latency` is
excluded, tuning-only) plus the resolved endpoint address, and records the last
`relay.validate` verdict against that fingerprint. `LiveView.validateSavedDestination()`
orchestrates it via `ServerDialog`'s OPTIONAL `onSaved?` callback (fired
fire-and-forget after a successful save — the dialog's mount contract and
federation bundle are unaffected). `StreamSetupChain`'s destination row reads
`getDestinationValidated()` for its traffic-light chip; any endpoint-key edit (or
a catalog-side addr/port drift under the same `relay_server` id) invalidates the
green light. The traffic light is purely informational — it never gates Start.

**Network-ingest operator enable/disable (Todo #6–9).** A new enable/disable layer
on top of the always-on gateway probe described in "NETWORK-INGEST GATEWAY" above:
- Backend: `apps/backend/src/modules/network/network-ingest-control.ts` —
  `readIngestDesired`/`persistIngestDesired`/`setIngestEnabled`/
  `reconcileIngestDesiredState` (fire-and-forget, self-serialising boot reconcile,
  never throws) + `planIngestUnitActions` (pure resolver, topology-aware: the NEW
  shared `ceralive-rtmp-gateway.service` topology stops a unit only when BOTH
  protocols are off and starts it when EITHER is on; the OLD `srtUnitPresent`
  topology keeps rtmp↔rtmp / `ceralive-srt-gateway.service`↔srt independent).
  `rpc.network.setIngestEnabled({protocol, enabled})` persists FIRST, then
  systemctl-applies (isActive-gated — a no-op re-run issues zero spawns), then
  re-broadcasts BOTH `status` and `sources`.
- `status.network_ingest.{rtmp,srt}.operator_disabled?: boolean` — additive,
  present only when `true`, DISTINCT from `service_active` (in the NEW topology a
  shared unit can stay `service_active:true` while a sibling protocol is
  `operator_disabled:true`).
- **The fail-visible three-mirror predicate** — "start-eligible = unit-active AND
  NOT operator-disabled" — is enforced identically in three places that MUST
  agree: the backend gateway probe (`network-ingest.ts` `buildGatewayProbe()`),
  the mock gate (`isMockGatewayActive()`, for dev/CI parity with the real probe),
  and the frontend `pipelineAvailability()` (operator intent checked FIRST, ahead
  of `service_active`/url-null/inactive, reason
  `live.education.reason.disabledInSettings`).
- Frontend: `apps/frontend/src/main/dialogs/NetworkIngestDialog.svelte` (Settings
  → "Network ingest" entry) toggles each protocol via a pessimistic bits-ui
  `Switch` composed with `osCommand` WITHOUT `confirmOnResolve` — the toggle
  position only moves once the confirming `status.network_ingest` broadcast
  lands; the spinner is the sole optimistic element. An emulated-mode refusal
  (`NETWORK_INGEST_UNAVAILABLE_ERROR`) renders a calm inline band instead of a
  toast. `SourceSection.svelte`'s `visibleSources` filter hides an
  operator-disabled network row UNLESS it is the currently-selected source
  (`config?.source === source.id`) — a selected-but-disabled row stays visible,
  disabled, with a reason line AND a Settings-hint line, so the operator can
  always see why their active source stopped working.

**Single audio surface (Todo #11).** The Source card (`SourceSection.svelte`) is
now the ONLY place that surfaces audio configuration. The `open-audio-dialog`
testid moved from the old Stream-setup audio row into SourceSection's audio block
(a "Codec & delay" ghost button, hidden while streaming — the audio surface stays
read-only mid-stream, same lock semantics as before). `StreamSetupChain` no
longer has an audio row (three rows only: Encoder/Destination/Network).

**One transport token per idle surface (Todo #12).** The idle Encoder-row summary
and SourceSection's active-config line no longer separately push a
`SRTLA`/`SRT`/`RIST` transport token — the ONE place the transport still shows
idle is the destination kind badge (e.g. "SRTLA · Bonded", via
`buildServerSummary` → `kindBadgeLabelKey`). The Encoder row instead names the
actual active source (capture device display name, or the pipeline name /
`reconfigureRequired` fallback for coarse/virtual/network sources). The LIVE
`LiveSummaryStrip` transport value is untouched — `deriveActiveSummary`
(`sourceSummary.ts`) still returns `transport` for the live strip; this is an
idle-only render-site fix, never a change to that shared derivation.

**Selected-row-only publish instructions (Todo #13).** A network-ingest row's QR
/ URL / copy / codec-education `<details>` disclosure now renders ONLY when that
row IS the selected source (`config?.source === source.id`); an
unselected-but-enabled network row still shows its select control, status line,
audio-kind pill, and info popover — just not the publish instructions. The QR
effect is narrowed the same way, so no QR is generated for an unselected row.

**Clear-saved-sign-in escape hatch (Todo #19).** `Layout.svelte`'s pre-auth
`authTimedOut` band ("Couldn't verify your session…") gained a second button
(`data-testid="clear-saved-session"`, i18n `connection.clearSavedSession`) beside
Retry. It clears the saved credential (`localStorage.removeItem('auth')` — the
same key `subscriptions.svelte.ts` reads for session restore) and falls through
to the password screen — breaking the retry loop a stale/dead saved token would
otherwise trap the operator in. Retry's own behavior is unchanged.

**Network mutation feedback completeness (Todo #20).** `NetifDialog.save()` and
`BondToggle.toggle()` deliberately share ONE `osCommand` resource key
(`` `netif:${name}` `` — never split into a separate key) so the two surfaces
refuse each other's concurrent mutation as a cross-surface race guard.
`osCommand` (`async-operation.svelte.ts`) gained a `silent?: boolean` option —
suppresses the failure toast but still transitions the op to `failed`, so a calm
inline band can still render off the phase — used by `WifiSelectorDialog`'s
periodic background rescan (`{ silent: true, confirmOnResolve: true }`). New
i18n key: `network.os.saved` (NetifDialog success toast; `deviceBusy`/
`operationFailed` pre-existed).

**Audio-naming tier-3 diagnostic (Todo #21).** The 3-tier audio-naming resolution
(engine `display_name` join on `alsa_card_id` → `/proc/asound/cards` longname →
`audioSrcAliases` generic alias) was already correct — Task 21 added
DIAGNOSTICS ONLY, no resolver rewrite. `audio-naming.ts` gained ONE `logger.info`
call (a deliberate, documented exception to the module's "pure, no side effects"
header) that logs `engineEntriesWithoutJoinKey` whenever a card falls through to
the generic `usbaudio*` tier-3 alias — the single most useful field for
root-causing an on-device "generic USB audio for a named device" report (almost
always a dropped `alsa_card_id` join key upstream of CeraUI). One-shot per
`cardId` per boot (`resetAudioNamingDiagnostics()` wired into `resetMockState()`
for test isolation).

**Audio-device naming cleanup + External marker (device-quality-wave2).** The
ladder above is now **4-tier** — a STATIC, code-level onboard display-name rule is
tier 0 — and tiers 1/2 are CLEANED before display. Both tiers carry raw ALSA
longnames (cerastream sets an audio entry's `display_name` to the longname
verbatim), so a live report showed `RØDE RØDE HDMI to USB-C at
usb-xhci-hcd.17.auto-1, super speed` (leaked via tier 1, because the engine
`product_name` was the generic `"usbaudio"` the human-name heuristic rejects) and
`DJI Technology Co., Ltd. DJI MIC MINI at usb-fc8c0000.usb-1, full speed` (tier 2,
no engine entry). `cleanAudioDeviceName()` strips the kernel `at <bus-path>,
<speed> speed` tail and collapses a manufacturer duplicated as the product prefix
(generic rule, no vendor allowlist — a non-filler token between the repeats blocks
the collapse). An onboard card whose only hardware string is a raw driver id
(`rockchip,hdmiin`) has nothing to clean, so `ONBOARD_AUDIO_DISPLAY_RULES` gives
it a fixed name (`HDMI Input`) — a RULE that ships with the app, keyed on the
driver/card id. The raw string is MOVED, not deleted: it rides
`AudioSource.detail` as a tooltip.

**The VIDEO half of that port gets the same rule.** cerastream reports the RK3588
HDMI-RX capture node's `display_name` as the raw driver id `rk_hdmirx`, which
surfaced verbatim in the Live source row AND the "Configured" summary line once
cerastream PR #69/#70 made the node a real selectable row.
`ONBOARD_VIDEO_DISPLAY_RULES` (`apps/backend/src/modules/streaming/onboard-display-names.ts`)
names it `HDMI Input` — the SAME name as the audio half, since both are one
physical port — and shares the audio rule's `normalizeOnboardKey` folding. The row
and the "Configured" label are NOT separate code paths: both read
`StreamSource.displayName` off the one `sources` broadcast, so the rule is applied
once at `fromEngineDevice()` (plus the v4l2 fallback scan and pre-rule persisted
snapshots) and never at a render site. Display-only — `input_id`/`device_path`/
`stable_id` and the kind heuristic are untouched. Full contract:
`apps/backend/AGENTS.md` → ONBOARD VIDEO DISPLAY NAMES.

**And that port's signal is re-checked, not read once.** The `signal` verdict
(`present`/`absent`/`unknown`, PR #216) was only ever recomputed when the device
SET changed — but an HDMI receiver that reports "no link" while its link
retrains and locks seconds later never changes the set, so the retraining answer
latched. Confirmed live on a Rock 5B+: `dmesg` logged `signal lock ok` +
`New format: 1920x1080p59.94` at 04:29 and the engine's `list-devices` reported
that mode correctly, while the UI still read "No signal" 45 minutes later —
nothing had asked the engine again. The device registry now fires a
`VIDEO_SIGNAL_RECHECK_INTERVAL_MS` (5 s) `onSignalRecheck` tick into
`recheckSourceSignals()`, which re-probes and broadcasts ONLY on change. It is
device-agnostic by construction — no driver or controller string anywhere in the
path, just the caps the engine's own `VIDIOC_QUERY_DV_TIMINGS` result projected.
Full contract: `apps/backend/AGENTS.md` → "A SIGNAL change is invisible to every
hotplug detector".

**A real audio device is never silently absent from the picker.** The card list is
CeraUI's own `/sys/class/sound` scan, and it reads `setup.sound_device_dir` — a
static value packaged into the separately-versioned `ceralive-device` `.deb`. A
value naming any other layout yields ZERO cards, so `audio_sources` collapses to
its two pipeline pseudo-sources and looks exactly like a board with no sound
hardware. Board-confirmed on a Rock 5B+ whose packaged `setup.json` still carried
the pre-#166 `"sound_device_dir": "/dev/snd"`: that directory holds ALSA's device
NODES and no `cardN` directory at all, so a connected, capture-ready RØDE
HDMI-to-USB-C was missing from the picker entirely while the ENGINE had been
reporting it correctly the whole time. `resolveConfiguredAlsaCards` reconciles the
configured directory against the kernel's own on positive evidence only, and
`isPlaybackOnlyCard` drops a card the kernel proves is an OUTPUT structurally
rather than by card id (`rockchiphdmi0` and `hdmi0` are the same block under two
vocabularies). Full contract: `apps/backend/AGENTS.md` → "…AND NEITHER IS A LIVE
AUDIO CARD".

**The idle level meter follows the picker.** Selecting an audio source used to change
nothing about the meter: cerastream chose its own idle card, so an operator who picked
the RØDE could watch the meter report the DJI Mic Mini — or "Meter unavailable" — with
no way to correct it. `config.asrc` is now resolved by `resolveMeterPreference()` and
pushed to the engine as `reload-config` `audio.meter_device` over the always-idle
`audio-meter-bridge` connection (schema ≥ 0.9.0; an older engine is sent nothing and
keeps auto-picking). It is a PREFERENCE, not a pin — cerastream still demotes a selected
card that delivers no samples, so a powered-off receiver can never leave the meter dead.

**"Auto" is resolved, NOT handed back.** It used to send an explicit `null` ("engine, you
choose"), which was right while `"Auto"` meant that and wrong the moment `resolveAutoAsrc`
made it deterministic. `resolveEffectiveAudioPick()` now maps the sentinel through the SAME
rule the start path uses, so the meter prefers the card a launch would actually open. The
old shortcut was doubly invisible: `null` made the engine auto-pick AND disarmed the
foreign-card gate, so on a Rock 5B+ the HDMI source with `"Audio source: Auto"` drew the
RØDE USB card's real, moving bars — for an HDMI audio half with NO capture PCM, i.e. for a
pick whose own start fails `audio-device-unavailable`. Because the resolved card depends on
the selected VIDEO source and on the engine's audio list, a `source` change and an
engine-list change re-push the preference too. Full contract:
`apps/backend/AGENTS.md` → IDLE AUDIO-METER DEVICE PREFERENCE.

**A feed that STOPS recovers itself.** The bridge's original recovery path watched frame
CONTENT (a sustained foreign-card run), so it could only run while frames arrived — and
the meter's worst failure is that they stop. Confirmed live: the engine's level feed went
silent 2 ms after a changed pick published its `handoff` gap, and the meter read a bare
`Meter unavailable` (no reason suffix — nothing was reaching the browser) for 14 minutes
with no operator action. A frame-ABSENCE watchdog now sits beside the content one and
re-asserts the preference through the SAME `null` escape hatch on the SAME once-per-30 s
floor. Full contract: `apps/backend/AGENTS.md` → "THE RECOVERY PATH MUST NOT BE GATED ON
THE SIGNAL WHOSE ABSENCE IS THE FAILURE".

**A momentary "No audio device" during a NORMAL libuvc rebind is a derived-state
artifact, and it is now absorbed.** Opening a UVC-H.264 camera detaches `uvcvideo`
from its USB interfaces (see LIBUVC-HELD DEVICES) — necessary, and no USB device
reset is involved: measured on a board, `devnum` never changes and the camera's ALSA
card and PCM node inode survive untouched. But on RELEASE the engine drops its held
record ≈400 ms (up to 2 s) before it rediscovers the re-registered node, and "Auto"
resolves audio by looking the VIDEO source up first. For that window the join key was
gone, Auto answered `no-same-device-audio`, and the meter read "Meter unavailable ·
No audio device" for a microphone that never moved. `resolveAutoAsrcFromLiveState()`
now resolves the selection through a strictly-bounded absence grace
(`capture-presence.ts`, 2 000 ms, keyed on stable identity) — a hysteresis on the
VERDICT only. Nothing else changes: the `sources` payload, the `lost` row and routing
are untouched, and a sustained absence still reports honestly. In the same window the
`hdmi_error` no-signal RAISE is now scoped like its retraction, so a stream-start's
incidental `/dev/video0` probe no longer shows HDMI text to a USB-camera session.
Full contracts: `apps/backend/AGENTS.md` → "A DEBOUNCE IS NOT AN ABSENCE GRACE" and
"…AND ITS RAISE MUST BE SCOPED LIKE ITS RETRACTION".

**There is NO operator rename.** #206 briefly shipped an alias/rename UI backed by
`config.audio_device_aliases`; #207 removed it in full — UI, `setAudioDeviceAlias`
RPC, oRPC contract entry, `audio-aliases.schema.ts`, and the config field — by
explicit product decision. Device naming is code-level only. Instead, a pluggable
accessory carries a read-only **"External"** badge, decided by the engine's
`transport` field (`usb`/`bluetooth`; corrected in cerastream PR #69) and never
re-derived from bus-path string matching. Frontend label precedence is
`product_name · TRANSPORT` → `label` → `labelKey` → `id`. Full contract:
`apps/backend/AGENTS.md` → AUDIO-DEVICE NAMING.

**And the ladder is UNCHANGED on the engine's PipeWire audio arm — proven, not
assumed.** cerastream's `[audio] backend = "pipewire"` moved where a row's
identity is derived (PipeWire node props, resolved back through the engine's
`pw_identity.rs`) and left the vocabulary alone: an audio row's `id` is still
`hw:CARD=<card>` and `alsa_card_id` is still published, so the join key CeraUI
resolves on never moved. `tests/audio-naming-pipewire-arm.test.ts` renders one
physical roster as BOTH arms' `list-devices` payloads and drives each through the
real whitelist copy and the real ladder; the arms disagree about `device_path`
(which is not in the audio whitelist at all) and agree about everything the
ladder reads. The persisted-config half is the same test's acceptance: a
`config.asrc` written before any PipeWire work — an alias name, a bare card id,
or a raw `hw:CARD=`/`plughw:` selector — resolves to the same meter target on
both arms and to the literal pre-migration answer, so **no `asrc` migration is
required for the backend flip**. Full contract: `apps/backend/AGENTS.md` →
"…AND THE LADDER IS THE SAME ON THE PIPEWIRE ARM" and the pre-migration paragraph
under IDLE AUDIO-METER DEVICE PREFERENCE.

**RELEASE SEQUENCING — this CeraUI release ships WITH the image's PipeWire
release, not before or after it.** The device image's PipeWire adoption
(`image-building-pipeline`, system-mode PipeWire + BlueALSA retirement) removes
`bluealsad` from the board in the same release that adds the PipeWire stack, and
CeraUI's Bluetooth-microphone presence oracle switches arms on the engine's
`pipewire-capture` feature token rather than on an image version. The two halves
are therefore atomic by construction: an image carrying PipeWire under a CeraUI
that still drives `bluealsad` would offer an operator a Bluetooth path the device
no longer has, and the reverse strands a working BlueALSA path behind a token
that never arrives. Nothing in either repo can detect the mismatch, so it is a
RELEASE-ORDER obligation, recorded here for the release checklist rather than
enforced in code.

