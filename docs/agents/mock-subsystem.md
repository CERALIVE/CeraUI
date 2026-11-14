<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## MOCK SUBSYSTEM [EXISTS]

The mock subsystem provides hardware simulation for development and testing. It is
activated by `MOCK_SCENARIO` env var and gated behind `shouldUseMocks()` — never
`isDevelopment()` directly. All mock state is owned by `mock-service.ts`.

**Zod-validated fixtures (`mocks/mock-schemas.ts`):**
Every shipped fixture in `mock-config.ts` is validated against a Zod schema at
`initMockService()` time. A drifted fixture (wrong IMEI length, bad IPv4, unknown
SIM-lock state) fails loudly in dev instead of silently feeding malformed data into
the mmcli/nmcli/relay providers. Schema types are the single source of truth — both
`mock-config.ts` and `mock-service.ts` re-export `z.infer<...>` types from here.

The modem fixtures also carry the existing `usb_modem_net` marker, validated by
the shared wire schema. `providers/network.ts` resolves it by the active scenario's
modem `interfaceName`; `applyModemNetProjection` uses that source only in mock
mode and retains its ordinary one-frame retraction. This makes the default
`multi-modem-wifi` topology exercise the same marker-plus-roster-claim handover
as a real device, without changing addresses, bond membership, or netns dongles.

**`resetMockState()` for per-test isolation:**
`initMockService()` captures a deep `structuredClone` of the seeded state as a
pristine snapshot. `resetMockState()` restores that snapshot AND clears all timers
(periodic-fluctuation + relay) — side-effect-clean, so each test starts from the
scenario's seeded state with no leaked intervals or cross-test bleed. Use in
`afterEach` for any test that mutates mock state.

**`updateMockState(partial)` — single write path:**
All writes to `mockState` funnel through the typed `updateMockState(partial)` mutator
(Object.assign top-level merge). The four named setters (`setMockModemConfig`,
`setMockWifiConnection`, `setMockNetifConfig`, `setMockEncoderConfig`) are thin
wrappers that compute the next slice and delegate to it.

**Bluetooth mocks (`providers/bluetooth.ts`):**
Dev/e2e parity for the BlueZ path with no controller: an adapter, a discoverable
roster, a pair/trust state machine and a bounded, TIMED scan window, all in
memory. Three rules carry it:

- **Nothing states `deviceClass` / `scoCapable` / `transport`.** All three are
  DERIVED through the production code that derives them on a board
  (`deriveCapability()` + `buildBluetoothStatus()`), so a fixture claiming a SCO
  leg beside an A2DP-source-only UUID is unexpressible rather than merely
  discouraged. The roster spans all four outcomes on purpose: an HFP mic
  (`audio-input` + `scoCapable`, battery 80%), an A2DP-source-only phone
  (`audio-input`, NO SCO leg — the forcing case), a playback-only speaker and a
  bare advertisement (both `unknown`).
- **The state is OUTSIDE `mockState`, and that is deliberate.** It owns scan
  timers, which `structuredClone` cannot capture, so the pristine snapshot could
  neither hold nor restore them. Its seed is a pure function of the active
  scenario, so `resetMockBluetoothState()` — called by BOTH `initMockService()`
  and `resetMockState()` — re-derives the pristine state and drops every timer.
- **Refusals use the SHARED `bluetoothMutationRefusalSchema` vocabulary**, in the
  same gate order `bluetooth.procedure.ts` applies, so a dev refusal a surface
  renders is the string a board would answer with. `setMockBtScenario(partial)`
  is the test/dev override seam (the `setMockEngineCapabilities` pattern) that
  makes the adapter-absent and operator-disabled arms reachable without a
  scenario per combination.

**Add-on + kiosk mocks (`providers/addons.ts`, `providers/kiosk.ts`):**
`MockAddonDescriptor` and `MockAddonState` are the canonical fixtures for add-on
tests. `MOCK_KIOSK_STATUS`, `MOCK_KIOSK_TOKEN`, and `MOCK_COG_DISPLAY_DESCRIPTOR`
are the kiosk fixtures. `resetMockKioskState()` resets kiosk state between tests.

**SIM PIN mock (`mocks/mock-schemas.ts` + `fixture-factory.ts`):**
`MockSimState` carries `lock`, `pinRetries`, and `pukRetries`. The factory's
`buildMockSimState(overrides)` builds a schema-valid SIM state for tests that need
to exercise the PIN/PUK unlock flow without a real modem.

**Cerastream error simulation (`providers/streaming.ts`):**
The streaming mock provider can simulate structured engine errors (Tier-2 codes from
`cerastream-error-mapping.ts`) so the frontend notification path is testable without
a real cerastream process.

**Device-detection override (`modules/system/device-detection.ts`):**
`withDeviceType(type, fn)` is the canonical test helper for flipping the
`isRealDevice()` gate. Sets `CERALIVE_DEVICE_TYPE` before calling `fn`, restores
(or deletes) in a `finally` block — exception-safe and supports nesting.

**Fixture factory (`mocks/fixture-factory.ts`):**
One typed builder per mock domain object: `buildMockModem`, `buildMockWifiRadio`,
`buildMockWifiNetwork`, `buildMockRelay`, `buildMockAddonDescriptor`,
`buildMockAddonState`, `buildMockKioskToken`, `buildMockSimState`. Each builder
merges caller overrides with sensible defaults and runs the result through the same
Zod schema that validates the shipped fixtures — an out-of-range value throws at the
build site, not at the provider.

**Engine-driven health mock:**
The streaming mock provider exposes a `MockHealthState` slot that drives the
`ingest-health` signal in dev. Tests can set `health.score` and `health.degraded`
via `updateMockState` to exercise the health-alert rendering path.

**Scenario-seeded capability profiles (T5):**

Three scenario-seeded `MOCK_SCENARIO` values drive the engine-capability state that
`getCapabilities()` serves to the frontend. The mock fetcher drives the fallback
ladder by what it returns or throws — no direct flag mutation:

- `caps-full` — full engine profile: H265 + hardware accel, audio-capable HDMI
  source, `audio_live_switch` enabled, `transports: ["srtla","srt"]`. Use this to
  exercise the full Live destination UI (all controls enabled, RIST/SRT transport
  selector visible).
- `engine-starting` — mock fetcher throws `CerastreamConnectionError` with an empty
  cache, so `getCapabilities()` returns the minimal safe floor with
  `engineStarting: true`. Simulates the device booting before cerastream is ready.
- `engine-unavailable` — mock fetcher throws after seeding a last-known-good
  snapshot, so `getCapabilities()` returns the cached snapshot with
  `engineUnavailable: true`. Simulates a cerastream crash after a successful start.

Full profiles report `encoder.default_codec: "h265"`; the minimal safe floor
leaves it absent. Active mock encodes report `route_reason: "not-compressed"` for
capture and `"adaptive-active"` for network ingest. Existing uppercase `codecs`
values remain unchanged. `mock-capabilities-producer-schema.test.ts` checks every
scenario through the installed producer parser and the RPC projection.

**Audio mix and free geometry [EXISTS; host simulation].** Only `caps-full`
adds `audio_mix` (four inputs, four tracks, -60 to 12 dB, up to 2000 ms),
`audio-mix`, `composition` and `composition-geometry`, and a third audio device
(the existing HDMI Input fixture name). Other scenarios retain their previous
fields and omit these additions, including `multi-modem-wifi`.

`startMockStreaming(params)` admits producer-owned `StartParams`, preserving
`audio.inputs` and `composition.rect` in `mockState.engineStart`. The mock
enforces the engine's empty/count/duplicate input, track membership/gaps,
gain/delay, device/mode conflicts and embedded-network rules, then resolves
audio registry identities before checking rectangle validity, compositor
availability, secondary/alpha/capture admission and finally mix factory support. An unknown audio identity therefore
outranks every composition refusal, including its capture causes.
`setMockAudioMix` validates
the whole batch before committing, preserves tracks, echoes applied defaults,
and refuses a non-mix session with `audio-mix-inactive`. Unknown input errors
carry `cerastream.audio.device_not_found`; `switchMockAudio` refuses a running
mix with `audio-mix-active`. Stop and reset clear the admitted session.

The live methods preserve their separate native admission orders.
`setMockAudioMix` checks the admitted mix session, then each update's identity
before its values, validating each update before proceeding to the next.
`changeMockComposition` checks the running session, then rectangle validity and
compositor availability and the same secondary/alpha/capture admission; it retains the already-admitted audio. Neither live
method invents a new Start admission or changes the other subsystem's state.

`changeMockComposition` enforces missing/unexpected/range rectangle errors and
the compositor availability gate for presets and custom layouts. At start and
live, an unavailable compositor returns
the native `composition-unsupported` refusal: numeric code `-32602`,
`data.code: "cerastream.params.invalid"` and
`data.capture_causes: [{ device: "composition", cause: "composition-unsupported" }]`.
Rectangle validation precedes that refusal, so malformed geometry remains
`composition-rect-range` without a capture cause. Frame-edge equality and the
minimum size are inclusive; regression tests cover both sides of each bound
through start and live admission.
Geometry refusals and inactive live changes also retain the complete native
message and `data.code`. `mock-audio-precedence.test.ts` pins paired failures,
including audio shape versus composition, unknown audio versus composition,
geometry versus availability, and live session/identity/value admission.
`providers/composition.ts` owns the shared native composition admission. After
geometry and compositor availability it checks a blank secondary (Rust Unicode
White_Space semantics), finite alpha in the inclusive range 0 to 1, secondary
lookup in video captures only, then primary selection. An explicit primary must
exist in that capture roster and differ from the secondary; automatic selection
needs another capture. Secondary refusals retain `secondary-unavailable` and
their exact capture cause; a missing explicit primary retains
`cerastream.device.not_found`. Forced passthrough is refused after selection.
The resolved primary is retained separately from operator Start intent so live
composition changes cannot silently select another primary after hotplug or a
secondary edit. Stop and scenario lifecycle clear that session identity.
`mock-composition-admission.test.ts` pins the post-availability pairs, alpha
boundaries, capture-only identities, automatic selection and retained primary.
Presets never enter `custom`; the producer rectangle
schema and minimum are exported separately by RPC. The preview socket adds
`inputs[]` only for an admitted live mix, with synthetic post-gain/post-mute
levels; its existing top-level meter remains unchanged. This simulates control
and meter contracts, not GStreamer timing or hardware behavior. The settings
RPC now records its mapped inputs through `startMockStreaming` and uses
`setMockAudioMix` for live writes. Audio validation and unknown-input errors
include the native message prefix and complete `data.code`; the live source
switch retains the native mixing refusal message. The mixer/designer UI
remains separate work. See the
[audio input contract](../../apps/backend/docs/agents/streaming-rpc-procedures.md#audio-inputs-exists).

**`setMockEngineCapabilities(partial)` — test-only capability override seam (T5):**
`setMockEngineCapabilities(partial)` (exported from `mocks/providers/streaming.ts`)
merges a `Partial<ScenarioCapabilities>` onto the active scenario's profile, then
immediately re-broadcasts the resolved `capabilities` event. Gated by
`shouldUseMocks()` — a no-op in production. Use in tests that need a specific
capability combination without switching the full scenario. Call only while the
stream is idle; the override is cleared by `resetMockState()`.

**Scenarios:**

| `MOCK_SCENARIO` | Description |
|-----------------|-------------|
| `multi-modem-wifi` | Default: 3 modems + WiFi (multi-modem-wifi) |
| `single-modem` | 1 modem, no WiFi |
| `streaming-active` | Active streaming simulation with live telemetry |
| `modem-pin-locked` | 2 modems, WiFi off, modem 0 SIM PIN-locked (fixture PIN `0000`) — drives the SIM unlock/PUK flow end-to-end in dev; the `unlockSim`/`unlockSimPuk` RPCs route to the mock SIM state machine |
| `bt-mic-paired` | Bluetooth on with an HFP mic already paired/trusted/connected (battery 80%) — the steady state a source surface renders. The default `multi-modem-wifi` is the OTHER half: BT on with an empty registry, so the scan → discover → pair flow is what a developer lands on |
| `caps-full` | Full engine caps: H265 + hw accel, audio-capable source, live audio switch, SRT transport (idle) |
| `engine-starting` | Engine still booting — minimal safe floor + `engineStarting` flag |
| `engine-unavailable` | Engine unreachable — cached/minimal snapshot + `engineUnavailable` flag |

