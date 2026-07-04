# CeraUI Frontend — Agent Knowledge Base

Parent: [`../../AGENTS.md`](../../AGENTS.md)

## ROLE

Svelte 5 PWA. Talks to the backend exclusively via WebSocket RPC — no REST, no direct hardware access.

## STRUCTURE

```
src/
├── main.ts / App.svelte      # entry: initSubscriptions(), auth gate, Layout, layout-mode effect
├── main/
│   ├── LiveView.svelte        # Live destination: stream control, encoder/audio/server config, bitrate hot-adjust
│   ├── NetworkView.svelte     # Network destination: bonded links, WiFi, modems, Ethernet, hotspot
│   │   └── network/CollisionBands.svelte  # same-subnet info band + policy-route warning band [EXISTS]
│   ├── SettingsView.svelte    # Settings destination: grouped config entry points (all via dialogs)
│   ├── HudBar.svelte          # Persistent HUD bar — bitrate, per-link signals, SoC telemetry, tap-to-expand Sheet
│   ├── HudRegion.svelte       # Responsive HUD mount (desktop top / mobile bottom dock)
│   ├── DisconnectedBanner.svelte  # Reconnect/reboot/session-expiry banner (authed branch only)
│   ├── notifications/         # NotificationsPanel.svelte — header bell + unread badge;
│   │                          #   AppDialog listing notifications.getPersistent() with per-item dismiss
│   ├── dialogs/               # 14 focused config dialogs, all compose AppDialog:
│   │   ├── EncoderDialog.svelte
│   │   ├── AudioDialog.svelte
│   │   ├── ServerDialog.svelte  # destination-first logic container (receiver-experience track, Tasks 1–14)
│   │   │   └── server/          # DestinationSection · TransportRow · LatencySection · RelayServerSelector · CustomEndpointForm · ServerIngestSlots (presentational)
│   │   ├── ModemConfigDialog.svelte
│   │   ├── HotspotDialog.svelte
│   │   ├── WifiSelectorDialog.svelte
│   │   ├── NetifDialog.svelte
│   │   ├── CloudRemoteDialog.svelte
│   │   ├── PasswordDialog.svelte
│   │   ├── SshDialog.svelte
│   │   ├── LogsDialog.svelte
│   │   ├── UpdatesDialog.svelte
│   │   ├── PowerDialog.svelte
│   │   └── VersionsDialog.svelte
│   └── tabs/                  # Legacy tab views (Streaming, Network, General, Advanced, DevTools)
│                              #   DevTools is dev-only (runtime-gated via navElements, not tree-shaken)
├── lib/
│   ├── rpc/                   # RPCClient + TypedRPC + subscriptions.svelte.ts
│   ├── stores/
│   │   ├── hud.svelte.ts          # HUD state: BARREL re-exporting hud/ sub-stores (public surface unchanged)
│   │   │                          #   exposes staleInterfaces (per-interface staleness, fingerprint-tracked,
│   │   │                          #   global STALE_THRESHOLD_MS, resolves while clock ticks: streaming/disconnect)
│   │   ├── hud/                   # split by derivation domain (all rune-free except store):
│   │   │                          #   constants · soc-telemetry (sensor parse) · link-status (buildLinks)
│   │   │                          #   · staleness (freshness+gated clock) · derive (deriveHudState)
│   │   │                          #   · store.svelte.ts (lazy runes store + selectors)
│   │   ├── connection-ux.svelte.ts # Reconnect/reboot/session-expiry UX (eager-init in browser)
│   │   ├── auth-status.svelte.ts  # SOLE auth-mutation path (ingestAuth/authenticate/createPassword) —
│   │   │                          #   websocket-store.svelte.ts is DELETED; do not re-add it
│   │   ├── notifications.svelte.ts # Active notifications (toast + persistent); getActive() feeds
│   │   │                          #   the toast host, getPersistent() feeds NotificationsPanel
│   │   └── layout-mode.svelte.ts  # Touch/kiosk layout flag ($persist "layout-mode")
│   ├── components/
│   │   ├── dialogs/           # AppDialog.svelte — shared responsive dialog chrome
│   │   │                      #   desktop: Dialog; mobile: Sheet (via MediaQuery from svelte/reactivity)
│   │   ├── custom/            # Custom components (NOT shadcn-managed):
│   │   │                      #   simple-alert-dialog, mode-toggle, locale-selector, mobile-link, pwa/,
│   │   │                      #   ComingSoon.svelte [EXISTS] (calm roadmap pill + tooltip, data-debt-id bound),
│   │   │                      #   SourceSection.svelte [EXISTS] (live input picker section),
│   │   │                      #   SourcePreference.svelte [EXISTS] (pre-start source preference selector),
│   │   │                      #   InfoPopover.svelte [EXISTS] (lightweight info popover, question-mark trigger),
│   │   │                      #   NetworkIngestSection.svelte [EXISTS] (LAN RTMP/SRT ingest sources card)
│   │   ├── streaming/         # ValidationAdapter.ts — FE constraint adapter (imports from @ceraui/rpc/schemas)
│   │   └── ui/                # shadcn-svelte primitives (bits-ui v2.18.1) — CLI-managed, do not hand-edit
│   └── env/ lib/helpers/ lib/config/ lib/types/
```

## CRITICAL: initSubscriptions() must be called at startup

`lib/rpc/subscriptions.svelte.ts` exports `initSubscriptions()` — this registers the `onMessage` and `onConnectionChange` handlers that feed all non-deprecated getters (`getConfig`, `getModems`, `getWifi`, `getIsStreaming`, etc.). It is called in `main.ts` before mount. **Any store or component that reads from `subscriptions.svelte` getters depends on this call being present.** If you remove or move it, the HUD, all destination views, and the disconnected banner will show stale/empty data.

## RPC PATTERN

```ts
import { rpc, rpcClient } from '$lib/rpc';
await rpc.streaming.start(config);          // typed via TypedRPC in client.ts
await rpc.streaming.setConfig(fields);      // persist config without starting stream (Task 19)
rpcClient.onMessage((type, data) => { });   // raw push events
```

New procedures: add to `@ceraui/rpc` schemas first, then extend `TypedRPC` in `client.ts`.

## COMMANDS

```bash
bun run dev / build / check / test       # Vite :5173 / dist/ / svelte-check / vitest
bun run build:federation                  # Vite lib-mode → dist/federation/<ceraui-version>/{encoder,audio,server}.js
bun run sign:federation                    # (root) SRI + GPG bundle sigs + signed manifest.json (Task 40)
# Linting is Biome-only, run from the workspace root: `biome check .` (or `bun run lint`)
```

## FEDERATION LIB BUILD (Task 39) [EXISTS]

`vite.federation.config.ts` is a SEPARATE Vite lib-mode build (not the SPA `vite.config.ts`)
that emits the Encoder/Audio/Server config dialogs as standalone ES-module bundles for the
version-federation hosting/signing contract (root `AGENTS.md` → version-federation). It runs
via `bun run build:federation` from the CeraUI root (delegates to the frontend
`build:federation` script).

- **Entries**: `src/main/dialogs/{EncoderDialog,AudioDialog,ServerDialog}.svelte` →
  `dist/federation/<ceraui-version>/{encoder,audio,server}.js` (`formats: ["es"]`,
  per-entry `fileName`). Shared graph (rpc, subscriptions, i18n) is code-split into sibling
  chunks co-located at the same versioned path — they upload + resolve together under the
  platform CSP.
- **`<ceraui-version>`** is read at build time from the workspace-root `package.json` `version`
  (CalVer, `2026.6.2` at time of writing) — the single source of truth, matching the platform's
  `ceraui-version` claim.
- **Isolation**: this build NEVER touches the SPA `dist/public` output, runs no
  PWA/service-worker plugin, and emits no `index.html`. The SPA `vite.config.ts` is unmodified.
- **CI ordering caveat**: the backend `build` script does `rm -rf ../../dist/`, so
  `build:federation` MUST run AFTER `bun run build` (the full SPA/backend build) — never before,
  or its output is wiped.

## FEDERATION SIGNING (Task 40) [EXISTS]

`scripts/sign-federation.ts` (CeraUI root, run via `bun run sign:federation`) is the post-build
step that signs the `build:federation` output. Run it AFTER `build:federation`
(`bun run build:federation && bun run sign:federation`). For each dialog bundle in
`dist/federation/<ceraui-version>/` it emits the artifacts the version-federation contract
(root `AGENTS.md` → version-federation) requires, then writes + signs the manifest the cloud
consumes.

- **Per bundle** (`encoder.js`, `audio.js`, `server.js`): `<file>.js.sri` (the `sha384-…`
  Subresource-Integrity hash, base64) + `<file>.js.sig` (a **GPG** detached signature).
- **`manifest.json`**: the EXACT shape `FederationManifestSchema` enforces —
  `{ ceraUiVersion, files: [{ filename, integrity }] }`. Do NOT change this shape; the cloud
  consumer (`ceralive-platform apps/api/lib/federation/manifest-verify.ts`) parses it.
- **`manifest.json.sig`**: a base64 **Ed25519** detached signature over the EXACT manifest
  bytes — **NOT GPG**. The cloud verifies it with `verifyAndParseManifest`
  (`verify(null, …)`, PEM SPKI public key) BEFORE trusting any SRI hash inside the manifest.
- **Two mechanisms, by design** (federation-security-design.md §3–4): bundles use GPG because
  apt-worker already GPG-verifies them at the R2 upload boundary (Task 41); the manifest uses
  raw Ed25519 because the cloud trust gate (Task 42) is dependency-free `node:crypto` — a GPG
  manifest signature could not be verified there.
- **Keys (fail-closed; never auto-generated)**: `GPG_SIGNING_KEY` (base64 ASCII-armored private
  key → imported into a throwaway GNUPGHOME) **or** a pre-imported keyring; optional
  `GPG_SIGNING_KEY_ID` (default = first secret key, no hardcoded id) + `GPG_SIGNING_KEY_PASSPHRASE`.
  `FEDERATION_MANIFEST_PRIVATE_KEY` (Ed25519, PEM PKCS8 or base64 of the PEM) signs the manifest;
  optional `FEDERATION_MANIFEST_PUBLIC_KEY` (PEM SPKI) is cross-checked at verify time. No private
  key is ever committed.
- **Self-verifying**: after signing the script GPG-verifies every bundle, recomputes each SRI
  against the manifest + `.sri` file, and Ed25519-verifies `manifest.json.sig`. `--verify-only`
  re-runs just the verification pass against existing artifacts (CI gate seam).

## FEDERATION PUBLISH (Task 41) [EXISTS]

The `publish-federation` job in `.github/workflows/publish-release.yml` is the release-triggered
CI job that uploads the signed bundles to R2. Pipeline (each step gates the next):
`bun run build:federation` → `bun run sign:federation` (sign + self-verify) →
`bun run sign:federation -- --verify-only` (independent re-verify before any write) →
`aws s3 cp` per file to `s3://$R2_BUCKET/ui-bundle/<ceraui-version>/`.

- **Fail-closed**: `sign-federation.ts` errors when a signing key is absent, so a missing GPG /
  Ed25519 secret blocks publish — bundles are never uploaded unsigned/unverified.
- **Version**: `<ceraui-version>` is read from `package.json` (`node -p`) — the same source
  `build:federation` + `sign-federation.ts` use, so the R2 path matches `dist/federation/<version>`
  and the manifest's `ceraUiVersion`.
- **Content-types pinned per file** (must match the apt-worker route, see `apt-worker/AGENTS.md`):
  `.js` → `application/javascript`, `.sri` → `text/plain`, `.sig`/`manifest.json.sig` →
  `application/octet-stream`, `manifest.json` → `application/json`. The `*.js` glob includes the
  code-split shared chunks (rpc, subscriptions, input) — they must upload alongside the dialog
  bundles so dynamic `import()` resolves under the platform CSP.
- **Secrets**: `FEDERATION_GPG_SIGNING_KEY` (+ optional `_ID`/`_PASSPHRASE`),
  `FEDERATION_MANIFEST_PRIVATE_KEY` (+ optional `FEDERATION_MANIFEST_PUBLIC_KEY`),
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET`. The job runs with
  `permissions: contents: read`; the workflow's `cancel-in-progress: false` applies (never cancel
  a mid-publish run).

## CONVENTIONS

- Stores: Svelte 5 runes only (`$state`, `$derived`, `$effect`) — files named `*.svelte.ts`.
- **Store ownership (single owner rule) [EXISTS]:** `lib/rpc/subscriptions.svelte.ts` is the SOLE `rpcClient.onMessage` consumer and owns every non-auth reactive/connection getter (`getConfig`, `getStatus`, `getIsConnected`, `getConnectionState`, …). `lib/stores/auth-status.svelte.ts` is the SOLE auth-mutation path (`ingestAuth`/`getAuthMessage`/`authenticate`/`createPassword`/`authStatusStore`). The legacy `websocket-store.svelte.ts` wrapper (528 LOC) is FULLY DELETED — do not re-add it or a second `onMessage`/auth-mutation owner. A CI grep gate (`src/tests/deprecated-ws-store-gate.test.ts`) fails the build if the literal module name reappears anywhere in `apps/frontend/src`. `offline-state.svelte.ts`/`pwa-status.svelte` are the one deliberate exception — they read connection state straight off `$lib/rpc/client` (not `subscriptions.svelte`) to stay pre-auth-pure.
- UI primitives: extend via shadcn-svelte CLI (`bunx shadcn-svelte@latest add <component>`), not by hand.
- Custom components (not shadcn-managed) live in `lib/components/custom/`, not `lib/components/ui/`.
- Mock scenarios: `MOCK_SCENARIO` env var. Runtime switching via `rpc.streaming.setMockHardware`.
- Design: read `../../.impeccable.md` before touching visuals. The Ground Control identity (phosphor lime primary, warm graphite background) is defined in `app.css` tokens — trust the committed tokens, not older docs.
- i18n: `@ceraui/i18n` workspace package — all user strings via `LL.*`. Only the base `en` locale uses typed params `{param:type}`; the 9 non-EN locales use bare `{param}`.
- Validation bounds: import from `ValidationAdapter.ts` (which sources from `@ceraui/rpc/schemas` constants). No inline numeric literals in dialog components.
- Touch/kiosk: `data-layout-mode` attribute on `<html>` drives CSS token scaling. Read `docs/TOUCHSCREEN.md`.
- Live-data feedback: dim aged values via `getStalenessState`; mark a single aged interface with `custom/Badge.svelte` `variant="stale"` (fed by `hud.staleInterfaces`); show in-flight actions with `custom/InlineSpinner.svelte` (role=status). All three are CSS-animation/transition based, so the e-ink freeze (`app.css` `[data-display='eink']`) stills them automatically — never JS-drive these animations.
- E-ink transition gate (T10) [EXISTS]: `$lib/transitions.ts` exports `gateForEink(transition)`, `einkGatedSlide`, `einkGatedFade`, and `einkGatedFly`. Svelte 5 css-based transitions compile to the Web Animations API (`Element.prototype.animate()`), which is NOT stilled by the `app.css` `transition/animation: none !important` freeze rule. `gateForEink` returns `{ duration: 0 }` under `prefersEinkTheme(getDisplayProfile())` so Svelte calls no `.animate()` — instant, no motion. Under LCD it returns the real transition verbatim. Components import `einkGatedSlide as slide` (etc.) and keep every `transition:`/`in:`/`out:` directive byte-identical.
- Onboarding checklist (T13) [EXISTS]: `OnboardingChecklist.svelte` (`src/main/`) renders a first-run guidance panel in `LiveView` when the device has no network interface and no server configured. Dismissal is persisted via `onboarding.svelte.ts` (`src/lib/stores/`) using `$persist("live-onboarding-dismissed")`. Auto-hides when `hasNetwork && hasServer` (config steps only — NOT gated on streaming). i18n under `live.onboarding.*` (10 locales, param-free keys).
- PowerDialog rebootCountdown + `clearRebooting()` (T14) [EXISTS]: after a successful `system.reboot` call, `PowerDialog` enters a `counting` phase showing a rebootCountdown instead of closing immediately. If the device never goes down within the reconnect window, it transitions to `recovery` phase and calls `clearRebooting()` (`connection-ux.svelte.ts`) to clear the rebooting latch without a reconnect. `clearRebooting()` is the deliberate escape hatch — it sets `rebooting: false` directly. The countdown duration is overridable via `window.__ceraRebootCountdownSeconds` (e2e seam, prod-inert). i18n key `settings.dialogs.rebootCountdownRemaining` carries the countdown copy (param key: `{seconds:number}`).
- Disabled-reason hints (T15) [EXISTS]: `WifiNetworkList`, `HotspotDialog`, `AudioDialog`, `StreamControlButton`, and `ModemConfigDialog` now surface a `title` attribute carrying a human-readable `disabledReason` string when a control is disabled. The reason is conditional — absent when the control is actionable. `WifiNetworkList` also distinguishes a scanning-in-progress state from a genuinely empty network list (nested `{#if scanning}` inside the `{:else}` of the `{#each}` block).
- Stream-start failure reason (T16) [EXISTS]: `mapCerastreamError(error)` (`modules/streaming/cerastream-error-mapping.ts`) maps a `RuntimeErrorEvent` or structured engine error to a Tier-2 code string. The `streaming.start` output carries an optional `reason` field (`StreamingStartOutputExtended`). `LiveView` reads `reason` from the start result and looks it up in `live.startFailed.*` (nested i18n namespace: `live.startFailed.generic` + 7 Tier-2 code keys). The frontend `TypedRPC` in `client.ts` was updated to use `StreamingStartOutputExtended` — the contract change alone is invisible to the FE without this update.
- i18n placeholder keys (T17) [EXISTS]: four hardcoded `placeholder="…"` literals in `NetifDialog`, `ModemConfigDialog`, `CloudRemoteDialog`, and `SshDialog` were moved to i18n keys (`settings.dialogs.ipPlaceholder`, `network.modem.apnPlaceholder`, `advanced.providerNamePlaceholder`, `advanced.providerHostPlaceholder`). No visual change; the keys are param-free and their values are identical across all 10 locales.
- Unified badge component: `custom/Badge.svelte` is the single variant-driven badge for all pill/marker needs. `variant="speed"` renders the throughput value (font-mono, signal-tier colour, dims when `stale`, carries `data-live-value`); `variant="stale"` renders the per-interface staleness marker (warning pill + Clock glyph + i18n copy, carries `data-stale-interface`); `variant="success" | "warning" | "error" | "info" | "neutral"` renders a semantic status pill (carries `data-status-badge`, passes `...rest` through, optional `icon`/`label`/`children` snippets, `size="sm" | "micro"`) with an unknown value falling back to `neutral`. It replaced the former `SpeedBadge` / `StaleBadge` / `StatusBadge` components (folded together with no visual change). Every variant is static/CSS-only, so all are e-ink-freeze safe.
- Per-field sync state: `rpc/field-sync-state.svelte.ts` is a lifecycle machine (`idle → pending → applying → applied | failed`) layered ON TOP of the dirty-registry — it does NOT replace it. It composes the existing `markPending` / `onRpcResolved` / `onRpcAppliedReactive` lock contract (so a field locked here is the same lock the ingestion path guards) and adds the phase. Consumers call `beginFieldSync` → `markFieldApplying` → `markFieldApplied(field, result.applied)` / `markFieldFailed(field, authoritative)`; read the phase with `getFieldState(field)` and render `custom/FieldSyncIndicator.svelte` (the InlineSpinner during `applying`). Contracts: `applied` releases to `result.applied` (never the typed value); a stuck in-flight field is TTL-released after `FIELD_LOCK_TTL_MS`; status fields (`is_streaming`, `wifi`, …) are refused (G4). `initFieldSyncState()` MUST run at startup (in `main.ts`, beside `initSubscriptions()`) — the store's reactive root must not be first created mid-render.
- Capability-first EncoderDialog (no presets): `main/dialogs/EncoderDialog.svelte` exposes independent, capability-gated controls directly — source, codec (Auto/H.264/H.265 segmented selector), bitrate (slider + number input sharing ONE board window + `clampBitrateToBounds`), resolution, framerate, and the bitrate-overlay toggle. There is NO mode-preset catalog: the `CANONICAL_PRESETS`/`ModePreset`/`presetMatchesOffered` layer (`@ceraui/rpc` `capabilities/mode-presets.ts`) and the frontend `lib/streaming/modePresets.ts` bridge (`presetToDraft`/`presetViews`/`findMatchingPresetId`) are DELETED, along with the `live.presets.*` i18n keys, the `data-testid="mode-presets"` card grid, the `encoderPreset` field-sync pseudo-field, and the "Advanced / Custom" `<details>` expander (its granular controls are now rendered inline). Every rung outside the offered set (`intersectCaps` → `offeredEncoderCaps`, still the gating core) renders DISABLED with a reason tooltip — never hidden; H.265 is disabled-with-reason when the platform can't encode it. The operator's codec choice (`localCodec`) IS persisted: `handleSave` writes it to the draft's `codec` → `video_codec` config field (fully wired through `streaming.schema.ts` → `config-schemas.ts` → `streaming.procedure.ts` → `cerastream-backend.ts`). `PreviewCanvas` (#72) stays mounted. Resolution/Framerate are device-mode-aware: `offeredAxes(hardware, pipelineId, pipeline, deviceModes, selectedVideoInput)` (`ValidationAdapter.ts`) intersects `platform ∩ active-source ∩ Tier-2 device modes` (`capabilities.device_modes` from `list-devices`), `framerateOptionsForResolution(axes, resolution)` gates framerate PER selected resolution, and `axisCeiling(axes)` drives the `axis-summary` line (`axis-current` / `axis-device-max` testids). With `device_modes` absent the offering is byte-identical to the coarse path (old-engine fallback). Option lists carry `data-testid="resolution-option"`/`"framerate-option"` with `data-value`, `aria-disabled`, and a resolved-reason `title`; the trigger carries `aria-invalid` when the current value is unsupported — the exact contract the truthfulness e2e asserts.
- Preview single-origin proxy (Task 20) [EXISTS]: `PreviewCanvas.svelte` NEVER dials the cerastream engine's preview port directly — the preview WebSocket is proxied through the CeraUI backend origin at `/preview` (single origin = remote-access safe: no second port to expose behind a reverse proxy, no mixed-origin/CORS). Flow: mint a single-use token over the authenticated RPC socket (`rpc.system.mintPreviewToken()`), then dial `getPreviewSocketUrl(token)` (which is `getSocketUrl()` + `/preview?token=…` — the RPC credential never rides the URL). The pre-dial gate stays `derivePreviewAvailability(caps)` (`preview-availability.ts`, now a single arg — the mock-dev exception is gone since dev also dials the backend proxy). Close codes from `@ceraui/rpc/schemas` map to the SAME availability bands: `PREVIEW_CLOSE_UPSTREAM_DOWN` (4502)→engineOffline, `PREVIEW_CLOSE_UPSTREAM_UNAVAILABLE` (4503)→previewUnavailable, `PREVIEW_CLOSE_UNAUTHORIZED` (4401)→one silent re-mint then the offline band, anything else→existing bounded reconnect (`RECONNECT_ATTEMPT_DISPLAY_CAP`). A CI grep gate (`src/tests/preview-single-origin-gate.test.ts`) fails the build if the engine preview port literal (or the removed `VITE_PREVIEW_PORT`) reappears in shipped frontend source.
- Per-link srtla telemetry (RTT/NAK/weight): `getLinkTelemetry()` (subscriptions, fed by the `status.linkTelemetry` push) → `NetworkView` → `BondedLinksSection`, rendered per card by `custom/LinkTelemetry.svelte`. Cards join telemetry by `link.id === entry.iface`; the three values always render (`--` when absent) so card height never shifts, and `entry.stale` dims the row + shows a `Badge` `variant="stale"`. `weight_percent` is each link's normalized share of total selection weight (0-100, active links sum to ~100 — `100` only for a lone link, NOT a per-link constant); `rtt_ms=0` and any valid `weight_percent` (incl. `0`/`100`) are shown as-is, never `--`.
- Ingest-stats panel (Live destination, #21): the SAME `getLinkTelemetry()` feed is also surfaced near the streaming status by `custom/IngestStats.svelte` (mounted in `LiveView` inside the `isStreaming` block). It is a read-only per-link table (`iface` / RTT / NAK / weight) with a totals footer — no new backend collector. Container carries `data-testid="ingest-stats"`; each row carries `data-iface` + `data-stale`; a stale link dims its row and shows a `Badge` `variant="stale"`. Empty/null feed keeps the panel mounted with a "waiting" line. i18n under `live.ingest.*` (10 locales). The per-link RTT-trend math (sparkline path + trend/degrade/health) lives in the pure, rune-free `custom/ingest-link-view.ts`; `createLinkViewCache()` memoizes each link's view keyed on its samples-buffer reference, so the SVG path is rebuilt only on a genuinely new sample — not on every component re-render (Task 19 perf, mirrors the `hud/` derivation split).
- "Coming soon" affordances [EXISTS]: still-deferred features (PiP, live audio codec change, mode-level fallback) surface a calm, informational `custom/ComingSoon.svelte` pill + roadmap tooltip — NEVER the amber/coral "disabled with reason" warning treatment, and NEVER a fake-interactive control. Each instance takes a `debtId` prop and renders `data-debt-id` into the DOM; copy comes from `live.comingSoon.*` (10 locales). Every `debtId` MUST point at an `open` entry in `docs/TECHNICAL_DEBT.md` — the call site carries a literal `data-debt-id="TD-…"` comment so `scripts/check-tech-debt.mjs` statically verifies the binding (the component's dynamic attribute is for the DOM/tests). The gate scans shipped source only — `*.test.*` / `*.spec.*` files are excluded. Live audio source switch (`TD-live-audio-switch`) and live audio delay (`TD-live-audio-delay`) are resolved (Task 26) — their `coming-soon` affordances are removed.
- Source-preference module [EXISTS]: `lib/streaming/source-preference.ts` owns the pre-start source preference logic — default selection, `localStorage` persistence key (`ceralive.sourcePreference`), and validation. `SourcePreference.svelte` is the UI surface; it reads/writes through this module only.
- Source summary [EXISTS]: `lib/streaming/sourceSummary.ts` derives a human-readable source summary string (e.g. `"USB Cam · Built-in Mic"`) from the active config for the Live header and HUD. Pure function, no side effects.
- Live audio switch gate [EXISTS]: `lib/streaming/liveAudioSwitch.ts` exports `isAudioLiveSwitchEnabled(caps)` — the single source of truth for whether the engine supports a live audio source switch. The Live picker calls this before dispatching `switchInput` for an `audio:*` id; `SourceSection` calls it to decide whether to render audio entries enabled or disabled. `TD-live-audio-switch` is resolved (Task 26) — the `coming-soon` affordance is removed from `InputPicker.svelte`.
- Streaming optimism [EXISTS]: `lib/rpc/streaming-optimism.svelte.ts` is an optimistic streaming state machine. It bridges the gap between `startStream` RPC dispatch and the first `is_streaming=true` push so the Live destination never flickers back to idle mid-start. Consumers read `getOptimisticIsStreaming()` instead of the raw `getIsStreaming()` during the transition window.
- Receiver-experience module [EXISTS]: `lib/streaming/receiver-experience.ts` is the pure, rune-free source of truth for the destination-first server dialog. Key exports: `deriveDestination(config)` → `'managed' | 'custom'`; `resolveReceiverKind(destination, protocol, server)` → `ReceiverKind`; `kindBadgeLabelKey(kind)` → i18n dot-path key; `buildServerSetConfig(draft, derived)` → the exact field set sent to `streaming.setConfig` (prunes undefined, enforces the lock-loop-safety invariant); `deriveServerReadiness(kind, linkCount)` → `ServerReadiness` union for the SRTLA bonded/single hint; `buildServerSummary(config, kind, linkCount, labels)` → human-readable server row string for the Live header. All are unit-tested in `receiver-experience.test.ts`.
- Managed ingest-slot auto-selection (T19) [EXISTS]: the platform-pushed ingest slots from T18 (backend `ingest-slots.ts`) reach the frontend via the `ingest.slots` broadcast (`subscriptions.svelte` → `getManagedIngestAccounts()`, `getSelectedIngestEndpoint()` from `config.selected_ingest_endpoint`). The pure decision lives in `receiver-experience.ts`: `autoSelectIngestSlot(accounts, selectedEndpointId)` → `{ kind: 'managed' | 'prompt' | 'custom' }` (one slot → silent; many → `default`, else last-used, else prompt; none → custom). `managedSlotLabel`/`findActiveSlot` resolve the active slot label; `buildManagedSlotConfig(account, latency)` builds the slot's `setConfig` payload (endpoint + stable `selected_ingest_endpoint`). The manual/custom endpoint is preserved and always available.
- ServerDialog destination-as-provider model [EXISTS, receiver-coherence v2]: `main/dialogs/ServerDialog.svelte` leads with `DestinationSection` (three tiles — CeraLive Cloud / BELABOX Cloud / Custom, `deriveDestinationChoice`), then `TransportRow` (SRTLA active; RIST/SRT coming-soon pills — no protocol radiogroup), then the endpoint surface: `RelayServerSelector` when the selected managed cloud is the active provider, an add-key prompt (`data-testid="destination-needs-key"`) that opens `CloudRemoteDialog` with the `provider` prop preselected when it is not, or `CustomEndpointForm` for Custom — then `LatencySection` (the single latency knob). The save path calls `buildServerSetConfig` (latency-only; clears a stale `selected_ingest_endpoint`) and iterates its output for the field-lock loop, then `streaming.setConfig` once. Platform-managed ingest slots (T19) still render `server/ServerIngestSlots.svelte` under the active managed cloud and save via `buildManagedSlotConfig`. Removed: `ProtocolSelector`, `TransportBadge`, `StreamTuningSection`, the provider picker, the manual-endpoint override, and the relay-staleness warnings. `CloudRemoteDialog` accepts an optional `provider` prop (preselect on open; wins over `config.remote_provider`) and no longer renders the obsolete `relay-provider-stale-warning`.
- HUD bar scope [EXISTS]: `HudBar.svelte` deliberately does NOT surface the server target. The Live header chip (`main/live/LiveHeader.svelte`) and the Live destination summary row own server-target display. Do not add server-target to the HUD.
- relay.validate mock seam [EXISTS]: `relay.validate` in `apps/backend/src/rpc/procedures/relay.procedure.ts` runs ordered stages (`input` → `protocol` → `endpoint` → `dns` → `probe`). The `dns` and `probe` stages are stubbed by the mock seam (`shouldUseMocks()` gate in `apps/backend/src/mocks/providers/relay.ts`) so tests can exercise the full pipeline without real DNS or UDP reachability. See `apps/backend/AGENTS.md` for the mock subsystem contract.
- Plain-SRT / RIST roadmap [EXISTS]: plain-SRT egress requires three layers (capability advertisement, real `srtAdapter`, `startStream` protocol branch). Full spec: [`../../docs/RECEIVER_MODEL.md`](../../docs/RECEIVER_MODEL.md). Tracked as `TD-plain-srt-egress` in [`../../docs/TECHNICAL_DEBT.md`](../../docs/TECHNICAL_DEBT.md). The `ServerDialog` reserved-SRT affordance carries `data-debt-id="TD-plain-srt-egress"` — do not remove it until all three layers land.
- E2E Testing: REQUIRED reading before writing E2E tests → [`tests/e2e/PLAYBOOK.md`](tests/e2e/PLAYBOOK.md)
- Accessibility gate [EXISTS]: `tests/e2e/a11y.spec.ts` (`@axe-core/playwright`) runs axe on the live/network/settings destinations and gates CI on `critical` + `serious` impact only. Pre-existing violations are baselined per-page in `tests/e2e/a11y-baseline.json` (a rule-id allowlist) so the gate fails only on a NEW critical/serious rule — never on day-one debt. The current baseline is `color-contrast` (the spectral `--link-*` ramp on small mono labels + dev-only nav tabs); fixing it is a design-system-wide change, out of the gate's scope. Refresh the baseline with `UPDATE_A11Y_BASELINE=1 bun run --filter frontend test:e2e -- a11y.spec.ts --project=desktop -g "axe gate"` (writes the allowlist + `test-results/task-7-a11y-baseline.json`, never fails); a normal run writes `test-results/task-7-a11y-gate.json`. The dedicated CI step is `Accessibility gate` in `build-check.yml`; the broad Functional E2E run grep-inverts `@a11y` to avoid double-booting.
- Skip-to-content + live telemetry [EXISTS]: `MainView.svelte` renders the skip link as the first focusable element (`sr-only focus:not-sr-only`, `href="#main-content"`) and `<main>` carries `id="main-content" tabindex="-1"` as its target. `HudBar.svelte` exposes a DEBOUNCED polite live region (`<span role="status" aria-live="polite" data-testid="hud-telemetry-status">`, `TELEMETRY_ANNOUNCE_DEBOUNCE_MS=1500`) announcing a concise `state · bitrate · link-count` summary — raw HUD values tick too fast to announce each. Exactly one `HudBar` mounts at a time (the MediaQuery `{#if}` in `MainView`), so there is no duplicate live region. Skip-link copy: `a11y.skipToContent` (all 10 locales).
- Async OS-operation optimism [EXISTS]: `lib/rpc/async-operation.svelte.ts` is the keyed status-domain transient layer for OS-mutating commands (WiFi connect/disconnect/forget/scan, mode switch, modem scan/configure, SIM PIN/PUK, hotspot start/stop/configure, SSH, software-update START). It is a SIBLING of `streaming-optimism.svelte.ts` and `field-sync-state.svelte.ts` — NOT a replacement. Use `osCommand()` (same module) for every in-scope OS dispatch; it owns the re-entry guard, the `beginOperation`/`failOperation`/`confirmOperation` lifecycle, and the single failure-feedback path. When to use: status-domain OS commands that are fire-and-forget (confirm via authoritative broadcast) or synchronous (use `confirmOnResolve`). When NOT to use: config-field writes (use `field-sync-state`), streaming start/stop (use `streaming-optimism`), netif enable/disable (use dirty-registry/BondToggle), power/reboot (direct raw-rpc). G4 status-field exclusion applies: status fields (`ssh`, `wifi`, `modems`, …) must NOT enter the dirty-registry — the async-operation transient layer is the correct approach for them. `initAsyncOperations()` MUST run at startup (in `main.ts`, beside `initSubscriptions()` and `initFieldSyncState()`).
- Additional shadcn-svelte component source: **shadcn-svelte-extras.com** (`https://www.shadcn-svelte-extras.com/`) provides additional components styled to match shadcn-svelte. Its `llms.txt` (`https://www.shadcn-svelte-extras.com/llms.txt`) and per-component `llms.txt` (e.g. `/components/<name>/llms.txt`) are the AI-readable references. Imported components still live in `lib/components/custom/` (NOT the CLI-managed `ui/`). Adopting them is optional — no new dependency is added by recording this source.
- Idle ingest empty-state + link-telemetry skeleton [EXISTS]: `LiveView.svelte` renders a calm idle empty-state (`data-testid="ingest-idle-empty"`, copy `live.ingest.idleTitle/idleHint`) in the ingest area when a server is configured but the stream is idle with no session — it points to Network and shows NO telemetry values (Live-Data Discipline). `custom/LinkTelemetry.svelte` takes a `loading` prop: while the `status.linkTelemetry` feed is `undefined` (not yet arrived, distinct from delivered-but-empty `null`), each value cell renders a `Skeleton` inside its `<dd>` (keeping the `<dl>` valid) instead of a `--` flicker; `network/BondedLinksSection.svelte` derives `loading = linkTelemetry === undefined`.
- Store-and-forward buffering indicator [EXISTS]: `lib/stores/buffering.svelte.ts` ingests the additive `status.buffering` payload (cerastream Task 32, rides the engine `status` event bus — NOT device-stats) via the pure `parseBufferingStatus`; the runes store is a global-singleton (dual-URL guard, like `stream-health.svelte.ts`) and starts `null` so the indicator is **capability-gated** — an engine that never sends `buffering` renders nothing. `lib/components/custom/BufferingIndicator.svelte` is the prop-driven calm pill (muted treatment, gentle pulse — never error/warning red, `data-testid="buffering-indicator"`); it renders only when `state.active === true` and shows `formatBytes` spooled bytes. `HudBar.svelte` mounts it beside the stream-health indicator; `subscriptions.svelte.ts` feeds it from the `status` case. Copy: `hud.buffering*` (10 locales). Tests: `buffering.test.ts` + `BufferingIndicator.test.ts`.
- HUD accessibility [EXISTS]: `HudBar.svelte` gives each telemetry badge (bitrate, per-link signal, SoC temp/voltage/current) an `aria-label` (`role="img"`) carrying the current value AND its staleness state, so assistive tech reads the same degradation the dimming conveys. A SECOND debounced polite region (`data-testid="hud-transition-status"`) announces only critical transitions — stream started/stopped, a bonded link dropping — edge-detected against the prior render (kept separate from the per-tick `hud-telemetry-status` summary). No visual/layout change; the 5-signal contract is untouched. Copy: `hud.announceStreamStarted/Stopped`, `hud.announceLinkDropped`. The HUD a11y assertions live in `tests/e2e/a11y.spec.ts` (the dedicated CI a11y gate).
- Long-running dialog feedback [EXISTS]: `dialogs/LogsDialog.svelte` tracks a per-log `downloading`/`failed` state — the row button shows an in-flight spinner (`advanced.downloading`) and a failed download renders a calm inline amber retry band (`data-testid="log-download-error"`, `advanced.downloadFailed` + `advanced.retryDownload`) that re-invokes the same download, instead of a bare toast. `dialogs/WifiSelectorDialog.svelte`/`WifiNetworkList.svelte` already disable the Scan button + show `wifi-scan-status` while a scan op is `pending` (async-operation phase). Both use EXISTING async-op state — no new backend events. Covered by `LogsDialog.test.ts` + `WifiNetworkList.test.ts`.
- Production-readiness signals [EXISTS]: `helpers/disk-warning.ts` (`isDiskLow`) DERIVES a low-disk warning from the EXISTING device-stats `disk` signal (NOT a sixth signal) at a FIXED `< 512 MiB` free floor (strict `<`: 512 MiB does not warn, 511 does); `custom/LowDiskBanner.svelte` renders a calm `role="status"` band in `SettingsView.svelte` that opens the Logs dialog. `dialogs/SimUnlockDialog.svelte` surfaces the remaining PUK retries (`sim-puk-attempts`, from the existing SIM status `pukRetries`), warns at ≤ 2, and disables submit at 0 (`pukExhausted`). Copy: `settings.deviceStats.lowDiskTitle/lowDiskBody/lowDiskAction`. Boundary + gating covered by `disk-warning.test.ts` + `SimUnlockDialog.test.ts`.

## CONNECTION RELIABILITY

### Connection-ready gate

`BootShell.svelte` holds the app in a loading state until the first full snapshot arrives from the backend. The gate flips once `subscriptions.svelte.ts` processes the post-login initial-state push. No destination view renders before this flip — prevents flash-of-stale-data on startup.

### Infinite-retry with jitter backoff

The transport (`lib/rpc/reconnect.ts`) never stops retrying. Backoff formula: `min(~30s, base · 2^n) · (1 + random(-0.3, +0.3))` — jitter on every step, not only when capped. `MAX_RECONNECT_ATTEMPTS` is a UI threshold only: once exceeded, `connection-ux.svelte.ts` flips to the "failed" banner, but the transport keeps dialing. Failed-UI state and transport state are independent state machines.

### Seq drop-stale

`subscriptions.svelte.ts` maintains a `Map<string, number>` of the last seen `seq` per event type. Any incoming message whose `seq` is not strictly greater than the last seen value is silently dropped. Gaps are fine — only strict monotonic-greater is required, not +1. The map resets on reconnect so a server restart (seq back to 0) is always accepted.

### Applied-state acknowledgement

After any RPC setter resolves, the frontend reads `result.applied` (not the client's intended value) and releases field locks to that value. This ensures the UI reflects what the backend actually wrote after clamping and validation, not what the user typed.

### Per-modem state merge

The backend broadcasts modem updates incrementally: a full snapshot carries every field, but targeted broadcasts (`configure`, network-scan completion) send only the changed modem(s), and for those only a subset of fields (e.g. just `available_networks`, or status-only entries for unchanged modems). `subscriptions.svelte.ts` therefore merges `modems`/`status.modems` payloads **field-by-field per modem id** (`mergeModemList`), never replacing the whole map — a wholesale replace would wipe the untouched fields (`status`, `config`, `name`) and flip a live modem to a spurious no-SIM state until the next full snapshot.

See [`docs/FRONTEND_CONNECTION_PATTERNS.md`](../../docs/FRONTEND_CONNECTION_PATTERNS.md) for the full connection-pattern reference.

## ANTI-PATTERNS

- No direct backend calls — everything through `rpc.*` or `rpcClient.onMessage`.
- No manual UI primitive files in `lib/components/ui/` — use the shadcn-svelte CLI.
- No `$:` reactive statements — Svelte 5 runes only.
- No hardcoded socket URL — call `getSocketUrl()` from `$lib/env`. It derives the RPC WebSocket URL from `window.location` in production (origin host:port, scheme from protocol) and ignores `VITE_SOCKET_*` there; those overrides apply to dev only. Never reconstruct the URL from `hostname` + a port literal.
- Don't read connection state from `lib/stores/offline-state.svelte` in authed components — use `subscriptions.svelte` `getIsConnected()`/`getConnectionState()` (survives socket replacement on reconnect). `offline-state` is only reliable for the pre-auth strip.
- Don't add inline validation literals to dialogs — import from `ValidationAdapter.ts`.
- Don't release field locks to the client's intended value — always use `result.applied` from the RPC response.
- Don't add custom endpoint fields inline in `ServerDialog` — use `CustomEndpointForm.svelte` in `main/dialogs/server/` (fields driven by `receiverKindManifest(kind)`).
- Don't derive receiver kind or build the `setConfig` field set inline in `ServerDialog` — use `resolveReceiverKind` and `buildServerSetConfig` from `lib/streaming/receiver-experience.ts`.
- Don't re-add a `websocket-store` wrapper, a second `rpcClient.onMessage` owner, or a parallel auth-mutation path — `subscriptions.svelte.ts` and `auth-status.svelte.ts` are the only two allowed owners; the CI grep gate blocks the module name from reappearing.
- Don't re-derive the "gateway inactive" (rtmp/srt requires-gateway) disabled-with-reason rule inline on a new surface — route through `lib/streaming/pipelineAvailability.ts`.
