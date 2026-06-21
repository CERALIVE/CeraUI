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
│   │   │   └── server/          # DestinationSection · CustomEndpointForm · TransportBadge (presentational)
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
│   │   │                      #   InfoPopover.svelte [EXISTS] (lightweight info popover, question-mark trigger)
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
pnpm dev / build / check / test          # Vite :5173 / dist/ / svelte-check / vitest
# Linting is Biome-only, run from the workspace root: `biome check .` (or `pnpm lint`)
```

## CONVENTIONS

- Stores: Svelte 5 runes only (`$state`, `$derived`, `$effect`) — files named `*.svelte.ts`.
- UI primitives: extend via shadcn-svelte CLI (`pnpm dlx shadcn-svelte@latest add <component>`), not by hand.
- Custom components (not shadcn-managed) live in `lib/components/custom/`, not `lib/components/ui/`.
- Mock scenarios: `MOCK_SCENARIO` env var. Runtime switching via `rpc.streaming.setMockHardware`.
- Design: read `../../.impeccable.md` before touching visuals. The Ground Control identity (phosphor lime primary, warm graphite background) is defined in `app.css` tokens — trust the committed tokens, not older docs.
- i18n: `@ceraui/i18n` workspace package — all user strings via `LL.*`. Only the base `en` locale uses typed params `{param:type}`; the 9 non-EN locales use bare `{param}`.
- Validation bounds: import from `ValidationAdapter.ts` (which sources from `@ceraui/rpc/schemas` constants). No inline numeric literals in dialog components.
- Touch/kiosk: `data-layout-mode` attribute on `<html>` drives CSS token scaling. Read `docs/TOUCHSCREEN.md`.
- Live-data feedback: dim aged values via `getStalenessState`; mark a single aged interface with `custom/Badge.svelte` `variant="stale"` (fed by `hud.staleInterfaces`); show in-flight actions with `custom/InlineSpinner.svelte` (role=status). All three are CSS-animation/transition based, so the e-ink freeze (`app.css` `[data-display='eink']`) stills them automatically — never JS-drive these animations.
- Unified badge component: `custom/Badge.svelte` is the single variant-driven badge for all pill/marker needs. `variant="speed"` renders the throughput value (font-mono, signal-tier colour, dims when `stale`, carries `data-live-value`); `variant="stale"` renders the per-interface staleness marker (warning pill + Clock glyph + i18n copy, carries `data-stale-interface`); `variant="success" | "warning" | "error" | "info" | "neutral"` renders a semantic status pill (carries `data-status-badge`, passes `...rest` through, optional `icon`/`label`/`children` snippets, `size="sm" | "micro"`) with an unknown value falling back to `neutral`. It replaced the former `SpeedBadge` / `StaleBadge` / `StatusBadge` components (folded together with no visual change). Every variant is static/CSS-only, so all are e-ink-freeze safe.
- Per-field sync state: `rpc/field-sync-state.svelte.ts` is a lifecycle machine (`idle → pending → applying → applied | failed`) layered ON TOP of the dirty-registry — it does NOT replace it. It composes the existing `markPending` / `onRpcResolved` / `onRpcAppliedReactive` lock contract (so a field locked here is the same lock the ingestion path guards) and adds the phase. Consumers call `beginFieldSync` → `markFieldApplying` → `markFieldApplied(field, result.applied)` / `markFieldFailed(field, authoritative)`; read the phase with `getFieldState(field)` and render `custom/FieldSyncIndicator.svelte` (the InlineSpinner during `applying`). Contracts: `applied` releases to `result.applied` (never the typed value); a stuck in-flight field is TTL-released after `FIELD_LOCK_TTL_MS`; status fields (`is_streaming`, `wifi`, …) are refused (G4). `initFieldSyncState()` MUST run at startup (in `main.ts`, beside `initSubscriptions()`) — the store's reactive root must not be first created mid-render.
- Mode-preset-led EncoderDialog (Task 7): `main/dialogs/EncoderDialog.svelte` LEADS with the shared mode-preset catalog (`@ceraui/rpc` `CANONICAL_PRESETS`) — a card grid; the granular resolution/framerate/codec/bitrate controls live under an "Advanced / Custom" `<details>` expander. The preset→draft mapping is the pure, unit-tested `lib/streaming/modePresets.ts` (`presetToDraft` clamps `bitrateDefault` to the board window via `clampBitrateToBounds`; `presetViews(offered)` tags each card supported/disabled-with-reason via `presetMatchesOffered` — unsupported presets render DISABLED with a reason tooltip, never hidden; `findMatchingPresetId` highlights a matching preset on seed). Codec is NOT a persisted draft field (the `setConfig` contract has no video-codec key) — it only drives the active-codec highlight + preset matching. The active preset is derived (`activePresetId`): any preset-defined Advanced edit (or a source change that makes the preset unsupported) drops the surface to "Custom" automatically. The apply drives the Task-5 field-sync machine on a pseudo-field (`encoderPreset`) so it reads applying → applied/failed via `FieldSyncIndicator`. `PreviewCanvas` (#72) stays mounted. New i18n under `live.presets.*` (10 locales).
- Per-link srtla telemetry (RTT/NAK/weight): `getLinkTelemetry()` (subscriptions, fed by the `status.linkTelemetry` push) → `NetworkView` → `BondedLinksSection`, rendered per card by `custom/LinkTelemetry.svelte`. Cards join telemetry by `link.id === entry.iface`; the three values always render (`--` when absent) so card height never shifts, and `entry.stale` dims the row + shows a `Badge` `variant="stale"`. `rtt_ms=0` / `weight_percent=100` are valid sender constants — shown as-is, never `--`.
- Ingest-stats panel (Live destination, #21): the SAME `getLinkTelemetry()` feed is also surfaced near the streaming status by `custom/IngestStats.svelte` (mounted in `LiveView` inside the `isStreaming` block). It is a read-only per-link table (`iface` / RTT / NAK / weight) with a totals footer — no new backend collector. Container carries `data-testid="ingest-stats"`; each row carries `data-iface` + `data-stale`; a stale link dims its row and shows a `Badge` `variant="stale"`. Empty/null feed keeps the panel mounted with a "waiting" line. i18n under `live.ingest.*` (10 locales). The per-link RTT-trend math (sparkline path + trend/degrade/health) lives in the pure, rune-free `custom/ingest-link-view.ts`; `createLinkViewCache()` memoizes each link's view keyed on its samples-buffer reference, so the SVG path is rebuilt only on a genuinely new sample — not on every component re-render (Task 19 perf, mirrors the `hud/` derivation split).
- "Coming soon" affordances [EXISTS]: still-deferred features (PiP, live audio codec change, mode-level fallback) surface a calm, informational `custom/ComingSoon.svelte` pill + roadmap tooltip — NEVER the amber/coral "disabled with reason" warning treatment, and NEVER a fake-interactive control. Each instance takes a `debtId` prop and renders `data-debt-id` into the DOM; copy comes from `live.comingSoon.*` (10 locales). Every `debtId` MUST point at an `open` entry in `docs/TECHNICAL_DEBT.md` — the call site carries a literal `data-debt-id="TD-…"` comment so `scripts/check-tech-debt.mjs` statically verifies the binding (the component's dynamic attribute is for the DOM/tests). The gate scans shipped source only — `*.test.*` / `*.spec.*` files are excluded. Live audio source switch (`TD-live-audio-switch`) and live audio delay (`TD-live-audio-delay`) are resolved (Task 26) — their `coming-soon` affordances are removed.
- Source-preference module [EXISTS]: `lib/streaming/source-preference.ts` owns the pre-start source preference logic — default selection, `localStorage` persistence key (`ceralive.sourcePreference`), and validation. `SourcePreference.svelte` is the UI surface; it reads/writes through this module only.
- Source summary [EXISTS]: `lib/streaming/sourceSummary.ts` derives a human-readable source summary string (e.g. `"USB Cam · Built-in Mic"`) from the active config for the Live header and HUD. Pure function, no side effects.
- Live audio switch gate [EXISTS]: `lib/streaming/liveAudioSwitch.ts` exports `isAudioLiveSwitchEnabled(caps)` — the single source of truth for whether the engine supports a live audio source switch. The Live picker calls this before dispatching `switchInput` for an `audio:*` id; `SourceSection` calls it to decide whether to render audio entries enabled or disabled. `TD-live-audio-switch` is resolved (Task 26) — the `coming-soon` affordance is removed from `InputPicker.svelte`.
- Streaming optimism [EXISTS]: `lib/rpc/streaming-optimism.svelte.ts` is an optimistic streaming state machine. It bridges the gap between `startStream` RPC dispatch and the first `is_streaming=true` push so the Live destination never flickers back to idle mid-start. Consumers read `getOptimisticIsStreaming()` instead of the raw `getIsStreaming()` during the transition window.
- Receiver-experience module [EXISTS]: `lib/streaming/receiver-experience.ts` is the pure, rune-free source of truth for the destination-first server dialog. Key exports: `deriveDestination(config)` → `'managed' | 'custom'`; `resolveReceiverKind(destination, protocol, server)` → `ReceiverKind`; `kindBadgeLabelKey(kind)` → i18n dot-path key; `buildServerSetConfig(draft, derived)` → the exact field set sent to `streaming.setConfig` (prunes undefined, enforces the lock-loop-safety invariant); `deriveServerReadiness(kind, linkCount)` → `ServerReadiness` union for the SRTLA bonded/single hint; `buildServerSummary(config, kind, linkCount, labels)` → human-readable server row string for the Live header. All are unit-tested in `receiver-experience.test.ts`.
- ServerDialog destination-first model [EXISTS]: `main/dialogs/ServerDialog.svelte` leads with `DestinationSection` (managed vs custom radiogroup), then shows `RelayServerSelector` (managed path) or `CustomEndpointForm` (custom path), then `TransportBadge` (transport chip + Advanced disclosure). The save path calls `buildServerSetConfig` and iterates its output for the field-lock loop, then calls `streaming.setConfig` once.
- ServerDialog provider-sync [EXISTS]: `DestinationSection` labels the managed option using `config.remote_provider` (set by `CloudRemoteDialog`). If the operator switches provider without re-opening `ServerDialog`, the persisted `relay_server` may reference a server from the previous provider's relay list. This is a known limitation — the operator must re-select a server after switching provider. Do not auto-clear `relay_server` on provider change without a deliberate UX decision.
- HUD bar scope [EXISTS]: `HudBar.svelte` deliberately does NOT surface the server target. The Live header chip (`main/live/LiveHeader.svelte`) and the Live destination summary row own server-target display. Do not add server-target to the HUD.
- relay.validate mock seam [EXISTS]: `relay.validate` in `apps/backend/src/rpc/procedures/relay.procedure.ts` runs ordered stages (`input` → `protocol` → `endpoint` → `dns` → `probe`). The `dns` and `probe` stages are stubbed by the mock seam (`shouldUseMocks()` gate in `apps/backend/src/mocks/providers/relay.ts`) so tests can exercise the full pipeline without real DNS or UDP reachability. See `apps/backend/AGENTS.md` for the mock subsystem contract.
- Plain-SRT / RIST roadmap [EXISTS]: plain-SRT egress requires three layers (capability advertisement, real `srtAdapter`, `startStream` protocol branch). Full spec: [`../../docs/RECEIVER_MODEL.md`](../../docs/RECEIVER_MODEL.md). Tracked as `TD-plain-srt-egress` in [`../../docs/TECHNICAL_DEBT.md`](../../docs/TECHNICAL_DEBT.md). The `ServerDialog` reserved-SRT affordance carries `data-debt-id="TD-plain-srt-egress"` — do not remove it until all three layers land.
- E2E Testing: REQUIRED reading before writing E2E tests → [`tests/e2e/PLAYBOOK.md`](tests/e2e/PLAYBOOK.md)
- Accessibility gate [EXISTS]: `tests/e2e/a11y.spec.ts` (`@axe-core/playwright`) runs axe on the live/network/settings destinations and gates CI on `critical` + `serious` impact only. Pre-existing violations are baselined per-page in `tests/e2e/a11y-baseline.json` (a rule-id allowlist) so the gate fails only on a NEW critical/serious rule — never on day-one debt. The current baseline is `color-contrast` (the spectral `--link-*` ramp on small mono labels + dev-only nav tabs); fixing it is a design-system-wide change, out of the gate's scope. Refresh the baseline with `UPDATE_A11Y_BASELINE=1 pnpm --filter frontend exec playwright test a11y.spec.ts --project=desktop -g "axe gate"` (writes the allowlist + `test-results/task-7-a11y-baseline.json`, never fails); a normal run writes `test-results/task-7-a11y-gate.json`. The dedicated CI step is `Accessibility gate` in `build-check.yml`; the broad Functional E2E run grep-inverts `@a11y` to avoid double-booting.
- Skip-to-content + live telemetry [EXISTS]: `MainView.svelte` renders the skip link as the first focusable element (`sr-only focus:not-sr-only`, `href="#main-content"`) and `<main>` carries `id="main-content" tabindex="-1"` as its target. `HudBar.svelte` exposes a DEBOUNCED polite live region (`<span role="status" aria-live="polite" data-testid="hud-telemetry-status">`, `TELEMETRY_ANNOUNCE_DEBOUNCE_MS=1500`) announcing a concise `state · bitrate · link-count` summary — raw HUD values tick too fast to announce each. Exactly one `HudBar` mounts at a time (the MediaQuery `{#if}` in `MainView`), so there is no duplicate live region. Skip-link copy: `a11y.skipToContent` (all 10 locales).
- Async OS-operation optimism [EXISTS]: `lib/rpc/async-operation.svelte.ts` is the keyed status-domain transient layer for OS-mutating commands (WiFi connect/disconnect/forget/scan, mode switch, modem scan/configure, SIM PIN/PUK, hotspot start/stop/configure, SSH, software-update START). It is a SIBLING of `streaming-optimism.svelte.ts` and `field-sync-state.svelte.ts` — NOT a replacement. Use `osCommand()` (same module) for every in-scope OS dispatch; it owns the re-entry guard, the `beginOperation`/`failOperation`/`confirmOperation` lifecycle, and the single failure-feedback path. When to use: status-domain OS commands that are fire-and-forget (confirm via authoritative broadcast) or synchronous (use `confirmOnResolve`). When NOT to use: config-field writes (use `field-sync-state`), streaming start/stop (use `streaming-optimism`), netif enable/disable (use dirty-registry/BondToggle), power/reboot (direct raw-rpc). G4 status-field exclusion applies: status fields (`ssh`, `wifi`, `modems`, …) must NOT enter the dirty-registry — the async-operation transient layer is the correct approach for them. `initAsyncOperations()` MUST run at startup (in `main.ts`, beside `initSubscriptions()` and `initFieldSyncState()`).
- Additional shadcn-svelte component source: **shadcn-svelte-extras.com** (`https://www.shadcn-svelte-extras.com/`) provides additional components styled to match shadcn-svelte. Its `llms.txt` (`https://www.shadcn-svelte-extras.com/llms.txt`) and per-component `llms.txt` (e.g. `/components/<name>/llms.txt`) are the AI-readable references. Imported components still live in `lib/components/custom/` (NOT the CLI-managed `ui/`). Adopting them is optional — no new dependency is added by recording this source.

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
