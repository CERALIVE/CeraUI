# CeraUI Architecture

## Components

- **Frontend (Svelte 5 PWA)**: Browser UI with 3 primary destinations. Talks to backend via WebSocket/RPC. Served as static files by the backend.
- **Backend (Bun/TypeScript)**: Drives cerastream over JSON-RPC/UDS, supervises srtla, manages network/modem, relays RPC events. Serves frontend static bundle.
- **cerastream**: Rust streaming engine — the sole engine (ceracoder retired 2026-06-11). Runs the GStreamer pipeline internally (capture, encode, mux) and sends SRT. Consumed via the `@ceralive/cerastream` npm tarball; controlled over JSON-RPC on a Unix domain socket.
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
    | JSON-RPC / UDS (cerastream)  +  spawn (srtla_send via streamloop)
    v
cerastream
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
   cerastream
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

- **Control**: Frontend → Backend (RPC) → cerastream (JSON-RPC over UDS) and srtla_send (spawned/supervised as a separate process via streamloop).
- **Media**: cerastream (GStreamer) → SRT → srtla → bonded links → srtla_rec → srt-live-transmit → consumer.
- **Bitrate Adaptation**: cerastream reads SRT stats, adjusts encoder bitrate dynamically.
- **Config Reload**: cerastream applies config changes live via the `reload-config` JSON-RPC method — no restart, no signal. (The former SIGHUP/INI reload was ceracoder-specific; retired 2026-06-11.)
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
| `pipelines` | on-change | pipeline list changes — deprecation shim, see "Device-First Source Model" below |
| `sources` | on-change (post-login snapshot + hardware swap) | unified device-first source list, see below |
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

## Device-First Source Model

The Live destination is organized around ONE device-first source list rather than
a separate pipeline picker, device list, and per-device capability broadcast. The
backend folds `pipelines` + `devices` + the coarse `capabilities.device_modes` map
into a single `sources` broadcast (`apps/backend/src/modules/streaming/sources.ts`,
`getSourcesMessage()`/`buildSources()`): every capture device, coarse pipeline
(hdmi/camlink/…), virtual pipeline (test pattern), and network-ingest slot
(rtmp/srt) appears as one `StreamSource` row in ONE ordered list, each carrying its
own `modes` (Tier-2 device modes, when known), `audioKind`, and availability.

- **`config.source`** is the persisted selection (a `StreamSource` id — an
  `input_id` for a capture device, a pipeline id for coarse/virtual, `rtmp`/`srt`
  for network). `deriveEngineRouting(sourceId, sources)` resolves it to the wire
  pair the engine actually needs (`{pipeline, selected_video_input}`); a capture id
  routes to its bridged pipeline + input_id, everything else routes to its
  pipeline id with `selected_video_input` cleared. The backend procedure seam is
  `resolveSourceRouting()`, invoked at `streaming.setConfig` and
  `streaming.start` — an unknown source id is rejected before any config mutation
  or engine dispatch.
- **Frontend**: `SourceSection.svelte` renders the single `getSources()` list
  (row per `StreamSource`, ordered by operator preference for capture devices) and
  owns the write itself (`rpc.streaming.setConfig({ source })`) — it is no longer
  a purely presentational component. `GoLiveCard.svelte` (mounted at the top of
  `IdleCockpit.svelte`) is the one adaptive readiness + config + start surface: it
  derives Start-gating from the pure `deriveGoLiveReadiness()` module
  (`lib/streaming/go-live-readiness.ts`) against the current source, network,
  destination, and engine state, and collapses to a thin ready-bar once every gate
  is green. `LiveView.svelte` switches between `IdleCockpit` (pre-stream: GoLiveCard
  + a Preview disclosure + SourceSection) and `LiveCockpit` (streaming: telemetry
  strip + bitrate adjuster + ingest stats + Stop) on the optimistic streaming edge.
- **`pipelines`/`devices`/the `device_modes` field on `capabilities`** are kept
  running, byte-for-byte unchanged, as one-release deprecation shims — see
  `docs/TECHNICAL_DEBT.md` (`TD-legacy-source-broadcasts`). No shipped frontend
  surface reads them anymore.
- **Telemetry lifecycle**: `getLinkTelemetry()` is guaranteed `null` (not just
  absent) on the transition edge from streaming to stopped — both a backend
  heartbeat null-broadcast and a belt-and-braces frontend clear on the
  `is_streaming: true → false` edge. The HUD bitrate and per-interface throughput
  numbers are likewise cleared to "—"/0 outside an active stream — no stale value
  survives a stop. The persistent HUD strip surfaces exactly four facts
  (lifecycle/state badge, health verdict, bitrate, one temperature chip); anything
  else (voltage/current, per-link RTT/NAK/weight) lives only in the expanded sheet.
  `network/BondedLinksSection.svelte` on the Network destination is the documented
  SOLE owner of live per-link telemetry numbers — the per-interface WiFi/Cellular/
  Ethernet section rows do NOT duplicate them.

## Connection Topology

The default deployment is **same-device**: the backend and the browser both run on the encoder hardware, so the WebSocket connects to `localhost`. A **remote** topology (browser on a separate machine, backend on the encoder) is also supported via an outbound WSS:443 tunnel — the device always dials out, making CGNAT-traversal feasible without inbound port forwarding.

See [`docs/REMOTE_TOPOLOGY.md`](REMOTE_TOPOLOGY.md) (design-only — not yet wired) for the remote topology design and [`docs/RPC_COMMUNICATION.md`](RPC_COMMUNICATION.md) for the full wire-protocol reference.
