<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A LIVE CAPTURE DEVICE IS NEVER SILENTLY DROPPED [EXISTS]

`buildSources` folds each device into the coarse capability entry its kind bridges
to. That is an INTERSECTION of two INDEPENDENTLY-VERSIONED vocabularies — the
engine's `capabilities.sources[]` ids and `DEVICE_KIND_TO_PIPELINE_ID` — and when
they disagree the intersection is EMPTY, so EVERY camera disappears at once.

Board-confirmed on a Rock 5B+ (operator-reported): the device ran the released
cerastream `2026.7.2` (commit `5544fe3`, `SCHEMA_VERSION 0.4.0`), whose catalog
advertises the retired `camlink` / `v4l_mjpeg` ids, against a CeraUI that bridges
`hdmi` / `usb_mjpeg`. A connected, locked **1920x1080@59.94** HDMI-RX input and a
connected RØDE USB camera BOTH vanished, and because `SUPPRESSED_COARSE_PIPELINE_IDS`
drops the legacy coarse rows unconditionally, the picker collapsed to the single
virtual test pattern — indistinguishable from "no hardware attached".

Diagnostic note worth keeping: the engine's `devices` list was CORRECT throughout
(`/dev/video1`, `kind: "hdmi"`), and `v4l2-ctl --query-dv-timings` reported the real
signal. The loss was entirely in this projection. The USB camera disappearing
alongside the HDMI one is what rules out any kernel/HDMI-RX explanation — a
receiver fault cannot unlist a USB webcam.

`buildUnofferedCaptureEntry` renders such a device `available: false` with
`live.education.reason.pipelineNotOffered` instead of `continue`-ing past it. This
is the same FAIL-CLOSED-AND-VISIBLE rule `networkAvailability` already applies to an
inactive gateway ("still emitted, just unavailable, never dropped") and the house
rule that an unsupported option is disabled-with-a-reason, never hidden.

Three scoping rules are load-bearing:

- **Only when NOTHING in the catalog speaks for the pipeline** (`basePipelineIds`).
  A `test`-kind device bridges to `test`, which exists as the VIRTUAL row and
  already represents it; without this check that row doubles. A regression test
  caught exactly this.
- **Only for kinds that DO name a video pipeline.** An unrecognised engine kind
  collapses to `"other"` in `mapEngineDeviceKind`, which is the SAME bucket as the
  SoC codec/scaler nodes (`rockchip-rga`, the `hantro-vpu` dec/enc/av1 nodes), so
  CeraUI cannot tell an unknown camera from a non-camera there. Rendering them all
  would put four codec blocks in the operator's picker. Dropping stays correct —
  this is a KNOWN, accepted boundary, not an oversight.
- **Appended last, never interleaved**, so it displaces and reorders nothing.

It is a SAFETY NET, not a substitute for a current engine: the row is deliberately
not selectable, because the pipeline really is not offered and a start would fail at
`pipeline_not_in_offered_set`.

Coverage: `tests/unoffered-capture-visibility.test.ts` (the real board payload, the
`test`-only regression lock, the conservative-facet and wire-schema assertions, and
the four negatives: codec nodes, audio class, the virtual/network double-render, and
row-order stability).

## …AND NEITHER IS A LIVE AUDIO CARD [EXISTS]

The section above is about VIDEO, and its cause was two independently-versioned
vocabularies disagreeing. The audio list has the same shape of defect from a
different pair, and it is worse: it loses EVERY card at once with no row left to
render a reason on.

`updateAudioDevices` reads `setup.sound_device_dir` as a sysfs CLASS directory
(`cardN/id`, `cardN/pcmC<N>D<M>c`). `setup.json` is a STATIC value packaged
verbatim into the `ceralive-device` `.deb` — the same drifting artifact
`warnOnHardwareIdentityDrift` exists for — so a value naming any other layout
yields ZERO cards and `audio_sources` collapses to its two pipeline
pseudo-sources, indistinguishable from a board with no sound hardware.

Board-confirmed on a Rock 5B+ running current CeraUI against `ceralive-device
2026.7.2-20260719T181141`, whose packaged `setup.json` still carries the pre-#166
`"sound_device_dir": "/dev/snd"`. That directory holds ALSA's DEVICE NODES
(`controlC0`, `pcmC0D0c`, `timer`) and NO `cardN` directory at all, so a
connected, capture-ready RØDE HDMI-to-USB-C —
`0 [usbaudio]: USB-Audio - RØDE HDMI to USB-C`, `00-00: USB Audio : capture 1` —
was absent from the picker entirely. `debug.log` recorded the whole story in one
line: `audio devices: {"No audio":…,"Pipeline default":…}`.

Diagnostic note worth keeping: the ENGINE's audio enumeration was correct
throughout (the fixed board's `audio_sources` carries `transport: "usb"` and
`stable_id: "card:usbaudio"`, both of which come from the engine join), so this
was never an engine gap. And fixing `setup.json` — PR #166 already did — only
reaches a device on the NEXT full `.deb` upgrade, so the code has to survive the
disagreement in the meantime.

**`resolveConfiguredAlsaCards` (`alsa-card-scan.ts`) is the reconciliation, and
it is POSITIVE-EVIDENCE-ONLY.** A configured directory naming at least one card
answers unreconciled; a configured directory that IS the canonical one has
nothing to fall back to; otherwise it read cleanly and named no card, which is a
statement about the PATH and never about the hardware, so
`/sys/class/sound` is asked and answers only if IT names cards. A board that
genuinely has none is byte-identical to before. The rescue scan can never throw —
it exists to recover from a bad configuration, not to turn one fault into another.

**The `dir` argument of `updateAudioDevices` is honoured VERBATIM, and that is
load-bearing.** Only the OMITTED (production) argument reconciles. The drift is
between `setup.sound_device_dir` and the kernel, so a caller that names a
directory has already stated the answer — and second-guessing it would make every
sysfs-shaped test fixture report the HOST's own sound cards instead of the
fixture's. `getResolvedAlsaCardDir()` is what proves the production path really
routes through the resolver rather than around it.

**A card the kernel proves is an OUTPUT is dropped structurally, not by name.**
The hand-maintained `exclude` list has always meant exactly this —
`rockchipdp0`, `rockchiphdmi0/1/2` are the SoC's DisplayPort and HDMI PLAYBACK
cards — but a card-id list is itself a vocabulary, and the kernel's is not the
same one: this board names those blocks `hdmi0` / `hdmi1` (simple-card), which
the list does not match. So the moment the scan started finding cards again, two
speakers would have rendered as selectable microphones. `isPlaybackOnlyCard`
(`audio.ts`) asks the structure instead: ALSA names a substream
`pcmC<card>D<device><p|c>`, and a card owning at least one `p` node and NO `c`
node has told the kernel it plays and does not record. The list is KEPT as a
back-stop; it is simply no longer the only defence.

**The zero-PCM case is deliberately NOT an output.** That is the RK3588 HDMI-RX —
an INPUT that enumerates permanently and exposes no substream at all until a
cable locks (see "LISTED IS NOT RECORDABLE" above). Absence of evidence is not
evidence: a card that has claimed no direction keeps its picker row exactly as
before, and only `audioCaptureCardIds` gates claims about what it can deliver.
Inverting this would silently delete the HDMI-RX row, so do NOT "simplify"
`isPlaybackOnlyCard` into `!hasCapturePcmNode`.

`rk3588es8316` joins `ONBOARD_AUDIO_DISPLAY_RULES` as `Onboard Audio` for the
same reason PR #274 added `snps_hdmirx` to the video rules: the board's onboard
codec has no human string to clean, and the fix is what made its row reachable.

Coverage: `tests/audio-card-scan-drift.test.ts` (the board repro driven through
the real resolver, the `isPlaybackOnlyCard` table, the board's own card tree
through the real scan, the wiring lock, and the negatives that matter: a
configured directory that DOES name cards is never second-guessed, a genuinely
card-less board stays empty, the rescue scan cannot throw, a non-ENOENT error on
the configured directory still rejects, and a signal-less capture card keeps its
row).

