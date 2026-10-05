<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE BLUETOOTH DOMAIN IS WIRED [EXISTS]

`modules/bluetooth/` shipped as a drivable foundation that nothing called. This
is its first live wiring: one process-wide `BluetoothStack`
(`bluetooth-runtime.ts`), a boot phase, a `bluetooth` broadcast, and the ten
`bluetooth.*` procedures. Wire contract:
[`packages/rpc/AGENTS.md`](../../../../packages/rpc/AGENTS.md) → THE BLUETOOTH DOMAIN
REUSES THE LADDER WITHOUT JOINING THE REGISTRY.

**The RPC layer TRANSLATES and GATES; it never re-implements.** The per-adapter
S5 lock, the S7 pending stamps, the bounded discovery window and every typed
BlueZ degradation are applied INSIDE the stack, so a handler that took its own
lock would be a second, drifting guard over one radio. `bluetooth-wire.ts` is the
pure projection (the Bluetooth twin of `modem-wire-projection.ts`).

Seven decisions carry weight:

- **"The operator switched it off" is checked BEFORE the stack's own
  unavailability.** The stack records an operator-disabled device as
  `bt_unavailable{bluez_unavailable}` — correct from its own point of view (it is
  not observing BlueZ) and misleading to an operator, for whom a switch they can
  flip and a service fault are opposite facts. Every mutating handler answers
  `bluetooth_disabled` first, and only past that gate does a cause mean what it
  says. `unit_missing` remains distinct from `service_start_failed`: the first means
  the image lacks a required unit, while the second means an installed unit refused
  to start.
- **The pairing agent is a real inbound D-Bus object.** The production
  `bluez-agent-exporter.ts` uses `@httptoolkit/dbus-native`'s existing
  `exportInterface` capability and issues `RegisterAgent` from that same
  connection, because BlueZ keys the registration on the caller's unique bus
  name. Export happens first; if it fails, no path is registered. The
  `NoInputNoOutput` policy answers `RequestAuthorization` only for the device in
  the operator-opened pairing window and rejects passkey/PIN requests.
- **A pairing is ATTEMPTED, not pre-refused, when no agent is registered.** A
  host that registers its own agent, or a peer needing no authorization, can
  still complete one, so refusing up front would withdraw a control that
  sometimes works. What changes is the LABEL: a BlueZ rejection with
  `agent.reason === "exporter_unavailable"` answers
  `pairing_agent_unavailable`, and `getStatus().agent` carries the same fact
  before the operator ever taps. `exporter_unavailable` remains a valid injected
  degradation, but the production default now supplies the exporter.
- **Live BlueZ signals omit a local sender predicate.** D-Bus `AddMatch` accepts
  the well-known `org.bluez` sender, but delivered messages identify the daemon
  by its unique `:1.x` name. The shared transport compares that sender literally
  after the daemon match, so naming `org.bluez` in the local spec discarded every
  `PropertiesChanged` / `InterfacesAdded` / `InterfacesRemoved` event.
  Interface+member matching keeps the live registry current; the initial
  `GetManagedObjects` snapshot remains unchanged.
- **The broadcast is on-change and trailing-debounced.** `onChange` fires on
  every registry edge and a discovery window turns every advertisement into one,
  so edges collapse onto a 250 ms trailing timer and the payload is compared
  before it is sent — the same on-change cadence `sources` follows. The timer is
  `unref`'d: a scan window must never hold the event loop open.
- **`enable`/`disable` REBUILD the stack rather than re-`start()`ing it.** The
  boot-reconnect latch is per-instance, and an operator who has just switched
  Bluetooth back on wants their trusted devices reconnected — the one moment
  "once per process" would be wrong.
- **The boot phase is FIRE-AND-FORGET behind `guardNonCritical`.** It enables
  systemd units and dials the system bus, so awaiting it would put a radio on the
  boot critical path. A dev host, a board with no controller and a masked
  `bluetoothd` all resolve to a typed `bt_unavailable` inside the stack, and the
  payload is also seeded into the post-auth initial-state push
  (`modules/ui/status.ts`) so a fresh client never waits for an edge.

Coverage: `tests/bluetooth-wire.test.ts` (the explicit recoverable booleans, the
omitted-vs-measured battery, the positive-evidence transport table, the claim
matrix incl. `no_adapter` ⇒ `unavailable` vs an unread stack ⇒ `enabled`, the
agent gap ⇒ `unavailable`, and the whole payload parsed against the published
schema) plus `packages/rpc/src/schemas/bluetooth.schema.test.ts`.

### …AND THE MICROPHONE PRESENCE ORACLE FOLLOWS THE ENGINE BACKEND [EXISTS]

`modules/bluetooth/bluetooth-audio-provider.ts` detects the installed generation
before either service reconciliation or microphone enumeration. BlueALSA wins a
mixed legacy image; otherwise `libspa-0.2-bluetooth` selects PipeWire and no marker
selects `unavailable`. Service reconciliation governs `bluetooth.service` alone on
PipeWire and adds `bluealsa.service` plus its drop-in only on BlueALSA.

`modules/streaming/bluetooth-audio.ts` intersects that provider with the configured
engine backend. Explicit `alsa` admits only BlueALSA, explicit `pipewire` admits only
PipeWire, and absent backend follows the installed provider. A mismatch exposes no
Bluetooth microphone. The exact `pipewire-capture` token is additionally required for
the engine-node arm: `sources.ts` preserves the
additive `device_address` from `list-devices` in `EngineAudioDevice`, CeraUI joins
that colon-form address case-insensitively to the BlueZ registry MAC, and the
matched row's `input_id` (`node.name`) becomes `AudioConfig.device` unchanged.
No matching row means no source, and the BlueALSA bus is not read on this arm.

On the BlueALSA provider, the existing `org.bluealsa` capture-PCM enumeration,
`audio-pcm-spec` gate, `bluealsa:DEV=<MAC>,PROFILE=sco` target, quality projection,
and retain-on-unreadable-bus behavior are byte-identical. The persisted identity is
also identical on both arms: `bt:` plus the upper-case MAC with colons replaced by
underscores. A reboot therefore resolves an existing selection to the current
backend target without rewriting config. `object.serial` is never consumed or
persisted.

Engine audio-list changes re-fold the PipeWire microphone before audio labels,
Auto resolution, and the meter preference are re-resolved. Mock capability
overrides can drive both the feature array and an addressable PipeWire node.
Coverage: `tests/bluetooth-mic-source.test.ts`,
`tests/dev-capability-profile.test.ts`, and the S6 boot case in `src/main.test.ts`.

### …AND A MICROPHONE THAT DROPS MID-STREAM IS TOLD, NOT REPAIRED [EXISTS]

`modules/streaming/bluetooth-audio-resilience.ts` is the operator-facing half of
a Bluetooth microphone vanishing. It repairs NOTHING, and that is the design.

**The engine already survives this, unasked.** cerastream's program audio is a
device⇄silence `fallbackswitch` whose actuator loop
(`cerastream/crates/cerastream/src/engine/audio.rs` `audio_actuator_loop`, over
the table-tested `crates/cerastream/src/audio.rs` `AudioActuator::poll`) polls
the device leg's `is-healthy` every 250 ms and answers `SelectSilence` on a
starve, `RebuildDevice` on a 3 s cadence while failed, and `SelectDevice` the
moment the leg is healthy again. The rebuild is opaque-spec aware and its failure
log is rate-limited to `OPAQUE_REBUILD_LOG_INTERVAL` (30 s), so a BlueALSA PCM
that is permanently gone costs one line per 30 s rather than an `eprintln` per
retry. **Do NOT add a second silence-on-disconnect mechanism in CeraUI, and do
NOT add a "re-promote the device leg" RPC** — none exists on the engine, and one
issued from here would race the actuator that already owns the decision.

**A reconnect therefore costs EXACTLY TWO things**: re-assert the idle-meter
preference (the engine holds none across a device leaving its registry, and
`set_preferred_device` early-returns on an unchanged value), and clear/emit the
notifications. `tests/bluetooth-audio-resilience.test.ts` proves the absence of
everything else against a REAL `audio-meter-bridge` over an injected engine
client: the only method that ever reaches it is `reload-config`.

- **`dropped` and `gone` are different registry facts.** BlueZ flips `Connected`
  for a link that dropped and retires the whole `Device1` row for a device that
  is gone. A drop the engine is still rebuilding for gets a retractable
  `bluetooth-source-dropped` warning; a retired row gets the TERMINAL
  `bluetooth-source-lost` error, which REPLACES a standing drop band in place
  rather than stacking on it. Both are `isDismissable` — the documented safety
  net, never the mechanism; the retraction evidence is the device's own return.
- **The verdict is HYSTERETIC, mirroring `capture-presence.ts`.**
  `BLUETOOTH_SOURCE_LOSS_GRACE_MS` (3 000) is sized against the ENGINE's own
  failover cadence, so a drop the actuator absorbs is silent. The clock starts at
  the FIRST degraded observation and a later edge inside the window never extends
  it. `BLUETOOTH_REASSERT_INTERVAL_MS` (5 000) is a leading-edge floor, so a
  radio that flaps five times in two seconds costs ONE re-assert, zero
  notifications and zero extra engine calls.
- **A device we never saw CONNECTED can never be "lost".** A trusted microphone
  simply switched off at boot is exactly that case and must stay silent — the
  same "absence is not evidence" rule the capture-presence grace follows.
- **DROPPED is stream-gated, GONE is not.** A drop is a claim about the live
  program leg; a retired row is a standing fact whether or not a stream is up.
- **The publish order in `bluetooth-runtime.ts` is the contract**: registry
  projection → picker re-fold → presence reconcile. Refreshing before publishing
  would re-derive the picker from the PREVIOUS registry view — at boot the empty
  one, so a trusted mic that just reconnected would be missing from the first
  source list an operator sees. Pinned by a source-order lock.

Coverage: `tests/bluetooth-audio-resilience.test.ts` (the presence table, both
hysteresis directions, the terminal escalation and its no-downgrade rule, the
never-seen-connected and non-Bluetooth-pick negatives, the exactly-two reconnect
duties, the storm bound, the engine-surface measurement, the boot reconnect's
once-per-process latch plus its re-arm on a module re-init, and the publish-order
lock). Rule-E proof in both directions: neutering the grace window reddens 2
tests, neutering the re-assert floor reddens 2.

**Honest status:** no claim here has been exercised against a real Bluetooth
microphone — every fixture models the BlueZ registry contract.

