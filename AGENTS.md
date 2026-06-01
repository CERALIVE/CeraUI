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
│   ├── frontend/     # Svelte 5 PWA — Vite, TailwindCSS v4, shadcn-svelte, vitest
│   └── backend/      # Bun server — WebSocket RPC via oRPC, serves frontend static
├── packages/
│   ├── rpc/          # Shared oRPC schemas (workspace:*)
│   └── i18n/         # typesafe-i18n, 10 languages (workspace:*)
├── scripts/build/    # build-debian-package.sh — produces ceraui .deb
├── docs/             # ARCHITECTURE, BUILD_PIPELINE, APT_VERSION_CONTROL, BRANDING
└── .impeccable.md    # UI/UX design constraints — read before touching frontend visuals
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Frontend UI components | `apps/frontend/src/` |
| Backend RPC handlers | `apps/backend/src/` |
| Shared RPC contract | `packages/rpc/` |
| i18n strings | `packages/i18n/` |
| .deb build | `scripts/build/build-debian-package.sh` |
| Build system / CI | `docs/BUILD_PIPELINE.md` |
| Debian versioning | `docs/APT_VERSION_CONTROL.md` |
| System data flow | `docs/ARCHITECTURE.md` |
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

## ANTI-PATTERNS

- Don't run `npm install` or `yarn` — pnpm workspaces only.
- Don't add `@ceralive/ceracoder` or `@ceralive/srtla` to `package.json` as npm packages — they are local `link:` deps by design.
- Don't edit `.impeccable.md` for code changes — it's a design reference, not config.
- Don't touch srtla binding call sites without checking `../srtla/AGENTS.md` first (API in flux).
