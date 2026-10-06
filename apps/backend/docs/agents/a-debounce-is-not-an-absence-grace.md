<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A DEBOUNCE IS NOT AN ABSENCE GRACE [EXISTS]

The section above fixes the HOLD. The same rebind has a second half — the
RELEASE — and nothing in the chain absorbed it.

Measured on a Rock 5B+ (2026-07-30, DJI Osmo Pocket 3 `2ca3:0023` on `usb5`/EHCI)
by polling cerastream's `list-devices` and the kernel together across one
ordinary preview open/close. The rebind is emphatically NOT a device reset:
`devnum` never changes, only interfaces `1.0`/`1.1` move `uvcvideo → usbfs →
uvcvideo`, the camera's ALSA card stays bound with its PCM node inode unchanged,
and `/proc/asound/card5/pcm0c/sub0/status` reads `RUNNING` throughout. During the
HOLD, `held_devices.rs` reports `/dev/video1` with its `physical_group_id`
intact — no UI impact, exactly as designed. **On RELEASE the engine drops the
held record BEFORE it rediscovers the re-registered node**: `list-devices`
answers with 2 devices instead of 3 while the kernel node already exists again.
Measured at ≈400 ms, bounded above by the 2.0 s close→node-back re-registration,
and observed firing spontaneously twice more within 30 s of the preview closing —
so this is hit in ordinary operation, not only on operator action.

**Every existing defence in the chain is an EVENT DEBOUNCE, and that is a
different thing.** The `/dev` watch waits 200 ms for quiet before re-reading, the
audio scan 500 ms, cerastream's registry debounces adds/removes by 250 ms. Those
are all *wait-for-quiet-before-re-reading*. None of them is
*wait-before-believing-it-is-gone*, so a hole of any length propagates straight
to a verdict. Auto-audio resolution had no hysteresis at all
(`auto-audio.ts`), and `lifecycle-indicators.ts` still flips `bad` the instant a
selected id is missing from a non-empty scan.

The operator-visible result was a derived-state artifact, not an audio fault.
With `config.asrc = "Auto"`, `resolveAutoAsrcFromLiveState()` looks the VIDEO
source up first and rule 5 joins it to its own card on `physical_group_id`. In
the window that join has nothing to match, so Auto resolved
`no-same-device-audio`, `resolveMeterPreference` returned `null`,
`isMeterPreferenceDevicePresent` returned `false`, and the meter rendered
**"Meter unavailable · No audio device"** for a microphone that was bound,
enumerated and streaming into cerastream the entire time.

`modules/streaming/capture-presence.ts` `resolveSelectedSourceWithGrace()` is the
hysteresis, and it is deliberately NARROW — it is read by
`resolveAutoAsrcFromLiveState()` and nothing else. The `sources` broadcast, the
`lost` row, `resolveSourceRouting`, and the picker are all untouched.

- **It is hysteresis on the VERDICT, not on the sampling.** Distinct from every
  debounce above by construction: nothing here changes when the device list is
  read or what it contains, only how long a degraded view is tolerated before it
  is believed.
- **There are TWO windows, and they are not interchangeable.** The board proved
  why. `CAPTURE_ABSENCE_GRACE_MS` (2 000 ms) governs a row that is ABSENT or
  `lost` — a real presence question, kept short because a genuine unplug must not
  be held longer than the transient it absorbs. `CAPTURE_METADATA_GRACE_MS`
  governs a row that is PRESENT but has lost its `physical_group_id`, which is
  NOT a presence claim at all: CeraUI's own scan sees the node and the engine
  listed it, so holding the remembered join key there **cannot** mask a
  device-gone failure — the row's own presence is the positive evidence.
- **`CAPTURE_METADATA_GRACE_MS` is DERIVED, not chosen**:
  `VIDEO_SIGNAL_RECHECK_INTERVAL_MS + 1 500`. Nothing refills that field until
  the next engine-authored commit, and while idle the only thing that produces
  one is the `recheckSourceSignals` tick — so CeraUI's VIEW can stay
  under-identified for a full recheck interval even though the engine's own hole
  was ≈400 ms. Measured across three preview cycles on the board: 434 ms, 258 ms
  and **5 077 ms**, the last being one interval plus a 77 ms probe round-trip. A
  window sized from the engine-side measurement alone (2 000 ms) demonstrably
  broke through on that third cycle — do not "simplify" the two constants back
  into one, and do not re-derive this one from the engine-side gap.
- **The clock starts at the FIRST DEGRADED OBSERVATION, never at the last healthy
  one.** Our knowledge of the device is refreshed on someone else's cadence (the
  5 s signal recheck, a hotplug tick), so a window measured from the memory's
  AGE would be expired in steady state and would never fire when it is needed.
  "How long we have tolerated a degraded view" is the quantity that matters.
  Do NOT rewrite this as a staleness check on the remembered value.
- **"Is the row there" is NOT the question.** `degradationOf()` answers `absent`
  (row gone, or a `lost` placeholder) or `under-identified` (row present, join key
  gone). The second is the one the window actually produces on this board — when
  the `/dev` scan sees the node return first, the hotplug merge restores the row
  through `withKnownEngineMetadata`, which restores durable IDENTITY
  (`kind`/`stable_id`) and deliberately refuses to re-assert a same-moment
  topology relation. That refusal is correct and must not be "fixed"; the row is
  simply useless to rule 5, and the grace is what covers it.
- **Bounded and self-clearing, with no renewal path.** After the applicable window
  of UNINTERRUPTED degradation the memory is dropped and the live view is
  reported verbatim — a true unplug reads exactly as it did before this module
  existed. Only a genuinely healthy observation resets the run, so polling the
  window at the meter's 5 Hz cadence extends nothing.
- **Stable identity OUTRANKS the node path, in BOTH directions.** Two rows that
  both carry a `stableId` settle the question outright: equal proves the renumber
  (a libuvc camera renumbers on every cycle — the very cycle this exists for),
  UNEQUAL proves a different device took the freed node and the memory is dropped
  on the spot. A borrowed `physical_group_id` must never bind Auto audio to the
  microphone of a device the operator is no longer pointing at. Only when the
  evidence runs out does the node path decide.

Coverage: `tests/capture-absence-grace.test.ts` — the real live-state resolver
driven across the window with both degraded shapes, plus the negative controls
that matter: a sustained absence resolving honestly again, a repeatedly-observed
absence failing to renew the window, the boundary millisecond, a `lost` row, a
substituted device, a renumber, and the coarse/unset selections.

