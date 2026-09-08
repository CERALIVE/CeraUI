# frontend

Svelte 5 PWA for CeraUI — the on-device control plane for CeraLive streaming hardware. Talks to the `backend` app exclusively via WebSocket RPC (`@ceraui/rpc`). No REST, no direct hardware access.

**Status**: [EXISTS] — active development, part of the `ceralive-workspace` Bun monorepo.

## Stack

- **Svelte 5** with runes (`$state`, `$derived`, `$effect`) — no `$:` reactive statements
- **Vite** dev server and bundler
- **TailwindCSS v4** with design tokens defined in `app.css`
- **shadcn-svelte** (bits-ui v2) for UI primitives — CLI-managed, not hand-edited
- **`@ceraui/rpc`** — shared oRPC schemas and validation constants (workspace package)
- **`@ceraui/i18n`** — Paraglide runtime over hand-editable JSON catalogs, 10 languages (workspace package)
- **vitest** for unit tests, **Playwright** for E2E

## Registry Dependencies

The `backend` app consumes both streaming bindings as pinned public npm packages:

```
"@ceralive/cerastream": "2026.9.5"   (public npm, @ceralive scope)
"@ceralive/srtla-send": "2026.8.0"   (public npm, @ceralive scope)
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

Starts the frontend (Vite, port 6173) and ordinary local development backend
(port 3002) together via mprocs. Functional E2E pages use separate worker-scoped
31xx backends. Run from the workspace root.

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

The separately hosted Encoder/Audio/Server bundles are built with
`bun run build:federation` from the repository root. Federation compiles the full
ten-locale catalog in isolated locale-module layout and minifies the final ES
modules; SPA namespace loading is unaffected. Run `bun run test:federation-abi`
for built-dialog and frozen-catalog parity, and after building both SPA and
federation run `bun scripts/ci/bundle-report.mjs` to check both size budgets.

| Command | Description |
|---------|-------------|
| `bun run --filter frontend check` | Type-check via `svelte-check` |
| `bun run --filter frontend test` | Run vitest unit tests |
| `bun run --filter frontend test:e2e` | Run Playwright E2E tests |
| `biome check .` (from workspace root) | Lint/format via Biome (single toolchain) |
| `bun run --filter frontend preview` | Preview production build locally |

### Unit-test projects [EXISTS]

`bun run --filter frontend test` runs both Vitest projects. The import-graph
classifier in `scripts/ci/vitest-classify.mjs` assigns source tests automatically:
`pure` uses Node with `isolate: false`; `components` uses isolated jsdom. Browser
globals and transitive Svelte imports select components, except tests explicitly
requiring the no-window Node fallback. No filename allowlist is maintained.

Both projects load `vitest.storage.setup.ts` for fresh in-memory Web Storage and
per-test clearing. Only jsdom loads `vitest.components.setup.ts` for catalog
registration, `matchMedia`, and the retained 50 ms bits-ui teardown wait. The
separate federation harness explicitly loads both files too. Classifier checks:
`bun test scripts/ci/vitest-classify.test.mjs` from the repository root.

The ordinary suite lets Bun load the already-compiled i18n ESM natively, keeping
the catalog registry and its locale runtime in one graph per isolated worker.
Svelte, the reactive locale facade, application modules and test-generated
registries still use Vite transforms. Catalog registration is idempotent within
each module graph; fresh workers still receive the complete catalog. No lazy-key
scanner, dependency optimizer or filesystem module cache is enabled. The
measurements and rejected alternatives are in
[`../../docs/FRONTEND-SETUP-COST.md`](../../docs/FRONTEND-SETUP-COST.md).

Worker concurrency is capped at the runtime's available CPU allocation, up to
16 workers on larger hosts. This respects CPU affinity and cgroup quotas rather
than assuming the development workstation's capacity on a hosted runner. CI
prints the selected CPU/worker budget. Test timeouts and component isolation are
unchanged; reducing contention must not be replaced by longer timeout allowances.

CI keeps the same two projects and their setup files inside the four-way
`test:ci-shard` lane (`VITEST_SHARD=1/4` through `4/4`); `test:ci-merge` merges
their blob reports. The ordinary `test` command still runs the whole suite and
hardware preflight without a shard environment variable.

### Mock Scenarios

Development mode mocks hardware. Set `MOCK_SCENARIO` to switch scenarios:

```sh
bun run dev                                   # default: multi-modem + WiFi
MOCK_SCENARIO=single-modem bun run dev        # 1 modem, no WiFi
MOCK_SCENARIO=streaming-active bun run dev    # active streaming simulation
MOCK_SCENARIO=modem-pin-locked bun run dev    # 2 modems, modem 0 SIM PIN-locked (PIN 0000)
```

## Structure

The shared encoder hint also supports the media-island `blocks[]` snapshot.
**Media details** opens a responsive, lazy-loaded read-only dialog with per-core
load/utilization, bound session PID/index pairs and explicit RGA limitations.
Dev-only `?health-mock=island` demonstrates the new states; `vendor`, `mainline`
and `unavailable` retain the legacy fixture paths. Real device snapshots always
win. Visual acceptance on Rock 5B+ and Orange Pi 5+ is still hardware-gated.

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

- **Bond membership**: HUD and Network use the backend's `netif.enabled` eligibility
  verdict plus an address and no blocking error. The exact duplicate-IPv4 warning
  is allowed only with `enabled:true`, which already includes the backend's
  mappability check; unmappable and compound-error links remain excluded.
  Idle eligibility is distinct from a running sender's mapping and telemetry.
- **RPC only**: all backend calls go through `rpc.*` or `rpcClient.onMessage`. No direct hardware access.
- **Validation bounds**: import from `ValidationAdapter.ts` (which sources from `@ceraui/rpc/schemas`). No inline numeric literals in dialog components.
- **Stores**: Svelte 5 runes only. Files named `*.svelte.ts`.
- **Reconnect UX**: `connection-ux.svelte.ts` owns the shared 3-second grace for authenticated and pre-auth connection-loss surfaces. A post-connect socket-only loss stays on the reconnect banner while the browser is online; browser-offline recovery owns the full-page takeover. Do not add component-local disconnect timers.
- **UI primitives**: add via `bunx shadcn-svelte@latest add <component>`, not by hand.
- **Custom components**: go in `lib/components/custom/`, not `lib/components/ui/`.
- **i18n**: all user-visible strings via `m["<key>"]()` from `@ceraui/i18n/svelte` (Paraglide); resolve a dynamic dot-path key through `resolveMessageKey`.
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
