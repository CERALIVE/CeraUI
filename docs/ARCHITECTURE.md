# CeraUI Architecture

## Components
- **Frontend (Svelte)**: Browser UI, talks to backend via WebSocket/RPC.
- **Backend (Bun/TypeScript)**: Orchestrates ceracoder, srtla, network/modem, relays RPC events.
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
