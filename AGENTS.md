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
│       └── src/
│           ├── helpers/
│           │   ├── config-loader.ts       # loadJsonConfig + writeFileAtomicSync (E3)
│           │   └── config-schemas.ts      # runtimeConfigSchema — addons key lives here
│           └── modules/system/
│               ├── device-stats.ts        # 5-signal device stats (S1 lock)
│               ├── device-detection.ts    # isRealDevice() — gates all add-on ops
│               ├── kiosk.ts               # Kiosk state machine (template for add-on manager)
│               └── software-updates.ts    # apt/size parsing; APT_PACKAGE_NAME_RE
├── packages/
│   ├── rpc/          # Shared oRPC schemas (workspace:*) — validation constants live here
│   │   └── src/schemas/
│   │       ├── addons.schema.ts           # AddonDescriptorSchema + AddonStateSchema (T21)
│   │       └── system.schema.ts           # KIOSK_UNAVAILABLE_ERROR + system schemas
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
| **Kiosk capability + inert-by-default model** | `docs/ON_DEVICE_DISPLAY.md` (cross-repo arch) |
| Kiosk state machine (DC-2) | `docs/KIOSK_STATE_MACHINE.md` |
| Kiosk token contract (DC-3) | `docs/KIOSK_TOKEN_CONTRACT.md` |
| Kiosk RPC + polling loop (backend) | `apps/backend/src/` (kiosk procedures, Task 23) |
| Kiosk settings dialog (frontend) | `apps/frontend/src/main/dialogs/` (Task 25) |
| Display-profile store + `?display=` param | `apps/frontend/src/lib/stores/display-profile.svelte.ts` |
| **Add-on Zod schemas (descriptor + state)** | `packages/rpc/src/schemas/addons.schema.ts` |
| **Device stats (5-signal broadcast)** | `apps/backend/src/modules/system/device-stats.ts` |
| **Config atomicity (E3)** | `apps/backend/src/helpers/config-loader.ts` — `writeFileAtomicSync` |
| **Runtime config schema (addons key)** | `apps/backend/src/helpers/config-schemas.ts` — `runtimeConfigSchema` |
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

## ADD-ON SUBSYSTEM [EXISTS]

The add-on subsystem lets CeraUI install, enable, and disable optional feature
sysexts at runtime without a reflash. It is gated on `isRealDevice()` — all
add-on operations are no-ops in dev/emulated mode.

**Zod schemas** (`packages/rpc/src/schemas/addons.schema.ts`) [EXISTS]

`AddonDescriptorSchema` mirrors the image-baked JSON descriptor format from
`image-building-pipeline/v2/manifests/schema/addon.schema.json`. It is the single
TypeScript source of truth for the descriptor shape — never duplicate it in `apps/`.

`AddonStateSchema` describes per-feature runtime state persisted under the `addons`
key of `config.json`. Fields: `enabled`, `phase`, `versionMaterialized`,
`userConfig`, `autoDisabled`.

Key regex constants (defined once in `addons.schema.ts`, imported everywhere):
- `ADDON_ID_RE` — lowercase alphanumeric + hyphens (stricter than `APT_PACKAGE_NAME_RE`)
- `SEMVER_RE` — `MAJOR.MINOR.PATCH` with optional pre-release/build
- `SYSEXT_PATH_RE` — `/usr/…` or `/opt/…` only (G2 contract)
- `ARTIFACT_URL_RE` — HTTPS with mandatory `{os_version}` placeholder

**Config atomicity (E3)** [EXISTS]

All writes to `config.json` go through `writeFileAtomicSync` in
`apps/backend/src/helpers/config-loader.ts`. The pattern: write to a sibling temp
file (`.<name>.<pid>.tmp`), `fsync`, then `rename` — so a crash mid-write never
corrupts the live config. The `addons` key in `runtimeConfigSchema` defaults to
`{}` when absent, so old configs without the key parse cleanly.

Test coverage: `apps/backend/src/tests/addons-config-state.test.ts` — round-trip,
crash-mid-write, and missing-key defaulting.

**sysext refresh protocol**

The add-on manager must follow the protocol from
`image-building-pipeline/v2/docs/addon-sysext-refresh.md`:
- **Update:** `systemd-sysext refresh` → `systemctl restart <addon>.service`
- **Disable:** `systemctl stop <addon>.service` → `systemd-sysext refresh`

Never report an add-on "updated" or "disabled" on the strength of the sysext call
alone. The service restart (on update) or stop (on disable) is what makes the
transition real.

**isRealDevice() gate**

All add-on operations (install, enable, disable, refresh) MUST call
`await isRealDevice()` at entry. In dev/emulated mode return
`{ success: false, error: "addon_unavailable_in_emulated_mode" }` without touching
`systemd-sysext` or `systemctl`. Read-only status queries are NOT gated.

## DEVICE STATS [EXISTS]

`apps/backend/src/modules/system/device-stats.ts` broadcasts exactly **5 signals**
on a `device-stats` event every 5 seconds (S1 lock):

| Signal | Description |
|--------|-------------|
| `disk` | Used/total bytes on `/data` + media type (SSD/HDD/eMMC/unknown) |
| `cpuLoad1` | 1-minute load average |
| `socTemp` | SoC temperature (wired from `sensors.ts` — no second `/sys/class/thermal` read) |
| `ifaceRxTx` | Per-interface RX/TX byte counters |
| `raucSlot` | Active RAUC A/B slot |

Adding a sixth field is a deliberate contract change, not a tweak. Every collector
wraps its read in its own `try/catch` and degrades to `null` on failure — a missing
`/sys` path or absent `rauc` binary must never crash the sampling loop.

## DEVICE DETECTION + KIOSK EMULATION SAFETY

`isRealDevice()` lives in `apps/backend/src/modules/system/device-detection.ts` and is re-exported from `apps/backend/src/modules/system/kiosk.ts`. It follows the same `deps`-injection pattern as the rest of the kiosk module (`DeviceDetectionDeps` + `defaultDeviceDetectionDeps`).

Detection contract (fail-safe, defaults to `false`):
1. `CERALIVE_DEVICE_TYPE==="real"` → true; `==="emulated"` → false (env override wins over everything)
2. `isDevelopment()` → false (short-circuits before any hardware probe)
3. `/proc/device-tree/model` contains `"Rockchip"` or `"RK3588"` → true
4. probe throws (file absent/unreadable) → false (never propagates)
5. unrecognised model → false

**Kiosk RPC handlers are emulated-safe.** The 4 action handlers (`kioskStart`, `kioskStop`, `kioskConfigure`, `kioskOsk`) in `apps/backend/src/rpc/procedures/system.procedure.ts` gate on `await isRealDevice()` at entry. In dev/emulated mode they return `{ success: false, error: "kiosk_unavailable_in_emulated_mode" }` without invoking `systemctl`. `kioskStatus` is NOT gated (read-only config; the settings UI needs it to render).

The error constant `KIOSK_UNAVAILABLE_ERROR` is the single source of truth in `packages/rpc/src/schemas/system.schema.ts`. The frontend (`OnDeviceDisplaySection.svelte`) renders a calm `role="status"` banner (`data-testid="kiosk-unavailable"`, i18n key `onDeviceDisplay.unavailable`) when the gate fires — not an error toast.

Override for tests: set `CERALIVE_DEVICE_TYPE=emulated` or `=real` in `beforeEach`/`afterEach` to pick the branch deterministically on any host.

## DEP BASELINE (as of 2026-06)

| Package | Version |
|---------|---------|
| `@orpc/*` (client, server, contract) | 1.14.5 |
| Bun pin (`.bun-version`) | 1.3.14 |
| `svelte` | 5.56.3 |
| `vitest` | 4.1.8 |

Fast-reload development loop (dev-sync / dev-push): [`image-building-pipeline/v2/docs/fast-reload.md`](../image-building-pipeline/v2/docs/fast-reload.md)

## CONVENTIONS

- Linting/formatting: Biome only (`@biomejs/biome` 2.4.16) — ESLint and Prettier are fully removed. Run `biome check .` (or `pnpm lint`) from the workspace root. Nested non-root configs live in `apps/frontend/`, `apps/backend/`, `packages/i18n/`.
- Svelte+TS: Biome's experimental HTML/Svelte support is enabled in the root `biome.json` (`html.experimentalFullSupportEnabled: true` + `html.formatter.enabled: true`). `.svelte` files are linted by Biome; their formatter is disabled in `apps/frontend/biome.json` (`overrides`) because Biome's experimental HTML formatter rewrites the `<script>` block to double quotes and cannot parse Svelte control-flow — so `.svelte` markup is still formatted by the Svelte VS Code extension. The same override silences false-positive `noUnusedVariables`/`noUnusedImports`/`useImportType`/`useConst` that Biome's partial template analysis emits for script vars used in markup.
- Strict TS: `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` are enabled in `tsconfig.json` (root), `apps/backend`, and `packages/rpc`. The frontend app (`apps/frontend/tsconfig.app.json`) and `tsconfig.node.json` enable `strict` + `noUncheckedIndexedAccess`; `exactOptionalPropertyTypes` is intentionally omitted there because it is incompatible with bits-ui v2 / shadcn-svelte and vite-plugin-pwa types (unfixable "union too complex" errors in CLI-managed components). The e2e tsconfig stays at baseline `strict` (ungated Playwright test code).
- Mock hardware in dev via `MOCK_SCENARIO` env var (`multi-modem-wifi` default).
- Backend binary compiled with `bun build --compile`; target set by `BUILD_ARCH`.
- Frontend is a PWA — service worker via `vite-plugin-pwa`.
- Validation constants live in `packages/rpc/src/schemas/`; the frontend reads them via `ValidationAdapter.ts` — never add inline numeric literals to dialog components.
- All config dialogs compose `AppDialog.svelte` (desktop Dialog / mobile Sheet via `MediaQuery` from `svelte/reactivity`).
- E2E Testing: REQUIRED reading before writing E2E tests → [`apps/frontend/tests/e2e/PLAYBOOK.md`](apps/frontend/tests/e2e/PLAYBOOK.md)

## BUN-NATIVE CONVENTIONS (as of 2026-06)

The backend is fully migrated to Bun-native APIs. Use these patterns for all new backend code:

- **Process spawning**: `Bun.spawn()` / `Bun.$` (shell) / `Bun.spawnSync()` — NOT `node:child_process`
- **File I/O**: `Bun.file().text()` / `Bun.write()` — NOT `fs.readFileSync` / `fs.writeFileSync`
- **HTTP client**: `fetch()` with `AbortSignal` — NOT `node:http`
- **Crypto**: `randomBase64()` from `src/helpers/crypto.ts` — NOT `crypto.randomBytes`
- **Keep on `node:`**: `node:path`, `node:os`, `node:dns`, `node:assert`, `node:events` — fully supported, no Bun gain
- **Keep on `node:fs/promises`**: directory ops (`readdir`, `mkdir`) — `Bun.file().exists()` is file-only and returns `false` for directories
- **`Bun.$` shell interpolation**: dynamic command strings must use `Bun.$\`${{ raw: cmd }}\`` — plain `${cmd}` escapes the whole string into one quoted arg
- **`process.env` writes**: stay on `process.env` — `Bun.env` is read-only

## ANTI-PATTERNS

- Don't run `npm install` or `yarn` — pnpm workspaces only.
- Don't add `@ceralive/ceracoder` or `@ceralive/srtla` to `package.json` as npm packages — they are local `link:` deps by design.
- Don't edit `.impeccable.md` for code changes — it's a design reference, not config.
- Don't touch srtla binding call sites without checking `../srtla/AGENTS.md` first (API in flux).
- Don't add custom UI components to `lib/components/ui/` — that directory is managed by the shadcn-svelte CLI. Custom components go in `lib/components/custom/`.
- Don't hardcode validation bounds (min/max lengths, bitrate limits, port ranges) in dialog components — import from `ValidationAdapter.ts` which sources from `packages/rpc/src/schemas/`.
