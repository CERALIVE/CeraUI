# frontend

Svelte 5 PWA for CeraUI — the on-device control plane for CeraLive streaming hardware. Talks to the `backend` app exclusively via WebSocket RPC (`@ceraui/rpc`). No REST, no direct hardware access.

**Status**: [EXISTS] — active development, part of the `ceralive-workspace` Bun monorepo.

## Stack

- **Svelte 5** with runes (`$state`, `$derived`, `$effect`) — no `$:` reactive statements
- **Vite** dev server and bundler
- **TailwindCSS v4** with design tokens defined in `app.css`
- **shadcn-svelte** (bits-ui v2) for UI primitives — CLI-managed, not hand-edited
- **`@ceraui/rpc`** — shared oRPC schemas and validation constants (workspace package)
- **`@ceraui/i18n`** — typesafe-i18n, 10 languages (workspace package)
- **vitest** for unit tests, **Playwright** for E2E

## Registry Dependencies

The `backend` app consumes both streaming bindings as pinned public npm packages:

```
"@ceralive/cerastream": "2026.7.1"   (public npm, @ceralive scope)
"@ceralive/srtla-send": "2026.6.2"   (public npm, @ceralive scope)
```

No sibling checkout or vendored tarball is required for CeraUI to install or
build. Both packages resolve from npm under the `@ceralive` scope.

```
ceralive/
├── srtla-send-rs/bindings/   ← source of @ceralive/srtla-send (published to public npm)
└── CeraUI/                   ← workspace root; backend resolves @ceralive/srtla-send as registry dep
```

## Development

### Prerequisites

- **Bun** (workspace manager — do not use npm, yarn, or pnpm)

### Install

Run from the `CeraUI/` workspace root:

```sh
bun install
```

This installs all workspaces and resolves all registry deps (no sibling checkout required).

### Dev Server

```sh
bun run dev
```

Starts the frontend (Vite, port 5173) and backend together via mprocs. Run from the workspace root.

To run the frontend alone:

```sh
bun run --filter frontend dev
```

### Build

```sh
bun run build
```

Or frontend only:

```sh
bun run --filter frontend build
```

Output goes to `dist/`.

### Other Commands

| Command | Description |
|---------|-------------|
| `bun run --filter frontend check` | Type-check via `svelte-check` |
| `bun run --filter frontend test` | Run vitest unit tests |
| `bun run --filter frontend test:e2e` | Run Playwright E2E tests |
| `biome check .` (from workspace root) | Lint/format via Biome (single toolchain) |
| `bun run --filter frontend preview` | Preview production build locally |

### Mock Scenarios

Development mode mocks hardware. Set `MOCK_SCENARIO` to switch scenarios:

```sh
bun run dev                                   # default: multi-modem + WiFi
MOCK_SCENARIO=single-modem bun run dev        # 1 modem, no WiFi
MOCK_SCENARIO=streaming-active bun run dev    # active streaming simulation
MOCK_SCENARIO=modem-pin-locked bun run dev    # 2 modems, modem 0 SIM PIN-locked (PIN 0000)
```

## Structure

```
src/
├── main.ts / App.svelte          # entry: initSubscriptions(), auth gate, Layout
├── main/
│   ├── LiveView.svelte           # stream control, encoder/audio/server config, bitrate
│   ├── NetworkView.svelte        # bonded links, WiFi, modems, Ethernet, hotspot
│   ├── SettingsView.svelte       # grouped config entry points (all via dialogs)
│   ├── HudBar.svelte             # persistent HUD: bitrate, per-link signals, SoC telemetry
│   ├── HudRegion.svelte          # responsive HUD mount (desktop top / mobile bottom dock)
│   ├── DisconnectedBanner.svelte # reconnect/reboot/session-expiry banner
│   └── dialogs/                  # 14 focused config dialogs, all compose AppDialog
└── lib/
    ├── rpc/                      # RPCClient, TypedRPC, subscriptions.svelte.ts
    ├── stores/                   # hud, connection-ux, layout-mode (Svelte 5 runes)
    └── components/
        ├── dialogs/              # AppDialog.svelte — shared responsive dialog chrome
        ├── custom/               # custom components (not shadcn-managed)
        ├── streaming/            # ValidationAdapter.ts — FE constraint adapter
        └── ui/                   # shadcn-svelte primitives (bits-ui v2) — CLI-managed
```

## Key Conventions

- **RPC only**: all backend calls go through `rpc.*` or `rpcClient.onMessage`. No direct hardware access.
- **Validation bounds**: import from `ValidationAdapter.ts` (which sources from `@ceraui/rpc/schemas`). No inline numeric literals in dialog components.
- **Stores**: Svelte 5 runes only. Files named `*.svelte.ts`.
- **UI primitives**: add via `bunx shadcn-svelte@latest add <component>`, not by hand.
- **Custom components**: go in `lib/components/custom/`, not `lib/components/ui/`.
- **i18n**: all user-visible strings via `LL.*` from `@ceraui/i18n`.
- **Design tokens**: Ground Control identity (phosphor lime primary, warm graphite background) defined in `app.css`. Read `../../.impeccable.md` before touching visuals.
- **Touch/kiosk mode**: `?mode=touch` URL flag. See `../../docs/TOUCHSCREEN.md`.
- **E2E tests**: read `tests/e2e/PLAYBOOK.md` before writing any E2E test.
- **Additional shadcn-svelte components**: [shadcn-svelte-extras.com](https://www.shadcn-svelte-extras.com/) — additional components styled to match shadcn-svelte. See `AGENTS.md` for the convention. Custom components go in `lib/components/custom/`.

## Deployment

The frontend ships as part of the `ceraui` Debian package. The backend serves the compiled `dist/` as static files. Build the `.deb` from the workspace root:

```sh
BUILD_ARCH=arm64 ./scripts/build/build-debian-package.sh
BUILD_ARCH=amd64 ./scripts/build/build-debian-package.sh
```

See [`../../docs/BUILD_PIPELINE.md`](../../docs/BUILD_PIPELINE.md) for the full build and CI reference.

## Documentation

| Document | Description |
|----------|-------------|
| [`docs/SCREENSHOTS.md`](docs/SCREENSHOTS.md) | Visual gallery — desktop and mobile, dark and light themes |
| [`docs/DEVTOOLS.md`](docs/DEVTOOLS.md) | DevTools tab reference (dev builds only) |
| [`../../docs/TOUCHSCREEN.md`](../../docs/TOUCHSCREEN.md) | Touch/kiosk layout mode |
| [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) | System overview and data flow |
| [`tests/e2e/PLAYBOOK.md`](tests/e2e/PLAYBOOK.md) | E2E test playbook (required reading) |

## License

GPL-3.0. See [LICENSE](LICENSE).
