<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## NETWORK-INGEST GATEWAY (LAN RTMP/SRT) [EXISTS]

Two image-baked LAN ingest gateways (image-building-pipeline `feat/network-ingest-gateway`
branch, Todos 14–15) let a phone or OBS on the same LAN publish directly into cerastream
without going through the cloud relay. CeraUI is the runtime-verification + UI layer; the
gateways themselves are baked into the device image. See image-building-pipeline
`v2/docs/DEFERRED.md` item 7 for the LAN-scoped-in-v1 posture and the on-device QA checklist.

**Baked units (image-building-pipeline, NOT this repo):**
- `ceralive-rtmp-gateway.service` — pinned MediaMTX (`moq: false`), config
  `/etc/mediamtx.yml`, binary `/usr/local/bin/mediamtx`. The publish path is HARDCODED
  (`rtmp://<device>:1935/publish/live`, matches cerastream's `InputKind::RtmpLocalhost`).
- SRT has **two topologies during the B2 fleet transition** (Task 16 makes CeraUI tolerate
  both): **OLD** — a standalone `ceralive-srt-gateway.service` (srt-live-transmit) on :4001;
  **NEW** — the SAME MediaMTX unit terminating SRT too (Task 14), proved by `/etc/mediamtx.yml`
  top-level keys `srt: yes` + `srtAddress: :4001`. The published SRT URL stays `srt://<lan>:4001`
  in BOTH. **No SRT passphrase in v1** — see the DEFERRED.md item 7 follow-up.

**Backend status surface** (`apps/backend/src/modules/network/network-ingest.ts`):
- `getNetworkIngestInfo(): NetworkIngest` — sync read of a cached snapshot probing the
  systemd unit(s) via `systemctl is-active` (`Bun.spawn`, gated on `isRealDevice()`), a
  reused LAN IP (`resolvePrimaryLanIp` — eth/en preferred, cellular/wifi excluded), and
  the board's capability source kinds.
- **FAIL-CLOSED dual-topology SRT probe (Task 16, B2):** SRT is available iff (OLD)
  `ceralive-srt-gateway.service` is active, OR (NEW) `ceralive-rtmp-gateway.service` is
  active AND `parseMediamtxSrtEnabled(/etc/mediamtx.yml)` proves top-level `srt: yes` +
  `srtAddress: :4001` (a targeted line-parse; only column-0 keys count). "rtmp active"
  alone NEVER implies SRT — an old image whose srt unit died must not false-positive; a
  parse failure/absent config → NOT srt-capable. The merge is the pure `resolveSrtTopology`;
  the serving topology is recorded on the additive `srt.gateway: 'mediamtx' |
  'srt-live-transmit'` field.
- Rides the EXISTING `status` broadcast as additive-optional `network_ingest` (NOT a new
  endpoint): `{ rtmp: {service_active, url} | null, srt: {service_active, url, gateway?} | null }`.
  Per-protocol `null` when the board's capabilities exclude that source; `gateway` is set only
  on SRT, only when available. Shape is additive-only — legacy consumers still parse.
- `buildGatewayProbe()` wires the real `GatewayProbe` into
  `apps/backend/src/modules/streaming/gateway-availability.ts` (`setGatewayProbe`) — the
  seam that gates an rtmp/srt stream start, keyed off the merged fail-closed `service_active`.

**Streaming-start gate** (`gateway-availability.ts` + `streaming.procedure.ts`): an rtmp/srt
pipeline carries `requires_gateway: 'rtmp' | 'srt'` on `pipelineSchema` (additive-optional,
present only on those two entries). `streamingStartProcedure` blocks the start and returns
`{success:false, error: GATEWAY_INACTIVE_ERROR}` when `isGatewayActive(kind)` is false. The
default probe is FAIL-SAFE (`isActive: () => false`) until `setGatewayProbe()` runs at boot —
rtmp/srt starts are blocked-by-default, never silently pass the gate. rtmp/srt stay VISIBLE
in the pipeline registry at all times (disabled-with-reason house rule) — never filtered out.

**Frontend card** (`apps/frontend/src/lib/components/custom/NetworkIngestSection.svelte`,
mounted in `LiveView.svelte` directly after `SourceSection`): shows each protocol's LAN
publish URL (copy button + QR via `generateDeviceAccessQr`), selects the matching pipeline
via `config.pipeline` through the standard field-sync lock, and disables-with-reason when
the service is inactive or the stream is already running. Renders nothing when
`status.network_ingest` is null/absent or both protocols are null.

**Single gateway-availability truth (Todo 19):**
`apps/frontend/src/lib/streaming/pipelineAvailability.ts` (pure, rune-free) is the ONE
shared rule every frontend surface routes through — `pipelineAvailability(pipeline,
networkIngest)` returns `{available:true}` or `{available:false, reason}` (i18n key
`live.education.reason.gatewayInactive`). Routed surfaces: `EncoderDialog.svelte` (source
list + Save gate), `lib/streaming/modePresets.ts` (`presetViews`), `ValidationAdapter.ts`
(re-export, single import surface), `StreamingConfigService.ts` (`buildStreamingConfig`
guard). FAIL-SAFE: a null/absent `network_ingest` (older backend, or the snapshot hasn't
arrived yet) blocks the pipeline — never silently permits it. Do NOT re-derive this rule
inline anywhere else.

