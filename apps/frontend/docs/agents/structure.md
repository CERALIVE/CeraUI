<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## STRUCTURE

```
src/
├── main.ts / App.svelte      # entry: initSubscriptions(), auth gate, Layout, layout-mode effect
├── main/
│   ├── LiveView.svelte        # Live destination: switches IdleCockpit/LiveCockpit on the optimistic streaming edge
│   ├── live/                  # Device-first Live cockpit split [EXISTS]:
│   │   │                      #   StreamSetupChain.svelte (readiness + config rows + Start, one always-visible
│   │   │                      #     3-row "Stream setup" card — no collapse, no ready bar; mounted in IdleCockpit)
│   │   │                      #   IdleCockpit.svelte (SourceSection → StreamSetupChain → Preview disclosure → Roadmap disclosure)
│   │   │                      #   LiveCockpit.svelte (preview disclosure → telemetry strip → bitrate adjuster → IngestStats → Stop)
│   │   │                      #   PreviewDisclosure.svelte (the preview <details>; mounted by BOTH cockpits)
│   │   │                      #   LiveHeader.svelte (title + live-state chip only, demoted)
│   │   │                      #   StreamSettingsCard.svelte / OnboardingChecklist.svelte / ServerReadiness.svelte /
│   │   │                      #     GoLiveCard.svelte — UNMOUNTED migration shims, kept-not-deleted
│   │   │                      #     (`TD-unmounted-source-shims`)
│   ├── NetworkView.svelte     # Network destination: bonded links, WiFi, modems, Ethernet, hotspot, Bluetooth
│   │   └── network/CollisionBands.svelte  # same-subnet info band + policy-route warning band [EXISTS]
│   │   └── network/BondedLinksSection.svelte  # SOLE owner of live per-link telemetry (RTT/NAK/weight) [EXISTS]
│   │   └── network/BluetoothSection.svelte  # BlueZ card: pessimistic enable, scan, pair/trust/forget/connect [EXISTS]
│   ├── SettingsView.svelte    # Settings destination: grouped config entry points (all via dialogs)
│   ├── HudBar.svelte          # Persistent HUD bar — bitrate, per-link signals, SoC telemetry, tap-to-expand Sheet
│   ├── HudRegion.svelte       # Responsive HUD mount (desktop top / mobile bottom dock)
│   ├── DisconnectedBanner.svelte  # Reconnect/reboot/session-expiry banner (authed branch only)
│   ├── notifications/         # PersistentNotices.svelte — the IN-FLOW band every persistent
│   │                          #   notice renders in (never the toast overlay);
│   │                          #   NotificationsPanel.svelte — header bell + unread badge,
│   │                          #   AppDialog listing notifications.getPersistent() with per-item dismiss;
│   │                          #   notification-presentation.ts — the icon vocabulary + dismiss both share
│   ├── dialogs/               # 15 focused config dialogs, all compose AppDialog:
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
│   │   ├── VersionsDialog.svelte
│   │   └── DeviceHealthDialog.svelte  # thin AppDialog shell
│   │       └── device-health/DeviceHealthPanel.svelte  # the instrument (mounts only while open)
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
│   │   ├── auth-status.svelte.ts  # SOLE auth-mutation/persistence path (ingestAuth/authenticate/createPassword) —
│   │   │                          #   websocket-store.svelte.ts is DELETED; do not re-add it
│   │   ├── notifications.svelte.ts # Active notifications; getActive() feeds the toast host
│   │   │                          #   (TRANSIENT entries only), getPersistent() feeds both
│   │   │                          #   PersistentNotices and NotificationsPanel
│   │   ├── layout-mode.svelte.ts  # Touch/kiosk layout flag ($persist "layout-mode")
│   │   └── persist-runtime.ts     # THE $persist runtime — aliased over the package's
│   │                              #   (vite.persist.ts) so its 11 unused serializer
│   │                              #   presets never enter the graph; see ANTI-PATTERNS
│   ├── components/
│   │   ├── dialogs/           # AppDialog.svelte (shared chrome) + lazyDialog()/LazyDialog registry — config dialogs load as separate chunks on first open (see CONVENTIONS below)
│   │   │                      #   lazy-dialog.svelte.ts + LazyDialog.svelte + LazyDialogFallback.svelte
│   │   │                      #   — the async registry that keeps every config dialog in its own chunk
│   │   │                      #   desktop: Dialog; mobile: Sheet (via MediaQuery from svelte/reactivity)
│   │   ├── custom/            # Custom components (NOT shadcn-managed):
│   │   │                      #   simple-alert-dialog, mode-toggle, locale-selector, mobile-link, pwa/,
│   │   │                      #   EncoderStatus.svelte [EXISTS] (the unified dual-encoder widget,
│   │   │                      #     density panel|inline — replaced EncoderCoreLanes.svelte),
│   │   │                      #   ComingSoon.svelte [EXISTS] (calm roadmap pill + tooltip, data-debt-id bound),
│   │   │                      #   SourceSection.svelte [EXISTS] (unified device-first source list — owns the
│   │   │                      #     config.source write itself + the sole audio-config surface, no reorder UI
│   │   │                      #     (removed), selected-row-only network publish instructions),
│   │   │                      #   InfoPopover.svelte [EXISTS] (lightweight info popover, question-mark trigger),
│   │   │                      #   NetworkIngestSection.svelte — UNMOUNTED migration shim, kept-not-deleted
│   │   │                      #     (`TD-unmounted-source-shims`); rows absorbed into SourceSection
│   │   ├── streaming/         # ValidationAdapter.ts — FE constraint adapter (imports from @ceraui/rpc/schemas)
│   │   └── ui/                # shadcn-svelte primitives (bits-ui v2.19.0) — CLI-managed, do not hand-edit
│   └── env/ lib/helpers/ lib/config/ lib/types/
```

