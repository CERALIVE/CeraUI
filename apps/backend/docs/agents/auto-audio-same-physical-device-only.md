<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## "AUTO" AUDIO — SAME PHYSICAL DEVICE ONLY [EXISTS]

`resolveAutoAsrc` rule 5 (`modules/streaming/auto-audio.ts`) binds "Auto" to the
audio card on the SAME PHYSICAL DEVICE as the selected USB/UVC camera, decided by
`physical_group_id` equality (cerastream ADR-0008), and to nothing else.

**Name similarity is not evidence of shared hardware.** The retired matcher scored
a shared leading display-name prefix against a 4-character floor. The DJI Osmo
Pocket 3 is why it had to go: audio `"DJI DJIPocket3 at usb-fc880000.usb-1, high
speed"` vs video `"DJIPocket3: OsmoPocket3"` share only `"DJI"` — one character
short — so the join missed and Auto served a still-enumerated RØDE's microphone,
i.e. a **different physical device's mic** presented as the camera's own. Widening
the candidate names only moved the coin-flip. USB topology answers the question the
strings could only approximate. `MIN_COMMON_PREFIX`, `commonPrefixLength`, and
`engineAudioJoinNames` are DELETED; `grep commonPrefixLength` must stay empty.

**Three typed outcomes, and two of them pick nothing:**

| Same-group cards | Resolution |
|---|---|
| exactly 1 | that card, `reason: usb-same-device` |
| more than 1 | `ambiguous-same-device-audio` + `candidates[]` — NO auto-pick |
| 0, or a group-less camera | `no-same-device-audio` — NO auto-pick |

**LISTED IS NOT RECORDABLE — rules 3 and 4 are gated on a CAPTURE PCM.** Rules 3/4
bind a card named by a FIXED id list (`HDMI_CARD_IDS` / `C4K`) on the strength of
CeraUI's own sysfs scan ENUMERATING it, and enumeration is a different question
from "can this be recorded from". The RK3588 HDMI-RX is the counter-example, and
it is not theoretical: measured on a Rock 5B+ **with a locked 1080p59.94 signal
on the port**, `/proc/asound/cards` lists card 3, `/proc/asound/pcm` carries
`03-00: rockchip,hdmiin i2s-hifi-0 :` with NO `capture N` field, `/sys/class/sound/card3`
has no `pcmC3D0c`, and `arecord -l` never shows it. Rule 3 bound it anyway, so
**every** `asrc: "Auto"` start on the HDMI source died:

```
BCAST {"status":{"resolved_asrc":"HDMI","resolved_asrc_reason":"hdmi"}}
RECV  {"success":false,"error":"start_invalid",
       "failure":{"phase":"start-rpc","code":-32602,
         "message":"invalid params: audio-device-unavailable: ALSA capture device
                    'hw:CARD=rockchiphdmiin' is busy or unavailable",
         "retriable":false}}
```

An operator whose camera was working could not go live at all. The capture-PCM
presence set already existed in this file (`hasCapturePcmNode` / `audioCaptureCardIds`,
built by `updateAudioDevices` and consumed by the audio meter) — rule 3 simply never
consulted it. It now does, via `getAudioCaptureCardIds()` threaded onto the resolver
input as `captureCapableCardIds`.

- **The refusal is `no-capture-audio` → the `"No audio"` pseudo-source**, i.e. the
  engine's `audio.mode: "none"`, so the start SUCCEEDS as an explicit video-only
  stream. Board-proven: the same source, in the same minute, went `streaming` in
  2.774 s under that value. Do NOT "simplify" it to a `null` asrcKey — that OMITS
  `asrc` from the launch copy and hands the engine its own legacy inference over the
  very port that cannot deliver.
- **FAIL-OPEN.** `captureCapableCardIds` is OPTIONAL; `undefined` means the question
  was never asked, and an unasked question is not evidence — the rules then bind
  byte-identically to before the gate existed. Only a scan that positively lists the
  cards AND omits this one withholds.
- **The card stays in the PICKER**, unchanged — same rule as the meter's presence
  gate. The operator selected that PORT; only claims that it can DELIVER audio are
  gated.
- **Rule 5 deliberately does NOT carry this gate.** Its candidates must each carry an
  `alsa_card_id` from the ENGINE's `list-devices`, and a card with no capture PCM
  never appears there at all — the engine has already answered the question. Adding
  a fourth gate there would be redundant, not safer.

**AND THE HDMI-RX CARD HAS TWO NAMES — the KERNEL TRACK picks which.** Rule 3's
id was a single hardcoded `"rockchiphdmiin"`, which is what the Rockchip vendor
6.1 BSP calls the port's audio half. The mainline / Armbian `edge` 7.1 tree
registers the SAME physical port as `hdmirx` — the Synopsys `snps_hdmirx`
receiver plus a first-party `simple-audio-card` DT node — so
`findAsrcKeyByCardId(audioDevices, "rockchiphdmiin")` answered `undefined`, rule
3 fell silently through, and "Auto" NEVER bound HDMI audio on that kernel. Not a
degenerate case: board-proven on a Rock 5B+ running `7.1.5-ceralive-rk3588` with
`rk3588-kernel-patches` PR #2 applied, `/proc/asound/cards` reads
`2 [hdmirx] : simple-card - hdmirx`, `/proc/asound/pcm` gives it
`fddf8000.i2s-i2s-hifi … : capture 1`, and a live `ffmpeg` capture through
`hw:2,0` recorded `mean_volume: -29.0 dB` — real, non-silent audio.

- **`HDMI_CARD_IDS` (`auto-audio.ts`) is the ordered list**, and ORDER IS THE
  CONTRACT: the first spelling the device ENUMERATES wins, so a board reporting
  more than one resolves deterministically and a vendor-6.1 board is
  byte-identical to before. `findEnumeratedCard()` is the multi-spelling form of
  `findAsrcKeyByCardId`.
- **The capture gate is asked about the spelling that MATCHED**, never a
  canonical one — a listed-but-unrecordable `hdmirx` is refused with
  `no-capture-audio` exactly as `rockchiphdmiin` is, and the mainline card is
  registered by a DT node that exists whether or not a cable is locked. Widening
  rule 3's id list did NOT weaken its gate.
- **It stays a NAME LIST, and that is the decision, not an omission.**
  cerastream's `capture_card_ids()` (`alsa_hotplug.rs`) detects capture-capable
  cards generically with no names at all — but that answers "can this card
  record", which CeraUI already asks separately via `captureCapableCardIds`. Rule
  3's question is "WHICH card is this port's audio half", and answering THAT by
  capability would bind an HDMI source to whatever unrelated microphone happened
  to be plugged in, i.e. exactly the cross-device guess rule 5 was rewritten to
  remove. Key on the IP block, never on a board model or kernel version — the
  same rule `ONBOARD_VIDEO_DISPLAY_RULES` already follows for the video half.
- **`RK3588_AUDIO_SRC_ALIASES` (`audio.ts`) is deliberately NOT dual-named.**
  `getAudioSrcReverseAliases()` inverts that table, so two card ids sharing the
  label `"HDMI"` would make `getAudioSrcId("HDMI")` answer with whichever was
  declared last — resolving a vendor board's pick to `hw:CARD=hdmirx`, a card it
  does not have. Rule 3 needs no alias (it joins by card-id VALUE), the tier-0
  display rule gives the edge-7.1 card the same `HDMI Input` label, and the
  `priority` list carries `hdmirx` so the port keeps its top placement.

Wire contract: `resolvedAsrcReasonSchema` (`@ceraui/rpc`) gains `no-capture-audio`;
the frontend bands it as `audio-no-capture` (`live.source.audioNoCapture*`, 10
locales) rather than letting it fall through to the em-dash. Coverage:
`tests/auto-audio.test.ts` → "a bound card must be able to CAPTURE (W4A4-F1)" (the
pure table incl. the fail-open and un-enumerated controls, the launch copy asserting
`{mode:"none"}`) + "Auto on the board's real HDMI topology (W4A4-F1 wiring)" (a real
sysfs fixture reproducing `card3`-without-`pcmC3D0c`, driven through
`resolveAutoAsrcFromLiveState`, with the capture-PCM-appears control) +
"the HDMI-RX card under BOTH kernel spellings" (the `hdmirx` bind, its own
capture-PCM refusal and `{mode:"none"}` launch copy, the fail-open control, the
both-listed ordering contract, the unchanged vendor bind, and the non-HDMI-source
negative) — plus the two `hdmirx` sysfs fixtures added to the wiring describe.

The generic `usb-alias` and `first-device` fallbacks are GONE, from the code AND
from `resolvedAsrcReasonSchema`: each could only ever name a card on a different
physical device, which is precisely the defect. Both non-resolutions ride `status`
(`resolved_asrc_reason` + `resolved_asrc_candidates`) and the UI turns each into a
manual-selection prompt (`SourceSection.svelte` bands `audio-same-device-ambiguous`
/ `audio-no-same-device`) rather than a silent em-dash.

**An ABSENT group never matches — not even another absent group.** `samePhysicalGroup()`
is the TS mirror of cerastream's helper (ADR-0008 §6): a match requires BOTH sides to
carry a key AND the keys to be equal. `None` means "no USB topology to key on" (HDMI-RX,
onboard audio, Bluetooth, test sources), not "unknown, might be the same" — and on the
wire the key is simply ABSENT for those, which is treated identically to an empty string.
A bare `a === b` would pair every group-less card with every group-less camera. Do NOT
"simplify" it back.

**A candidate must clear three gates**, not just the group: the engine gave it an
`alsa_card_id` (no join key, no candidate), it shares the camera's group, and CeraUI
itself enumerates that card — a card the engine lists but this device cannot open is
not selectable, so it is not offered.

**Auto re-resolution stays launch-only.** `refreshResolvedAsrcPreview` still returns
early while streaming, so an ambiguous or absent verdict can never disturb a running
stream; it is computed at start and on idle preview.

**Manual selections are untouched.** A concrete `config.asrc` short-circuits every
Auto path (`resolveLaunchConfig`, `refreshResolvedAsrcPreview`, `applySwitchInputFollow`),
still resolves through the unchanged alias/card lookup, and still migrates by stable
identity via `reconcileConfiguredAudioIdentity`.

The field is threaded verbatim from the engine: `fromEngineDevice` → `CaptureDevice.physical_group_id`
→ `StreamSource.physicalGroupId` (video) and `probeEngineDevices` → `EngineAudioDevice.physical_group_id`
(audio). It is deliberately NOT restored from `lastEngineVideoDevices` — a group id is a
same-moment topology relation, not a durable identity like `stable_id`.

Coverage: `tests/auto-audio.test.ts` (the matcher table: 1 / N⇒ambiguous / 0 / group-less
camera / group-less card / empty-string group / un-enumerated card / no join key, the two
board topologies, manual precedence, and the saved-selection migration).

**An unavailable selected input fails the start ONCE, as itself.** `asrcProbe()`
polls for `AUDIO_PROBE_TIMEOUT_MS` (15 s) — a deliberate "give the device a moment
to come back" grace window that also wakes early on a hotplug re-enumeration. That
window is LONGER than the generic 10 s per-attempt launch deadline, so the deadline
used to preempt it and misclassify a permanently-absent device as a retriable
`start_timeout`. `asrcProbeRemainingMs()` now feeds the retry runner's
`pendingGateRemainingMs` seam so the deadline defers behind the probe, and the
probe's own expiry surfaces the non-retriable `audio_source_unavailable` class
(carried on `StartStreamResult.failureClass`). The probe still runs BEFORE the
sender spawn and any engine IPC, so a probe failure dispatches ZERO engine `start`
calls. A stop during the window still resolves as the first-class `cancelled`
result, not a failure — the orchestrator's cancellation check runs ahead of
classification. Coverage: `tests/audio-probe-start-classification.test.ts`,
`tests/audio-probe-failure-reason.test.ts`.

