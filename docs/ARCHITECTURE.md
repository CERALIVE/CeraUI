# CeraUI Architecture

## Components

- **Frontend (Svelte 5 PWA)**: Browser UI with 3 primary destinations. Talks to backend via WebSocket/RPC. Served as static files by the backend.
- **Backend (Bun/TypeScript)**: Orchestrates ceracoder, srtla, network/modem, relays RPC events. Serves frontend static bundle.
- **ceracoder**: Runs GStreamer pipeline internally (capture, encode, mux) and sends SRT.
- **srtla**: Splits SRT packets across multiple interfaces (bonding).
- **srtla_rec**: Reassembles bonded streams on the server.
- **srt-live-transmit**: Relays to the final consumer (OBS/Player/CDN).

## System Flow (Frontend → Backend → Encoder)

```
Browser (CeraUI Frontend)
    |
    | WebSocket / RPC
    v
Backend (Bun/TypeScript)
    |
    | spawn / signal / configure
    v
ceracoder
    |
    | SRT (localhost)
    v
srtla (sender)
    |
    +-- Modem1 (4G/5G)
    +-- Modem2 (4G/5G)
    +-- WiFi / Ethernet
          |
          v
       Internet
```

## Frontend Information Architecture

The frontend is a single-page PWA with **3 primary destinations** (plus a dev-only DevTools view):

| Destination | View file | Purpose |
|-------------|-----------|---------|
| **Live** | `main/LiveView.svelte` | Streaming control: start/stop, encoder/audio/server config, bitrate hot-adjust, active telemetry |
| **Network** | `main/NetworkView.svelte` | Connectivity: bonded links overview, WiFi, cellular modems, Ethernet, hotspot |
| **Settings** | `main/SettingsView.svelte` | System/device config — all actions open focused dialogs; no inline forms |
| DevTools | `main/tabs/DevTools.svelte` | Dev-only (runtime-gated, not tree-shaken) |

### Persistent HUD Bar

`main/HudBar.svelte` mounts persistently across all destinations (above content on desktop, docked at the bottom on mobile). It shows live bitrate, per-link signal indicators, and SoC telemetry. Tapping/clicking expands a Sheet with full detail. State is derived from `lib/stores/hud.svelte.ts`.

### Shared Dialog Framework

All configuration flows use `lib/components/dialogs/AppDialog.svelte` — a responsive chrome that renders as a centered Dialog on desktop and a bottom Sheet on mobile (via `MediaQuery` from `svelte/reactivity`). The 14 focused dialogs in `main/dialogs/` compose on this framework:

`EncoderDialog`, `AudioDialog`, `ServerDialog`, `ModemConfigDialog`, `HotspotDialog`, `WifiSelectorDialog`, `NetifDialog`, `CloudRemoteDialog`, `PasswordDialog`, `SshDialog`, `LogsDialog`, `UpdatesDialog`, `PowerDialog`, `VersionsDialog`

### Validation Single Source of Truth

All field constraints originate in `packages/rpc/src/schemas/` as exported constants (e.g. `BITRATE_MIN`, `BITRATE_MAX`, `HOTSPOT_NAME_MIN`). The frontend reads these via `lib/components/streaming/ValidationAdapter.ts` — no inline literals in dialog components.

### Dependency Notes

- **bits-ui**: upgraded to v2.18.1; shadcn-svelte components regenerated against v2 API.
- **Custom components**: moved from `lib/components/ui/` to `lib/components/custom/` (`simple-alert-dialog`, `mode-toggle`, `locale-selector`, `mobile-link`, `pwa/`).
- **Touch/kiosk foundation**: `data-layout-mode` attribute on `<html>` drives CSS token scaling (`--touch-target-min`, `--spacing-touch-scale`). Stored in `lib/stores/layout-mode.svelte.ts`.

## Streaming Pipeline (Encoder → Bonding → Server)

```
ENCODER DEVICE (Field)                        SERVER (Ingest/Cloud)
======================                        =====================

Video Source (HDMI/USB/SRT/etc)
        |
        v
   ceracoder
   +---------------------------+
   | GStreamer (internal)      |
   | - Capture/Encode/Mux      |
   | - MPEG-TS + SRT send      |
   +-------------+-------------+
                 |
                 | SRT (localhost:9000)
                 v
           srtla (sender)
   +-------------+-------------+
   | splits packets across     |
   | multiple interfaces       |
   +------+------+------+------+
          |      |      |
      Modem1  Modem2  WiFi
          \      |      /
           \     |     /
            \    |    /
             \   |   /
              \  |  /
               \ | /
             Internet
                 |
                 v
                            srtla_rec
                    +----------------------+
                    | reassemble bonded    |
                    | SRT stream           |
                    +----------+-----------+
                               |
                               v
                        srt-live-transmit
                    +----------------------+
                    | relay / bridge       |
                    +----------+-----------+
                               |
                               v
                       OBS / Player / CDN
```

## Data & Control Paths

- **Control**: Frontend → Backend (RPC) → ceracoder/srtla (spawn, config, SIGHUP).
- **Media**: ceracoder (GStreamer) → SRT → srtla → bonded links → srtla_rec → srt-live-transmit → consumer.
- **Bitrate Adaptation**: ceracoder reads SRT stats, adjusts encoder bitrate dynamically.
- **Config Reload**: ceracoder supports SIGHUP to reload INI without restart.
- **Config Persist (no stream start)**: `rpc.streaming.setConfig` saves config fields without launching the stream — used by all Live destination dialogs when not streaming.
