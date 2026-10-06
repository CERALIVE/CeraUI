<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## STRUCTURE

The live cockpit consumes an authoritative session-switch namespace, distinct from
device discovery. Both consumers pin published cerastream 2026.9.11, schema 0.21.0.
Admission, the legacy two-capture fallback, explicit absent/empty notices,
and the outstanding U6 colour drill are in [LIVE-SESSION-SWITCHING](../LIVE-SESSION-SWITCHING.md).

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
│   │   │   │   └── server/            # ServerDialog sub-components: DestinationSection, TransportRow, LatencySection, RelayServerSelector, CustomEndpointForm, ServerIngestSlots
│   │       │   └── tabs/                  # Legacy tab views (Streaming, Network, General, Advanced, DevTools)
│   │       └── lib/
│   │           ├── components/
│   │           │   ├── dialogs/           # AppDialog.svelte (shared chrome) + lazyDialog()/LazyDialog registry — config dialogs load as separate chunks on first open
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
│           │           ├── device-stats.ts        # 5-signal device stats (S1 lock)
│           ├── encoder-load.ts        # per-core VEPU580 load; probes BOTH kernel realities
│           │   ├── device-detection.ts    # isRealDevice() — gates all add-on ops
│           │   ├── kiosk.ts               # Kiosk DC-2 state machine; toggle runs the cog-display add-on via the manager
│           │   ├── software-updates.ts    # apt/size parsing; APT_PACKAGE_NAME_RE
│           │   ├── software-update-service.ts # transient-unit lifecycle + retained exit status
│           │   └── software-update-process.ts # durable progress polling + restart reattachment
│           └── modules/addons/
│               └── manager.ts             # Add-on enable/disable state machine (T28)
├── packages/
│   ├── rpc/          # Shared oRPC schemas (workspace:*) — validation constants live here
│   │   └── src/schemas/
│   │       ├── addons.schema.ts           # AddonDescriptorSchema + AddonStateSchema (T21)
│   │       └── system.schema.ts           # KIOSK_UNAVAILABLE_ERROR + system schemas
│   ├── i18n/         # Paraglide runtime + hand-editable JSON catalogs, 10 languages (workspace:*)
│   └── srtla-send/   # @ceraui/srtla-send — srtla_send args builder + telemetry reader (workspace:*, PRIVATE, never published)
├── scripts/build/    # build-debian-package.sh — produces ceraui .deb
├── docs/             # ARCHITECTURE, BUILD_PIPELINE, APT_VERSION_CONTROL, BRANDING, TOUCHSCREEN, LIFECYCLE-INDICATORS
└── .impeccable.md    # UI/UX design constraints — read before touching frontend visuals
```

