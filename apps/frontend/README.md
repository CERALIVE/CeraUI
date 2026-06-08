# frontend

Svelte 5 PWA for CeraUI — the on-device control plane for CeraLive streaming hardware. Talks to the `backend` app exclusively via WebSocket RPC (`@ceraui/rpc`). No REST, no direct hardware access.

**Status**: [EXISTS] — active development, part of the `ceralive-workspace` pnpm monorepo.

## Stack

- **Svelte 5** with runes (`$state`, `$derived`, `$effect`) — no `$:` reactive statements
- **Vite** dev server and bundler
- **TailwindCSS v4** with design tokens defined in `app.css`
- **shadcn-svelte** (bits-ui v2) for UI primitives — CLI-managed, not hand-edited
- **`@ceraui/rpc`** — shared oRPC schemas and validation constants (workspace package)
- **`@ceraui/i18n`** — typesafe-i18n, 10 languages (workspace package)
- **vitest** for unit tests, **Playwright** for E2E

## Sibling-Checkout Layout

The workspace root (`ceralive-workspace`) resolves native bindings via `link:` paths. The `backend` app depends on:

```
"@ceralive/ceracoder": "link:../../../ceracoder/bindings/typescript"
"@ceralive/srtla":     "link:../../../srtla/bindings/typescript"
```

`ceracoder/`, `srtla/`, and `CeraUI/` must be siblings under the same parent directory. Breaking this layout breaks `pnpm install` for the backend.

```
ceralive/
├── ceracoder/bindings/typescript/   ← @ceralive/ceracoder
├── srtla/bindings/typescript/       ← @ceralive/srtla
└── CeraUI/                          ← workspace root; backend resolves link: three levels up
```

## Development

### Prerequisites

- **pnpm** (workspace manager — do not use npm or yarn)
- Sibling repos `ceracoder` and `srtla` checked out at the correct paths (see above)

### Install

Run from the `CeraUI/` workspace root:

```sh
pnpm install
```

This installs all workspaces and resolves the `link:` sibling deps.

### Dev Server

```sh
pnpm dev
```

Starts the frontend (Vite, port 5173) and backend together via mprocs. Run from the workspace root.

To run the frontend alone:

```sh
pnpm --filter frontend run dev
```

### Build

```sh
pnpm build
```

Or frontend only:

```sh
pnpm --filter frontend run build
```

Output goes to `dist/`.

### Other Commands

| Command | Description |
|---------|-------------|
| `pnpm --filter frontend run check` | Type-check via `svelte-check` |
| `pnpm --filter frontend run test` | Run vitest unit tests |
| `pnpm --filter frontend run test:e2e` | Run Playwright E2E tests |
| `biome check .` (from workspace root) | Lint/format via Biome (single toolchain) |
| `pnpm --filter frontend run preview` | Preview production build locally |

### Mock Scenarios

Development mode mocks hardware. Set `MOCK_SCENARIO` to switch scenarios:

```sh
pnpm dev                                      # default: multi-modem + WiFi
MOCK_SCENARIO=single-modem pnpm dev           # 1 modem, no WiFi
MOCK_SCENARIO=streaming-active pnpm dev       # active streaming simulation
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
- **UI primitives**: add via `pnpm dlx shadcn-svelte@latest add <component>`, not by hand.
- **Custom components**: go in `lib/components/custom/`, not `lib/components/ui/`.
- **i18n**: all user-visible strings via `LL.*` from `@ceraui/i18n`.
- **Design tokens**: Ground Control identity (phosphor lime primary, warm graphite background) defined in `app.css`. Read `../../.impeccable.md` before touching visuals.
- **Touch/kiosk mode**: `?mode=touch` URL flag. See `../../docs/TOUCHSCREEN.md`.
- **E2E tests**: read `tests/e2e/PLAYBOOK.md` before writing any E2E test.

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
