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

## WebSocket Broadcast Events

The backend pushes typed events to all connected clients over the WebSocket channel. Each event type has its own broadcast interval and carries a monotonic sequence number (`seq`) for drop-stale filtering on the frontend.

| Event type | Interval | Source module |
|------------|----------|---------------|
| `netif` | 5 s | `modules/network/network-interfaces.ts` |
| `sensors` | 1 s | `modules/system/sensors.ts` |
| `gateways` | 2 s | `modules/network/gateways.ts` |
| `modems` | 30 s | `modules/modems/modem-update-loop.ts` |
| `status` | on-change | streaming state transitions |
| `config` | on-change | any `setConfig` / `start` / `stop` call |
| `wifi` | on-change | WiFi scan / connect / disconnect |
| `relays` | on-change | relay list mutations |
| `acodecs` | on-change | audio codec list changes |
| `pipelines` | on-change | pipeline list changes |
| `notifications` | on-demand | user-facing toast events |
| `ping` | 5 s | heartbeat emitter (server → client) |

### Sequence numbers

Each event type tracks its own counter (`Map<string, number>` in `rpc/events.ts`). The counter resets to 0 on server restart. The frontend drops any message whose `seq` is not strictly greater than the last seen value for that type, so stale duplicates from a slow network path are silently discarded. Messages without a `seq` field bypass the check (backward-additive).

### Heartbeat

The server emits `{ ping: { t: number } }` every 5 s. The frontend resets a watchdog timer on each ping; if no ping arrives within ~15 s (≈3 missed intervals) the connection is considered half-open and the transport tears down for a fresh reconnect.

### Post-login initial-state push

Immediately after a client authenticates, the backend pushes a full snapshot of every event type so the frontend can render without waiting for the first periodic tick.

### Applied-state returns

RPC setters (`setConfig`, `setBitrate`, etc.) return `{ success: boolean, applied: <fields> }` where `applied` reflects the post-clamp, post-validation values the backend actually wrote. The frontend releases field locks to the `applied` value, not the client's intended value.

## Connection Topology

The default deployment is **same-device**: the backend and the browser both run on the encoder hardware, so the WebSocket connects to `localhost`. A **remote** topology (browser on a separate machine, backend on the encoder) is also supported via an outbound WSS:443 tunnel — the device always dials out, making CGNAT-traversal feasible without inbound port forwarding.

See [`docs/REMOTE_TOPOLOGY.md`](REMOTE_TOPOLOGY.md) (design-only — not yet wired) for the remote topology design and [`docs/RPC_COMMUNICATION.md`](RPC_COMMUNICATION.md) for the full wire-protocol reference.
