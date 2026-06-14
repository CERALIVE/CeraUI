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
│   │   ├── ServerDialog.svelte  # logic container; splits into server/ sub-components (Task 14)
│   │   │   └── server/          # RelayServerSelector + ManualEndpointForm (presentational)
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
│   │   │                      #   simple-alert-dialog, mode-toggle, locale-selector, mobile-link, pwa/
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
- Live-data feedback: dim aged values via `getStalenessState`; mark a single aged interface with `custom/StaleBadge.svelte` (fed by `hud.staleInterfaces`); show in-flight actions with `custom/InlineSpinner.svelte` (role=status). All three are CSS-animation/transition based, so the e-ink freeze (`app.css` `[data-display='eink']`) stills them automatically — never JS-drive these animations.
- Per-link srtla telemetry (RTT/NAK/weight): `getLinkTelemetry()` (subscriptions, fed by the `status.linkTelemetry` push) → `NetworkView` → `BondedLinksSection`, rendered per card by `custom/LinkTelemetry.svelte`. Cards join telemetry by `link.id === entry.iface`; the three values always render (`--` when absent) so card height never shifts, and `entry.stale` dims the row + shows a `StaleBadge`. `rtt_ms=0` / `weight_percent=100` are valid sender constants — shown as-is, never `--`.
- Ingest-stats panel (Live destination, #21): the SAME `getLinkTelemetry()` feed is also surfaced near the streaming status by `custom/IngestStats.svelte` (mounted in `LiveView` inside the `isStreaming` block). It is a read-only per-link table (`iface` / RTT / NAK / weight) with a totals footer — no new backend collector. Container carries `data-testid="ingest-stats"`; each row carries `data-iface` + `data-stale`; a stale link dims its row and shows a `StaleBadge`. Empty/null feed keeps the panel mounted with a "waiting" line. i18n under `live.ingest.*` (10 locales). The per-link RTT-trend math (sparkline path + trend/degrade/health) lives in the pure, rune-free `custom/ingest-link-view.ts`; `createLinkViewCache()` memoizes each link's view keyed on its samples-buffer reference, so the SVG path is rebuilt only on a genuinely new sample — not on every component re-render (Task 19 perf, mirrors the `hud/` derivation split).
- E2E Testing: REQUIRED reading before writing E2E tests → [`tests/e2e/PLAYBOOK.md`](tests/e2e/PLAYBOOK.md)

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
