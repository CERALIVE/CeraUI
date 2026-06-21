# CeraUI

[![CI](https://github.com/CERALIVE/CeraUI/actions/workflows/build-check.yml/badge.svg)](https://github.com/CERALIVE/CeraUI/actions/workflows/build-check.yml)
[![Release](https://github.com/CERALIVE/CeraUI/actions/workflows/publish-release.yml/badge.svg)](https://github.com/CERALIVE/CeraUI/actions/workflows/publish-release.yml)

Web-based control interface for live video streaming with cellular bonding. Built with Svelte 5 (frontend) and Bun (backend).

## Quick Start

```bash
pnpm install
pnpm dev
```

Opens at `http://localhost:5173`. Backend runs on port 3001.

## Project Structure

```
CeraUI/
├── apps/
│   ├── frontend/     # Svelte 5 PWA
│   └── backend/      # Bun/TypeScript server
├── packages/
│   ├── rpc/          # Shared RPC schemas + validation constants
│   └── i18n/         # Internationalization (10 languages)
└── docs/             # Documentation
```

## Features

### 3-Destination Navigation

The app is organized into three primary destinations:

- **Live** — streaming control and configuration. Start/stop the stream, adjust encoder settings, audio, server target, and bitrate. A persistent HUD bar shows live bitrate, per-link signal strength, and SoC telemetry across all destinations.
- **Network** — connectivity overview. Bonded link status, WiFi networks (connect/disconnect/forget), cellular modems (APN, roaming, network type), Ethernet interfaces, and hotspot configuration.
- **Settings** — system and device configuration. All actions open focused dialogs: cloud remote, LAN password, SSH, logs, software updates, power, and version info.

A dev-only DevTools destination is available in development builds.

### Other Highlights

- **Progressive Web App**: offline capabilities and native app-like performance
- **Internationalization**: 10 languages with full RTL support
- **Touch/kiosk mode**: `?mode=touch` URL flag scales touch targets to 44px minimum
- **Responsive**: desktop and mobile layouts with a persistent bottom HUD dock on mobile

## Development

### Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start frontend + backend with mprocs TUI |
| `pnpm build` | Build for production |
| `pnpm frontend:dev` | Frontend only |
| `pnpm frontend:build` | Build frontend only |

### Mock Scenarios

Development mode includes hardware mocking. All mock state is Zod-validated at startup
and can be reset between tests via `resetMockState()`.

```bash
pnpm dev                           # Default: 3 modems + WiFi (multi-modem-wifi)
pnpm dev:single-modem              # 1 modem, no WiFi
pnpm dev:streaming                 # Active streaming simulation
MOCK_SCENARIO=streaming-active pnpm dev  # Override inline
```

| Scenario | Modems | WiFi | Streaming |
|----------|--------|------|-----------|
| `multi-modem-wifi` | 3 (5G/4G/3G) | Yes | Idle |
| `single-modem` | 1 | No | Idle |
| `streaming-active` | 3 | Yes | Active (with live telemetry) |
| `caps-full` | 2 | Yes | Idle — full engine caps: H265 + hw accel, audio-capable source, live audio switch, SRT transport |
| `engine-starting` | 1 | No | Idle — engine still booting, minimal safe floor + `engineStarting` flag |
| `engine-unavailable` | 1 | No | Idle — engine unreachable, cached/minimal snapshot + `engineUnavailable` flag |

The mock subsystem also simulates add-on state, kiosk state, SIM PIN/PUK lock states,
cerastream engine errors, and device-detection overrides. See `apps/backend/src/mocks/`
for the fixture factory and schema definitions.

### Environment Variables

In **production** the WebSocket RPC URL is derived purely from the page origin
(`window.location`): the single backend binary serves the static frontend and the
WebSocket on the same host and port, so no socket host/port/protocol is configured
and the `VITE_SOCKET_*` variables are ignored. The variables below apply to
**development only**, where Vite (`:6173`) and the backend (`:3002`) are separate
origins; all are optional.

These dev-only values live in the tracked **`.env.development`** file, which Vite
loads only in `mode === "development"` and the `pnpm dev` scripts load via
`dotenv -e .env.development`. A production build never reads `.env.development`, so
none of these can reach the shipped bundle. The gitignored root `.env` is loaded in
**every** Vite mode, so it must stay absent — a CI guard fails the build if a stray
`.env` bakes a `ws://localhost` literal into `dist/public`. `NODE_ENV` is not read
from any env file (Vite sets the frontend mode; the backend `dev` scripts export it
inline). See `.env.example` for the full layout.

| Variable | Scope | Home | Dev Default | Description |
|----------|-------|------|-------------|-------------|
| `VITE_SOCKET_ENDPOINT` | dev only | `.env.development` | `ws://<page hostname>` | WebSocket endpoint (scheme + host, no port) |
| `VITE_SOCKET_PORT` | dev only | `.env.development` | `3002` | Backend dev WebSocket port |
| `MOCK_SCENARIO` | dev only | `.env.development` | `multi-modem-wifi` | Hardware mock scenario |
| `LOG_LEVEL` | dev + prod | shell / systemd env | _(per-transport default)_ | Override Winston log level for all transports. Dev console default: `info`; prod console: `warn`; file: `debug`. Set to `debug` to enable per-RPC call trace lines. |

## Build & Deploy

### Debian Package

```bash
BUILD_ARCH=arm64 ./scripts/build/build-debian-package.sh
BUILD_ARCH=amd64 ./scripts/build/build-debian-package.sh
```

### Supported Hardware

**ARM64**: Orange Pi 5/5+, Radxa Rock 5B, NVIDIA Jetson Orin  
**AMD64**: Intel N100/N200 Mini PCs, standard x86 computers

See [BUILD_PIPELINE.md](docs/BUILD_PIPELINE.md) for full build documentation.

## Documentation

| Document | Description |
|----------|-------------|
| [LIVE_DEVELOPMENT.md](../LIVE_DEVELOPMENT.md) | Local dev, deploy to device, image build, debugging |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System overview and data flow diagrams |
| [BUILD_PIPELINE.md](docs/BUILD_PIPELINE.md) | Build system and CI/CD |
| [APT_VERSION_CONTROL.md](docs/APT_VERSION_CONTROL.md) | Debian package versioning |
| [BRANDING.md](docs/BRANDING.md) | Branding guidelines |
| [TOUCHSCREEN.md](docs/TOUCHSCREEN.md) | Touch/kiosk layout mode |
| [TECHNICAL_DEBT.md](docs/TECHNICAL_DEBT.md) | Machine-checkable tech-debt register (source-experience overhaul) |
| [CONVENTIONS.md](docs/CONVENTIONS.md) | CeraUI-local conventions including tech-debt register contract |
| [apps/frontend/docs/DEVTOOLS.md](apps/frontend/docs/DEVTOOLS.md) | Development tools |

## Workspace Commands

```bash
pnpm --filter frontend add [package]  # Add dependency to frontend
pnpm add -w [package]                 # Add shared dependency
pnpm clean                            # Clean all build artifacts
```

## Tech Stack

- **Frontend**: Svelte 5, TailwindCSS v4, shadcn-svelte (bits-ui v2), Vite
- **Backend**: Bun, TypeScript, WebSocket RPC (oRPC)
- **Build**: pnpm workspaces, mprocs

## Support the Project

If you find CeraUI useful, consider supporting CeraLive development:

- ☕ [Ko-fi](https://ko-fi.com/andrescera)
- 💳 [PayPal](https://www.paypal.com/donate/?business=7KKQS9KBSAMNE&no_recurring=0&item_name=CERALIVE+Development+Support&currency_code=USD)
