# CeraUI — Agent Knowledge Base

Parent: [`../AGENTS.md`](../AGENTS.md)

## ROLE IN THE GROUP

Device control plane. Svelte 5 PWA (frontend) + Bun/TypeScript WebSocket-RPC backend. Drives `cerastream` (active engine) and `srtla-send-rs` at runtime. Produces the `ceraui` .deb for ARM64 and AMD64 device images.

**Single engine.** `@ceralive/cerastream` is the ONLY streaming engine, consumed
as a public-npm registry dep. The legacy ceracoder engine and its sibling `link:`
dependency are fully retired (legacy `engine` values persisted in device
setup.json are coerced to `"cerastream"` at parse time with a warning).

The backend resolves both streaming deps as public-npm registry packages — no sibling checkout, no vendored tarball:

```
"@ceralive/cerastream":  "2026.6.1"   (public npm, @ceralive scope)
"@ceralive/srtla-send":  "2026.6.0"   (public npm, @ceralive scope)
```

Both are published npm packages (`@ceralive` scope on npmjs.org) consumed as normal registry deps, not `link:` paths and not vendored `.tgz` files. No sibling checkout of `srtla` or `srtla-send-rs` is needed for `CeraUI` to install or build.

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
│           ├── modules/system/
│           │   ├── device-stats.ts        # 5-signal device stats (S1 lock)
│           │   ├── device-detection.ts    # isRealDevice() — gates all add-on ops
│           │   ├── kiosk.ts               # Kiosk DC-2 state machine; toggle runs the cog-display add-on via the manager
│           │   └── software-updates.ts    # apt/size parsing; APT_PACKAGE_NAME_RE
│           └── modules/addons/
│               └── manager.ts             # Add-on enable/disable state machine (T28)
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
| **Add-on manager (enable/disable state machine, T28)** | `apps/backend/src/modules/addons/manager.ts` |
| **Device stats (5-signal broadcast)** | `apps/backend/src/modules/system/device-stats.ts` |
| **Config atomicity (E3)** | `apps/backend/src/helpers/config-loader.ts` — `writeFileAtomicSync` |
| **Runtime config schema (addons key)** | `apps/backend/src/helpers/config-schemas.ts` — `runtimeConfigSchema` |
| **Logger (dev pretty + prod JSON + redaction + boot banner)** | `apps/backend/src/helpers/logger.ts` + `helpers/boot-banner.ts` |
| **Per-RPC call tracing** | `apps/backend/src/rpc/rpc-logging.ts` |
| **Mock subsystem (state, reset, schemas, fixture factory)** | `apps/backend/src/mocks/` — `mock-service.ts`, `mock-schemas.ts`, `fixture-factory.ts` |
| **Device-detection override helper (tests)** | `apps/backend/src/modules/system/device-detection.ts` — `withDeviceType()` |
| **Ingest sparkline memoization** | `apps/frontend/src/lib/components/custom/ingest-link-view.ts` |
| **Ingest visual/UX + @visual spec** | `apps/frontend/src/lib/components/custom/IngestStats.svelte` + `tests/e2e/visual/ingest-states.visual.spec.ts` |
| Design rules | `.impeccable.md` |

## COMMANDS

```bash
pnpm install          # installs all workspaces; resolves registry deps (no sibling checkout required)
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
`osVersionMaterialized`, `userConfig`, `lastError`, `autoDisabled`.
`osVersionMaterialized` (T29) records the OS VERSION_ID the staged `.raw` was
fetched for, so the reconciler can detect an OTA-stale artifact by exact (G1)
match. The persisted `phase` enum (`ADDON_PHASES`) is
`idle | installing | active | pending | disabling | error`; `pending` (T29) is
the reconciler's non-terminal "wanted but not yet materialisable" state.

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

**Manager state machine** (`apps/backend/src/modules/addons/manager.ts`) [EXISTS]

The runtime orchestration layer (T28). Mirrors the kiosk state machine: every
OS/network/persistence primitive is injected through `AddonManagerDeps` (DI for
tests), and the SAME crash-loop discriminator drives auto-disable.

- **Manager phases** (`AddonManagerPhase`): `disabled → enabling → enabled`,
  `enabled → disabling → disabled`, plus `failed`, `pending`, `auto_disabled`.
  `toAddonState`/`phaseFromState` losslessly map these onto the schema-valid
  `AddonState` triple (`enabled` + `phase` + `autoDisabled`), so `config.json`
  always parses even though the persisted `phase` enum is coarser.
- **Enable pipeline** (ordered, each gated/atomic): `isRealDevice()` (G6) →
  free-space precheck (E1: `/data` free > `sizeInstalled × 2 + 512 MiB`) →
  download → `/data/tmp/<id>.raw.tmp` → sha256 (+ helper GPG) verify → atomic
  rename → `/data/extensions/<id>.raw` → `ceralive-addon-helper enable <id>` →
  unmask + start descriptor units → validation probe (auto-disable on failure).
- **Disable pipeline**: reverse + idempotent — stop + mask units → helper
  `disable` → remove artifact → drop config state.
- **Crash-loop auto-disable**: `pollAddonCrashLoop` reads `NRestarts` per unit;
  `>= ADDON_CRASH_LOOP_RESTART_THRESHOLD` (3) masks the units and parks the
  add-on in `auto_disabled` (same rule as kiosk T5).
- All privileged work is delegated to `ceralive-addon-helper` (G-trust); the
  manager never mutates the sysext scan dir or systemd directly on the trusted
  path — it drives the helper and argv-only `systemctl`.

Test coverage: `apps/backend/src/tests/manager.test.ts` — pure mapping, the
enable/disable pipelines, crash-loop + validation auto-disable, and the G6/E1
negative paths.

**Post-boot reconciler** (`apps/backend/src/modules/addons/reconciler.ts`) [EXISTS]

`runAddonReconciler()` (T29) reconciles desired state (config.json `addons`)
against the materialised `/data/extensions/<id>.raw` sysexts after a boot/OTA. It
is **fire-and-forget and NEVER gates boot or the OS-update healthcheck/rollback** —
every failure is caught and downgraded to a persisted `pending` phase; the run
never throws and self-serialises (a concurrent call is a no-op).

- Per enabled add-on: if the staged `.raw` is missing **or** its
  `osVersionMaterialized` ≠ the live `/etc/os-release` VERSION_ID (G1 exact
  match — never loosened), re-fetch `artifact.urlTemplate` (substituting
  `{os_version}` + `{board}`) → sha256 + GPG verify → atomic stage → helper
  `refresh`.
- **No compatible artifact** (404 / network / descriptor `compatibleOsVersions`
  excludes the live OS): set `phase: pending` + `lastError:
  addon_not_available_for_os_version`. Boot is unaffected.
- **Live stream**: a disruptive refresh is deferred — set `phase: pending` +
  `lastError: addon_refresh_deferred_streaming`; retried on the next boot.
- Triggered from `main.ts` at startup (non-blocking) and re-pokable via SIGUSR1
  from the `ceralive-addon-reconciler.service` oneshot (deployment/), which is
  deliberately NOT wired into any rollback/healthcheck target.
- All effectful surface is injected via `ReconcilerDeps`; default deps are built
  lazily (dynamic import) so the module never pulls the streaming/config graph or
  requires `setup.json` at test-import time.

Test coverage: `apps/backend/src/tests/addon-reconciler.test.ts` — re-materialise
(missing + VERSION_ID mismatch), idempotency, the pending/defer negative paths,
and the boot-safety (never-throws) + emulated-mode no-op guarantees.

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
`systemd-sysext` or `systemctl`. Read-only status queries are NOT gated. The
manager's `enableAddon`/`disableAddon`/`pollAddonCrashLoop` all enforce this gate
as their first step (`ADDON_UNAVAILABLE_ERROR`).

## MOCK SUBSYSTEM [EXISTS]

The mock subsystem provides hardware simulation for development and testing. It is
activated by `MOCK_SCENARIO` env var and gated behind `shouldUseMocks()` — never
`isDevelopment()` directly. All mock state is owned by `mock-service.ts`.

**Zod-validated fixtures (`mocks/mock-schemas.ts`):**
Every shipped fixture in `mock-config.ts` is validated against a Zod schema at
`initMockService()` time. A drifted fixture (wrong IMEI length, bad IPv4, unknown
SIM-lock state) fails loudly in dev instead of silently feeding malformed data into
the mmcli/nmcli/relay providers. Schema types are the single source of truth — both
`mock-config.ts` and `mock-service.ts` re-export `z.infer<...>` types from here.

**`resetMockState()` for per-test isolation:**
`initMockService()` captures a deep `structuredClone` of the seeded state as a
pristine snapshot. `resetMockState()` restores that snapshot AND clears all timers
(periodic-fluctuation + relay) — side-effect-clean, so each test starts from the
scenario's seeded state with no leaked intervals or cross-test bleed. Use in
`afterEach` for any test that mutates mock state.

**`updateMockState(partial)` — single write path:**
All writes to `mockState` funnel through the typed `updateMockState(partial)` mutator
(Object.assign top-level merge). The four named setters (`setMockModemConfig`,
`setMockWifiConnection`, `setMockNetifConfig`, `setMockEncoderConfig`) are thin
wrappers that compute the next slice and delegate to it.

**Add-on + kiosk mocks (`providers/addons.ts`, `providers/kiosk.ts`):**
`MockAddonDescriptor` and `MockAddonState` are the canonical fixtures for add-on
tests. `MOCK_KIOSK_STATUS`, `MOCK_KIOSK_TOKEN`, and `MOCK_COG_DISPLAY_DESCRIPTOR`
are the kiosk fixtures. `resetMockKioskState()` resets kiosk state between tests.

**SIM PIN mock (`mocks/mock-schemas.ts` + `fixture-factory.ts`):**
`MockSimState` carries `lock`, `pinRetries`, and `pukRetries`. The factory's
`buildMockSimState(overrides)` builds a schema-valid SIM state for tests that need
to exercise the PIN/PUK unlock flow without a real modem.

**Cerastream error simulation (`providers/streaming.ts`):**
The streaming mock provider can simulate structured engine errors (Tier-2 codes from
`cerastream-error-mapping.ts`) so the frontend notification path is testable without
a real cerastream process.

**Device-detection override (`modules/system/device-detection.ts`):**
`withDeviceType(type, fn)` is the canonical test helper for flipping the
`isRealDevice()` gate. Sets `CERALIVE_DEVICE_TYPE` before calling `fn`, restores
(or deletes) in a `finally` block — exception-safe and supports nesting.

**Fixture factory (`mocks/fixture-factory.ts`):**
One typed builder per mock domain object: `buildMockModem`, `buildMockWifiRadio`,
`buildMockWifiNetwork`, `buildMockRelay`, `buildMockAddonDescriptor`,
`buildMockAddonState`, `buildMockKioskToken`, `buildMockSimState`. Each builder
merges caller overrides with sensible defaults and runs the result through the same
Zod schema that validates the shipped fixtures — an out-of-range value throws at the
build site, not at the provider.

**Engine-driven health mock:**
The streaming mock provider exposes a `MockHealthState` slot that drives the
`ingest-health` signal in dev. Tests can set `health.score` and `health.degraded`
via `updateMockState` to exercise the health-alert rendering path.

**Scenarios:**

| `MOCK_SCENARIO` | Description |
|-----------------|-------------|
| `multi-modem-wifi` | Default: 3 modems + WiFi (multi-modem-wifi) |
| `single-modem` | 1 modem, no WiFi |
| `streaming-active` | Active streaming simulation with live telemetry |

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

**SIM PIN boot auto-unlock is another `isRealDevice()`-gated boot action.** `maybeAutoUnlockSimPins()` (`apps/backend/src/modules/modems/sim-autounlock.ts`, wired into `initModemUpdateLoop`) no-ops on a dev/emulated host. It submits the opt-in PIN — stored in the chmod-600 tmpfs file `/run/ceralive/sim-pin.secret` (`sim-secrets.ts`), never in `config.json` — at most once per locked modem, then clears the PIN and stops on any failure (no PUK-lockout loop). See `apps/backend/AGENTS.md` → SIM PIN AUTO-UNLOCK.

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

- Linting/formatting: Biome 2.5 via `@ceralive/biome-config` — ESLint and Prettier are fully removed. The root `biome.json` extends `@ceralive/biome-config` (`"extends": ["@ceralive/biome-config"]`). Run `biome check .` (or `pnpm lint`) from the workspace root. Nested non-root configs live in `apps/frontend/`, `apps/backend/`, `packages/i18n/`.
- Svelte+TS: Biome's experimental HTML/Svelte support is enabled via the shared config (`html.experimentalFullSupportEnabled: true` + `html.formatter.enabled: true`). `.svelte` files are linted by Biome; their formatter is disabled in `apps/frontend/biome.json` (`overrides`) because Biome's experimental HTML formatter rewrites the `<script>` block to double quotes and cannot parse Svelte control-flow — so `.svelte` markup is still formatted by the Svelte VS Code extension. The same override silences false-positive `noUnusedVariables`/`noUnusedImports`/`useImportType`/`useConst` that Biome's partial template analysis emits for script vars used in markup.
- Strict TS: `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` are enabled in `tsconfig.json` (root), `apps/backend`, and `packages/rpc`. The frontend app (`apps/frontend/tsconfig.app.json`) and `tsconfig.node.json` enable `strict` + `noUncheckedIndexedAccess`; `exactOptionalPropertyTypes` is intentionally omitted there because it is incompatible with bits-ui v2 / shadcn-svelte and vite-plugin-pwa types (unfixable "union too complex" errors in CLI-managed components). The e2e tsconfig stays at baseline `strict` (ungated Playwright test code).
- Mock hardware in dev via `MOCK_SCENARIO` env var (`multi-modem-wifi` default). Use `shouldUseMocks()` — never raw `isDevelopment()` — to gate mock paths.
- `LOG_LEVEL` env var overrides the Winston transport level for ALL transports (console + file). Unset = per-transport defaults (dev console `info`, prod console `warn`, file `debug`). Set `LOG_LEVEL=debug` to enable per-RPC trace lines.
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

## CAPABILITY CONSUMER [PARTIAL]

CeraUI is the strict consumer of the `get-capabilities` IPC contract emitted by
`cerastream`. The backend calls `get-capabilities` (a post-hello JSON-RPC method on
the UDS control plane) and forwards the tiered response to the frontend. The frontend
renders only the intersected offered set:

```
platform caps ∩ capture-source caps ∩ current-mode → offered set
```

Options outside the offered set are shown **disabled with a reason tooltip** — never
hidden, so operators can see what the hardware doesn't support and why.

**`pipeline-sources.ts` per-board tables deleted [PARTIAL].** The static per-board
capability tables that previously lived in `pipeline-sources.ts` are removed. All
capability data is now derived from the `get-capabilities` response at runtime. Do not
re-add static board tables; the contract is the single source of truth.

**Tier-4 add-on compat [PARTIAL].** Add-on compatibility is resolved entirely inside
CeraUI and is NOT part of the `get-capabilities` response. Three enforcement layers:

- `compatibleHardware` field in `AddonDescriptorSchema` gates which boards may enable
  an add-on (server-side enforcement in `apps/backend/src/modules/addons/manager.ts`
  — not UI-only).
- `deps[]` / `conflicts[]` in `AddonDescriptorSchema` are enforced at enable time
  (previously declared but unenforced).
- In-UI docs: incompatible add-ons show a reason tooltip explaining the hardware or
  dependency constraint.

**Recent enhancements [PARTIAL]:**

- **SIM PUK recovery** — UI flow for entering the PUK code when a SIM is PUK-locked.
- **SIM PIN auto-unlock** — `maybeAutoUnlockSimPins()` submits the opt-in PIN (stored
  in the chmod-600 tmpfs file `/run/ceralive/sim-pin.secret`, never in `config.json`)
  at most once per locked modem on boot, then clears the PIN and stops on any failure.
  See `apps/backend/src/modules/modems/sim-autounlock.ts`.
- **Ingest sparklines** — fixed ~60-sample in-memory ring buffer per link; no
  persistence. Rendered in the HUD bar as a compact bitrate history.
- **Session summary** — post-stream summary panel showing duration, average bitrate,
  and per-link stats for the completed session.
- **EncoderDialog modal preview (#72)** — live encoder settings preview rendered inside
  the EncoderDialog modal before the user applies changes.
- **HotspotDialog connect-phone section (#67, Phase-0)** — QR-code section in
  HotspotDialog that lets a phone scan and join the device hotspot. Backed by the
  `wifi.hotspotInfo` RPC and the `generateDeviceAccessQr` helper.

## STREAMING BACKEND QUALITY [EXISTS]

Quality improvements landed in `chore/backend-quality` (Tasks 5–7, 13–14).

### streamloop module split

`apps/backend/src/modules/streaming/streamloop.ts` is now a 5-line barrel re-exporting
from `streamloop/index.ts`. The 10 public exports are unchanged — all caller import paths
are unmodified.

```
modules/streaming/streamloop/
├── exec-paths.ts    # srtlaSendExec, bcrptExec constants
├── process-runner.ts # mutable streamingProcesses list + spawnStreamingLoop/stopProcess/stopAll/getStreamingProcesses
├── start-stream.ts  # startStream — spawns srtla_send, wires telemetry, starts the engine session over the seam
├── session.ts       # start / stop + removeNetworkInterfacesChangeListener module-state
├── autostart.ts     # AUTOSTART_CHECK_FILE / setAutostart / checkAutoStartStream / autoStartStream backoff
└── index.ts         # named re-export barrel (exactly the 10 public exports)
```

**Locked public API surface (9 exports):** `AUTOSTART_CHECK_FILE`, `autoStartStream`,
`bcrptExec`, `checkAutoStartStream`, `setAutostart`, `srtlaSendExec`,
`start`, `startStream`, `stop`. Adding or removing any of these is a breaking change.

### timing-constants.ts

`apps/backend/src/modules/streaming/timing-constants.ts` centralizes all hardcoded
timeout/retry values. Import from here — never add inline numeric literals to streaming
modules.

| Constant | Value | Used in |
|----------|-------|---------|
| `MAX_BCRPT_RETRIES` | 5 | `bcrpt.ts` |
| `INITIAL_RETRY_DELAY` | 1000ms | `bcrpt.ts` |
| `AUTOSTART_RETRY_DELAY` | 1000ms | `streamloop/autostart.ts` |
| `AUDIO_SOURCE_POLL_DELAY` | 1000ms | `audio.ts` |

### Logger (`apps/backend/src/helpers/logger.ts`) [EXISTS]

All `console.*` calls in streaming and ingest/rpc modules are replaced with the Winston
logger. Empty catches now log via `logger.debug`/`logger.warn` before suppressing. No
`console.*` calls remain in `modules/ingest/` or `modules/streaming/` (verified by grep
gate).

**Dev console (TTY-gated colorized pretty-print):**
`formatConsoleEntry(info, useColor)` emits `HH:MM:SS.mmm LEVEL message` with 2-space-indented
JSON metadata on subsequent lines. Color is raw ANSI (no chalk/picocolors dep) — error=red,
warn=yellow, info=green, debug=dim. `shouldColorizeConsole()` gates on
`isDevelopment() && process.stdout.isTTY`, evaluated per-record so CI/piped/prod never emit
ANSI escapes.

**Prod JSON schema (file transport + prod console):**
`formatProdEntry(info)` serializes to a single-line JSON record with a fixed shape:
```ts
{ ts: string, level: string, msg: string, module?: string, meta?: Record<string, unknown> }
```
`ts` is ISO-8601 UTC; `module` is promoted to top-level (not buried in `meta`); all other
non-reserved fields fold under `meta`. `jsonReplacer` surfaces `Error` objects as
`{name, message, stack}` rather than `{}`. Both the file transport and the production
console use this same schema so log shippers parse one format.

**`LOG_LEVEL` env override:**
`resolveLogLevel(defaultLevel)` reads `process.env.LOG_LEVEL` (non-empty, trimmed) and
applies it to EVERY transport when set. Defaults: dev console `info`, prod console `warn`,
file `debug`. Set `LOG_LEVEL=debug` to enable per-RPC trace lines in production.

**Per-RPC call tracing (`rpc/rpc-logging.ts`):**
`instrumentRpcCall` wraps every oRPC procedure dispatch with a debug-level trace line
carrying `{ procedure, cid, latency_ms, ok }`. Gated on `isRpcTraceEnabled()` (dev or
`LOG_LEVEL=debug`) so a shipped device never pays the per-call cost. Auth procedures
(`auth.*`) have their args omitted entirely — not even redacted-partial. All other
procedure args pass through `logRedact()` before logging.

**Boot banner + per-phase markers (`helpers/boot-banner.ts`):**
`buildBootBanner(info)` emits a one-line startup banner: `🎬 CeraUI vX · env=… · scenario=…`.
`createBootTimer()` tracks per-phase deltas (injectable clock for tests). `main.ts` emits
7 phase markers (🔧 config / 🔌 pipelines / 🖥️ hardware / 🌐 network / 🎵 audio & devices /
🚀 server / ▶️ autostart & reconciler) and a final `✅ CeraUI ready on port N in Xms` line.

**Secret redaction (all transports):**
`redact()` format scrubs every record before it reaches any transport. Keys matching
`/pin|password|token|secret|paseto|bcrp|auth/i` are replaced with `[REDACTED]`. Value-shaped
secrets (PASETO `v4.public.*`, JWT `eyJ…`, Bearer credentials) are also scrubbed from string
values. The `logRedact(value)` helper is exported for call sites building metadata objects.

**Loop visibility:**
Streaming and ingest loop modules log entry/exit and error paths via `logger.debug`/`logger.warn`
so the boot sequence and per-tick activity are visible in dev without noise in prod.

## INGEST HARDENING [EXISTS]

Quality improvements to the ingest pipeline landed across Tasks 6, 19, and 23.

### Export-failure handling

`IngestStats.svelte` catches `URL.createObjectURL` / `Blob` failures during JSON/CSV
export and renders a calm amber bordered band (`ingest-export-error`) instead of
silently swallowing the error. The error state is driven by a local `exportError`
slot and clears on the next successful export.

### Sparkline memoization (`lib/components/custom/ingest-link-view.ts`)

The per-link SVG sparkline computation is extracted into a pure rune-free module.
`createLinkViewCache()` keeps a `Map<conn_id, {ref, view}>` and recomputes only when
the samples-buffer reference differs from the last call for that `conn_id`. The ring
effect allocates a fresh array only on append (`[...prev, sample]`), so a stable
reference means unchanged samples and a memo hit; a genuinely new sample swaps the
reference and triggers exactly one recompute. The cache is per-component-instance
(freed on unmount) — no module-global state, no unbounded growth.

`EMPTY_SAMPLES` is a shared stable empty buffer so a link awaiting its first frame
is also a memo hit. `RING_CAPACITY` (60 samples), `SPARK_W`, `SPARK_H`, and the
`Sample` / `LinkViewComputed` types are all exported from this module — never
duplicated in the component.

### Visual/UX polish (Task 23)

`IngestStats.svelte` markup was polished without changing any data logic, thresholds,
or `Props`:

- Header: phosphor-lime icon chip + count/sample pill.
- Per-link table: spectral identity dot (CSS `--link-1..6` ramp) before each iface;
  column headers aligned past the dot.
- Sparkline strip: leading `Trend` micro-label (i18n key `live.ingest.trend`, added
  to all 10 locales), taller `h-6`, neutral baseline `<line>` (NOT a second
  `<polyline>` — keeps `spark.locator("polyline").toHaveCount(1)` valid).
- Health verdict: pill with a leading dot (lime healthy, amber degraded).
- Alert + export-error: calm amber bands with icon.
- Summary: stat tiles with icons; drops value goes amber when `> 0`; per-link uptime
  rows gain a `--primary` progress bar.

### @visual spec (`tests/e2e/visual/ingest-states.visual.spec.ts`)

5 desktop visual tests (tag `@visual`): idle / streaming / summary / health-alert /
export-error. Each captures one PNG to `apps/frontend/test-results/`. The export-error
state is driven by overriding `URL.createObjectURL` via `page.evaluate` at click time.

### Ring-buffer lifecycle

The 60-sample ring is per-component-instance `$state<Record<conn_id, Sample[]>>` —
NOT module-global. Verified: fill → unmount → remount starts at 1 sample, not 61.
Per-`conn_id` rings bound independently: two `conn_id`s fed 99 frames each both cap
at exactly 60.

## ANTI-PATTERNS

- Don't run `npm install` or `yarn` — pnpm workspaces only.
- Don't add `@ceralive/srtla` to `package.json` — that package is retired from CeraUI. The sender binding is `@ceralive/srtla-send` (public-npm registry dep, `@ceralive` scope). **`@ceralive/cerastream` is a public-npm registry dep** (`@ceralive` scope, pinned to a CalVer version; ADR-0002 Decision 13 / ARCHITECTURE §7) — never a sibling `link:` or vendored `.tgz`.
- Don't edit `.impeccable.md` for code changes — it's a design reference, not config.
- Don't touch `@ceralive/srtla-send` call sites without checking `../srtla-send-rs/AGENTS.md` first (binding API).
- Don't add custom UI components to `lib/components/ui/` — that directory is managed by the shadcn-svelte CLI. Custom components go in `lib/components/custom/`.
- Don't hardcode validation bounds (min/max lengths, bitrate limits, port ranges) in dialog components — import from `ValidationAdapter.ts` which sources from `packages/rpc/src/schemas/`.
- Don't hardcode timeout/retry values in streaming modules — import from `timing-constants.ts`.
- Don't add new exports to the streamloop barrel without updating the locked-API surface test in `tests/streamloop-modules.test.ts`.
