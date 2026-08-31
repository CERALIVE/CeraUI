# CeraUI Backend

Bun/TypeScript HTTP + WebSocket server for CeraLive streaming hardware. Serves the frontend static bundle and exposes all device control via oRPC over WebSocket.

## Overview

The backend is a single compiled binary (`ceralive`) produced by `bun build --compile`. It drives the `cerastream` Rust streaming engine — the sole engine (ceracoder retired 2026-06-11) — over JSON-RPC on a Unix domain socket via the `@ceralive/cerastream` npm package, and supervises `srtla_send` as a separate process (streamloop) through the `@ceralive/srtla-send` npm package (both public-npm registry deps, `@ceralive` scope).

**Stack**: Bun, TypeScript, oRPC (`@orpc/server`), Zod, WebSocket RPC  
**Shared contract**: `@ceraui/rpc` (workspace package at `packages/rpc/`)  
**Engine/bindings**: `@ceralive/cerastream` (public-npm registry dep — JSON-RPC/UDS client), `@ceralive/srtla-send` (public-npm registry dep)

### Modem-control compatibility

The backend pins `@ceralive/modem-control` at `1.3.0` EXACTLY. The SMS port, the
usage-policy setter and the band certification catalog are static imports: while
the pin was the published `0.2.0` floor each was resolved through a lazy
`import()` and a structural probe, because its API had landed in modem-stack
after the pinned release and a static import would have failed the build rather
than degrading. With an exact pin that question is settled by `tsc` and by
`bun install`.

`modems.getSms` follows the committed `modem_backend`: `dbus` uses the
package's read-only `createDbusSmsPort` with one inbox store per modem and MM
owner epoch; `mmcli` retains the shipped list/read implementation as the explicit
rollback. An owner-epoch change stops old subscriptions before resolving the
same `ID_PATH` on the new roster and rebuilding its immutable-path port, so MM
renumbering cannot leave a stale path subscribed. USSD remains on mmcli.

Fourteen frozen projection modules still consume additive pure modem logic
through `src/modules/modem-control-compat.ts`, which is a static namespace import
rather than a probe. It is permanent: two of its names are exported by no release,
so the local implementations behind it are the implementation, not a fallback.
The package-owned `MODEM_OPERATION_IDS` registry is held to set equality with
CeraUI's disposition manifest by the unskipped frontend tier-2 drift gate.

A fifteenth compatibility consumer lives in `modems/usb-mode-runtime.ts`.
Version 1.3.0 supplies its read-only `resolveRuntimeCompositionCapability`
candidate; a boundary test proves the package function is selected and remains
structurally and behaviorally identical to CeraUI's local fallback. The package's
write-side composition registry is intentionally not consumed by this bump.

Modem-stack mutation operations receive CeraUI's existing stream-coupled admission
policy through `src/modules/modems/mutation-admission-port.ts`; transport/session
ownership and the device wire contract remain in CeraUI. The committed pin and
boundary gate is `src/tests/modem-control-projections.test.ts`.

USB composition transitions treat the modem's physical reappearance and its
NetworkManager readiness as separate events. After re-enumeration, the backend
boundedly resolves the transaction's NM connection id to its replacement interface
before returning the target snapshot to the transition engine. If that interface
never appears, the transaction fails and its journal records the failure rather than
claiming success. Shipping-modem catalog admission remains evidence-gated; the
RM530N-GL entry is deferred to the hardware-validation Todo 42.

## Structure

```
src/
├── main.ts                  # Entry point
├── modules/                 # Domain logic (no RPC awareness)
│   ├── streaming/           # cerastream JSON-RPC client + srtla supervision (streamloop)
│   ├── modems/              # mmcli integration
│   ├── network/             # Network interfaces, gateways
│   ├── wifi/                # WiFi scan, connect, disconnect
│   ├── system/              # Sensors, system info
│   ├── ui/                  # HTTP + WebSocket servers, auth
│   ├── ingest/              # Ingest config
│   ├── remote/              # Cloud remote relay
│   ├── config.ts            # Config read/write
│   └── setup.ts             # First-run setup
├── rpc/                     # oRPC layer
│   ├── router.ts            # Procedure router
│   ├── procedures/          # <domain>.procedure.ts files
│   ├── middleware/          # Auth middleware
│   └── events.ts            # Typed broadcast events
├── helpers/                 # Pure utilities
├── mocks/                   # MOCK_SCENARIO providers
└── tests/                   # bun:test suites
```

## Development

### Prerequisites

[Bun](https://bun.sh/docs/installation) v1.3.0 or newer. Install dependencies from the workspace root:

```bash
bun install
```

### Run in development

From the workspace root, `bun run dev` starts both frontend and backend together via mprocs. To run the backend alone:

```bash
bun run dev
```

Mock hardware scenarios are available via `MOCK_SCENARIO`:

| Command | Scenario |
|---------|----------|
| `bun run dev` | `multi-modem-wifi` (default) |
| `bun run dev:single-modem` | Single modem, no WiFi |
| `bun run dev:streaming` | Active streaming simulation |
| `bun run dev:modem-pin-locked` | 2 modems, modem 0 SIM PIN-locked (fixture PIN `0000`) |
| `bun run dev:bt-mic-paired` | Bluetooth on with an HFP mic already paired, trusted and connected |

Bluetooth microphone source identity remains `bt:<upper-case underscored MAC>`.
The engine's `pipewire-capture` feature makes an address-matched `list-devices`
node the presence oracle and routes its `node.name` unchanged; engines without
the token retain the existing BlueALSA PCM path as the rollback arm.

### Type-check

```bash
bun run check
```

### Tests

```bash
bun test
```

## Build

The backend compiles to a single self-contained binary. Architecture is controlled by `BUILD_ARCH`:

```bash
BUILD_ARCH=arm64 bun run build   # ARM64 (default)
BUILD_ARCH=amd64 bun run build   # AMD64
```

The full `.deb` package (backend binary + frontend static) is built from the workspace root:

```bash
BUILD_ARCH=arm64 ./scripts/build/build-debian-package.sh
BUILD_ARCH=amd64 ./scripts/build/build-debian-package.sh
```

See [`docs/BUILD_PIPELINE.md`](../../docs/BUILD_PIPELINE.md) for the full build and CI reference.

## RPC Architecture

All device control goes through oRPC over WebSocket. There are no HTTP REST endpoints for device state.

### Procedures

Procedures live in `src/rpc/procedures/<domain>.procedure.ts` and are wired into `src/rpc/router.ts`. The shared schema types and validation constants are defined in `@ceraui/rpc` (`packages/rpc/`) and consumed by both the backend and frontend.

Key streaming procedures:

| Procedure | Purpose |
|-----------|---------|
| `streaming.start(config)` | Overlay optional fields on saved stream config, then validate and admit one lifecycle attempt; concurrent/cancelled admission resolves as typed `busy`/`cancelled` plus `attemptId` |
| `streaming.stop()` | Cancel/stop the active lifecycle generation and return a typed stop result |
| `streaming.setConfig(fields)` | Persist config fields without starting the stream |
| `streaming.setBitrate({ max_br })` | Hot-adjust bitrate while streaming |
| `streaming.getPipelines()` | List available GStreamer pipelines |
| `streaming.getAudioCodecs()` | List available audio codecs |
| `streaming.getConfig()` | Return current config snapshot |

All setters return `{ success: boolean, applied: <fields> }`. The `applied` object reflects post-validation values actually written to config. Clients must lock their UI to `applied`, not to the raw input.

`streaming.start` accepts a partial config. An empty `{}` starts from the complete
persisted stream configuration; defined fields override only their saved counterparts.
A manual address/port switches away from both saved managed-relay fields, while a
managed relay server switches away from the saved manual address/port. An omitted
audio codec remains omitted and uses cerastream's engine default; only an explicitly
stated codec is registry-validated.
The merge occurs in the shared streamloop update seam, so UI starts and control-channel
reconnects have the same semantics.

All start origins share `stream-session-orchestrator.ts`; UI, autostart, remote
control, and set-profile cannot launch parallel engine sessions. The backend
publishes additive `status.stream_lifecycle` transitions and keeps legacy
`is_streaming=false` until the engine confirms the stream. Boot/reconnect
reconciliation adopts a stream that survived a backend process restart. A timeout,
query error, or contradictory engine status stays `reconciling`; the reconnect-heal
path retries instead of publishing a false idle state.

Stop uses a fresh, short-lived cerastream control connection. The engine processes
one request at a time per connection, so sending stop on the session connection and
then closing it can discard an unread stop behind another RPC. The backend dispatches
stop independently, closes the old session client to interrupt pending local work,
and signals completion only after the engine replies with its idle state. The
connect-plus-acknowledgement request is bounded at 7 seconds, leaving 5 seconds of
the unchanged 12-second lifecycle bound for cleanup; a connection resolving after
that request deadline is closed before it can dispatch a stale stop.

### Broadcast Events

The backend pushes typed events to all connected clients via `src/rpc/events.ts`. Each event type carries a monotonic `seq` counter that resets on server restart.

| Event | Interval | Source |
|-------|----------|--------|
| `netif` | 5 s | `modules/network/network-interfaces.ts` |
| `uplinks` | 5 s / on change | `modules/network/uplink-health/` |
| `uplink-steering` | on change + post-login snapshot | Persistent steering availability/refusal state |
| `uplink-shaper` | 5 s / lifecycle edge + post-login snapshot | Priority mode, realized CAKE/HTB algorithm, or honest degraded state |
| `uplink-flows-reset` | hard-down only | Transient `{iface, linkId}` conntrack-reset notice |
| `sensors` | 1 s | `modules/system/sensors.ts` |
| `gateways` | 2 s | `modules/network/gateways.ts` |
| `modems` | 30 s | `modules/modems/modem-update-loop.ts` |
| `status` | on-change | Streaming state transitions |
| `config` | on-change | `setConfig` / `start` / `stop` |
| `wifi` | on-change | WiFi scan / connect / disconnect |
| `relays` | on-change | Relay list mutations |
| `ping` | 5 s | Heartbeat (frontend reconnects after ~15 s silence) |

After a client authenticates, the backend immediately pushes a full snapshot of every event type. Clients don't need to wait for the first periodic tick to render.

See [`docs/RPC_COMMUNICATION.md`](../../docs/RPC_COMMUNICATION.md) for the full wire-protocol reference.

### Shared-client uplink steering

`modules/network/uplink-steering/` owns `inet ceralive_share`, stable namespaced
flow marks, per-uplink policy-route support, and the single-flight reconcile loop.
Only packets entering a registered hotspot/shared-LAN zone are eligible; local
traffic and foreign nftables tables are structurally outside the generated rules.
Hard-down removes new-flow selection before a mark-scoped conntrack flush and
route teardown. Full design, failure behavior, deployment dependency, and netns
coverage: [`docs/UPLINK_STEERING.md`](../../docs/UPLINK_STEERING.md).

### Streaming-first uplink shaping

`modules/network/uplink-shaper/` consumes steering's shared-uplink set and installs
a two-band priority hierarchy while streaming. Local traffic remains uncapped;
only `CLIENT_FLOW`-marked client traffic reaches the adaptive CAKE/HTB ceiling.
Ownership, AIMD behavior, failure reporting, and real netns classification proof:
[`docs/UPLINK_SHAPING.md`](../../docs/UPLINK_SHAPING.md).

## Conventions

- **Runtime**: Bun only. No Node-specific APIs (`node:path`, `node:os`, `node:fs/promises` are fine).
- **Process spawning**: `Bun.spawn()` / `Bun.$` shell — not `node:child_process`.
- **File I/O**: `Bun.file().text()` / `Bun.write()` — not `fs.readFileSync`.
- **Config files**: read/written via `helpers/config-loader.ts` — not raw `fs`.
- **Error handling**: `invariant` from `helpers/invariant.ts` — not `process.exit`.
- **All device control**: oRPC over WebSocket — no new HTTP REST endpoints.

## License

GPL-3.0. See the [LICENSE](LICENSE) file for details.
## Start-failure diagnostics

Terminal start failures retain the engine's original diagnostic `message` beside
the typed class/code. It is logged and carried in notification params, so JSON-RPC
reasons such as an unavailable ALSA capture device are not reduced to `-32602`
alone and stay readable in the device log.

That detail lands in the **log**, not the operator's toast. CeraLive operators
have no console, so the failure toast renders the localized class + retry state
only and points at Settings → System Logs; the verbatim engine string (and any
shell command or systemd unit name) never appears in user-facing copy.
