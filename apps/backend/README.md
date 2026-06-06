# CeraUI Backend

Bun/TypeScript HTTP + WebSocket server for CeraLive streaming hardware. Serves the frontend static bundle and exposes all device control via oRPC over WebSocket.

## Overview

The backend is a single compiled binary (`ceralive`) produced by `bun build --compile`. It drives `ceracoder` and `srtla` at runtime through their native TypeScript bindings, which are resolved via `link:` paths to sibling checkouts.

**Stack**: Bun, TypeScript, oRPC (`@orpc/server`), Zod, WebSocket RPC  
**Shared contract**: `@ceraui/rpc` (workspace package at `packages/rpc/`)  
**Native bindings**: `@ceralive/ceracoder`, `@ceralive/srtla` (local `link:` deps — not npm packages)

## Structure

```
src/
├── main.ts                  # Entry point
├── modules/                 # Domain logic (no RPC awareness)
│   ├── streaming/           # ceracoder + srtla consumers
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
pnpm install
```

### Run in development

From the workspace root, `pnpm dev` starts both frontend and backend together via mprocs. To run the backend alone:

```bash
bun run dev
```

Mock hardware scenarios are available via `MOCK_SCENARIO`:

| Command | Scenario |
|---------|----------|
| `bun run dev` | `multi-modem-wifi` (default) |
| `bun run dev:single-modem` | Single modem, no WiFi |
| `bun run dev:streaming` | Active streaming simulation |

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
| `streaming.start(config)` | Validate config, launch stream, persist config |
| `streaming.stop()` | Stop active stream |
| `streaming.setConfig(fields)` | Persist config fields without starting the stream |
| `streaming.setBitrate({ max_br })` | Hot-adjust bitrate while streaming |
| `streaming.getPipelines()` | List available GStreamer pipelines |
| `streaming.getAudioCodecs()` | List available audio codecs |
| `streaming.getConfig()` | Return current config snapshot |

All setters return `{ success: boolean, applied: <fields> }`. The `applied` object reflects post-validation values actually written to config. Clients must lock their UI to `applied`, not to the raw input.

### Broadcast Events

The backend pushes typed events to all connected clients via `src/rpc/events.ts`. Each event type carries a monotonic `seq` counter that resets on server restart.

| Event | Interval | Source |
|-------|----------|--------|
| `netif` | 5 s | `modules/network/network-interfaces.ts` |
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

## Conventions

- **Runtime**: Bun only. No Node-specific APIs (`node:path`, `node:os`, `node:fs/promises` are fine).
- **Process spawning**: `Bun.spawn()` / `Bun.$` shell — not `node:child_process`.
- **File I/O**: `Bun.file().text()` / `Bun.write()` — not `fs.readFileSync`.
- **Config files**: read/written via `helpers/config-loader.ts` — not raw `fs`.
- **Error handling**: `invariant` from `helpers/invariant.ts` — not `process.exit`.
- **All device control**: oRPC over WebSocket — no new HTTP REST endpoints.

## License

GPL-3.0. See the [LICENSE](LICENSE) file for details.
