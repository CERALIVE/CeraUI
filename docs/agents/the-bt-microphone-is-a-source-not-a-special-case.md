<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE BT MICROPHONE IS A SOURCE, NOT A SPECIAL CASE [EXISTS]

**The presence oracle follows both the installed provider and the engine's configured
audio backend, never BlueZ `Connected`.** BlueALSA is detected from its daemon/package;
PipeWire Bluetooth is detected from `libspa-0.2-bluetooth`. When both are present during
a migration, BlueALSA wins so the old image retains its working unit contract. An
explicit `alsa` backend can use only BlueALSA, and an explicit `pipewire` backend can
use only PipeWire; a mismatch publishes no Bluetooth microphone. When the selected
arm advertises the exact `pipewire-capture` feature token,
the oracle is its `list-devices` audio row whose optional `device_address` matches the
paired registry MAC; CeraUI sends that row's `input_id` (`node.name`) through
`AudioConfig.device` unchanged. A connected registry device with no matching engine
node yields no source. CeraUI compares the colon-form address case-insensitively and
keeps the persisted id byte-identical as `bt:<upper-case underscored MAC>`; it never
persists PipeWire `object.serial`.

On a detected BlueALSA image, the oracle remains the `org.bluealsa` capture PCM object
byte-for-byte. A device can be connected with no PCM behind it, and naming it as an
available source is a claim the device cannot honour. `scoCapable` + PCM present yields
the row; connected-but-no-PCM yields none; A2DP-only yields none.

The address is `bluealsa:DEV=<MAC>,PROFILE=sco`, routed through `AudioConfig.device`
unchanged: `toAlsaCaptureDevice` passes it through untouched because it already carries
`:`/`=`, so the opaque spec reaches the engine's `alsasrc device=` **verbatim**. The
engine half is cerastream's `AlsaPcmSpec::Opaque` seam, gated on the `audio-pcm-spec`
features token; the gate reads a `z.array(z.string())` wire field and **fails closed**
on the minimal-safe fallback rung, which carries no `features` at all. See
`cerastream/AGENTS.md` → OPAQUE ALSA PCM SPECS.

**The mic hint is gated on CONNECTED, not on paired.** A bonded-but-disconnected mic has
no PCM behind it — the same rule the `audio_source_unavailable` start class enforces one
layer down. With the ALSA backend selected on a PipeWire image, the Network card replaces
the Live-source pointer with an inline instruction to choose PipeWire first.

**`dropped` and `gone` are different BlueZ facts and must not be one band.**
`PropertiesChanged{Connected:false}` is expected back (the engine is already rebuilding
for it) and gets a retractable warning; `InterfacesRemoved(Device1)` needs a human and
gets a **terminal** error that REPLACES the warning in place rather than stacking. And
"we never saw it connected" is a third, silent state: a trusted mic switched off at boot
sits in the registry `connected:false` forever, and claiming it was *lost* would put a
standing error on a device that is merely off.

**Recovery is the ENGINE's; CeraUI only speaks.** There is no re-promote RPC anywhere on
the engine surface — `ProgramAudioBranch` is a device⇄silence `fallbackswitch` whose
actuator polls every 250 ms (silence at 1100 ms, rebuild on the 3 s cadence). A radio
flaps, so the verdict needs hysteresis and the re-assert needs a floor, and the two
bounds answer different questions: `BLUETOOTH_SOURCE_LOSS_GRACE_MS` (3 000) is sized
against the engine's own failover cadence so a drop the actuator absorbs stays silent,
while `BLUETOOTH_REASSERT_INTERVAL_MS` (5 000) is leading-edge. A 5-events-in-2 s storm
costs 1 re-assert, 0 notifications, and zero engine calls beyond the meter
`reload-config`.

**The publish order in `bluetooth-runtime.ts` is source-order-locked**: registry
projection → picker re-fold → presence reconcile. Getting it wrong is invisible in
steady state and only bites at boot, where the previous registry view is the empty one
and a trusted mic that just reconnected would be missing from the first source list an
operator sees.

**Board validation status:** the software path is fixture- and injection-proven and the
Bluetooth registry/pairing halves are board-proven, but **no physical BT microphone
exists at the bench**, so the picker → meter → stream → power-cycle drill has not run.
Recorded as a hardware gap, not a code gap, in
`docs/RELIABILITY-FINDINGS.md` → B4.

