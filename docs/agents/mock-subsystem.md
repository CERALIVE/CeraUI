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

