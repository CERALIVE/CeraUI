# CeraUI — Agent Knowledge Base

Parent: [`../AGENTS.md`](../AGENTS.md)

## ROLE IN THE GROUP

Device control plane. Svelte 5 PWA (frontend) + Bun/TypeScript WebSocket-RPC backend. Drives `ceracoder` and `srtla` at runtime via their native TS bindings. Produces the `ceraui` .deb for ARM64 and AMD64 device images.

The backend resolves `@ceralive/ceracoder` and `@ceralive/srtla` via pnpm `link:` paths that point three levels up:

```
"@ceralive/ceracoder": "link:../../../ceracoder/bindings/typescript"
"@ceralive/srtla":     "link:../../../srtla/bindings/typescript"
```

**LOAD-BEARING layout.** CI must check out `ceracoder`, `srtla`, and `CeraUI` as siblings under the same parent. These paths are correct as-is — do not rename or restructure them.

The srtla binding API may be in flux while the upstream srtla merge is in progress. Check `../srtla/AGENTS.md` before touching anything that calls `@ceralive/srtla`.

## STRUCTURE

```
CeraUI/
├── apps/
│   ├── frontend/     # Svelte 5 PWA — Vite, TailwindCSS v4, shadcn-svelte, bits-ui v2, vitest
│   │   └── src/
│   │       ├── main/
│   │       │   ├── LiveView.svelte        # Live destination: stream control + config
│   │       │   ├── NetworkView.svelte     # Network destination: links, WiFi, modems, hotspot
│   │       │   ├── SettingsView.svelte    # Settings destination: grouped config entry points
│   │       │   ├── HudBar.svelte          # Persistent HUD bar (bitrate, links, SoC telemetry)
│   │       │   ├── HudRegion.svelte       # Responsive HUD mount (desktop top / mobile bottom)
│   │       │   ├── DisconnectedBanner.svelte  # Reconnect/reboot/failed banner
│   │       │   ├── dialogs/               # 14 focused config dialogs (AppDialog-based)
│   │       │   └── tabs/                  # Legacy tab views (Streaming, Network, General, Advanced, DevTools)
│   │       └── lib/
│   │           ├── components/
│   │           │   ├── dialogs/           # AppDialog.svelte — shared responsive dialog chrome
│   │           │   ├── custom/            # Custom components (moved from ui/): simple-alert-dialog,
│   │           │   │                      #   mode-toggle, locale-selector, mobile-link, pwa/
│   │           │   ├── streaming/         # ValidationAdapter.ts — FE constraint adapter (no literals)
│   │           │   └── ui/                # shadcn-svelte primitives (bits-ui v2)
│   │           └── stores/
│   │               ├── hud.svelte.ts          # HUD state: pure derivation + lazy runes store
│   │               ├── connection-ux.svelte.ts # Reconnect/reboot/session-expiry UX state
│   │               └── layout-mode.svelte.ts  # Touch/kiosk layout flag ($persist)
│   └── backend/      # Bun server — WebSocket RPC via oRPC, serves frontend static
├── packages/
│   ├── rpc/          # Shared oRPC schemas (workspace:*) — validation constants live here
│   └── i18n/         # typesafe-i18n, 10 languages (workspace:*)
├── scripts/build/    # build-debian-package.sh — produces ceraui .deb
├── docs/             # ARCHITECTURE, BUILD_PIPELINE, APT_VERSION_CONTROL, BRANDING, TOUCHSCREEN
└── .impeccable.md    # UI/UX design constraints — read before touching frontend visuals
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Live destination (stream control) | `apps/frontend/src/main/LiveView.svelte` |
| Network destination (links/WiFi/modems) | `apps/frontend/src/main/NetworkView.svelte` |
| Settings destination (config entry points) | `apps/frontend/src/main/SettingsView.svelte` |
| Persistent HUD bar | `apps/frontend/src/main/HudBar.svelte` + `apps/frontend/src/lib/stores/hud.svelte.ts` |
| Config dialogs (14 focused dialogs) | `apps/frontend/src/main/dialogs/` |
| Shared dialog chrome (AppDialog) | `apps/frontend/src/lib/components/dialogs/AppDialog.svelte` |
| Reconnect/reboot/session-expiry UX | `apps/frontend/src/lib/stores/connection-ux.svelte.ts` |
| Touch/kiosk layout mode | `apps/frontend/src/lib/stores/layout-mode.svelte.ts` |
| Validation constraints (FE adapter) | `apps/frontend/src/lib/components/streaming/ValidationAdapter.ts` |
| Validation constants (source of truth) | `packages/rpc/src/schemas/` |
| Custom UI components | `apps/frontend/src/lib/components/custom/` |
| shadcn-svelte primitives (bits-ui v2) | `apps/frontend/src/lib/components/ui/` |
| Backend RPC handlers | `apps/backend/src/` |
| Shared RPC contract | `packages/rpc/` |
| i18n strings | `packages/i18n/` |
| .deb build | `scripts/build/build-debian-package.sh` |
| Build system / CI | `docs/BUILD_PIPELINE.md` |
| Debian versioning | `docs/APT_VERSION_CONTROL.md` |
| System data flow | `docs/ARCHITECTURE.md` |
| Touch/kiosk CSS spec | `docs/TOUCHSCREEN.md` |
| Design rules | `.impeccable.md` |

## COMMANDS

```bash
pnpm install          # installs all workspaces; resolves link: deps (siblings must exist)
pnpm dev              # frontend + backend via mprocs TUI (port 5173 + 3001)
pnpm build            # compile backend binary + frontend static
BUILD_ARCH=arm64 ./scripts/build/build-debian-package.sh   # .deb for ARM64
BUILD_ARCH=amd64 ./scripts/build/build-debian-package.sh   # .deb for AMD64
bun tsc --noEmit      # type-check backend (run from apps/backend/)
pnpm --filter frontend run test   # vitest frontend unit tests
```

## CONVENTIONS

- Linting: Biome at workspace root (`biome.json`). ESLint only in `apps/frontend/`.
- Mock hardware in dev via `MOCK_SCENARIO` env var (`multi-modem-wifi` default).
- Backend binary compiled with `bun build --compile`; target set by `BUILD_ARCH`.
- Frontend is a PWA — service worker via `vite-plugin-pwa`.
- Validation constants live in `packages/rpc/src/schemas/`; the frontend reads them via `ValidationAdapter.ts` — never add inline numeric literals to dialog components.
- All config dialogs compose `AppDialog.svelte` (desktop Dialog / mobile Sheet via `MediaQuery` from `svelte/reactivity`).
- E2E Testing: REQUIRED reading before writing E2E tests → [`apps/frontend/tests/e2e/PLAYBOOK.md`](apps/frontend/tests/e2e/PLAYBOOK.md)

## ANTI-PATTERNS

- Don't run `npm install` or `yarn` — pnpm workspaces only.
- Don't add `@ceralive/ceracoder` or `@ceralive/srtla` to `package.json` as npm packages — they are local `link:` deps by design.
- Don't edit `.impeccable.md` for code changes — it's a design reference, not config.
- Don't touch srtla binding call sites without checking `../srtla/AGENTS.md` first (API in flux).
- Don't add custom UI components to `lib/components/ui/` — that directory is managed by the shadcn-svelte CLI. Custom components go in `lib/components/custom/`.
- Don't hardcode validation bounds (min/max lengths, bitrate limits, port ranges) in dialog components — import from `ValidationAdapter.ts` which sources from `packages/rpc/src/schemas/`.
