<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## IDLE AUDIO-METER DEVICE PREFERENCE [EXISTS]

The engine's ALWAYS-ON level meter (ADR-0007) used to pick its own ALSA card while
idle, entirely independent of the operator's **Audio source** selection. Found live on
a board: the operator selected the RØDE, `SourceSection` showed the RØDE, and the meter
reported the DJI Mic Mini (or "Meter unavailable") — because with two healthy cards the
engine's candidate list is ordered by enumeration and `"DJI Technology…"` sorts first.

`config.asrc` now reaches the engine's idle meter:

- **`resolveMeterPreference(asrc)`** (`modules/streaming/audio.ts`) turns the picker
  value into the ALSA device the meter should prefer, or `null` for "engine, choose for
  yourself". `null` covers both pipeline pseudo-sources (`"No audio"` /
  `"Pipeline default"`), an unset `asrc`, an `"Auto"` that resolves to no single card,
  and anything that resolves to no card. It reuses the SAME `audioDevices` map + alias
  reverse-lookup + `hw:CARD=` wrapping that `resolveAudioMode` uses for `start`, so the
  meter and the program leg can never disagree about which card a pick names. It is
  deliberately NOT `resolveAudioMode`: this is the IDLE meter, which has no notion of
  network-embedded program audio and must keep following the card the picker is showing.
- **`"Auto"` is NOT a hand-back — it is resolved, by the SAME rule the start path uses.**
  `resolveEffectiveAudioPick(asrc)` maps the sentinel through
  `resolveAutoAsrcFromLiveState()` (`auto-audio.ts`) and hands the resulting picker key
  to both `resolveMeterPreference` and `isMeterPreferenceDevicePresent`; every other pick
  passes through verbatim. This is a CORRECTION, not an addition: `"Auto"` short-circuited
  to `null` back when it really did mean "engine, you choose", and `resolveAutoAsrc` ended
  that by making it deterministic (an HDMI video source follows `rockchiphdmiin` by rule 3,
  a USB camera follows its `physical_group_id` sibling by rule 5). While the meter kept the
  old reading, the sentence directly above it — the meter and the program leg can never
  disagree about which card a pick names — was FALSE for the single most common pick on the
  device. Found live on a Rock 5B+: HDMI selected with `"Audio source: Auto"` drew the RØDE
  USB card's real, MOVING bars, because (a) a `null` preference told the engine to auto-pick
  and it picked the only card it could open, and (b) `isForeignCardLevel` needs BOTH sides to
  name a card, so `null` also disarmed the gate that exists to refuse exactly that reading.
  The HDMI-RX audio half owns NO capture PCM, so the very pick the meter was decorating with
  another device's audio is one whose own `start` fails `audio-device-unavailable`. An `"Auto"`
  that resolves to no single card (`embedded` / `pipeline-default` /
  `ambiguous-same-device-audio` / `no-same-device-audio`) still answers `null` — those are the
  outcomes the UI turns into their own prompts, and pinning them would leave the meter dead.
  The resolver is a PARAMETER on both functions (defaulted to the live-state one) because it
  reads `config.source` + the sources list + the engine audio list; a test must be able to pin
  one resolution without assembling that graph. It is FAIL-OPEN: a throw yields `undefined`,
  i.e. the engine's own pick, because this runs on every broadcast.
- **The `audio-meter-bridge` delivers it**, because it already holds the ONE long-lived
  IDLE connection to the engine (`cerastream-backend.ts`'s client only exists while
  streaming). `pushPreference()` sends `reload-config` with
  `{ audio: { meter_device } }`.
- **`syncAudioMeterPreference()`** re-pushes on change. FOUR call sites, and the last
  three exist because an UNCHANGED pick can still resolve to a different card: the
  bridge's own `runAttempt` (every fresh connect — the engine holds NO preference across
  a restart), `streaming.setConfig` when `input.asrc` **or `input.source`** changed,
  `updateAudioDevices` (a re-enumeration), and `reresolveAudioForEngineChange` (a changed
  engine audio list). The `input.source` and engine-list sites are BOTH consequences of
  `"Auto"` being resolved rather than handed back: rule 3 keys on the selected VIDEO
  source and rule 5 joins through the ENGINE's audio list, so switching camera → HDMI, or
  the engine's audio enumeration landing seconds after a hotplug, each move the resolved
  card with `config.asrc` untouched. Re-pushing an unchanged pick is free — the bridge
  dedupes on the `(silenced, preference)` PAIR, so it broadcasts no gap — but SKIPPING a
  changed one is not: the engine's `set_preferred_device` early-returns on an unchanged
  value, so nothing later corrects it and the meter reports the previous device
  indefinitely.

**Why `reload-config` and not `switch-audio`.** `switch-audio` is stream-only — it
answers `-32001 cerastream.state.not_streaming` while idle, which is exactly when the
idle meter runs. `reload-config` already carries an `audio` section and is idle-safe on
the engine side (it no-ops against an absent session).

**Three wire states, and they are NOT interchangeable.** `audio.meter_device` ABSENT
leaves the engine's preference unchanged (so `reloadAudioDelay`'s delay-only reload can
never clear it), explicit `null` restores the engine's own delivery-based auto-pick, and
a string prefers that card. Never send `undefined` expecting "Auto".

**Sent over `rawRequest`, gated on schema ≥ 0.9.0.** The published
`@ceralive/cerastream` client Zod-STRIPS the additive `meter_device` key, so the typed
`reloadConfig()` would silently drop it — same constraint as `audio.mode` and
`video_passthrough`. `supportsMeterDevicePreference(schemaVersion)`
(`cerastream-backend.ts`) is the fail-safe gate: an older engine is sent nothing and
keeps auto-picking, which is the exact pre-0.9.0 behaviour.

### ONE CARD, TWO VOCABULARIES — AND ONLY ONE MODULE RELATES THEM [EXISTS]

Everything above compares a card CeraUI names with a card the ENGINE names, and
those are only the same string on the ALSA arm. `audio-card-vocabulary.ts` is the
one place that relates them; nothing else may compare the two by hand.

CeraUI names a card by the KERNEL CARD ID it reads out of `/sys/class/sound/cardN/id`
— the vocabulary of `config.asrc`, the picker, and every `hw:CARD=<id>` string this
backend has ever produced. The engine names it by whatever its GStreamer device
provider published. Board-measured on a Rock 5B+ running cerastream 2026.8.3 with
`[audio] backend = "pipewire"`:

| kernel `cardN/id` | engine `alsa_card_id`                    |
|-------------------|------------------------------------------|
| `usbaudio`        | `USB Audio`                              |
| `hdmirx`          | `fddf8000.i2s-i2s-hifi i2s-hifi-0`       |
| `rk3588es8316`    | `fe470000.i2s-ES8316 HiFi ES8316 HiFi-0` |

Those right-hand values are ALSA **PCM** ids, not card ids — the first field of a
`/proc/asound/pcm` row. **That is an ENGINE defect** (its PipeWire arm reads a NODE
proplist, where the `alsa.id` fallback is the PCM id; `api.alsa.card.id` is absent
from the graph entirely), recorded separately and NOT worked around by pretending
the engine is right. What this module does is stop CeraUI being WRONG about it.

**Two independent consequences, two independent fixes.**

1. **The gate must not claim a foreignness it cannot prove.** `isForeignCardLevel`
   compared the two keys as bare strings, so `hw:CARD=usbaudio` met `card:USB Audio`
   and every selection, on every card, reported `not_selected_device` ("Not the
   selected device") for a card that was working — board-confirmed for `hdmirx`,
   `usbaudio` and `rk3588es8316` in one session. `classifyMeterIdentity` is now a
   TRI-STATE and only `foreign` suppresses: both keys are canonicalised onto a card
   this board knows, and a name belonging to NO known card is `unknown`, which
   proves nothing in either direction. This also stops an opaque `bluealsa:` PCM
   spec — whose `alsaCardKey` is meaningless — from suppressing a Bluetooth mic's
   own levels.
2. **The engine must be spoken to in its OWN vocabulary.** `resolveAudioCaptureDevice`
   — the single seam feeding BOTH `audio.device` (program) and `audio.meter_device`
   (idle meter) — now resolves the card to the engine's own `list-devices`
   `input_id`. On the ALSA arm that IS `hw:CARD=<kernel card id>`, so it is
   byte-identical; on the PipeWire arm a `hw:CARD=<kernel id>` matches no engine
   candidate at all, which is why the meter ignored the pick and an explicit device
   selection failed `audio-device-unavailable`.

**The join is DETERMINISTIC, never fuzzy.** `/proc/asound/pcm` keys each PCM id by
CARD INDEX and `/sys/class/sound/cardN` gives that index its card id, so
`ScannedAlsaCard` now carries `index` and `buildCardAliases` pairs the two. No name
similarity, no prefix matching, no vendor table — the product-name route was
available and rejected for exactly that reason. An unreadable `/proc/asound/pcm`
degrades to card-id-only aliases, i.e. the pre-existing single-name behaviour, and
never loses a card.

**…AND IT IS UNAMBIGUOUS, WHICH IS A SECOND PROPERTY, NOT A RESTATEMENT.** A PCM
id is NOT unique: two identical-model USB sound cards enumerate as two kernel card
ids (`snd_usb_audio` suffixes the second) and BOTH report the generic PCM id
`USB Audio`, so that name is a real alias of two different cards. The first
implementation resolved a name by taking the first card that claimed it — a
`.find()` in `engineAudioDeviceForCard` and a first-match loop in
`canonicalCardId` — so on the PipeWire arm, where the join key IS the PCM id,
selecting the SECOND unit routed to the FIRST unit's engine node, and the second
unit's OWN meter reading was then classified `foreign` and suppressed. Both halves
came from one ambiguous lookup, and both contradicted this module's own
"deterministic, never fuzzy" contract.

`buildCardAliasOwners(aliases)` is the reverse index that closes it: every name
this board answers to, mapped to the ONE card that owns it, or `null` when more
than one does. Four rules are load-bearing:

- **A shared name identifies NOBODY**, not the first claimant. `engineAudioDeviceForCard`
  returns no match for either twin, so `engineAudioDeviceString` falls back to the
  caller's own `hw:CARD=<kernel id>` through the UNCHANGED fail-soft path — a
  translation nobody can vouch for is still never invented.
- **On the meter side ambiguity is `unknown`, never `foreign`.** `canonicalCardId`
  answers `undefined` for a shared name, and `classifyMeterIdentity`'s existing
  tri-state then reports `unknown` — which proves nothing and SUPPRESSES nothing.
  `foreign` is a positive claim of misidentification and would silence the very
  device the operator picked; the two are different operator facts and collapsing
  them is the defect.
- **A KERNEL CARD ID still resolves, always.** It is unique by construction, so
  `ownerOfName` checks it first and each twin keeps its own identity — which is
  why an ALSA-arm engine (whose join key IS the kernel id) resolves both twins
  correctly and is byte-unchanged.
- **The card-id-only degrade is preserved by an EXPLICIT branch.**
  `engineAudioDeviceForCard` short-circuits on `key === cardId` before consulting
  the index, because an unreadable `/proc/asound/pcm` yields an alias table that
  cannot answer for any card. It looks redundant with the index and is not:
  removing it reddens 13 tests across three files (`audio-naming`,
  `audio-device-naming-cleanup`, `audio-naming-pipewire-arm`).

`isAliasOfCard` is deliberately NOT routed through the index — it is a MEMBERSHIP
test ("is this string one of the names for this card"), used by `isHumanAudioName`
to REJECT a non-human display name, and rejecting a shared generic name for both
twins is exactly right.

Coverage: `tests/audio-card-vocabulary.test.ts` (the parser against the board's own
verbatim `/proc/asound/pcm`, the alias build, both canonicalisation directions, the
translation with its ALSA byte-identical and engine-silent controls, the tri-state
matrix, and the twin-card describe: the second twin never routed to the first, the
fallback it falls to, `unknown`-not-`foreign` on the shared alias, each twin still
answering to its own kernel id, the ALSA-arm control, and the unique-alias control)
+ the retargeted `tests/audio-meter-bridge.test.ts` cases. Rule-E proof both ways:
restoring the bare-string comparison reddens 4 tests across the two files, and
restoring the first-match lookup reddens the 3 twin cases.

**It is a PREFERENCE, not a pin — and the engine is what guarantees that.** cerastream
only moves the named card to the head of its candidate list; its delivery-confirmation
demotion (a card holding the ALSA handle for 2 s without clocking a sample yields to the
next candidate, cerastream PR #71 / ADR-0007 §10–§11) is unchanged. So selecting a
powered-off receiver still ends on a working card, never on a permanently dead meter.
Do NOT add a CeraUI-side "force this device" path that tries to override that.

A failed push NEVER breaks the meter: `pushPreference` swallows and logs, the previous
preference stands, and the next config change or reconnect re-pushes.

**Because it is only a preference, the bridge must also REFUSE another card's audio.**
The engine reorders candidates but still meters whatever it CAN open, so an unopenable
selection leaves real, moving bars on screen that belong to a different device — the
meter lies rather than goes quiet. Found live on a Rock 5B+ with nothing plugged into
the HDMI-RX port: the operator selected `HDMI Input`, and the meter reported the RØDE
(`card:usbaudio`, rms ≈ −30 dBFS ⇒ ~49% fill on BOTH channels), which reads as healthy
embedded HDMI audio. `projectLevel()` therefore drops a level whose reported
`source.identity` names a different ALSA card than `meterPreference()` and broadcasts
the ADR's existing `unavailable` + `no_device` gap instead. `alsaCardKey()` reduces both
sides to the bare card id (mirroring cerastream's own `alsa_card_key`), so
`hw:CARD=x` / `plughw:CARD=x,DEV=0` / `card:x` all compare equal.

**It can only ever suppress a reading PROVEN foreign.** `isForeignCardLevel` returns
false unless BOTH sides name a card: a `null` preference has genuinely delegated the
choice, and an engine that reports no identity cannot be shown to mismatch. Note what
this means in the other direction — a preference that is wrongly `null` does not merely
fail to be pushed, it DISARMS this gate, so the two halves of the `"Auto"` defect above
compound instead of one covering for the other. A resolved `"Auto"` reaches here as a
real card and is gated exactly like a manual pick; only the `"Auto"` outcomes that name
no single card still arrive as `null`. An engine-sent `unavailable` passes through with
its OWN reason. Do NOT "simplify" this
by gating on the video-side `signal` field — audio and video are separate device lists
with no shared identifier (see "THREE capture-row states"), and the audio card's own
absence is the direct, device-agnostic evidence.

**Why an absent HDMI signal is genuinely NO audio, not silence.** Verified on the board:
without a signal the RK3588 `rockchiphdmiin` card still lists in `/proc/asound/cards` but
exposes NO capture PCM substream (no `card3/pcm0c`), `alsasrc device=hw:CARD=rockchiphdmiin`
fails `No such file or directory`, and the card never appears in the engine's
`list-devices` at all — so the preference is inert rather than merely losing. HDMI
embedded audio is therefore unavailable, never noise-that-reads-as-signal; a device that
DOES deliver audio without video still enumerates, still matches, and still meters.

**A suppressed reading must name the RIGHT gap, and must not be permanent.** The gate
above is correct to refuse another card's audio; two things about how it did so were
not. It reported every suppression as `no_device` ("No audio device") — a claim CeraUI
can prove false, because the selected card was still in its own `/sys/class/sound` list.
A mis-bound preference was therefore indistinguishable from an unplugged cable, and a
live investigation went looking for a missing config write that never existed. And it
never re-tried: the engine's `set_preferred_device` early-returns on an unchanged value,
so a plain re-push is inert, a card demoted for not delivering during its probe window
stays demoted while any other candidate keeps delivering, and a preference pushed while
the card was absent from the engine's registry stays inert. The meter was dead
indefinitely for a present device, with no recovery short of the operator re-picking.

- `foreignCardReason()` answers `not_selected_device` (additive
  `AUDIO_LEVEL_UNAVAILABLE_REASONS` member, copy in all 10 locales) when
  `isMeterPreferenceDevicePresent()` — an `audio.ts` predicate keyed on the PICKER
  VALUE, not the resolved ALSA string — says CeraUI still lists the pick. A selection
  CeraUI can no longer see keeps `no_device`, unchanged. Keying on the picker value is
  deliberate: a pick that is not a device-map key resolves through the alias fallback to
  a card CeraUI cannot vouch for, and must not claim presence.
- **LISTED IS NOT USABLE — presence requires a CAPTURE PCM.** The predicate above
  originally asked only `asrc in audioDevices`, i.e. "did CeraUI's `/sys/class/sound`
  scan see this card". That is not the same question. The RK3588 HDMI-RX enumerates
  PERMANENTLY — it is in the scan and in the picker whether or not a cable is live —
  so with "HDMI Input" selected the meter reported `not_selected_device` ("Not the
  selected device"), asserting a mismatch that does not exist for a card nothing can
  ever meter. Confirmed live: `/proc/asound/pcm` carries
  `03-00: rockchip,hdmiin i2s-hifi-0 : ` with NO `capture N` field, and
  `/sys/class/sound/card3/` has no `pcmC3D0c` node, while every working card does
  (`05-00: USB Audio : USB Audio : capture 1`, `pcmC5D0c`). This is EXACTLY the
  "absent HDMI signal is genuinely NO audio" case documented two paragraphs above, so
  it must report the SAME gap: `no_device`. `updateAudioDevices` therefore also records
  `audioCaptureCardIds` — the scanned cards owning at least one capture PCM, decided by
  the pure `hasCapturePcmNode(entries)` (ALSA names capture substreams
  `pcmC<card>D<device>c`; the `c` suffix IS the rule) — and presence now requires the
  pick to resolve to a card in THAT set. Same semantics as cerastream's
  `capture_card_ids()` (PR #73), which intersects `/proc/asound/cards` with the
  `capture N` fields of `/proc/asound/pcm`; asked here of the sysfs tree the audio scan
  already walks, so it costs no extra source of truth.
- **The card stays in the PICKER.** `audioCaptureCardIds` is a parallel set, never a
  filter on `audioDevices`: the operator selected that PORT and a signal can arrive at
  any moment, so removing the row would be a regression (and would change `asrcs` on
  the wire). Only claims that the card can DELIVER audio are gated on it.
- `noteForeignCardLevel()` re-asserts the preference **through `null`** — the only way
  to make the value change, so the engine clears its demotions and re-probes — after
  `AUDIO_METER_MISMATCH_GRACE_MS` (5 s) of uninterrupted foreign readings, at most once
  per `AUDIO_METER_REASSERT_INTERVAL_MS` (30 s). Bounded on both sides so a mismatch
  that is simply permanent (a selected card with no capture PCM) costs one cheap reload
  pair per interval and never a loop. One `warn` per episode names the selected card;
  the live investigation had zero signal because nothing was logged at all.

The gate itself is unchanged: a level whose `source.identity` names a different card
than the preference is still dropped. Only the reason string and the retry behaviour
moved. `AudioLevelMeter` needed no change — it already resolves the dynamic Paraglide
key with `resolveMessageKey(\`live.preview.audioUnavailableReason.${reason}\`)`.

**THE RECOVERY PATH MUST NOT BE GATED ON THE SIGNAL WHOSE ABSENCE IS THE FAILURE.**
`noteForeignCardLevel` watches frame CONTENT, so it can only ever run while frames
arrive — and the meter's worst failure is that they STOP. Confirmed live on a Rock
5B+: a changed pick published its `handoff` gap and the engine's level feed went
silent 2 ms later (last `audio-level` broadcast `23:34:27.615Z`, board clock
`23:48:25Z`), so the gap was the last thing the frontend was ever told and the meter
read a bare `Meter unavailable` — no reason suffix, because no frame was reaching
the browser at all — for 14 minutes with no operator action. With ZERO frames there
are no foreign readings to accumulate, the 5 s grace window never elapses, the
re-assert never fires, and every documented sync trigger (`asrc`/`source` change,
`updateAudioDevices`, `reresolveAudioForEngineChange`, bridge reconnect) is
EDGE-triggered on things that had all gone still. Same raise-but-never-retract family
as `policy_route_missing` and `active_encode` on stop; the difference is that the
un-retracted state lives in the ENGINE's meter sidecar.

`AUDIO_METER_FRAME_ABSENCE_MS` (2 500 ms) + `armFrameAbsenceWatchdog` /
`noteFrameAbsence` are the frame-ABSENCE half, sitting beside the content half:

- **It is a DEBOUNCE on arrival, not a poll.** Every `audio-level` event re-arms the
  deadline (ahead of the broadcast, so a throwing consumer cannot leave the feed
  unwatched), so expiry is ITSELF the proof that no frame arrived — no clock compare
  — and an UNARMED watchdog is exactly a connection that has not delivered a frame
  yet. That is how the "never fire before the first frame of a fresh connect" rule is
  satisfied by construction rather than by a second flag, mirroring
  `noteMeterSelection`'s first-connect silence.
- **2 500 ms is ~12 missed frames** at the sidecar's 5 Hz cadence — beyond event-loop
  jitter, a GC pause, or one re-subscribe on the binding's `autoReconnect`.
  Deliberately SHORTER than the 5 s content grace: absence is unambiguous, where a
  foreign reading deserves time to be corrected by the next frame.
- **ONE escape hatch, two triggers.** It calls the same `reassertPreference()`
  (through `null`) and shares `lastReassertAt`, so the two watchdogs cannot double up
  and a permanently-dead card still costs one cheap reload pair per
  `AUDIO_METER_REASSERT_INTERVAL_MS`. `reassertPreference(cause)` names which
  watchdog asked, so the log distinguishes a wrong card from a dead feed.
- **It never fires for a silenced pick** (`meterSilenced()` — the operator asked for
  silence) **nor for `null`** (Auto: the engine owns that selection). Both gates run
  AFTER the re-arm, so a feed that is silent for a reason we refuse to act on today
  is still being watched when that reason changes.
- **A missing client is the one case that does NOT re-arm** — there is nothing to
  re-assert against, and the next connect's first frame arms it again.
  `stopAudioMeterBridge` clears it.
- **It yields to a stream LAUNCH** (`launchInFlight()`), and so does the
  content watchdog — see the section below.

**A RE-ASSERT IS AN ACQUISITION, SO IT MUST NEVER RACE A LAUNCH.** Both watchdogs
recover through the same `reassertPreference`, which re-OPENS the selected card.
A launch RELEASES the idle meter on purpose (`audio_meter_begin_stream()`), so
levels legitimately stop — and `noteFrameAbsence` read those ~12 missed frames as
a stuck feed and grabbed the card back while the start's pre-flight was still
opening it. Measured on a Rock 5B+ with a DJI Osmo Pocket 3:

```
20:03:22.466  streaming.start issued
20:03:25.024  audio-meter bridge: no audio level for 2500 ms … re-asserting
20:03:25.026  audio-meter bridge: re-asserted the preference hw:CARD=DJIPocket3
20:03:27.142  audio-device-unavailable: ALSA capture device 'hw:CARD=DJIPocket3'
              is busy or unavailable   class=start_invalid retry=not_retriable
```

`deferReassertToLaunch()` gates both watchdogs on
`launchIsAcquiringAudio(getStreamLifecycleState())` — the lifecycle the
orchestrator already publishes, NOT a parallel signal. Three properties are
load-bearing:

- **`starting` is the ONLY gated state.** A successful launch leaves for
  `streaming` and a failed one for `idle`, so BOTH outcomes re-arm the watchdog
  immediately, and the state is bounded by the launch phase deadlines — the
  deferral can never become a permanent suppression. `reconfiguring` is excluded
  because it runs from `streaming`, where the idle meter does not hold the card.
- **The gate sits immediately BEFORE `lastReassertAt` is stamped**, so a deferred
  window does not spend the 30 s floor. Moving it one line later silently turns a
  deferral into half a minute of real suppression after the launch resolved.
- **The re-arm still happens above every gate** (unchanged), so a genuinely dead
  feed is watched throughout the launch and recovers on the very next window.

**This is necessary but NOT sufficient, and the remainder is engine-side.** It
removes ONE of two acquirers. The other is the idle meter's ordinary hold:
`syncAudioMeterPreference` pushes the preference on a source/`asrc` change, the
engine opens the card for the idle meter, and a launch seconds later needs that
same card. Board measurement with the watchdog gated and cerastream's bounded
1.5 s self-release retry deployed: 0/5 clean starts when the source is re-selected
just before starting, 2/5 when it is not — the same rate as before the gate. CeraUI
cannot close it: the engine has no "meter nothing" value (`meter_device: null`
means *auto-pick*, which re-opens a card rather than releasing one), so the
idle-meter → stream handoff can only be made atomic inside cerastream. Do NOT
"fix" the remainder by widening this gate to `streaming`, and do NOT delete the
gate because the start still fails — the watchdog re-acquisition is a real,
separately-proven racer.

**"No audio" is NOT "Auto", and only the picker value can tell them apart.**
`resolveMeterPreference` answered `null` for both, and `null` on the wire means
"engine, choose for yourself" — so the one pick that means *meter nothing* made the
engine auto-pick a card AND left `isForeignCardLevel` unarmed (it returns `false` for
a `null` preference by design). The meter therefore rendered another card's real,
moving audio under an "Audio source: No audio" label. (`"Auto"` no longer shares that
`null` — see the resolution bullet above — but `"No audio"` still resolves to one, so
this distinction remains load-bearing and is still the FIRST branch `projectLevel`
applies. The two defects are the same shape reached by different picks.) Found live in Wave H QA; it read
as a transient "few seconds of green bars" only because PR #232's frozen-content
watchdog happened to age the bars out once that card's content stopped changing.
`isMeterSilencedByPick(asrc)` (`audio.ts`, true for `NO_AUDIO_ID` alone) is the
distinction, and `projectLevel` applies it BEFORE every other branch — including the
engine's own `unavailable` reason, because the operator's explicit silence outranks
whatever gap the engine is reporting. It reuses the existing `mode_none` reason
(`resolveAudioMode("No audio")` is literally `{mode:"none"}`), so no schema or locale
change was needed. `DEFAULT_AUDIO_ID` and `AUDIO_SOURCE_AUTO` are deliberately NOT
silenced: the pipeline default really does hand sourcing to the engine, and `"Auto"` is
resolved to a concrete card instead (so it is gated on THAT card, never silenced).
Neither means "meter nothing".

### …AND A SOURCE THAT BRINGS ITS OWN AUDIO HAS NO CARD TO METER [EXISTS]

The paragraph above is about a PICK. This is the same shape reached from the
SOURCE, and it is the third member of the family: `resolveMeterPreference`
answers `null` for an rtmp/srt selection, `null` on the wire means "engine,
choose for yourself", and `isForeignCardLevel` needs BOTH sides to name a card —
so the engine's idle sidecar opened whatever card it could and its real, moving
bars rendered as the ingest source's own audio with no publisher connected. The
two halves compounded exactly as the resolved-`"Auto"` defect did: the `null` did
not merely fail to name a card, it DISARMED the gate that would have refused the
reading. Operator-reported, in their words: *"the RTMP & SRT input sources … try
to select other available audio source even if we are not receiving signal —
they should use their own audio, and when they start receiving signal/streaming,
of course use its own metrics."*

`isMeterEmbeddedBySource()` (`audio.ts`, over `auto-audio.ts`'s
`selectedSourceCarriesEmbeddedAudio`) is the distinction, and `projectLevel`
applies it immediately AFTER the explicit-silence gate. Five rules are
load-bearing:

- **It is keyed on the SOURCE, not on the pick and not on the Auto REASON.** Both
  Auto rules for a network source name no card — rule 1 answers `embedded` with
  the engine capability, rule 2 answers `pipeline-default` without it — so a
  reason-keyed gate would leave the un-capped half unguarded. It is likewise not
  keyed on `origin === "network"`: it is the AUDIO property that decides, and a
  network source the engine reports as `selectable` still wants a card.
- **It is NOT gated on `network_embedded_audio`.** That capability answers whether
  the ENGINE can ROUTE the muxed track; this answers whether the SOURCE owns a
  card, and an ingest row owns none under either answer.
- **A `streaming`-owned level passes STRAIGHT THROUGH, and that is the feature.**
  cerastream resolves an `AudioPlan::NetworkEmbedded` start to
  `MeterMode::ProgramAudio` — ADR-0007 §7's `embedded-HDMI` row, "no ALSA card of
  its own; the streaming leg is the meter" — so a level tagged `streaming` here IS
  the muxed track, and suppressing it would kill the one reading the operator
  asked for. The discriminator is the engine's OWN `source.owner` tag rather than
  a second lifecycle guess, so the two can never disagree about which leg is
  publishing.
- **The gap has its OWN typed reason**, `embedded_audio`, never `no_device`
  (nothing is missing) and never `mode_none` (the operator did not ask for
  silence). Copy: `live.preview.audioUnavailableReason.embedded_audio`, 10
  locales.
- **The ENGINE needs no change, and none was made.** It already refuses to give an
  embedded row an idle meter of its own; what was wrong was CeraUI presenting the
  sidecar's unrelated card as that row's audio.

Coverage: `tests/audio-meter-bridge.test.ts` → "an embedded-audio source has no
card to meter" (the suppressed sidecar level, the streaming passthrough, the
explicit-`No audio` precedence, the switch-retires-the-level case, the
never-re-assert case, and a non-vacuity control proving the SAME frame on the SAME
`null` preference is forwarded for a card-owning source). Frontend half:
`apps/frontend/AGENTS.md` → "…AND IT HAS NO DEVICE TO PICK, IN ANY CONNECTION
STATE".

**A pick change retires the level already on screen, without waiting for a frame.**
Every gate above acts on the NEXT event the engine sends, and the engine needs a
moment to re-point its sidecar — so between the config write and that event the meter
keeps drawing the PREVIOUS device's bars. `noteMeterSelection()` broadcasts the gap
immediately on a changed pick: `mode_none` when the new pick is silenced,
`embedded_audio` when the new source brings its own, `handoff` otherwise. Three
properties are load-bearing:

- **The change key is the TRIPLE** `(silenced, embedded, preference)`. "Auto" and
  "No audio" both resolve to a `null` preference, so a preference-only diff cannot
  see that switch — and an ingest source resolves to that same `null`, so without
  the embedded arm a switch ONTO one moves no part of the key at all and the
  previous device's bars stay up until the next engine frame.
- **It fires even while the bridge is disconnected.** `syncAudioMeterPreference()`
  calls it BEFORE the client check: the stale level was already broadcast, so it must
  be retired whether or not the engine can be told about the change yet.
- **It never fires on the first connect** (no prior selection recorded ⇒ nothing has
  been shown) nor on a re-enumeration that re-syncs an UNCHANGED pick — otherwise
  `updateAudioDevices` would blink the meter on every hotplug.

This is a re-evaluation, never a pin: the very next real level replaces the gap.

**A gap this side publishes may be held for one window before it is PAINTED, and
the two STATED reasons are exempt.** Every gap above is honest and every gap above
is also instantaneous, so a single dropped frame between two healthy readings drew
the full "Meter unavailable" treatment for one paint and took it away again — on a
board that reads as the meter blinking, and an operator cannot tell a blink apart
from the real thing. The frontend therefore holds a TRANSIENT gap over the reading
already on screen for `METER_UNAVAILABLE_DISPLAY_GRACE_MS` (1 200 ms, defined in
`apps/frontend/src/lib/components/preview/audio-meter-liveness.ts` and applied by
`LiveAudioMeter.svelte`). Three consequences bind THIS side:

- **It is a DISPLAY rule and changes nothing here.** No gap is delayed, suppressed
  or coalesced on the wire; a gap that outlasts the window still bands, with this
  side's own typed reason. Do not "simplify" a future paint problem by debouncing
  `noteMeterSelection` or the watchdogs instead — that would hide a real outage.
- **`mode_none` and `embedded_audio` are NEVER graced** (`STATED_UNAVAILABLE_REASONS`,
  read by `isTransientMeterGap`). Both are answers to something somebody just did —
  the operator's own "No audio" pick, and a property of the selected source — and
  both are published SYNCHRONOUSLY by `noteMeterSelection` on the selection change,
  i.e. squarely inside that window. Delaying either would make a deliberate action
  look laggy. A NEW stated reason published from this module must be added to that
  set on the frontend side in the same change; a gap carrying no reason at all is
  treated as transient, which is the honest default for the weakest claim on the wire.
- **The window is strictly below `AUDIO_METER_STALE_MS` (2 000 ms) and well above
  the sidecar's ~200 ms cadence.** Above the deadline the staleness watchdog would
  draw its own band first and the grace would be unreachable; at the cadence an
  ordinary missed frame would still reach the operator. It is unrelated to
  `AUDIO_METER_FRAME_ABSENCE_MS` (2 500 ms), which is this side's re-assert trigger
  rather than a paint rule — do not couple them.

Frontend half: `apps/frontend/AGENTS.md` → "…AND A TRANSIENT GAP IS HELD FOR ONE
DISPLAY WINDOW". Coverage there: `LiveAudioMeter.grace.test.ts`.

Coverage for both: `tests/audio-meter-bridge.test.ts` (the silenced pick vs. Auto at
the same `null` preference, the engine-reason override, no re-assert while silenced,
the switching gap before any frame, the Auto→No-audio pair key, the unchanged-pick and
first-connect silences, the disconnected path, and the hand-back to the new device).

Coverage: `tests/audio-meter-bridge.test.ts` (push on connect, `null` for Auto, re-push
on change, nothing sent to a pre-0.9.0 engine, a refused reload leaves levels flowing,
no-op while down, the schema gate, plus the foreign-card gate: suppressed mismatch,
untouched match, never-gated Auto/identity-less, passthrough `unavailable`, the
`alsaCardKey`/`isForeignCardLevel` unit table, and the reason/re-assert behaviour:
`not_selected_device` vs `no_device`, the grace window, the interval floor, and the
run reset; plus the frame-absence watchdog: the feed that simply stops, the shared
interval floor, the shared floor ACROSS both watchdogs, exactly one armed watchdog
per feed, no fire before the first frame of a fresh connect, the silenced and Auto
negatives, `stop()` disarming it, and a refused re-assert leaving levels flowing)
and `tests/audio-sources.test.ts` (`resolveMeterPreference` — alias,
no-alias, every `null` case, selector passthrough; plus `hasCapturePcmNode` and the
capture-PCM presence rule: a listed card with zero capture PCM is absent, a card that
owns one is present, the same card flips once its capture PCM appears, and an unlisted
pick stays absent — driven through a real sysfs-shaped fixture dir).

**NO CONFIG MIGRATION IS REQUIRED FOR THE PIPEWIRE ARM, and that is a TESTED
claim.** `resolveMeterPreference` reads the picker map + the alias table, and the
picker map is CeraUI's own `/sys/class/sound` walk — a read the engine's audio
backend has no part in. So a `config.asrc` persisted before any PipeWire work
existed resolves to the same engine target whichever arm is running, by
construction rather than by coincidence.
`tests/audio-naming-pipewire-arm.test.ts` pins every pre-migration shape — the
alias display name, a bare card id, a raw `hw:CARD=` / `plughw:CARD=…,DEV=…` /
`hw:N,M` selector, both pseudo-sources and an unset pick — against BOTH arms AND
against the literal pre-migration answers, so a change that moved both arms
together is still a failure. `"Auto"` is covered separately because it is the ONE
resolution that reads the engine's audio list: rule 5's `physical_group_id` join
is driven through the pure `resolveAutoAsrc` with each arm's really-crossed rows
and must answer identically. Do NOT add an `asrc` migration for the backend flip.

