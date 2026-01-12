# CeraUI

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
│   ├── rpc/          # Shared RPC schemas
│   └── i18n/         # Internationalization (10 languages)
└── docs/             # Documentation
```

## Development

### Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start frontend + backend with mprocs TUI |
| `pnpm build` | Build for production |
| `pnpm frontend:dev` | Frontend only |
| `pnpm frontend:build` | Build frontend only |

### Mock Scenarios

Development mode includes hardware mocking:

```bash
pnpm dev                           # Default: 3 modems + WiFi
pnpm dev:single-modem              # 1 modem, no WiFi
pnpm dev:streaming                 # Active streaming simulation
MOCK_SCENARIO=streaming-active pnpm dev  # Override inline
```

### Environment Variables

All optional in development mode:

| Variable | Dev Default | Description |
|----------|-------------|-------------|
| `VITE_SOCKET_ENDPOINT` | `ws://localhost` | WebSocket URL |
| `VITE_SOCKET_PORT` | `3001` | WebSocket port |
| `MOCK_SCENARIO` | `multi-modem-wifi` | Hardware mock scenario |

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
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System overview and data flow diagrams |
| [BUILD_PIPELINE.md](docs/BUILD_PIPELINE.md) | Build system and CI/CD |
| [APT_VERSION_CONTROL.md](docs/APT_VERSION_CONTROL.md) | Debian package versioning |
| [BRANDING.md](docs/BRANDING.md) | Branding guidelines |
| [apps/frontend/docs/DEVTOOLS.md](apps/frontend/docs/DEVTOOLS.md) | Development tools |
| [apps/frontend/docs/SCREENSHOTS.md](apps/frontend/docs/SCREENSHOTS.md) | Screenshot automation |

## Workspace Commands

```bash
pnpm --filter frontend add [package]  # Add dependency to frontend
pnpm add -w [package]                 # Add shared dependency
pnpm clean                            # Clean all build artifacts
```

## Tech Stack

- **Frontend**: Svelte 5, TailwindCSS, shadcn-svelte, Vite
- **Backend**: Bun, TypeScript, WebSocket RPC
- **Build**: pnpm workspaces, mprocs

## Support the Project

If you find CeraUI useful, consider supporting CeraLive development:

- ☕ [Ko-fi](https://ko-fi.com/andrescera)
- 💳 [PayPal](https://www.paypal.com/donate/?business=7KKQS9KBSAMNE&no_recurring=0&item_name=CERALIVE+Development+Support&currency_code=USD)
