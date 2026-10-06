<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## REMOTE CONTROL PLANE [EXISTS]

The remote control plane (v2.0) adds a **second, independent outbound WebSocket** from the device to the cloud platform hub. It does NOT multiplex onto the existing BCRPT relay socket (`modules/remote/remote.ts`) and does NOT touch the proto-v16 relay protocol.

### Architecture

```
modules/identity/index.ts          # initIdentity() — resolves device_id + paired at boot
modules/remote/control-endpoint.ts # resolveControlChannelEndpoint() — reads CERALIVE_CONTROL_HUB_URL (build-time pin)
modules/pairing/paseto-v4.ts       # Ed25519 sign/verify primitives (node:crypto, synchronous)
modules/pairing/device-token.ts    # verifyDeviceControlToken — purpose gate BEFORE claim-shape validation
modules/remote-control/
├── protocol.ts          # THIN re-export of @ceralive/control-protocol (device-tolerant variants + tolerantParse* helpers)
├── channel.ts           # initControlChannel — second outbound WS; exponential backoff; WS-level keepalive ping
├── command-router.ts    # routeCommand — NEVER_REMOTE → unknown → role → self_fencing → streaming dispatch
├── status-relay.ts       # relayStatusToGateway — wired into broadcastMsg; 7 relayable types; per-type seq
├── telemetry-recorder.ts # batched per-link telemetry → `telemetry` status frames (spec §8.1); non-blocking
└── self-fencing.ts      # handleSelfFencingOp / handleSelfFencingConfirm — 30 s watchdog; revertible + non-revertible
```

### Wire schema — shared `@ceralive/control-protocol` package [EXISTS]

`modules/remote-control/protocol.ts` is now a **THIN re-export** of the canonical
`@ceralive/control-protocol` npm package (`@ceralive` scope, pinned to an exact
CalVer version in `apps/backend/package.json`). The package is the single Zod
derivation of the control-channel wire contract
(`openspec/specs/remote-relay-support/spec.md`), consumed identically by BOTH this
device and the cloud hub (`ceralive-platform`) — it replaces the two previously
hand-written, independently-drifting per-repo `protocol.ts` derivations.

- **Device-tolerant posture preserved byte-for-byte.** The package ships an explicit
  `*Strict*` (hub) and `*Tolerant*` (device) variant of every frame/payload that
  differs between the two sides. `protocol.ts` binds each historical un-suffixed
  device name (`CommandSchema`, `StatusSchema`, `FrameSchema`, `AckSchema`,
  `DeliveryAckSchema`, `HandshakeSchema`, `HandshakeDeviceSchema`,
  `HandshakeHubSchema`, `IngestSlotSchema`, `IngestSlotsPayloadSchema`) to the
  DEVICE-TOLERANT variant, so every downstream importer (`channel.ts`,
  `command-router.ts`, `status-relay.ts`, `set-profile.ts`, `ingest-slots.ts`,
  `self-fencing.ts`, `active-profile-reporter.ts`) keeps the exact schema and
  behaviour it had before — no import-site change beyond the re-export. The
  package's un-suffixed alias for a colliding name resolves to the STRICT (hub)
  variant, so the device MUST use the `*Tolerant*` schema (which `protocol.ts` does).
- **`tolerantParse*` helpers** (`tolerantParseFrame`, `tolerantParseCommand`, …,
  `tolerantParseSetProfilePayload`, `parseHandshakeDeviceBody/HubBody`) are
  re-exported alongside so new call sites can name the device-posture parser
  directly.
- **Registry-dep, Rule-D-compatible.** `@ceralive/control-protocol` resolves through
  the package registry identically whether or not the sibling repo is checked out —
  a CalVer registry dep like `@ceralive/cerastream`, NOT a
  sibling `link:` or a `../` path. Evolution is **additive-optional forever**: a
  change that would make a currently-optional field required is a new protocol `v`,
  never a package version bump.
- **RC bridge + merge gate.** During the W2/W3 integration bridge the pin is an
  EXACT prerelease (`2026.7.0-rc.1`). `scripts/check-rc-pins.sh` (root script
  `check:rc-pins`, wired into the `build-check.yml` BE job) FAILS the build while any
  `package.json`/`bun.lock` still carries an `-rc.` pin of
  `@ceralive/control-protocol` or `@ceralive/cerastream` — it MUST be swapped for the
  exact stable CalVer before merging to a canonical branch.
- **Contract coverage.** `protocol.export-surface.test.ts` is a regression lock over
  the module's runtime export surface (every symbol + typeof); `protocol.contract.test.ts`
  parses the package-exported §14 fixtures with the device schemas;
  `protocol.frame-exchange.test.ts` is the device half of the frame-exchange contract
  (tolerant accepts every hub-strict-emitted fixture; v1-minimal; unknown-field
  tolerance).

### Key invariants

- **Gate = `canDialControlChannel()`** (`paired && deviceId !== undefined`). An unpaired device or one whose `device_id` is missing never dials the hub.
- **`CERALIVE_CONTROL_HUB_URL`** is the build-time-pinned hub URL. It is NOT operator-configurable and is NOT derived from `custom_provider` or `remote_provider`.
- **Two token audiences** (`purpose: "device-control"` vs `purpose: "relay-config"`). The purpose check runs BEFORE claim-schema validation — a validly-signed relay-config token is rejected by purpose, not by signature failure.
- **Real-device fail-closed (Task 20)** — `verifyDeviceControlToken(token, now, { isRealDevice })` REFUSES the token on a real device (`isRealDevice()` true) when `PASETO_PUBLIC_KEY` is absent: a real device can't verify a signature, so it never accepts the unsigned/opaque path. The key-less unsigned dev path stays available only on dev/mock hosts (`isRealDevice` false, the default). `channel.ts` resolves `isRealDevice()` once at `initControlChannel` and threads it into the default `verifyToken`. Wire format + verification order are unchanged — the gate slots into the existing key-presence branch.
- **Control-token source is the persisted `config.remote_key`** — the default `getControlToken` seam reads the same claim/control credential the pairing claim stored. `resolveAuthToken` still self-verifies it via `verifyToken` (`verifyDeviceControlToken`, purpose + signature) BEFORE presenting it, so a non-device-control or unverifiable token is dropped and the channel falls back to the key-less path; a valid device-control token is presented as `Authorization: Bearer …` on the dial (so the LAN gateway accepts an authenticated socket). Wiring the token source did NOT change the verification contract.
- **Post-pairing reconnect (no reboot)** — `completePairingProcedure`, after a successful claim, calls an idempotent `initIdentity()` + `initControlChannel()` (`reconnectControlChannelAfterClaim`). A freshly claimed device re-resolves identity from the now-persisted `remote_key`/`device_id` and re-dials the control channel WITHOUT a reboot — the boot-time identity had resolved it as unpaired. Both calls are idempotent (`initControlChannel` tears down any prior channel first), so a repeated claim never double-connects.
- **`RELAYABLE_TYPES`** = `[status, config, sensors, netif, modems, device-stats, notifications]`. No auth/token/secret-bearing type is ever in this set. The no-secrets contract test enforces this. **`telemetry` is intentionally NOT in `RELAYABLE_TYPES`** — it is a `STATUS_TYPES` member (protocol.ts) emitted directly over the control channel by the telemetry recorder, not a `broadcastMsg` event. (`STATUS_TYPES` = 8: the 7 relayable broadcast types + `telemetry`.)
- **Telemetry recorder is batched + non-blocking** (`telemetry-recorder.ts`, spec §8.1). It folds `buildLinkTelemetry()` per-link rows into `telemetry` status frames on a size (`DEFAULT_TELEMETRY_MAX_BATCH=30`) or age (`DEFAULT_TELEMETRY_MAX_AGE_MS=10s`) boundary; every tick is synchronous and exception-safe so it never stalls the heartbeat/live loop. It carries NO bitrate (platform owns that) and NO secret. Wired onto the heartbeat in `main.ts` (`startTelemetryRecorder` + `onHeartbeatTick(recordTelemetryTick)`).
- **`self_fencing: true`** is a TOP-LEVEL frame flag, NOT inside payload. Revertible ops emit two result frames (apply + commit/revert). Non-revertible ops do NOT execute until an explicit `self_fencing.confirm` arrives.
- **`modem.reconfig` is readiness-gated ON THE SELF-FENCING ROUTE, not by `cellularReadyMiddleware`.** `routeCommand` intercepts it at the `SELF_FENCING_TYPES_SET` branch, so it never reaches `modemProcedure` and the RPC middleware never sees it — the gate therefore lives in `handleSelfFencingOp` (`isSubsystemReady`, defaulting to `getCellularStack().ready` for that one type). It is checked BEFORE `snapshot`/`apply`, so an initializing stack leaves nothing half-applied and NO watchdog armed, and the refusal (`ok:false, error:"cellular_stack_initializing"`) rides out AFTER the delivery-ack the router already sent — never a silent drop. Adding a new modem-scoped self_fencing op means adding it to `READINESS_GATED_TYPES`; wiring it to the RPC middleware instead would be a no-op. Pinned in `tests/control-modem-reconfig-self-fencing.test.ts`, which also re-proves the untouched wire semantics (ack/de-dup, snapshot-before-mutation, 30 s auto-revert, cid-matching confirm) under BOTH `modem_backend` selections.
- The control channel grants ZERO local UI-client authority — it never calls `addAuthedSocket` and has no import of `modules/remote/remote.ts`.

### Boot wiring order (main.ts)

```
runCritical("config", loadConfig)            # CRITICAL — abort on failure
runCritical("ws-control-server", initServer) # CRITICAL — bind the operator lifeline FIRST
runCritical("systemd-ready", notifyServiceReady) # release ordered units after signal reservation + bind
guardNonCritical("identity", initIdentity)            # resolves device_id + paired
guardNonCritical("control-channel", initControlChannel) # gates on canDialControlChannel()
guardNonCritical("pipelines", initEngineConnection)   # streaming engine init + reconnect loop
guardNonCritical("rtmp-ingest", initRTMPIngestStats)  # RTMP bandwidth poller
```

The `pipelines` init is now `initEngineConnection` (`modules/streaming/engine-reconnect.ts`),
NOT the raw `initPipelines`. See ENGINE CONNECTION RESILIENCE below.

