# CeraUI Backend — Agent Knowledge Base

Parent: [`../../AGENTS.md`](../../AGENTS.md)

## OVERVIEW

Bun/TypeScript HTTP + WebSocket server. Serves the frontend static bundle, exposes all device control via oRPC over WebSocket, drives the `cerastream` engine over structured IPC (`@ceralive/cerastream` public-npm registry dep) and `srtla-send-rs` via the `@ceralive/srtla-send` npm package.

## STRUCTURE

`src/main.ts` — entry. `src/modules/` — domain logic (no RPC awareness): `streaming/` (cerastream + srtla consumers), `modems/` (mmcli), `network/`, `wifi/`, `system/`, `ui/` (HTTP + WS servers, auth), `ingest/`, `remote/`, `config.ts`, `setup.ts`. `src/rpc/` — oRPC layer: `router.ts`, `procedures/<domain>.procedure.ts`, `middleware/`, `events.ts`. `src/helpers/` — pure utils. `src/mocks/` — MOCK_SCENARIO providers. `src/tests/` — bun:test.

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Per-core encoder load (two kernel realities, probed at runtime; `encoder-load` broadcast) | `modules/system/encoder-load.ts` (`collectEncoderLoad`, `parseMppLoad`, `initEncoderLoad`); contract below → PER-CORE ENCODER LOAD |
| CPU core count — the denominator `device-stats.cpuLoad1` needs to be readable (`cpu` broadcast) | `modules/system/cpu.ts` (`collectCpuInfo`, `getCpuInfo`, `initCpu`); contract below → CPU TOPOLOGY |
| Fan presence + PWM duty cycle (`pwm-fan` discovered by TYPE string, never an index; `fan` broadcast) | `modules/system/fan.ts` (`discoverPwmFanCoolingDevice`, `parsePwmDuty`, `collectFan`, `initFan`); contract below → FAN |
| Idle audio-meter device preference (operator's audio pick → engine idle meter) | `modules/streaming/audio-meter-bridge.ts` (`syncAudioMeterPreference`, `pushPreference`) + `modules/streaming/audio.ts` (`resolveMeterPreference`) + `modules/streaming/cerastream-backend.ts` (`supportsMeterDevicePreference`) |
| Add/change an RPC procedure | `rpc/procedures/<domain>.procedure.ts` + `rpc/router.ts` |
| Bluetooth operator surface (the 10 `bluetooth.*` procedures, the live stack singleton, the `bluetooth` broadcast) | `rpc/procedures/bluetooth.procedure.ts` + `modules/bluetooth/bluetooth-runtime.ts` + `modules/bluetooth/bluetooth-wire.ts`; contract below → THE BLUETOOTH DOMAIN IS WIRED |
| **A Bluetooth microphone dropping mid-stream (operator bands + the two reconnect duties; recovery itself is ENGINE-owned)** | `modules/streaming/bluetooth-audio-resilience.ts` (`classifyBluetoothSourcePresence`, `noteBluetoothAudioPresence`) + the 3-step publish order in `modules/bluetooth/bluetooth-runtime.ts`; contract below → …AND A MICROPHONE THAT DROPS MID-STREAM IS TOLD, NOT REPAIRED |
| Engine seam + registry (cerastream-only) | `modules/streaming/streaming-engine.ts` (`getStreamingBackend`) |
| Capability contract service (engine emits, CeraUI consumes; cache + fallback ladder; `transports` + `getSupportedTransports()`) | `modules/streaming/capabilities.ts` (`getCapabilities`) |
| Transport resolver + protocol registry (srtla/rist active, srt reserved; RIST capability-gated via `ristAvailable`) | `modules/streaming/transport/` (`resolveStreamEndpoint`, `registry.ts`, `rist-adapter.ts`) |
| Pipeline registry (derived from the capability contract; `initPipelines` is async) | `modules/streaming/pipelines.ts` |
| Engine connection resilience (bounded boot retry → periodic recheck; heals `engine-unavailable` and re-broadcasts caps/pipelines/sources) | `modules/streaming/engine-reconnect.ts` (`initEngineConnection`) |
| Cerastream engine backend (structured IPC, `@ceralive/cerastream`) | `modules/streaming/cerastream-backend.ts` |
| Structured engine error → notification (Task-7 table swap, no regex); `mapCerastreamError()` maps a `RuntimeErrorEvent` to a Tier-2 code string (T16) | `modules/streaming/cerastream-error-mapping.ts` |
| srtla binding calls (flux — check `../../../srtla/AGENTS.md` first) | `modules/streaming/srtla.ts` |
| srtla per-link telemetry → `status.linkTelemetry` (incl. the MEASURED `bitrate_bps` per link + the summed `measured_bps` — the only honest live bitrate; `engine_bitrate.applied_kbps` is a setpoint) | `modules/streaming/link-telemetry.ts` (`buildLinkTelemetry`) |
| **Which PHYSICAL device a telemetry row is (twin disambiguation) — the `link_id` registry, the resolution ladder, and the port label** | `modules/streaming/link-registry.ts` (`registerBondIdentities`, `portLabelFromIdPath`) + `link-telemetry-rows.ts` (`buildLinkRows`); contract below → …AND A TELEMETRY ROW IS A PHYSICAL DEVICE |
| **The sender's own bind-map verdict → the ONE normalized stream → `status.bond_mapping`** | `modules/streaming/link-mapping-report.ts` (`ingestSenderBindMapReport`, `isBondMappingActive`, `buildBondMapping`) |
| Stream lifecycle (spawn supervision, start/stop, autostart, exec paths) | `modules/streaming/streamloop/` (barrel: `modules/streaming/streamloop.ts`) |
| Authoritative stream-session lifecycle (UI/autostart/remote arbitration, cancellation generations, boot adoption) | `modules/streaming/stream-session-orchestrator.ts` |
| **Apply-now config change (transaction seam, `reconfiguring` state, queued stop)** | `modules/streaming/stream-session-orchestrator.ts` (`changeConfig`, `noteConfigChangePhase`) + `modules/streaming/config-change-bridge.ts` |
| **Apply-now staged persistence + marker-only crash reconciliation** | `modules/streaming/config-change-staging.ts` (pure) + `modules/streaming/config-change-persistence.ts` (writes) |
| **One-shot stream restoration after engine death (armed marker + boot-scoped gate table)** | `modules/streaming/armed-stream-marker.ts` (pure gate + persistence + `StreamStopCause`) + `modules/streaming/stream-restoration.ts` (`armStreamRestoration`, `runStreamRestoration`) |
| **Derived `reconfiguring` deadline (65 000 engine bound + 12 000 stop bound)** | `modules/streaming/start-lifecycle-timing.ts` (`RECONFIGURE_DEADLINE_MS`) ← `@ceraui/rpc` `config-change.schema.ts` |
| Transactional launch cleanup + phase/stop deadlines | `modules/streaming/launch-transaction.ts`, `start-lifecycle-timing.ts`, `streamloop/start-stream.ts`; contract in `../../docs/START-LIFECYCLE.md` |
| Bounded start retry + suppression + diagnostics | `modules/streaming/stream-start-retry.ts`, `stream-start-retry-reporting.ts` |
| Pre-engine gate deadline deferral (`pendingGateRemainingMs` ← `asrcProbeRemainingMs`) | `modules/streaming/stream-start-retry.ts` + `modules/streaming/audio.ts`; contract in `../../AGENTS.md` → STREAMING BACKEND QUALITY |
| Raw `active_encode` bridge (passthrough + frame-liveness the typed client strips) | `modules/streaming/active-passthrough.ts`; cache-lifetime contract below → RAW `active_encode` BRIDGE |
| Engine restarted mid-session (session control connection dropped → retire the session so the next start works) | `modules/streaming/cerastream-backend.ts` (`noteConnectionLoss`, `withSessionClient`, `onSessionConnectionLost`); contract below → SESSION CONTROL CONNECTION |
| …and then RESTORE that stream, once, within the same boot | `modules/streaming/stream-restoration.ts` (`runStreamRestoration`); contract below → ONE-SHOT STREAM RESTORATION AFTER ENGINE DEATH |
| Stream health rollup (`frames.advancing` freshness window, idle/dead/degraded/healthy) | `modules/streaming/health.ts` (`collectRealLiveness`, `deriveFramesAdvancing`, `FRAMES_FRESHNESS_MS`) |
| WebSocket server wiring | `modules/ui/websocket-server.ts` + `rpc/server.ts` |
| Auth token logic | `modules/ui/auth.ts` + `rpc/middleware/auth.middleware.ts` |
| PASETO device-token verification (relay-config + device-control, ADR-0006) | `modules/pairing/device-token.ts` — `verifyDeviceControlToken`, `resolveControlChannelEndpoint` |
| D3 forced re-pair migration (paired-but-tokenless device on PASETO activation, ADR-0006) | `modules/remote/remote.ts` — `resolveRemoteAuthDecision`, `forceRepairMigration`, `isPasetoVerificationActive` |
| PASETO v4.public crypto primitives (PAE, Ed25519 sign/verify, key import) | `modules/pairing/paseto-v4.ts` |
| Real platform claim + pairing-secret registration (`POST /api/device/pairing-secret`, isRealDevice-gated, HTTPS required in production/on real devices; loopback HTTP only in emulated development; redirects rejected, retry/log, never blocks pairing). Forwards the optional operator-pasted `x-ceralive-pairing-authorization` header (`PAIRING_AUTHORIZATION_HEADER`) on BOTH the registration and claim calls when present — the pinned tenant-credential contract whose platform-side acceptance is todo 36 (device SENDS only). | `modules/pairing/platform-claim.ts` — `completePlatformPairing`, `registerPairingSecret` |
| Control-channel hub endpoint pinning (rejects `custom_provider`, spec §10) | `modules/remote/control-endpoint.ts` |
| **Device identity init (`initIdentity`, `canDialControlChannel`)** | `modules/identity/index.ts` — resolves `device_id` + `paired` at boot; gates the control channel |
| **Resolved hardware-kind provider (`getHardwareKind`/`getHardwareKindCached`; engine raw-IPC probe → device-tree → setup.hw → generic; cached w/ tier; re-resolved on engine reconnect + drift warn)** | `modules/system/hardware-kind.ts` — the SINGLE runtime board authority the four `setup.hw` consumers (sensors/audio/pipelines/reconciler) read; `setup.hw` demoted to fallback |
| **Remote-control channel (second outbound WS, independent of BCRPT relay)** | `modules/remote-control/channel.ts` — `initControlChannel`, `sendFrame`, `isConnected`; exponential backoff + keepalive; default `getControlToken` reads the persisted `config.remote_key` (self-verified before presentation → authenticated dial) |
| **Inbound command routing (PASETO-authed, role-checked, RPC dispatch)** | `modules/remote-control/command-router.ts` — `routeCommand`; NEVER_REMOTE guard, INTERNAL-command branch (pre owner-gate), owner-only, streaming dispatch |
| **Ingest slots → managed accounts (T18; `ingest.slots` internal command)** | `modules/remote-control/ingest-slots.ts` — `handleIngestSlots`, `selectIngestSlot`, `getManagedIngestAccounts`; maps platform-pushed slots keyed by `endpointId`, persists the selection via `selected_ingest_endpoint` |
| **Apply pushed SRT profile (Todo 28; `device.setProfile` internal command)** | `modules/remote-control/set-profile.ts` — `handleSetProfile`; caps-intersect → persist (`stream_profile`/`srt_latency`/`fec_enabled`/`recovery_mode`) → reconnect-when-streaming → ack `{commandId,status,reason?,effectiveActiveProfile,effectiveLatencyMs}`; idempotent on `commandId`. Production deps wired by `set-profile-wiring.ts` (`wireSetProfile`, called from `main.ts`) |
| **Outbound status relay (broadcast → gateway fan-out)** | `modules/remote-control/status-relay.ts` — `relayStatusToGateway`, `RELAYABLE_TYPES` (7 types), per-type seq |
| **Telemetry recorder (batched per-link samples → `telemetry` status frames)** | `modules/remote-control/telemetry-recorder.ts` — `recordTelemetryTick`/`flushTelemetry`; non-blocking, size/age batching; emits over the control channel (spec §8.1) |
| **self_fencing watchdog (commit-confirm + auto-revert)** | `modules/remote-control/self-fencing.ts` — `handleSelfFencingOp`, `handleSelfFencingConfirm`; 30 s watchdog |
| **Wire-envelope Zod schema + contract tests** | `modules/remote-control/protocol.ts` — THIN re-export of `@ceralive/control-protocol` (device-tolerant `FrameSchema`/`CommandSchema`/`StatusSchema`/`IngestSlotsPayloadSchema` + `COMMAND_REGISTRY` incl. `INTERNAL_COMMANDS` + `NEVER_REMOTE` + `tolerantParse*`); `protocol.export-surface.test.ts` / `protocol.contract.test.ts` / `protocol.frame-exchange.test.ts` |
| **RC-pin merge gate (rejects `-rc.` pins of `@ceralive/{control-protocol,cerastream}`)** | `scripts/check-rc-pins.sh` (root `check:rc-pins`, wired into `.github/workflows/build-check.yml` BE job) |
| Kiosk loopback token (DC-3, single-use, tmpfs) | `modules/ui/kiosk-token.ts` + `rpc/server.ts` |
| Preview WebSocket proxy (single-origin `/preview`; forks before oRPC upgrade; backpressure-aware, bounded drop-oldest queue) | `modules/ui/preview-proxy.ts` + `modules/ui/preview-frame-queue.ts` (`BoundedDropOldestQueue`) + `rpc/server.ts` + `rpc/adapter.ts` (`createServerWebSocketHandler`) |
| Preview single-use token store (in-memory, TTL 30s) + `system.mintPreviewToken` | `modules/ui/preview-token.ts` + `rpc/procedures/system.procedure.ts` |
| SIM PIN secrets store (opt-in "remember PIN", chmod-600 tmpfs) | `modules/modems/sim-secrets.ts` |
| Boot SIM PIN auto-unlock hook (bounded, single attempt) | `modules/modems/sim-autounlock.ts` |
| **Cellular composition root (backend selection + readiness gate) and its boot wiring** | `modules/cellular/cellular-stack.ts` (`initCellularStack`, `getCellularStack`, `assertCellularStackReady`) + `main.ts`; contract below → THE CELLULAR SUBSYSTEM |
| **The `modems` wire producer (`stable_key`, dongle rows, synthetic ids, the ID_PATH cache)** | `modules/modems/modem-wire-producer.ts` (`buildProjectedModemsMessage`, `refreshModemIdPaths`) → `modem-status.ts` (`buildModemsWireMessage`) |
| **Where a modem's `ID_PATH` — the anchor EVERY mutation fails closed on — actually comes from (udev NET records, never the USB enumerator)** | `modules/modems/modem-id-path-source.ts` (`readModemIdPaths`, `parseNetIdPaths`); contract below → THE COMPOSITION ROOT OWNS THE THREE THINGS… item 1 |
| **A 3GPP network scan's explicit lifecycle (`network_scan` generation + phase), typed admission/refusal, and why an empty result is a SUCCESS** | `modules/modems/modem-network-scan.ts` (`dispatchModemNetworkScan`, `modemNetworkScan`, `clearScanningMarker`) + `modules/modems/mmcli.ts` (`mmNetworkScan`, `SCAN_TIMEOUT_GRACE_S`) → `rpc/procedures/modems.procedure.ts` `scanModemProcedure`; wire `scanGeneration` on the reply and `network_scan` on modem rows |
| **The OPTIMISTIC "Modem detected" row (udev attach → provisional row, and the precedence that retires it)** | `modules/cellular/udev-cellular-events.ts` + `udev-provisional-cache.ts` + `udev-monitor.ts`; contract below → A DEVICE IS ANNOUNCED BEFORE ANY MODEM SERVICE CAN DESCRIBE IT |
| **Mutation-free D-Bus-vs-mmcli shadow evidence (opt-in, never on the wire)** | `modules/cellular/shadow.ts` (`startModemShadowIfEnabled`) + `shadow-wiring.ts` + `docs/MMCLI-RETIREMENT-GATE.md` |
| USB-composition-mode switch gates (`modems.setUsbMode`, default-absent `modem_provisioning`) | `rpc/procedures/modems.procedure.ts` → `setUsbModeProcedure`; contract below → USB-COMPOSITION SWITCH |
| **Operator-settable data-usage POLICY (cycle day + advisory limit)** | `modules/modems/usage-policy.ts` (`writeUsagePolicy`, `refreshUsagePolicies`, `getCachedUsagePolicy`, `usagePolicySlotKey`) → `rpc/procedures/modems.procedure.ts` `configureModemProcedure`; wire stamp in `modules/modems/modem-wire-producer.ts` (`projectUsagePolicy`); contract below → THE DATA-USAGE POLICY IS A LOCAL WRITE |
| **Read-only SMS inbox (`modems.getSms`) — list + read, never send/delete** | `modules/modems/mmcli-sms.ts` (`readSmsInbox`, `parseSmsList`, `parseSmsRecord`, `SMS_PATH_RE`) → `rpc/procedures/modems.procedure.ts` → `getModemSmsProcedure`; contract below → THE READ-ONLY SMS INBOX |
| **Streaming-admission ↔ modem-lifecycle interlock (process-wide fail-fast lease, both race orders)** | `modules/streaming/lifecycle-admission.ts` (`tryAcquireLifecycle`, `withLifecycleLock`, `leaseRefusal`) + `modules/streaming/stream-session-orchestrator.ts` (`admitLifecycle`); contract below → THE STREAMING-ADMISSION ↔ MODEM-LIFECYCLE INTERLOCK |
| **The shared modem MUTATION-SAFETY contract (per-device lease, durable journal, replay barrier, both acknowledgement paths)** | `modules/streaming/lifecycle-admission.ts` (`tryAcquireModemMutation`, `setMutationBlocks`, `streamingBlockingMutation`) + `modules/streaming/recovery-barrier.ts` + `modules/modems/mutation-{journal,journal-state,lease,identity,blocks,rollback,acknowledge,replay}.ts`; contract below → THE MODEM MUTATION-SAFETY CONTRACT |
| **The modem-control consumer cutover (exact 1.2.1 pin, static imports, frozen boundary gate + active operation-registry drift gate)** | `modules/modem-control-compat.ts` + the 14 frozen pure projection modules + `modules/modems/mutation-admission-port.ts`; `tests/modem-control-projections.test.ts`; frontend `tests/modem-parity-drift.test.ts`; contract below → MODEM-CONTROL COMPATIBILITY PROJECTIONS |
| **The certified USB-mode transition ENGINE, wired** | `modules/modems/transition-engine.ts` (ports + interlock bridge) + `transition-ports.ts` (mmcli inhibit lease, AT sender) + `usb-mode-{transition,identity,contract,execute,rollback}.ts` |
| Kiosk DC-2 state machine (toggle runs the `cog-display` add-on via the manager) | `modules/system/kiosk.ts` |
| Observable logs (getLog/getSyslog → `log` push → LogsDialog download) | `modules/system/logs.ts` + `rpc/procedures/system.procedure.ts` |
| In-memory log ring buffer (dev/CI journal substitute) | `helpers/logger.ts` — `getRecentLogLines` |
| Add-on enable/disable state machine (T28) | `modules/addons/manager.ts` |
| Post-boot add-on reconciler (T29, non-blocking; never gates rollback) | `modules/addons/reconciler.ts` |
| Network-ingest gateway status (fail-closed dual-topology SRT probe: OLD `ceralive-srt-gateway.service` OR NEW MediaMTX `/etc/mediamtx.yml` `srt: yes`+`srtAddress: :4001`; LAN URLs, additive `srt.gateway`, `status.network_ingest`) | `modules/network/network-ingest.ts` |
| **Network-ingest operator enable/disable (topology-aware desired-state + systemctl apply + boot reconcile)** | `modules/network/network-ingest-control.ts` |
| Gateway-active probe seam (blocks rtmp/srt `streaming.start` until the gateway is up; fail-safe default) | `modules/streaming/gateway-availability.ts` |
| Same-subnet detection (`same_subnet_group`, informational, AP-excluded) | `modules/network/network-interfaces.ts` (`netIfBuildMsg`) |
| Measured per-interface throughput (`tx_bps`/`rx_bps`, bits/s) | `modules/network/network-interfaces.ts` (`computeInterfaceRate`, `processIfconfigOutput`) |
| WiFi AP-vs-client classification (`isApMode`, `activeConn`/`activeMode`) | `modules/wifi/wifi-hotspot-types.ts` + `modules/wifi/wifi-interfaces.ts` |
| **The ONE per-adapter WiFi lock key (permanent MAC) every mutation acquires — RPC layer AND hotspot transactions** | `modules/wifi/wifi-adapter-lock.ts` (`wifiAdapterLockKey`, `wifiAdapterLockKeyForDeviceId`, `wifiAdapterLockKeyForConnectionUuid`, `withWifiAdapterLock`); contract below → EVERY WIFI MUTATION SHARES ONE ADAPTER LOCK |
| WiFi scan coalescing + Forget removing EVERY same-SSID profile | `modules/wifi/wifi-connections.ts` (`wifiRescan`) + `modules/wifi/wifi.ts` (`savedAll`, `wifiSiblingConnections`, `wifiForget`); contract below → A SCAN IS COALESCED, AND FORGET REMOVES THE NETWORK |
| Regulatory domain + kernel-derived hotspot channels (`iw reg set` / `iw phy` parser, regdb precheck, armed restore timer) | `modules/wifi/regdomain.ts` (`applyRegulatoryDomain`, `deriveApChannels`, `checkWirelessRegdbSupport`, `buildRegdomainRestoreCommand`) |
| Persisted country → apply → re-derive → hotspot restart | `modules/wifi/wifi-country.ts` (`setWifiCountry`, `reconcileHotspotChannels`) |
| **Device-bound connectivity probe (`curl --interface`) — the only thing that can name one of two same-IP twins** | `modules/network/device-bound-probe.ts` (`checkConnectivityViaDevice`, `SAFE_IFNAME_RE`) + `connectivity-candidates.ts` (`probeBindingFor`, `deviceBoundProbeExclusionReason`) + `connectivity-election.ts` (`electConnectivityCandidate`, injected probe pair); contract below → …AND A PROBE THAT MUST NAME A DEVICE BINDS ONE |
| Policy-route self-check for bonded wifi/modem/dongle interfaces (`policy_route_missing`) | `modules/network/policy-route-check.ts` |
| **Flow-sticky client sharing (owned nft table, stable marks, per-uplink routes, hard-down drain)** | `modules/network/uplink-steering/` + `modules/network/uplink-sharing.ts`; contract [`../../docs/UPLINK_STEERING.md`](../../docs/UPLINK_STEERING.md) |
| **Whether the two shared-client NAT layers still coexist (READ-ONLY, tri-state; `sharing_diag`)** | `modules/network/sharing-diag/`; contract below → …AND THE TWO NAT LAYERS ARE WATCHED, NEVER ARBITRATED |
| **Streaming-first egress shaping (uncapped local band, adaptive marked-client cap)** | `modules/network/uplink-shaper/`; contract [`../../docs/UPLINK_SHAPING.md`](../../docs/UPLINK_SHAPING.md) |
| **Router-dongle netns runtime metadata (contract-v1 MIRROR reader; stale/ambiguous/bad-version ignored+logged)** | `modules/network/dongle-metadata.ts` (`readDongleMetadata`, `refreshDongleMetadata`, `getDongleMarker`, `dongleSlotLabel`) |
| **The `dongle` netif marker (live-row stamp + wire-only union rows + one-frame retraction)** | `modules/network/network-interfaces.ts` (`applyDongleProjection`); contract below → AN ISOLATED DONGLE IS SURFACED WITHOUT ENTERING THE BOND |
| Retracting the `hdmi_error` notification (BOTH the no-signal message and the EMI/cable advisory) once the link relocks | `modules/system/hdmi-signal-notification.ts` (`clearHdmiSignalErrorOnRecovery`, `HDMI_MSGS_CLEARED_BY_LOCKED_SIGNAL`, hooked into `sources.ts` `commitEngineDevices`); contract below → A PERSISTENT NOTIFICATION MUST BE RETRACTABLE |
| Scoping the `hdmi_error` "No HDMI signal detected" RAISE to a relevant selection, and dedup-guarding the EMI/cable advisory's raise | `modules/system/hdmi-signal-notification.ts` (`provesSelectionIsNotHdmi`) + `modules/system/sensors.ts` (`handleRk3588HdmiDmesg`); contract below → …AND ITS RAISE MUST BE SCOPED LIKE ITS RETRACTION |
| Retracting the `cerastream` `capture_video_error` notification at a healthy session boundary | `modules/streaming/cerastream-backend.ts` (`standingEngineError`, `clearRecoveredEngineError`, `ENGINE_ERRORS_CLEARED_BY_HEALTHY_SESSION`) |
| **One row per physical camera + per-device mode ladders (`inputModes`, `selectedInputMode`, coarse USB placeholder suppression)** | `modules/streaming/sources.ts` (`SUPPRESSED_COARSE_PIPELINE_IDS`, `buildInputModes`, `resolveSelectedInputMode`, mode-aware `deriveEngineRouting`) |
| **Last-streamed-config retention (the ONE remembered `lost` device)** | `modules/streaming/sources.ts` (`collectLostCandidates`, `noteStreamedSourceCommitted`) + `config.last_streamed_source` in `helpers/config-schemas.ts`; commit hook wired at `stream-session-orchestrator.ts` `onStreamCommitted` |
| **Degraded-SELECTED capture snapshot (`capture_video_error` + `selected:true`)** | `modules/streaming/capture-degraded.ts`; raised/retracted in `modules/streaming/cerastream-backend.ts` (`clearRecoveredEngineError` is the ONLY clearing seam) |
| **Device-truth save guard + persisted-mode clamp (ADR-0008 §10)** | `modules/streaming/device-mode-guard.ts` (`verifySaveDeviceMode`, `clampPersistedDeviceMode`) + `modules/streaming/persisted-mode-clamp.ts` (`reconcilePersistedDeviceMode`); the RULE itself is `@ceraui/rpc` `capabilities/device-mode-truth.ts`, shared with the frontend |
| **Unified device-first `sources` builder + engine-device cache + `config.source` routing seam** | `modules/streaming/sources.ts` (`buildSources`, `getSourcesMessage`, `deriveEngineRouting`, `resolveSourceRouting`) |
| **Which capture kinds release their kernel v4l2 node while the engine holds them (libuvc)** | `modules/streaming/held-devices.ts` (`releasesV4l2Node`) — CeraUI-side mirror of cerastream `engine::held_devices` |
| **Absence GRACE on the selected capture source (the libuvc release window)** | `modules/streaming/capture-presence.ts` (`resolveSelectedSourceWithGrace`, `CAPTURE_ABSENCE_GRACE_MS`), read by `auto-audio.ts` `resolveAutoAsrcFromLiveState`; contract below → A DEBOUNCE IS NOT AN ABSENCE GRACE |
| **`config.source` legacy coercion (pipeline/selected_video_input → source, idempotent)** | `helpers/config-schemas.ts` (`coerceLegacySource`) |
| **Audio-naming resolution (4-tier: static onboard rule → engine join → ALSA longname → generic alias) + name cleaning + tier-3 diagnostic** | `modules/streaming/audio-naming.ts` |
| **ALSA card scan + `setup.sound_device_dir` ↔ kernel reconciliation** | `modules/streaming/alsa-card-scan.ts` (`scanAlsaCards`, `resolveConfiguredAlsaCards`, `getResolvedAlsaCardDir`) + `modules/streaming/audio.ts` (`isPlaybackOnlyCard`); contract below → …AND NEITHER IS A LIVE AUDIO CARD |
| **Static onboard AUDIO display-name rules (`rockchip,hdmiin` → `HDMI Input`) — code-level, no operator surface** | `modules/streaming/audio-naming.ts` (`ONBOARD_AUDIO_DISPLAY_RULES`, `resolveOnboardDisplayName`) |
| **Static onboard VIDEO display-name rules (`rk_hdmirx` → `HDMI Input`) + the shared key folding** | `modules/streaming/onboard-display-names.ts` (`ONBOARD_VIDEO_DISPLAY_RULES`, `applyOnboardVideoDisplayRule`, `normalizeOnboardKey`) |
| Mock hardware data | `mocks/providers/` |
| Shared RPC schema types | `../../../packages/rpc/` (`@ceraui/rpc`) |

## STREAMING RPC PROCEDURES

The `streaming` router exposes these procedures:

| Procedure | Purpose |
|-----------|---------|
| `start(config)` | Validate config, launch stream, persist config |
| `stop()` | Stop active stream |
| `setConfig(fields)` | Persist config fields **without** starting the stream (added Task 19) |
| `setBitrate({ max_br })` | Hot-adjust bitrate while streaming |
| `getPipelines()` | List available capture sources, derived from the capability contract (`getCapabilities`) — NOT the `pipeline-sources.ts` tables directly |
| `getAudioCodecs()` | List available audio codecs |
| `getConfig()` | Return current config snapshot |

`setConfig` writes the provided fields onto the running config (same relay/manual mutual-exclusion logic as `updateConfig`, minus DNS/pipeline validation), then calls `saveConfig` and broadcasts a `config` message. Use this for all config-only dialogs that must not start the stream.

## AUDIO-DEVICE NAMING [EXISTS]

`modules/streaming/audio-naming.ts` turns the raw audio-card map into per-card
operator-facing labels. Resolution is PURE (the one documented exception is the
tier-3 diagnostic below) and runs a **4-tier** ladder:

| Tier | Source |
|------|--------|
| **0** | a STATIC, code-level display-name rule for a known ONBOARD card (`ONBOARD_AUDIO_DISPLAY_RULES`) |
| 1 | the engine `list-devices` entry joined on `alsa_card_id` (`product_name`, then `display_name`), each gated by `isHumanAudioName()` |
| 2 | the `/proc/asound/cards` longname |
| 3 | the current generic alias/name (byte-identical fallback) |

**There is NO operator rename anywhere in CeraUI.** No text field, no RPC, no
config field, for any device. Device naming is either the cleaned hardware name
(tiers 1-2) or a code-level rule (tier 0) reviewed like any other source change.
Do not re-add an alias/rename surface.

**Tiers 1 and 2 both carry RAW device strings and are CLEANED before display.**
On Linux both are literally the ALSA longname — `sound/usb/card.c` appends
`" at usb-<bus>-<devpath>, <speed> speed"` to `"<manufacturer> <product>"`, and
cerastream sets an audio entry's `display_name` to that same longname. A live
operator report showed both leaking verbatim into the picker, via *different*
tiers:

- **tier 1** — `RØDE RØDE HDMI to USB-C at usb-xhci-hcd.17.auto-1, super speed`
  (engine `product_name` was the generic `"usbaudio"`, rejected for equalling the
  card id, so the heuristic fell through to the longname-valued `display_name`);
- **tier 2** — `DJI Technology Co., Ltd. DJI MIC MINI at usb-fc8c0000.usb-1, full speed`
  (no engine entry for that card at all).

`cleanAudioDeviceName(raw)` fixes both: it strips the kernel bus/speed tail
(anchored on the trailing `speed` word, so a product name merely CONTAINING
" at " is never truncated) and collapses a manufacturer duplicated as the product
prefix. The duplicate rule is generic — no vendor allowlist: the first token must
reappear later with ONLY corporate filler (`Technology`, `Co.`, `Ltd.`, `Inc`, …)
in between; any other token BLOCKS the collapse, so `"Blue Microphones Yeti Blue"`
is left alone. Diacritics are not folded (`Rode` ≠ `RØDE`) — a wrong collapse
silently mangles a real product name.

**Tier 0 — static onboard display-name rules.** Cleaning cannot help a card whose
only hardware string is a raw driver id: the RK3588 HDMI-RX capture card reports
`rockchip,hdmiin` through every tier (engine, longname, and card id alike), and
there is nothing human in it to recover. `ONBOARD_AUDIO_DISPLAY_RULES` maps such
a card to a fixed operator-facing name (`rockchiphdmiin` → `HDMI Input`,
`rockchipes8388` → `Onboard Audio`). Keys are normalized through
`normalizeOnboardKey` (punctuation + case folded), so ONE entry matches every
spelling of the same block — the ALSA card id `rockchiphdmiin`, the driver name
`rockchip_hdmiin`, and the longname `rockchip,hdmiin`. `resolveOnboardDisplayName`
probes the card id first, then the raw hardware string. Only cards that can
actually REACH the picker are listed — `updateAudioDevices` already excludes the
HDMI-output and codec-playback cards. Adding a board is a code change.

**Punctuation folding is not enough for the HDMI-RX — it has TWO card ids.**
Which one a board reports is decided by the KERNEL TRACK, not the hardware: the
vendor 6.1 BSP registers the port's audio half as `rockchiphdmiin`, while
mainline / Armbian `edge` 7.1 registers the SAME port as `hdmirx` (the
first-party `simple-audio-card` DT node over the Synopsys receiver). They do not
fold onto one key, so BOTH are listed — the audio twin of the several-spellings
rule `ONBOARD_VIDEO_DISPLAY_RULES` already carries for the video half, and of
`auto-audio.ts`'s `HDMI_CARD_IDS`.

**The raw string is moved, never deleted.** It rides `AudioSource.detail`
(diagnostic-only: a tooltip on the picker rows and the read-only source line) so
the bus path, link speed, full legal manufacturer name, and the raw driver id a
tier-0 rule replaced all stay available for debugging. `detail` is absent when the
resolved name is already the raw string.

**External vs onboard is a READ-ONLY marker, derived from `transport`.** The
engine's `transport` field (`usb` / `hdmi` / `bluetooth` / `onboard`, corrected in
cerastream PR #69) rides `AudioSource.transport` through `resolveAudioIdentities`
unchanged. The frontend turns `usb`/`bluetooth` into an "External" badge
(`isExternalAudioSource`, `apps/frontend/src/lib/streaming/sourceSummary.ts`).
NEVER re-derive external-ness from bus-path string matching — the engine reports
it correctly.

`deriveAudioSources()` defaults its display/identity args to the last resolved
maps, so the pull-based `status` snapshots (`modules/ui/status.ts`,
`rpc/procedures/status.procedure.ts`) serve the same labels as the push
broadcast instead of falling back to the bare asrc key.

Coverage: `tests/audio-device-naming-cleanup.test.ts`, `tests/audio-naming.test.ts`.

**The resolved label/identity maps are re-resolved when the ENGINE list changes,
not only on a udev hotplug.** `lastAudioDisplays` / `lastAudioIdentities` are built
inside `broadcastAudioSources()`, which only `updateAudioDevices()` called — and
that runs on the SIGUSR2 udev hotplug and at boot. The engine's own audio
enumeration lands on ITS schedule, seconds later, through `sources.ts`
`commitEngineDevices` (the 5 s signal recheck and the video-hotplug probe both
commit it). Nothing re-ran the join, so whatever the maps resolved to at plug time
LATCHED. Confirmed live on a Rock 5B+: a DJI Osmo Pocket 3 plugged in mid-session
rendered with no `transport` and no `stable_id` for the rest of the session while
the engine had been reporting `alsa_card_id: "DJIPocket3"`, `transport: "usb"`,
`stable_id: "card:DJIPocket3"` within seconds of the plug; one manual SIGUSR2
filled both in instantly. Same latched-stale class as `policy_route_missing` and
the video signal recheck.

`commitEngineDevices` now fires an injected handler when the SERIALIZED audio list
changes (default: a lazy `import("./audio.ts")` — `audio.ts` imports `sources.ts`,
so a static import would cycle; the same shape `devices.ts` uses for
`onDevicesChanged`). The handler is `reresolveAudioForEngineChange()`, deliberately
NOT the whole of `updateAudioDevices()`: the sysfs card scan has not changed
(nothing was plugged), so re-walking it would raise a spurious lost-device verdict
and re-blink the meter through `noteMeterSelection`. Only the engine JOIN goes
stale, so only `broadcastAudioSources()` + `refreshResolvedAsrcPreview()` are
redone; `syncAudioMeterPreference()` is skipped because the meter preference
resolves from the sysfs card map. Keyed on the serialized list, so the 5 s recheck's
steady state costs one string compare and broadcasts nothing.
`setEngineAudioChangeHandler()` is the test seam. Coverage:
`tests/lost-device-retention.test.ts`.

## "AUTO" AUDIO — SAME PHYSICAL DEVICE ONLY [EXISTS]

`resolveAutoAsrc` rule 5 (`modules/streaming/auto-audio.ts`) binds "Auto" to the
audio card on the SAME PHYSICAL DEVICE as the selected USB/UVC camera, decided by
`physical_group_id` equality (cerastream ADR-0008), and to nothing else.

**Name similarity is not evidence of shared hardware.** The retired matcher scored
a shared leading display-name prefix against a 4-character floor. The DJI Osmo
Pocket 3 is why it had to go: audio `"DJI DJIPocket3 at usb-fc880000.usb-1, high
speed"` vs video `"DJIPocket3: OsmoPocket3"` share only `"DJI"` — one character
short — so the join missed and Auto served a still-enumerated RØDE's microphone,
i.e. a **different physical device's mic** presented as the camera's own. Widening
the candidate names only moved the coin-flip. USB topology answers the question the
strings could only approximate. `MIN_COMMON_PREFIX`, `commonPrefixLength`, and
`engineAudioJoinNames` are DELETED; `grep commonPrefixLength` must stay empty.

**Three typed outcomes, and two of them pick nothing:**

| Same-group cards | Resolution |
|---|---|
| exactly 1 | that card, `reason: usb-same-device` |
| more than 1 | `ambiguous-same-device-audio` + `candidates[]` — NO auto-pick |
| 0, or a group-less camera | `no-same-device-audio` — NO auto-pick |

**LISTED IS NOT RECORDABLE — rules 3 and 4 are gated on a CAPTURE PCM.** Rules 3/4
bind a card named by a FIXED id list (`HDMI_CARD_IDS` / `C4K`) on the strength of
CeraUI's own sysfs scan ENUMERATING it, and enumeration is a different question
from "can this be recorded from". The RK3588 HDMI-RX is the counter-example, and
it is not theoretical: measured on a Rock 5B+ **with a locked 1080p59.94 signal
on the port**, `/proc/asound/cards` lists card 3, `/proc/asound/pcm` carries
`03-00: rockchip,hdmiin i2s-hifi-0 :` with NO `capture N` field, `/sys/class/sound/card3`
has no `pcmC3D0c`, and `arecord -l` never shows it. Rule 3 bound it anyway, so
**every** `asrc: "Auto"` start on the HDMI source died:

```
BCAST {"status":{"resolved_asrc":"HDMI","resolved_asrc_reason":"hdmi"}}
RECV  {"success":false,"error":"start_invalid",
       "failure":{"phase":"start-rpc","code":-32602,
         "message":"invalid params: audio-device-unavailable: ALSA capture device
                    'hw:CARD=rockchiphdmiin' is busy or unavailable",
         "retriable":false}}
```

An operator whose camera was working could not go live at all. The capture-PCM
presence set already existed in this file (`hasCapturePcmNode` / `audioCaptureCardIds`,
built by `updateAudioDevices` and consumed by the audio meter) — rule 3 simply never
consulted it. It now does, via `getAudioCaptureCardIds()` threaded onto the resolver
input as `captureCapableCardIds`.

- **The refusal is `no-capture-audio` → the `"No audio"` pseudo-source**, i.e. the
  engine's `audio.mode: "none"`, so the start SUCCEEDS as an explicit video-only
  stream. Board-proven: the same source, in the same minute, went `streaming` in
  2.774 s under that value. Do NOT "simplify" it to a `null` asrcKey — that OMITS
  `asrc` from the launch copy and hands the engine its own legacy inference over the
  very port that cannot deliver.
- **FAIL-OPEN.** `captureCapableCardIds` is OPTIONAL; `undefined` means the question
  was never asked, and an unasked question is not evidence — the rules then bind
  byte-identically to before the gate existed. Only a scan that positively lists the
  cards AND omits this one withholds.
- **The card stays in the PICKER**, unchanged — same rule as the meter's presence
  gate. The operator selected that PORT; only claims that it can DELIVER audio are
  gated.
- **Rule 5 deliberately does NOT carry this gate.** Its candidates must each carry an
  `alsa_card_id` from the ENGINE's `list-devices`, and a card with no capture PCM
  never appears there at all — the engine has already answered the question. Adding
  a fourth gate there would be redundant, not safer.

**AND THE HDMI-RX CARD HAS TWO NAMES — the KERNEL TRACK picks which.** Rule 3's
id was a single hardcoded `"rockchiphdmiin"`, which is what the Rockchip vendor
6.1 BSP calls the port's audio half. The mainline / Armbian `edge` 7.1 tree
registers the SAME physical port as `hdmirx` — the Synopsys `snps_hdmirx`
receiver plus a first-party `simple-audio-card` DT node — so
`findAsrcKeyByCardId(audioDevices, "rockchiphdmiin")` answered `undefined`, rule
3 fell silently through, and "Auto" NEVER bound HDMI audio on that kernel. Not a
degenerate case: board-proven on a Rock 5B+ running `7.1.5-ceralive-rk3588` with
`rk3588-kernel-patches` PR #2 applied, `/proc/asound/cards` reads
`2 [hdmirx] : simple-card - hdmirx`, `/proc/asound/pcm` gives it
`fddf8000.i2s-i2s-hifi … : capture 1`, and a live `ffmpeg` capture through
`hw:2,0` recorded `mean_volume: -29.0 dB` — real, non-silent audio.

- **`HDMI_CARD_IDS` (`auto-audio.ts`) is the ordered list**, and ORDER IS THE
  CONTRACT: the first spelling the device ENUMERATES wins, so a board reporting
  more than one resolves deterministically and a vendor-6.1 board is
  byte-identical to before. `findEnumeratedCard()` is the multi-spelling form of
  `findAsrcKeyByCardId`.
- **The capture gate is asked about the spelling that MATCHED**, never a
  canonical one — a listed-but-unrecordable `hdmirx` is refused with
  `no-capture-audio` exactly as `rockchiphdmiin` is, and the mainline card is
  registered by a DT node that exists whether or not a cable is locked. Widening
  rule 3's id list did NOT weaken its gate.
- **It stays a NAME LIST, and that is the decision, not an omission.**
  cerastream's `capture_card_ids()` (`alsa_hotplug.rs`) detects capture-capable
  cards generically with no names at all — but that answers "can this card
  record", which CeraUI already asks separately via `captureCapableCardIds`. Rule
  3's question is "WHICH card is this port's audio half", and answering THAT by
  capability would bind an HDMI source to whatever unrelated microphone happened
  to be plugged in, i.e. exactly the cross-device guess rule 5 was rewritten to
  remove. Key on the IP block, never on a board model or kernel version — the
  same rule `ONBOARD_VIDEO_DISPLAY_RULES` already follows for the video half.
- **`RK3588_AUDIO_SRC_ALIASES` (`audio.ts`) is deliberately NOT dual-named.**
  `getAudioSrcReverseAliases()` inverts that table, so two card ids sharing the
  label `"HDMI"` would make `getAudioSrcId("HDMI")` answer with whichever was
  declared last — resolving a vendor board's pick to `hw:CARD=hdmirx`, a card it
  does not have. Rule 3 needs no alias (it joins by card-id VALUE), the tier-0
  display rule gives the edge-7.1 card the same `HDMI Input` label, and the
  `priority` list carries `hdmirx` so the port keeps its top placement.

Wire contract: `resolvedAsrcReasonSchema` (`@ceraui/rpc`) gains `no-capture-audio`;
the frontend bands it as `audio-no-capture` (`live.source.audioNoCapture*`, 10
locales) rather than letting it fall through to the em-dash. Coverage:
`tests/auto-audio.test.ts` → "a bound card must be able to CAPTURE (W4A4-F1)" (the
pure table incl. the fail-open and un-enumerated controls, the launch copy asserting
`{mode:"none"}`) + "Auto on the board's real HDMI topology (W4A4-F1 wiring)" (a real
sysfs fixture reproducing `card3`-without-`pcmC3D0c`, driven through
`resolveAutoAsrcFromLiveState`, with the capture-PCM-appears control) +
"the HDMI-RX card under BOTH kernel spellings" (the `hdmirx` bind, its own
capture-PCM refusal and `{mode:"none"}` launch copy, the fail-open control, the
both-listed ordering contract, the unchanged vendor bind, and the non-HDMI-source
negative) — plus the two `hdmirx` sysfs fixtures added to the wiring describe.

The generic `usb-alias` and `first-device` fallbacks are GONE, from the code AND
from `resolvedAsrcReasonSchema`: each could only ever name a card on a different
physical device, which is precisely the defect. Both non-resolutions ride `status`
(`resolved_asrc_reason` + `resolved_asrc_candidates`) and the UI turns each into a
manual-selection prompt (`SourceSection.svelte` bands `audio-same-device-ambiguous`
/ `audio-no-same-device`) rather than a silent em-dash.

**An ABSENT group never matches — not even another absent group.** `samePhysicalGroup()`
is the TS mirror of cerastream's helper (ADR-0008 §6): a match requires BOTH sides to
carry a key AND the keys to be equal. `None` means "no USB topology to key on" (HDMI-RX,
onboard audio, Bluetooth, test sources), not "unknown, might be the same" — and on the
wire the key is simply ABSENT for those, which is treated identically to an empty string.
A bare `a === b` would pair every group-less card with every group-less camera. Do NOT
"simplify" it back.

**A candidate must clear three gates**, not just the group: the engine gave it an
`alsa_card_id` (no join key, no candidate), it shares the camera's group, and CeraUI
itself enumerates that card — a card the engine lists but this device cannot open is
not selectable, so it is not offered.

**Auto re-resolution stays launch-only.** `refreshResolvedAsrcPreview` still returns
early while streaming, so an ambiguous or absent verdict can never disturb a running
stream; it is computed at start and on idle preview.

**Manual selections are untouched.** A concrete `config.asrc` short-circuits every
Auto path (`resolveLaunchConfig`, `refreshResolvedAsrcPreview`, `applySwitchInputFollow`),
still resolves through the unchanged alias/card lookup, and still migrates by stable
identity via `reconcileConfiguredAudioIdentity`.

The field is threaded verbatim from the engine: `fromEngineDevice` → `CaptureDevice.physical_group_id`
→ `StreamSource.physicalGroupId` (video) and `probeEngineDevices` → `EngineAudioDevice.physical_group_id`
(audio). It is deliberately NOT restored from `lastEngineVideoDevices` — a group id is a
same-moment topology relation, not a durable identity like `stable_id`.

Coverage: `tests/auto-audio.test.ts` (the matcher table: 1 / N⇒ambiguous / 0 / group-less
camera / group-less card / empty-string group / un-enumerated card / no join key, the two
board topologies, manual precedence, and the saved-selection migration).

**An unavailable selected input fails the start ONCE, as itself.** `asrcProbe()`
polls for `AUDIO_PROBE_TIMEOUT_MS` (15 s) — a deliberate "give the device a moment
to come back" grace window that also wakes early on a hotplug re-enumeration. That
window is LONGER than the generic 10 s per-attempt launch deadline, so the deadline
used to preempt it and misclassify a permanently-absent device as a retriable
`start_timeout`. `asrcProbeRemainingMs()` now feeds the retry runner's
`pendingGateRemainingMs` seam so the deadline defers behind the probe, and the
probe's own expiry surfaces the non-retriable `audio_source_unavailable` class
(carried on `StartStreamResult.failureClass`). The probe still runs BEFORE the
sender spawn and any engine IPC, so a probe failure dispatches ZERO engine `start`
calls. A stop during the window still resolves as the first-class `cancelled`
result, not a failure — the orchestrator's cancellation check runs ahead of
classification. Coverage: `tests/audio-probe-start-classification.test.ts`,
`tests/audio-probe-failure-reason.test.ts`.

## ONBOARD VIDEO DISPLAY NAMES [EXISTS]

The video half of the same port needed the same treatment. cerastream reports the
RK3588 HDMI-RX capture node's `display_name` as the raw kernel driver id
`rk_hdmirx`, and once cerastream PR #69/#70 fixed its classification the node
became a real, selectable, connected row — so that raw id surfaced verbatim in the
Live source list AND in the "Configured" summary line above it.

`modules/streaming/onboard-display-names.ts` is the video counterpart of the audio
tier-0 rule and shares its key folding: `normalizeOnboardKey` lives there and
`audio-naming.ts` imports it, so both media types key their rules identically.
`ONBOARD_VIDEO_DISPLAY_RULES` maps `rkhdmirx` / `streamhdmirx` / `snpshdmirx` /
`rockchiphdmirx` / `rockchiphdmirxcontroller` → `HDMI Input` — deliberately the
SAME name the audio ladder gives `rockchip,hdmiin`, because the two are the video
and audio halves of ONE physical port.

**One node has SEVERAL spellings, and which one arrives depends on the engine
build.** The v4l2 CARD TYPE and the v4l2 DRIVER name are different strings for the
same block: a Rock 5B+ HDMI-RX reports card type `stream_hdmirx` but driver
`snps_hdmirx` (Synopsys DesignWare HDMI-RX — the IP Rockchip licenses).
Board-confirmed: after the engine moved to naming the node after its driver, the
raw `snps_hdmirx` rendered verbatim in the operator's source picker. Keying the
rule on the IP block rather than on a node path or board model is what makes it
work on every board carrying the same receiver. Like the audio rule it is code-level only: no UI, no RPC, no
config field. Adding a board is a code change.

**It is applied at the device-construction seam, not at each render site.** The
"Configured" label and the picker row are NOT separate code paths — both read
`StreamSource.displayName` off the single `sources` broadcast (the frontend's
`resolveSourceName` in `lib/streaming/sourceSummary.ts` and `SourceSection`'s row
label). So the rule fires once, in `fromEngineDevice()`
(`modules/streaming/devices.ts`), which every engine-device consumer flows through
— the `sources` builder, the legacy `devices` broadcast, and the persisted
`last_seen_devices` snapshots alike. Two supporting sites: `buildDeviceList()`
(the engine-down v4l2 fallback scan reads the same `rk_hdmirx` from
`/sys/class/video4linux/*/name`) and `buildLostEntry()` in `sources.ts` (a
snapshot persisted BEFORE this rule existed still holds the raw id, so it is
re-applied on read).

**Display-only, and the raw name still drives classification.** `input_id`,
`device_path`, and `stable_id` are untouched — routing is byte-identical — and
`mapEngineDeviceKind`/`deriveKind` are still passed the RAW string, so the kind
heuristic sees exactly what the engine reported.

Coverage: `tests/onboard-video-display-name.test.ts` (the pure rule, both device
seams, the rendered `sources` payload, and the lost row — the last two assert the
serialized payload contains no `rk_hdmirx` at all).

## IDLE AUDIO-METER DEVICE PREFERENCE [EXISTS]

The engine's ALWAYS-ON level meter (ADR-0007) used to pick its own ALSA card while
idle, entirely independent of the operator's **Audio source** selection. Found live on
a board: the operator selected the RØDE, `SourceSection` showed the RØDE, and the meter
reported the DJI Mic Mini (or "Meter unavailable") — because with two healthy cards the
engine's candidate list is ordered by enumeration and `"DJI Technology…"` sorts first.

`config.asrc` now reaches the engine's idle meter:

- **`resolveMeterPreference(asrc)`** (`modules/streaming/audio.ts`) turns the picker
  value into the ALSA device the meter should prefer, or `null` for "engine, choose for
  yourself". `null` covers both pipeline pseudo-sources (`"No audio"` /
  `"Pipeline default"`), an unset `asrc`, an `"Auto"` that resolves to no single card,
  and anything that resolves to no card. It reuses the SAME `audioDevices` map + alias
  reverse-lookup + `hw:CARD=` wrapping that `resolveAudioMode` uses for `start`, so the
  meter and the program leg can never disagree about which card a pick names. It is
  deliberately NOT `resolveAudioMode`: this is the IDLE meter, which has no notion of
  network-embedded program audio and must keep following the card the picker is showing.
- **`"Auto"` is NOT a hand-back — it is resolved, by the SAME rule the start path uses.**
  `resolveEffectiveAudioPick(asrc)` maps the sentinel through
  `resolveAutoAsrcFromLiveState()` (`auto-audio.ts`) and hands the resulting picker key
  to both `resolveMeterPreference` and `isMeterPreferenceDevicePresent`; every other pick
  passes through verbatim. This is a CORRECTION, not an addition: `"Auto"` short-circuited
  to `null` back when it really did mean "engine, you choose", and `resolveAutoAsrc` ended
  that by making it deterministic (an HDMI video source follows `rockchiphdmiin` by rule 3,
  a USB camera follows its `physical_group_id` sibling by rule 5). While the meter kept the
  old reading, the sentence directly above it — the meter and the program leg can never
  disagree about which card a pick names — was FALSE for the single most common pick on the
  device. Found live on a Rock 5B+: HDMI selected with `"Audio source: Auto"` drew the RØDE
  USB card's real, MOVING bars, because (a) a `null` preference told the engine to auto-pick
  and it picked the only card it could open, and (b) `isForeignCardLevel` needs BOTH sides to
  name a card, so `null` also disarmed the gate that exists to refuse exactly that reading.
  The HDMI-RX audio half owns NO capture PCM, so the very pick the meter was decorating with
  another device's audio is one whose own `start` fails `audio-device-unavailable`. An `"Auto"`
  that resolves to no single card (`embedded` / `pipeline-default` /
  `ambiguous-same-device-audio` / `no-same-device-audio`) still answers `null` — those are the
  outcomes the UI turns into their own prompts, and pinning them would leave the meter dead.
  The resolver is a PARAMETER on both functions (defaulted to the live-state one) because it
  reads `config.source` + the sources list + the engine audio list; a test must be able to pin
  one resolution without assembling that graph. It is FAIL-OPEN: a throw yields `undefined`,
  i.e. the engine's own pick, because this runs on every broadcast.
- **The `audio-meter-bridge` delivers it**, because it already holds the ONE long-lived
  IDLE connection to the engine (`cerastream-backend.ts`'s client only exists while
  streaming). `pushPreference()` sends `reload-config` with
  `{ audio: { meter_device } }`.
- **`syncAudioMeterPreference()`** re-pushes on change. FOUR call sites, and the last
  three exist because an UNCHANGED pick can still resolve to a different card: the
  bridge's own `runAttempt` (every fresh connect — the engine holds NO preference across
  a restart), `streaming.setConfig` when `input.asrc` **or `input.source`** changed,
  `updateAudioDevices` (a re-enumeration), and `reresolveAudioForEngineChange` (a changed
  engine audio list). The `input.source` and engine-list sites are BOTH consequences of
  `"Auto"` being resolved rather than handed back: rule 3 keys on the selected VIDEO
  source and rule 5 joins through the ENGINE's audio list, so switching camera → HDMI, or
  the engine's audio enumeration landing seconds after a hotplug, each move the resolved
  card with `config.asrc` untouched. Re-pushing an unchanged pick is free — the bridge
  dedupes on the `(silenced, preference)` PAIR, so it broadcasts no gap — but SKIPPING a
  changed one is not: the engine's `set_preferred_device` early-returns on an unchanged
  value, so nothing later corrects it and the meter reports the previous device
  indefinitely.

**Why `reload-config` and not `switch-audio`.** `switch-audio` is stream-only — it
answers `-32001 cerastream.state.not_streaming` while idle, which is exactly when the
idle meter runs. `reload-config` already carries an `audio` section and is idle-safe on
the engine side (it no-ops against an absent session).

**Three wire states, and they are NOT interchangeable.** `audio.meter_device` ABSENT
leaves the engine's preference unchanged (so `reloadAudioDelay`'s delay-only reload can
never clear it), explicit `null` restores the engine's own delivery-based auto-pick, and
a string prefers that card. Never send `undefined` expecting "Auto".

**Sent over `rawRequest`, gated on schema ≥ 0.9.0.** The published
`@ceralive/cerastream` client Zod-STRIPS the additive `meter_device` key, so the typed
`reloadConfig()` would silently drop it — same constraint as `audio.mode` and
`video_passthrough`. `supportsMeterDevicePreference(schemaVersion)`
(`cerastream-backend.ts`) is the fail-safe gate: an older engine is sent nothing and
keeps auto-picking, which is the exact pre-0.9.0 behaviour.

**It is a PREFERENCE, not a pin — and the engine is what guarantees that.** cerastream
only moves the named card to the head of its candidate list; its delivery-confirmation
demotion (a card holding the ALSA handle for 2 s without clocking a sample yields to the
next candidate, cerastream PR #71 / ADR-0007 §10–§11) is unchanged. So selecting a
powered-off receiver still ends on a working card, never on a permanently dead meter.
Do NOT add a CeraUI-side "force this device" path that tries to override that.

A failed push NEVER breaks the meter: `pushPreference` swallows and logs, the previous
preference stands, and the next config change or reconnect re-pushes.

**Because it is only a preference, the bridge must also REFUSE another card's audio.**
The engine reorders candidates but still meters whatever it CAN open, so an unopenable
selection leaves real, moving bars on screen that belong to a different device — the
meter lies rather than goes quiet. Found live on a Rock 5B+ with nothing plugged into
the HDMI-RX port: the operator selected `HDMI Input`, and the meter reported the RØDE
(`card:usbaudio`, rms ≈ −30 dBFS ⇒ ~49% fill on BOTH channels), which reads as healthy
embedded HDMI audio. `projectLevel()` therefore drops a level whose reported
`source.identity` names a different ALSA card than `meterPreference()` and broadcasts
the ADR's existing `unavailable` + `no_device` gap instead. `alsaCardKey()` reduces both
sides to the bare card id (mirroring cerastream's own `alsa_card_key`), so
`hw:CARD=x` / `plughw:CARD=x,DEV=0` / `card:x` all compare equal.

**It can only ever suppress a reading PROVEN foreign.** `isForeignCardLevel` returns
false unless BOTH sides name a card: a `null` preference has genuinely delegated the
choice, and an engine that reports no identity cannot be shown to mismatch. Note what
this means in the other direction — a preference that is wrongly `null` does not merely
fail to be pushed, it DISARMS this gate, so the two halves of the `"Auto"` defect above
compound instead of one covering for the other. A resolved `"Auto"` reaches here as a
real card and is gated exactly like a manual pick; only the `"Auto"` outcomes that name
no single card still arrive as `null`. An engine-sent `unavailable` passes through with
its OWN reason. Do NOT "simplify" this
by gating on the video-side `signal` field — audio and video are separate device lists
with no shared identifier (see "THREE capture-row states"), and the audio card's own
absence is the direct, device-agnostic evidence.

**Why an absent HDMI signal is genuinely NO audio, not silence.** Verified on the board:
without a signal the RK3588 `rockchiphdmiin` card still lists in `/proc/asound/cards` but
exposes NO capture PCM substream (no `card3/pcm0c`), `alsasrc device=hw:CARD=rockchiphdmiin`
fails `No such file or directory`, and the card never appears in the engine's
`list-devices` at all — so the preference is inert rather than merely losing. HDMI
embedded audio is therefore unavailable, never noise-that-reads-as-signal; a device that
DOES deliver audio without video still enumerates, still matches, and still meters.

**A suppressed reading must name the RIGHT gap, and must not be permanent.** The gate
above is correct to refuse another card's audio; two things about how it did so were
not. It reported every suppression as `no_device` ("No audio device") — a claim CeraUI
can prove false, because the selected card was still in its own `/sys/class/sound` list.
A mis-bound preference was therefore indistinguishable from an unplugged cable, and a
live investigation went looking for a missing config write that never existed. And it
never re-tried: the engine's `set_preferred_device` early-returns on an unchanged value,
so a plain re-push is inert, a card demoted for not delivering during its probe window
stays demoted while any other candidate keeps delivering, and a preference pushed while
the card was absent from the engine's registry stays inert. The meter was dead
indefinitely for a present device, with no recovery short of the operator re-picking.

- `foreignCardReason()` answers `not_selected_device` (additive
  `AUDIO_LEVEL_UNAVAILABLE_REASONS` member, copy in all 10 locales) when
  `isMeterPreferenceDevicePresent()` — an `audio.ts` predicate keyed on the PICKER
  VALUE, not the resolved ALSA string — says CeraUI still lists the pick. A selection
  CeraUI can no longer see keeps `no_device`, unchanged. Keying on the picker value is
  deliberate: a pick that is not a device-map key resolves through the alias fallback to
  a card CeraUI cannot vouch for, and must not claim presence.
- **LISTED IS NOT USABLE — presence requires a CAPTURE PCM.** The predicate above
  originally asked only `asrc in audioDevices`, i.e. "did CeraUI's `/sys/class/sound`
  scan see this card". That is not the same question. The RK3588 HDMI-RX enumerates
  PERMANENTLY — it is in the scan and in the picker whether or not a cable is live —
  so with "HDMI Input" selected the meter reported `not_selected_device` ("Not the
  selected device"), asserting a mismatch that does not exist for a card nothing can
  ever meter. Confirmed live: `/proc/asound/pcm` carries
  `03-00: rockchip,hdmiin i2s-hifi-0 : ` with NO `capture N` field, and
  `/sys/class/sound/card3/` has no `pcmC3D0c` node, while every working card does
  (`05-00: USB Audio : USB Audio : capture 1`, `pcmC5D0c`). This is EXACTLY the
  "absent HDMI signal is genuinely NO audio" case documented two paragraphs above, so
  it must report the SAME gap: `no_device`. `updateAudioDevices` therefore also records
  `audioCaptureCardIds` — the scanned cards owning at least one capture PCM, decided by
  the pure `hasCapturePcmNode(entries)` (ALSA names capture substreams
  `pcmC<card>D<device>c`; the `c` suffix IS the rule) — and presence now requires the
  pick to resolve to a card in THAT set. Same semantics as cerastream's
  `capture_card_ids()` (PR #73), which intersects `/proc/asound/cards` with the
  `capture N` fields of `/proc/asound/pcm`; asked here of the sysfs tree the audio scan
  already walks, so it costs no extra source of truth.
- **The card stays in the PICKER.** `audioCaptureCardIds` is a parallel set, never a
  filter on `audioDevices`: the operator selected that PORT and a signal can arrive at
  any moment, so removing the row would be a regression (and would change `asrcs` on
  the wire). Only claims that the card can DELIVER audio are gated on it.
- `noteForeignCardLevel()` re-asserts the preference **through `null`** — the only way
  to make the value change, so the engine clears its demotions and re-probes — after
  `AUDIO_METER_MISMATCH_GRACE_MS` (5 s) of uninterrupted foreign readings, at most once
  per `AUDIO_METER_REASSERT_INTERVAL_MS` (30 s). Bounded on both sides so a mismatch
  that is simply permanent (a selected card with no capture PCM) costs one cheap reload
  pair per interval and never a loop. One `warn` per episode names the selected card;
  the live investigation had zero signal because nothing was logged at all.

The gate itself is unchanged: a level whose `source.identity` names a different card
than the preference is still dropped. Only the reason string and the retry behaviour
moved. `AudioLevelMeter` needed no change — it already resolves the dynamic Paraglide
key with `resolveMessageKey(\`live.preview.audioUnavailableReason.${reason}\`)`.

**THE RECOVERY PATH MUST NOT BE GATED ON THE SIGNAL WHOSE ABSENCE IS THE FAILURE.**
`noteForeignCardLevel` watches frame CONTENT, so it can only ever run while frames
arrive — and the meter's worst failure is that they STOP. Confirmed live on a Rock
5B+: a changed pick published its `handoff` gap and the engine's level feed went
silent 2 ms later (last `audio-level` broadcast `23:34:27.615Z`, board clock
`23:48:25Z`), so the gap was the last thing the frontend was ever told and the meter
read a bare `Meter unavailable` — no reason suffix, because no frame was reaching
the browser at all — for 14 minutes with no operator action. With ZERO frames there
are no foreign readings to accumulate, the 5 s grace window never elapses, the
re-assert never fires, and every documented sync trigger (`asrc`/`source` change,
`updateAudioDevices`, `reresolveAudioForEngineChange`, bridge reconnect) is
EDGE-triggered on things that had all gone still. Same raise-but-never-retract family
as `policy_route_missing` and `active_encode` on stop; the difference is that the
un-retracted state lives in the ENGINE's meter sidecar.

`AUDIO_METER_FRAME_ABSENCE_MS` (2 500 ms) + `armFrameAbsenceWatchdog` /
`noteFrameAbsence` are the frame-ABSENCE half, sitting beside the content half:

- **It is a DEBOUNCE on arrival, not a poll.** Every `audio-level` event re-arms the
  deadline (ahead of the broadcast, so a throwing consumer cannot leave the feed
  unwatched), so expiry is ITSELF the proof that no frame arrived — no clock compare
  — and an UNARMED watchdog is exactly a connection that has not delivered a frame
  yet. That is how the "never fire before the first frame of a fresh connect" rule is
  satisfied by construction rather than by a second flag, mirroring
  `noteMeterSelection`'s first-connect silence.
- **2 500 ms is ~12 missed frames** at the sidecar's 5 Hz cadence — beyond event-loop
  jitter, a GC pause, or one re-subscribe on the binding's `autoReconnect`.
  Deliberately SHORTER than the 5 s content grace: absence is unambiguous, where a
  foreign reading deserves time to be corrected by the next frame.
- **ONE escape hatch, two triggers.** It calls the same `reassertPreference()`
  (through `null`) and shares `lastReassertAt`, so the two watchdogs cannot double up
  and a permanently-dead card still costs one cheap reload pair per
  `AUDIO_METER_REASSERT_INTERVAL_MS`. `reassertPreference(cause)` names which
  watchdog asked, so the log distinguishes a wrong card from a dead feed.
- **It never fires for a silenced pick** (`meterSilenced()` — the operator asked for
  silence) **nor for `null`** (Auto: the engine owns that selection). Both gates run
  AFTER the re-arm, so a feed that is silent for a reason we refuse to act on today
  is still being watched when that reason changes.
- **A missing client is the one case that does NOT re-arm** — there is nothing to
  re-assert against, and the next connect's first frame arms it again.
  `stopAudioMeterBridge` clears it.
- **It yields to a stream LAUNCH** (`launchInFlight()`), and so does the
  content watchdog — see the section below.

**A RE-ASSERT IS AN ACQUISITION, SO IT MUST NEVER RACE A LAUNCH.** Both watchdogs
recover through the same `reassertPreference`, which re-OPENS the selected card.
A launch RELEASES the idle meter on purpose (`audio_meter_begin_stream()`), so
levels legitimately stop — and `noteFrameAbsence` read those ~12 missed frames as
a stuck feed and grabbed the card back while the start's pre-flight was still
opening it. Measured on a Rock 5B+ with a DJI Osmo Pocket 3:

```
20:03:22.466  streaming.start issued
20:03:25.024  audio-meter bridge: no audio level for 2500 ms … re-asserting
20:03:25.026  audio-meter bridge: re-asserted the preference hw:CARD=DJIPocket3
20:03:27.142  audio-device-unavailable: ALSA capture device 'hw:CARD=DJIPocket3'
              is busy or unavailable   class=start_invalid retry=not_retriable
```

`deferReassertToLaunch()` gates both watchdogs on
`launchIsAcquiringAudio(getStreamLifecycleState())` — the lifecycle the
orchestrator already publishes, NOT a parallel signal. Three properties are
load-bearing:

- **`starting` is the ONLY gated state.** A successful launch leaves for
  `streaming` and a failed one for `idle`, so BOTH outcomes re-arm the watchdog
  immediately, and the state is bounded by the launch phase deadlines — the
  deferral can never become a permanent suppression. `reconfiguring` is excluded
  because it runs from `streaming`, where the idle meter does not hold the card.
- **The gate sits immediately BEFORE `lastReassertAt` is stamped**, so a deferred
  window does not spend the 30 s floor. Moving it one line later silently turns a
  deferral into half a minute of real suppression after the launch resolved.
- **The re-arm still happens above every gate** (unchanged), so a genuinely dead
  feed is watched throughout the launch and recovers on the very next window.

**This is necessary but NOT sufficient, and the remainder is engine-side.** It
removes ONE of two acquirers. The other is the idle meter's ordinary hold:
`syncAudioMeterPreference` pushes the preference on a source/`asrc` change, the
engine opens the card for the idle meter, and a launch seconds later needs that
same card. Board measurement with the watchdog gated and cerastream's bounded
1.5 s self-release retry deployed: 0/5 clean starts when the source is re-selected
just before starting, 2/5 when it is not — the same rate as before the gate. CeraUI
cannot close it: the engine has no "meter nothing" value (`meter_device: null`
means *auto-pick*, which re-opens a card rather than releasing one), so the
idle-meter → stream handoff can only be made atomic inside cerastream. Do NOT
"fix" the remainder by widening this gate to `streaming`, and do NOT delete the
gate because the start still fails — the watchdog re-acquisition is a real,
separately-proven racer.

**"No audio" is NOT "Auto", and only the picker value can tell them apart.**
`resolveMeterPreference` answered `null` for both, and `null` on the wire means
"engine, choose for yourself" — so the one pick that means *meter nothing* made the
engine auto-pick a card AND left `isForeignCardLevel` unarmed (it returns `false` for
a `null` preference by design). The meter therefore rendered another card's real,
moving audio under an "Audio source: No audio" label. (`"Auto"` no longer shares that
`null` — see the resolution bullet above — but `"No audio"` still resolves to one, so
this distinction remains load-bearing and is still the FIRST branch `projectLevel`
applies. The two defects are the same shape reached by different picks.) Found live in Wave H QA; it read
as a transient "few seconds of green bars" only because PR #232's frozen-content
watchdog happened to age the bars out once that card's content stopped changing.
`isMeterSilencedByPick(asrc)` (`audio.ts`, true for `NO_AUDIO_ID` alone) is the
distinction, and `projectLevel` applies it BEFORE every other branch — including the
engine's own `unavailable` reason, because the operator's explicit silence outranks
whatever gap the engine is reporting. It reuses the existing `mode_none` reason
(`resolveAudioMode("No audio")` is literally `{mode:"none"}`), so no schema or locale
change was needed. `DEFAULT_AUDIO_ID` and `AUDIO_SOURCE_AUTO` are deliberately NOT
silenced: the pipeline default really does hand sourcing to the engine, and `"Auto"` is
resolved to a concrete card instead (so it is gated on THAT card, never silenced).
Neither means "meter nothing".

**A pick change retires the level already on screen, without waiting for a frame.**
Every gate above acts on the NEXT event the engine sends, and the engine needs a
moment to re-point its sidecar — so between the config write and that event the meter
keeps drawing the PREVIOUS device's bars. `noteMeterSelection()` broadcasts the gap
immediately on a changed pick: `mode_none` when the new pick is silenced, `handoff`
otherwise. Three properties are load-bearing:

- **The change key is the PAIR** `(silenced, preference)` — "Auto" and "No audio" both
  resolve to a `null` preference, so a preference-only diff cannot see that switch.
- **It fires even while the bridge is disconnected.** `syncAudioMeterPreference()`
  calls it BEFORE the client check: the stale level was already broadcast, so it must
  be retired whether or not the engine can be told about the change yet.
- **It never fires on the first connect** (no prior selection recorded ⇒ nothing has
  been shown) nor on a re-enumeration that re-syncs an UNCHANGED pick — otherwise
  `updateAudioDevices` would blink the meter on every hotplug.

This is a re-evaluation, never a pin: the very next real level replaces the gap.

Coverage for both: `tests/audio-meter-bridge.test.ts` (the silenced pick vs. Auto at
the same `null` preference, the engine-reason override, no re-assert while silenced,
the switching gap before any frame, the Auto→No-audio pair key, the unchanged-pick and
first-connect silences, the disconnected path, and the hand-back to the new device).

Coverage: `tests/audio-meter-bridge.test.ts` (push on connect, `null` for Auto, re-push
on change, nothing sent to a pre-0.9.0 engine, a refused reload leaves levels flowing,
no-op while down, the schema gate, plus the foreign-card gate: suppressed mismatch,
untouched match, never-gated Auto/identity-less, passthrough `unavailable`, the
`alsaCardKey`/`isForeignCardLevel` unit table, and the reason/re-assert behaviour:
`not_selected_device` vs `no_device`, the grace window, the interval floor, and the
run reset; plus the frame-absence watchdog: the feed that simply stops, the shared
interval floor, the shared floor ACROSS both watchdogs, exactly one armed watchdog
per feed, no fire before the first frame of a fresh connect, the silenced and Auto
negatives, `stop()` disarming it, and a refused re-assert leaving levels flowing)
and `tests/audio-sources.test.ts` (`resolveMeterPreference` — alias,
no-alias, every `null` case, selector passthrough; plus `hasCapturePcmNode` and the
capture-PCM presence rule: a listed card with zero capture PCM is absent, a card that
owns one is present, the same card flips once its capture PCM appears, and an unlisted
pick stays absent — driven through a real sysfs-shaped fixture dir).

## AN ISOLATED DONGLE IS SURFACED WITHOUT ENTERING THE BOND [PARTIAL — reader only; the PRODUCER is retired]

**READ THIS FIRST: the producer described below no longer exists.** Phase-C todo
39 retired the image's router-dongle netns layer, so nothing writes
`/run/ceralive/dongles/dongle<N>.json` on any image going forward and the classified
dongle bonds through its OWN `enx…`/`eth…` interface instead (see …AND IT IS NAMED
CELLULAR WITHOUT WAITING FOR THAT LAYER). The reader below is KEPT, deliberately
and indefinitely: it is what lets a board still running an old netns image and a
board running a post-retirement image degrade to the SAME honest silence, so
deleting it would turn a graceful degradation into a crash on exactly the fleet
that still has the files. Its steady state is now "the directory is not there",
and that is a tested claim rather than an assumption —
`tests/dongle-metadata.test.ts` proves it against `defaultDongleMetadataDeps`
itself, not only against the injected seam. Everything from here down describes a
layer that WAS shipped and is being torn down; do not build anything new on it.

A router-mode USB dongle (Huawei HiLink, ZTE MF79U and relatives) hands the host
an address from its OWN embedded DHCP server, so two units of one model lease the
host the SAME address on the SAME subnet — board-confirmed on the bench, where two
physically distinct HiLink units also share one factory MAC (`0c:5b:8f:27:9a:64`)
and both lease `192.168.8.100`. The device image resolves that by claiming each
dongle into its own network namespace and handing the host a unique
`10.208.<N>.1/30` over a veth pair named `dg<N>h`
(image-building-pipeline `docs/dongle-netns-contract.md`).

`modules/network/dongle-metadata.ts` is CeraUI's INDEPENDENT reader of that
layer's runtime metadata (`/run/ceralive/dongles/dongle<N>.json`, schema v1).

- **The schema is a MIRROR, never an import.** Rule D forbids reaching into a
  sibling checkout, and the contract itself (§6.1 Rule-D note) states each repo
  carries its own reader and its own fixtures. `tests/dongle-metadata.test.ts` is
  what proves the mirror still matches the producer.
- **Every rejection is silent to the caller and logged ONCE per file+reason.** An
  unknown `version` is ignored and the file is left alone (§6.1: a reader "does
  not guess, and it does not delete"); a malformed record, a record missing a
  non-nullable field, and a record whose heartbeat has gone stale are all ignored
  the same way. Nothing here throws — it runs inside the netif poll.
- **Stale is `3 x` the 30 s heartbeat (90 s), not one missed beat.** One delayed
  heartbeat under load must never demote a healthy streaming link. A FUTURE
  timestamp (clock skew) is not stale.
- **`driver` is typed as a string, not the contract's three-value enum.** §6.1
  permits additive-optional evolution within v1 and requires a reader to ignore
  what it does not know, so rejecting a record for naming a fourth USB-ethernet
  driver would drop a working dongle over a field this consumer never reads.
- **A veth claimed by TWO records is ambiguous and NEITHER is trusted.** Picking
  either would attribute one dongle's state to the other — the duplicate-MAC pair
  above is exactly why that is not hypothetical.

**The marker is stamped onto the WIRE PROJECTION only** (`applyDongleProjection`
in `network-interfaces.ts`), and that is the whole safety argument:

- a live `dg<N>h` row gains `dongle: {slot, state}`;
- an `acquiring`/`down` dongle is UNIONED IN as a wire-only row (no `ip`,
  `enabled: false`, zero counters). Its veth is administratively DOWN and
  address-less, so it is not RUNNING and never enters the live `netif` map at
  all — and `genSrtlaIpList` reads THAT map's `enabled && ip`, so bonding is
  untouched BY CONSTRUCTION rather than by a filter someone could remove. Do NOT
  "simplify" this by inserting union rows into the map and filtering later.
- **The marker is RETRACTABLE, and that is not optional.** Publishing it
  true-only would repeat the `policy_route_missing` latch: the frontend merge
  preserves an omitted optional field, so a marker could be raised and never
  lowered. On release the backend emits `dongle: null` for exactly ONE frame — on
  the live row when it still has one, as a bare wire-only row when it does not —
  and plain absence still means "not a dongle" for a row never marked.

**The FRONTEND ingestion seam is an explicit edit, not a consequence.**
`subscriptions.svelte.ts` `case "netif"` rebuilds each entry from a
hand-maintained allowlist, so `dongle` had to be added there (spread-when-present)
or it would be dropped between the socket and `getNetif()` — the exact seam where
`tx_bps` once shipped "fully green" and rendered 0 kbps on hardware. It ALSO
prunes any row whose `dongle: null` frame arrives, including a released LIVE
dongle's `dg<N>h` row: that merge never deletes rows, so without the prune a
released dongle ghosts forever with its last IP.

**Three collaborators were extended, each minimally:**

- `policy-route-check.ts` gained `dg\d+h` ONLY. The dongle's routing table is
  named after the interface (contract §3.2), so it verifies through the existing
  derivation with no special case. **`enx*` is deliberately NOT added** — the
  image dispatcher maps only `enx*0`..`enx*7` by the ifname's LAST character, so
  roughly half of correctly-working `enx` adapters have no source rule and would
  false-flag amber. That dispatcher gap is a documented contract limitation, not
  a fault this check may report.
- `link-telemetry.ts`'s default iface resolver prefers the dongle's slot label
  (`dongle<N>`) for a `dg<N>h` row; every other interface keeps the unchanged
  first-IP-match name.
- `network-interfaces.ts` re-queues gateway election on every topology edge via
  `setQueueUpdateGwHook`. `gateways.ts`'s `updateGwQueue` is ONE-SHOT — cleared
  after a successful election, after which the periodic caller exits forever — so
  a default route lost later was never re-elected. The hook is INSTALLED BY
  `initNetworkInterfaceMonitoring` rather than statically imported: `gateways.ts`
  imports this module (a static edge back would cycle), and an unwired default
  keeps a parser-only test from dialing real DNS through `updateGw`.

**A dongle state change is invisible to the netif diff**, because a gated veth is
not in the map that diff compares. `refreshDongleState` therefore broadcasts
directly on a real edge (and re-queues gateway election), instead of relying on
`triggerNetworkInterfacesChange`.

Coverage: `tests/dongle-metadata.test.ts` (the reader matrix — valid, unknown
version, missing field, malformed, stale boundary in both directions, clock skew,
ambiguity, and the cache's edge reporting, PLUS the post-retirement block that
drives the SHIPPED `defaultDongleMetadataDeps` against an absent
`/run/ceralive/dongles` and a stale left-behind file),
`tests/dongle-netif-marker.test.ts`
(marker stamping, both union states, the union-row-vs-empty-bonded-list
assertion, both retraction shapes and their once-only property, dup-IP
preservation against the real bench collision, the policy-route candidate table
— now asserting a `dg*` veth is NOT collected — and the gateway re-queue edge),
`tests/link-telemetry-dongle-label.test.ts`
(driven through the REAL lazy-import resolver), and the frontend half
`apps/frontend/src/tests/netif-dongle-ingestion.test.ts`.

**Honest status:** no claim has been exercised against a physical dongle. The
producing layer is itself `[PARTIAL — implemented + statically gated, never run
against a real dongle]`, so every fixture here models the contract, not a board.

## …AND IT IS NAMED CELLULAR WITHOUT WAITING FOR THAT LAYER [EXISTS]

Everything above depends on the device image's netns manager writing
`/run/ceralive/dongles/*.json`. **No shipped image writes it.** So on every board
in the field a router-mode cellular dongle rendered as a nameless row under
"Ethernet" — no badge, no cellular treatment, nothing saying what it was.
Operator-reported, and reproduced on the bench: three such dongles, three
anonymous wired rows.

The descriptors that identify them were there the whole time.
`modules/network/usb-net-classifier.ts` (pure) + `router-cellular-scan.ts`
(sysfs + cache) read them and stamp a `router_cellular` marker on the netif wire
projection, with NO dependency on the netns layer, ModemManager, or any spawn.

**THE INTERFACE NAME IS NEVER AN INPUT.** Not a prefix, not a suffix, nowhere.
This bench is the proof: its two Huawei HiLink units are physically distinct
devices shipping ONE factory MAC, so the predictable-naming scheme can only name
one of them — `enx0c5b8f279a64` — and its twin falls back to `eth1`. A rule keyed
on `enx*` badges one and misses the other; a rule keyed on `eth*` does the
reverse. `classifyUsbNetDevice` is not even GIVEN a name (`UsbNetDevice` has no
such field), so the property holds by construction rather than by discipline.

**The RULE is a Rule-D mirror of modem-stack's
`control/src/backend/device-classifier.ts`**, re-derived from the same USB-IF
class codes and driver names, never imported. Precedence is that file's,
unchanged: a recognized MBIM/QMI/AT control port ⇒ `mm-managed`; an ECM / NCM /
RNDIS / CDC-data tether with NO control port ⇒ the router class; anything else ⇒
`unknown`, with an honest reason.

**One thing is ADDED, and it is the difference between the two repos' questions.**
modem-stack asks "can ModemManager drive this", so its `router-mode` verdict
means "a tether with no control port" — which is equally true of a plain
USB-to-Ethernet adapter. CeraUI is about to print the word CELLULAR on an
operator's screen, so the tether verdict alone is not enough. `cellularEvidence()`
requires a POSITIVE signal before `router-cellular` is claimed, and a tether with
none is reported as `wired-ethernet` — "this is a USB network adapter", said
plainly, rather than a guess. Two independent signals, either sufficient:

- a **known cellular vendor id** (`CELLULAR_USB_VENDOR_IDS`; both bench dongles
  are covered — `12d1` Huawei, `19d2` ZTE). The table is consulted ONLY after the
  descriptors have already proven a control-port-less tether, so a vendor id
  never classifies anything on its own and a Huawei keyboard is not a modem;
- a **mass-storage companion interface** on the same physical device — the ZeroCD
  installer LUN every router-mode dongle carries and no plain USB NIC does. This
  one is vendor-agnostic, so an unlisted vendor's dongle is still recognised
  (covered by a test). A `ID_USB_MODESWITCH` udev property counts as the same
  signal where udev supplies one.

**The read is sysfs, not `udevadm`, and that is deliberate.**
`/sys/class/net/<if>/device` names the USB INTERFACE; its PARENT is the physical
device, and only from there are the vendor/product ids and the SIBLING interfaces
visible. Reading the netdev's own interface alone would miss both the
mass-storage companion and the AT/QMI ports — i.e. exactly the descriptors the
classification turns on. Nothing is spawned, so this costs nothing on the 5 s
netif cadence and has no failure mode a spawn has. It is also the same source the
bench inventory sweep reads, so a captured fixture is byte-comparable.

**`duplicate_model` is MEASURED, never assumed.** It is true only when another
classified router-cellular device attached RIGHT NOW reports the same `vid_pid`,
so it is resolved across the whole scan result rather than one interface at a
time. Same model ⇒ same factory LAN subnet ⇒ both lease the host the same address
— board-confirmed, with both HiLink units handing out `192.168.8.100`. That is
what finally explains the `NETIF_ERR_DUPIPV4` exclusion the operator could
previously only see as an unexplained "Off".

**The marker is RETRACTABLE, and its retraction is NOT the dongle marker's.**
`applyRouterCellularProjection` emits one explicit `router_cellular: null` when a
name stops classifying, for the same latch reason as everything else on this wire.
But unlike `applyDongleProjection` it **never unions a row in** (the
classification is a statement about an interface the netif scan already
enumerated) and its `null` **keeps the row** (the interface is still there; it
merely stopped classifying). The frontend ingestion deletes the FIELD, not the
row. Do NOT "unify" the two projections.

Coverage: `tests/router-cellular-classification.test.ts` — every device fixture
is a verbatim sysfs transcription from the bench board (both HiLinks, the ZTE,
the Quectel RM530N-GL, the SIMCom), plus the plain-USB-NIC negative, the
unlisted-vendor-by-ZeroCD case, the `duplicate_model` pair-vs-lone table, the
projection, the one-frame retraction, and the name-independence proof (every
interface renamed to a prefix no rule could have an opinion about; verdicts
unchanged). Frontend half: `apps/frontend/AGENTS.md` → "A dongle is named
CELLULAR from its descriptors".

### …AND TWO OVERLAPPING SWEEPS CANNOT COMMIT OUT OF ORDER [EXISTS]

`refreshUsbNetMarkers` is driven by the 5 s netif cadence AND by anything else
wanting a fresh marker set, so two sweeps of the same sysfs tree can be in flight
at once — and a replug, which is what prompts the second sweep, is also what
makes the reads slow. Last-writer-wins meant an OLDER sweep landing late
overwrote a NEWER one's view of the very topology change that triggered it: the
retired dongle's markers, `stable_key` and physical descriptors all came back,
and nothing re-poked until the next cadence tick. Same defect class, and the same
remedy, as `sources.ts`'s `hotplugRefreshGeneration`.

- **A ticket is taken BEFORE the read and checked AFTER it.** A completion whose
  generation is no longer the newest writes nothing and answers `false` — it
  published no edge, and the sweep that fenced it out reports the real one. Only
  the newest generation can reach the commit, so the `snapshotKey` "did anything
  change" comparison is taken at commit time rather than before the read.
- **Single-flight JOINS an identical request** — same interface set AND the same
  `deps` OBJECT (identity, not shape: two different deps read two different
  trees, which is exactly what a fixture does). A second sweep of the same tree
  could only answer the same question twice and race its own twin.
- **A DIFFERENT request is never coalesced.** It starts its own sweep, takes a
  newer ticket, and fences the earlier one out — coalescing on the ifname set
  alone would answer one question with another's data.
- **The fence is scoped to THIS domain and must stay that way.** The counter
  covers the three marker caches in `router-cellular-scan.ts` and nothing else;
  putting the modem, dongle-metadata or policy-route sweeps behind one shared
  gate would let an unrelated slow read stall this one for no correctness gain.
- **`resetUsbNetMarkers()` bumps the generation too**, so a sweep still reading
  when a test resets cannot repopulate the caches that reset just cleared.

Coverage: `tests/usb-net-scan-fencing.test.ts` — the out-of-order case driven by
a manually-resolved gate (the older sweep is parked at its first sysfs read and
the newer one is AWAITED to completion before the gate opens, so the ordering is
controlled rather than timed), with a non-vacuity check that the older tree
really does describe a different SKU; plus the natural-order fence, the
join-don't-re-read proof by read count, the two-different-requests negative, the
reset fence, and the sequential control. Rule-E proof in both directions:
neutering the generation check reddens 3 tests, neutering the join reddens 1.

## …AND A DONGLE THAT NAMES A CLASS IS GIVEN ITS REAL MODEL [EXISTS]

The classification above was right and the NAME beside it was not. Both bench
HiLink units rendered as `HUAWEI_MOBILE · 12d1:14dc`, and the collision band read
"Another **HUAWEI_MOBILE** is attached" — operator-reported as a generic name
where a model belongs, and the two physically distinct units were indistinguishable
from each other.

**The device published ONE string for BOTH descriptors, so neither is an identity.**
`manufacturer` and `product` are both `HUAWEI_MOBILE`: that is a device CLASS, not a
vendor and not a model. `publishesGenericIdentity` (`usb-net-classifier.ts`) is that
MEASURED condition — the two trimmed strings comparing equal — never a name pattern,
never a vendor allowlist. A device that distinguished its two descriptors is
untouched and keeps its own words, typos included (the bench ZTE stays
`ZTE,Incorporated` / `ZTE Mobile Boardband`).

**The real model comes from udev's hwdb, and the ASYMMETRY is why the two labels
resolve differently.** `usb.ids` carries a MODEL for `12d1:14dc`
(`E3372 LTE/UMTS/GSM HiLink Modem/Networkcard`) and only a vendor for `19d2:1405`.
So `modelLabel` prefers `ID_MODEL_FROM_DATABASE` for a generic-identity device, while
`vendorLabel` prefers the curated `CELLULAR_USB_VENDOR_IDS` name over
`ID_VENDOR_FROM_DATABASE` — hwdb's vendor is the USB-IF REGISTRATION, which can name
a business unit rather than the brand on the casing (`19d2` registers as
`ZTE WCDMA Technologies MSM`, which would be a downgrade). Board-verified: both
HiLink rows now read `Huawei E3372 LTE/UMTS/GSM HiLink Modem/Networkcard`.

**THE READ IS OF THE PARENT USB DEVICE, AND THAT IS THE WHOLE POINT.** The second
HiLink's NETDEV has no udev properties at all — its database entry is a bare
`E:ID_RENAMING=1`. Root cause, confirmed on the board and **outside CeraUI**: the two
units ship ONE factory MAC (`0c:5b:8f:27:9a:64`), systemd's own
`/usr/lib/systemd/network/73-usb-net-by-mac.link` (`[Match] Path=*-usb-*`,
`[Link] NamePolicy=mac`) therefore derives the SAME name `enx0c5b8f279a64` for both,
the second rename fails `-EEXIST`, the interface keeps its kernel default `eth1`, and
udev never commits the rest of that device's properties. `udevadm info` on `eth1`
returns `DEVPATH`, `SUBSYSTEM`, `INTERFACE`, `IFINDEX`, `ID_RENAMING` and nothing
else. Its PARENT USB device is a separate udev device whose entry is complete, so
reading there makes the resolution immune to the collision instead of a victim of it
— and it is the same parent the descriptors already come from.

- **NOT a CeraUI defect, and NOT a CeraUI fix.** The duplicate MAC is a hardware
  fact about two same-model dongles; the naming collision is systemd's documented
  behaviour given that fact. The underlying identity problem is what the image's
  router-dongle netns layer exists to resolve (`image-building-pipeline`
  `docs/dongle-netns-contract.md`, whose per-slot claim keys on the USB `ID_PATH`
  precisely because MAC and ifname are both unreliable here); nothing in this repo
  should try to rename an interface. Do NOT add a udev rule, a `.link` override, or
  an ifname remap to CeraUI.
- **Read, never spawned.** `readUdevDatabaseNames` (`router-cellular-scan.ts`) parses
  `/run/udev/data/c<major>:<minor>` directly, keeping this module's zero-spawn posture
  on the 5 s netif cadence. USB devices are keyed by their CHARACTER-DEVICE number,
  not their bus id: usbfs is major 189 and packs 128 devices per bus, so
  `minor = (busnum - 1) * 128 + (devnum - 1)` from the device's own sysfs attributes.
- **The hwdb is an ENRICHMENT, never a requirement.** An image with no hwdb, a device
  udev has not processed, and an unreadable entry all leave the device NAMED — a
  missing model degrades to a worse LABEL, never to a blank identity.
- **…but the honest floor is the PRODUCT ID, never the class string.** The fallback
  chain used to end at the device's own published string, which is exactly the
  string `publishesGenericIdentity` had just MEASURED to be a class rather than an
  identity — so a device whose vid:pid usb.ids does not carry got its class name
  back. Board-confirmed (2026-08-17): two Qualcomm reference RNDIS sticks
  (`05c6:9024`, distinct serials `2b16081` / `c6125db3`) publish `Android` for BOTH
  descriptors, usb.ids has a VENDOR for `05c6` and no model, and both rows reached
  the operator titled **`Android`**. `vendorLabel`/`modelLabel` now answer
  `Qualcomm` + `9024`; `routerCellularDisplayName` composes the brand onto the
  descriptor answer as well as onto the admin one, so the row reads
  `Qualcomm 9024` — true, stable, and naming the silicon vendor USB-IF registered.
- **A twin pair gets a DISCRIMINATOR, and only a twin pair.** Two units of one SKU
  are identical in vendor, model and `vid_pid` alike, so `RouterCellularMarker.serial`
  (fed by `unitDiscriminator`, additive-optional on the wire) is the only thing that
  separates their rows — appended to the display name as `· <serial>`. It is
  withheld from a lone device (nothing to separate it from) and from a device that
  publishes no serial or republishes a string descriptor as one: the bench HiLink
  pair is a `duplicate_model` and still gets none, because none exists. Never
  fabricated, and never an input to any classification.

Coverage: `tests/router-cellular-classification.test.ts` — the bench fixtures gained
their real `busnum`/`devnum` and the verbatim `E:` lines from each device's own udev
entry, plus the recovered-model case, the device-named-itself negative (ZTE keeps its
own strings AND is not given hwdb's worse vendor), the no-udev fallback (now proving
it degrades to the product id and NOT back to the class string), and the twin-stick
naming/discriminator matrix incl. both withhold cases.

## …AND AN MM-MANAGED MODEM'S DATA FUNCTION IS NOT A SECOND DEVICE [EXISTS]

The same sysfs sweep answers a second question, and the answer had nowhere to go.
`classifyUsbNetDevice` returns `mm-managed` for a device carrying a recognized
MBIM/QMI/AT control port — ModemManager's, and therefore the Cellular section's —
and `scanRouterCellular` simply `continue`d past it. That was harmless while every
such modem's data path was a `wwan*` interface, because the frontend's
`isWiredSectionEntry` already excludes that prefix.

**An RNDIS data path is named after its MAC, and no prefix can reach it.**
Board-confirmed (2026-08-17): the bench Fibocom FM350-GL (`0e8d:7127`, seven
`option`-bound serial ports plus an RNDIS pair) is fully represented as
ModemManager modem 4 AND rendered a bare second Ethernet row `enx000011121314` —
no address, `UNKNOWN` state, no explanation. One physical device, drawn twice, the
second time as a mystery adapter.

- **The correlation is ModemManager's OWN, not a USB-parent heuristic.**
  `mmcli -m 4` reports `ports: enx000011121314 (net), ttyUSB12 (at)`, and
  `modem-registration.ts` already resolves `Modem.ifname` from exactly that field —
  so the modem row has always NAMED this interface. Nothing new had to be
  correlated; the Ethernet side simply had no way to recognise the claim.
- **`scanUsbNetMarkers` is now ONE sweep returning TWO disjoint sets**
  (`routerCellular` + `modemNet`), because both read the same descriptors off the
  same parent USB device. `scanRouterCellular` is the router half of it, unchanged
  for every existing caller.
- **`usb_modem_net` rides the netif wire and is RETRACTABLE on exactly
  `router_cellular`'s terms** — an explicit `null` for one frame, which clears the
  claim and KEEPS the row (the interface is still enumerated; it merely stopped
  classifying). Publishing it true-only would repeat the `policy_route_missing`
  latch.
- **The marker is what makes the claim SAFE to act on.** The frontend rule is
  "claimed by a modem row AND carrying a cellular-device marker", so a modem row
  naming an ordinary NIC can never take the board's management link off the
  Ethernet list. Frontend half: `apps/frontend/AGENTS.md` → "An MM-managed modem's
  data function".
- **Nothing is hidden.** The row is not suppressed — it is REPRESENTED, by the
  Cellular row for the same device, which carries the modem's state, its bond
  toggle and its whole configuration surface. In the handover window before that
  row exists (the two broadcasts are independent), the Ethernet row stays and is
  NAMED from the same descriptors (`Fibocom Wireless Inc. FM350-GL · 0e8d:7127`)
  plus a sentence saying which modem it belongs to.

Coverage: `tests/router-cellular-classification.test.ts` — the FM350 fixture, the
disjoint-sets assertion across the whole roster, and the wire stamp + one-frame
retraction.

## …AND IT IS LISTED AS A MODEM, WITH THE ONLY SURFACE IT REALLY HAS [EXISTS]

Todo 43 classified these dongles and todo 47 named them, but both left them in the
Ethernet list. The operator overruled that: *"everything should be in modems, not in
Ethernet. And we should be able to control or configure the options that can be
configured."* So `modem-wire-producer.ts` now emits a `router-ethernet` modem row per
classified dongle (`collectRouterCellularSources`), reusing the todo-43 marker cache
as the SOLE classification signal — there is no second opinion about what a device is.

**The two router adapters are NOT interchangeable, and unifying them re-breaks the
row.** `fromRouterView` describes a netns-CLAIMED dongle, which hides behind a `dg<N>h`
veth that owns the bond toggle, so its modem row must refuse one (`router_managed`).
`fromRouterCellularView` describes a CLASSIFIED dongle on an image with no isolation
layer — which is every shipped image — so its own `enx…` interface IS the bonded link,
and after the relocation it is the only row that device gets. Its availability token is
therefore `router_direct` (or `dongle_acquiring` before the lease lands), and the
frontend lets the bond toggle live. Handing it `router_managed` would tell an operator
that a dongle currently carrying bonded traffic cannot bond. `getDongleRecords()` is
unchanged and still produces the netns rows.

**The configuration surface is READ-ONLY BY EVIDENCE, not by caution.**
`router-cellular-admin.ts` reads the dongle's own LAN-side HTTP admin API — Huawei
HiLink's `/api/*` XML behind a `SesTokInfo` session, ZTE's `goform_get_cmd_process`
JSON — and publishes the normalized result as the additive `modem.router_admin`. Both
APIs answered UNAUTHENTICATED from the board. Nothing is written: every dongle on the
bench arrived SIM-less (HiLink `SimStatus 255`, ZTE `modem_sim_undetected`), so no
write could be shown to take effect, and todo 47's lesson stands — a control that
cannot be proven is not shipped. What the operator gets is the device's own truth
(model, serial, SIM presence, connection state, signal bars, APN) plus the STATED
address of the vendor UI that does own its configuration.

**`curl --interface` is load-bearing, not laziness.** The two HiLink units ship ONE
factory MAC and one factory LAN subnet, so the host holds `192.168.8.100` twice and
BOTH dongles answer on `192.168.8.1`. Addressing one specifically needs
SO_BINDTODEVICE, which Node/Bun's HTTP client cannot express — `localAddress` is
identical for the pair. Proven on the bench: the same request bound to each interface
returned two different serials (`…793` / `…872`). Do not "modernize" this to `fetch`.

The admin URL is the interface's DEFAULT GATEWAY read from `ip -4 route show default`,
never a hardcoded `192.168.8.1`, so a re-subnetted or unfamiliar dongle still resolves.
The probe runs on its OWN 30 s cadence (not the 5 s netif poll — it is the most
expensive probe in the module and the least urgent), is `isRealDevice()`-gated, and
degrades every failure to `{admin_url, reachable: false}` rather than throwing.
A vendor whose dialect is unknown still gets that reading: the address is a routing
fact worth stating even when nothing could be read behind it.

**A SIM CODE MUST BE READ IN THE DIALECT'S OWN VOCABULARY, NOT A NEIGHBOUR'S.**
The three dialects each name SIM presence differently, and getting one word wrong
costs the whole segment silently — `unknown` renders as ABSENCE OF A CLAIM, so an
unrecognised code is indistinguishable from a dongle that was never asked. The UFI
was in exactly that state: `ufiSim` knew `"valid"`, the firmware answers `"ok"`
(board-measured on `UFI_HM_SIM1_V016_240828`, beside a real IMSI and ICCID), so a
seated card reported no SIM segment at all while ZTE and Huawei rows carried one.
The fix is one accepted code, NOT the vendor's own looser rule — its bundle treats
every non-`"invalid"` value as a good card, and adopting that would report a
future locked state as healthy.

**The bond gate needed NO change, and that is the design working.**
`isSimlessForBond` gates on `"absent"` alone, so `unknown` never gated and the UFI
stayed bondable throughout; once the read was fixed, `"present"` keeps it bondable
for a REASON rather than by default, and a card pulled from it would now correctly
raise `NETIF_ERR_NOSIM`. Confirmed live: the UFI reads `SIM present` and remains
`In Bond`. This is the documented positive-evidence rule, so do not "harden" the
gate to fire on `unknown` when a dialect looks quiet — fix the DATA.

Coverage: `tests/router-cellular-admin.test.ts` (verbatim bench bodies for all three
dialects, the unjustifiable-SIM-code → `unknown` rule, the UFI's `"ok"` seated-card
capture with its unnamed-code negatives, the dev-host no-spawn gate, the
per-interface binding) and `tests/router-cellular-wire.test.ts` (the two adapters'
divergence, no fabricated status/SIM/network list, the twins keeping separate ids).

### …AND A SIM-LESS ONE NEVER JOINS THE BOND [EXISTS]

`no_sim` is ModemManager's answer, and a `router-ethernet` dongle is
architecturally invisible to ModemManager — so the bond gate, which only ever
read that field, never covered this class at all. The dongle still leases the
host a perfectly good address from its OWN embedded router, so it looked
bondable to every rule that reads only an address.

**Board-measured, and the accident that hid it:** a SIM-less ZTE MF79U
(`192.168.0.169`) and a SIM-less Qualcomm UFI were both in `genSrtlaIpList()`,
while their SIM-less Huawei siblings were out — and the ONLY thing separating
the two pairs was that the Huaweis happen to share one factory LAN subnet and so
collided on `NETIF_ERR_DUPIPV4`. Their exclusion was a different rule firing by
luck, not this one working. The operator-visible symptom was the same condition
producing three different toggle states across four dongles.

- **`NETIF_ERR_NOSIM` (0x04) is the mechanism**, set by `applyRouterSimBondGate`
  from the admin cache `router-cellular-admin.ts` already fills. Everything
  downstream then follows for free and CANNOT disagree: `setNetifError` lowers
  `enabled`, `isBondCandidate`'s existing `(error & ~DUPIPV4) !== 0` test
  excludes it, and the frontend's `isBondMember` mirror (`enabled && ip`,
  error-free) drops the row from Bonded Links. A gate that excluded the link from
  srtla WITHOUT lowering `enabled` would have left that documented mirror lying.
- **It runs on EVERY pass, not inside the `intsChanged` branch its dup-IP sibling
  lives in.** The netif map is byte-identical across a SIM being pulled from a
  dongle that keeps its lease, so a topology-gated check would never fire for the
  case it exists for. Pinned by a test that drives two passes with an unchanged
  interface set.
- **`sim: "absent"` is the ONLY gating answer.** It is reachable only from a
  device-stated code the dialect parser was willing to justify — an unreachable
  dongle carries no `sim` field at all and a doubtful one reads `unknown` — so a
  missed 30 s probe cycle can never take a working uplink out of a live bond.
  Do NOT "harden" this to gate on `unknown`.
- **The rule itself is `@ceraui/rpc` `capabilities/sim-bond-eligibility.ts`**,
  shared verbatim with the frontend's toggle. Same argument as
  `device-mode-truth.ts`: a live toggle over a link the device refuses, and a
  disabled toggle over a link the device is bonding, are both lies.
- **Recovery is an operator action, exactly like dup-IP's.** `clearNetifError`
  drops the flag but does not restore `enabled`, so inserting a SIM leaves the
  link excluded until the operator toggles it back in. That is the existing
  behaviour of every netif error flag and is deliberate — the device stops
  refusing, the operator decides to bond.

Coverage: `tests/no-sim-bond-gate.test.ts` — the production path (real
`processIfconfigOutput` against the real admin cache) asserting `genSrtlaIpList()`
and the wire's `enabled`/`error`, the self-correction, the no-topology-change
pass, and the four positive-evidence negatives. Frontend half:
`apps/frontend/AGENTS.md` → "A SIM-LESS LINK CANNOT BE TOGGLED INTO THE BOND".

### …AND THE ZTE/UFI READS EXPANDED WITHOUT GAINING A WRITE [EXISTS]

`modules/network/router-details.ts` (pure) reads the NON-SIGNAL half of what
those two dialects publish — network type, operator, serving cell and band for
the ZTE; radio mode, WAN address, IMSI/ICCID, WiFi name and product record for
the UFI — into the additive `router_admin.details` block
(`routerAdminDetailsSchema`). Todo 20's signal model is untouched: a radio
quantity has to say WHY it is missing, and these are strings the device either
published or did not.

- **The ZTE reads stay ONE request.** `goform_get_cmd_process` takes a
  `multi_data` key list, so the detail keys are appended to `ZTE_READ_KEYS` and
  ride the existing GET. Per-field requests would multiply the module's slowest
  probe by the field count for no new information; a test asserts exactly one
  fetch carrying every key.
- **Absence renders as absence, and an empty block is not a block.** A field the
  device did not state is OMITTED, the vendor's own `-` placeholder (the UFI
  answers it for an unset WAN address, IMSI and ICCID) is dropped at the parser,
  and a device that stated nothing carries no `details` at all — an empty detail
  surface reads as a failed read rather than as a device with nothing to add.
- **Candidate spellings, not one guess per field.** `network_provider`/`provider`
  and `lte_band`/`band` are both asked for, because a second key on an existing
  `multi_data` list costs no request and the device echoes what it does not know
  as an empty string, which this reader already treats as "not stated". Same
  shape as `parseUfiSignal`'s two-command dBm ladder.
- **The block rides todo 10's identity**, so it lands on the physical row rather
  than on an interface name the twin HiLinks swap on replug.
- **NEITHER DIALECT GAINS A WRITE, and the fence is tested three ways**
  (`tests/router-read-expansion.test.ts`): the module source is greped
  comment-stripped for the ZTE set endpoint / `SET_` verbs / `CONNECT_NETWORK` /
  the UFI usb-tether setter (so this prose may name them), `router-details.ts`'s
  export list is enumerated for a mutating name, and every request both probes
  issue is inspected — the UFI posts only `login` and `get*`, the ZTE posts
  nothing at all. `applyRouterCellularControl` still refuses both vid:pids.

Coverage also proves the auth path is the file's existing canon rather than a new
one: a UFI cycle answering `SessionOut` opens exactly TWO sessions (re-auth once)
and then reports `auth-expired` with no detail block, and a cycle whose re-auth
itself fails reports an unreachable dongle.

### …AND THE HiLINK CAPABILITY IS DISCOVERED BEFORE ANYTHING IS OFFERED [EXISTS]

`modules/network/router-capabilities.ts` (pure) reads the HiLink firmware's OWN
network-mode catalog — `/api/net/net-mode-list` plus `/api/net/net-mode`, both
GETs — into the additive `router_admin.capabilities` block
(`routerAdminCapabilitiesSchema`). It exists because "no control" and "we never
asked" were the same thing on screen: the write was correctly refused (the bench
unit answers error `112008` instead of applying it, so its success could not be
observed), and nothing then reported the capability at all.

- **A REFUSAL IS A READING, not silence.** `parseHilinkCapabilities` ALWAYS
  answers. `reported` carries the catalog verbatim (plus the mode the device says
  is selected); `unavailable` carries WHY, in `routerSignalMetric`'s own
  vocabulary plus `refused` — which carries the vendor's own code, so `112008`
  reaches the operator as `112008`.
- **`125002` is SPLIT OUT from every other error code.** It is what every HiLink
  endpoint answers without a valid session token, so folding it in with a
  firmware refusal would tell an operator their dongle cannot do something it may
  do fine. It resolves to `auth-expired`.
- **There is deliberately NO `writable` field, and that IS the staging seam.**
  Proving a setting writable means WRITING it, which this stage does not do, so a
  `writable: true` could only repeat the vendor's own claim — the hearsay
  `applyRouterCellularControl` exists to refuse. `controls` still holds exactly
  the two proven writes; no net-mode control is offered for any firmware.
- **"Before any control renders" is satisfied STRUCTURALLY.** The two reads are
  appended to the URL list `probeHilink` already spawns ONE `curl` for, so
  `capabilities` and `controls` land in the SAME atomic reading — a consumer
  cannot receive one without the other, and the per-unit `--interface` binding
  (the only thing separating the twin HiLinks) is unchanged. A dialect that ran
  no discovery omits the block ENTIRELY rather than shipping an empty one.
- **An entry with no `<Index>` is DROPPED, never given a synthetic id** — the
  index is what a write would have to NAME. A refused or unreadable `net-mode`
  yields no `current` rather than a guess.

**THE DISCOVERY MODULE IS STILL READ-ONLY — the WRITE it gates lives elsewhere.**
Stage B added the `/api/net/net-mode` write and the `/api/dhcp/settings` subnet
rewrite, in `router-cellular-control.ts` / `router-subnet-hygiene.ts` over the
shared `hilink-session.ts` / `hilink-documents.ts`. The fence here was RETARGETED
rather than dropped, and it is strictly stronger: the write tokens must appear in
the write modules and in NEITHER `router-capabilities.ts` nor
`router-cellular-admin.ts`, and a HiLink READ cycle must still POST nothing at
all (its `postViaInterface` throws in the test). Coverage:
`tests/router-capability-discovery.test.ts` +
`tests/router-net-mode-write.test.ts`. Render side:
`apps/frontend/src/main/dialogs/router-dongle-fields.ts` (`netModeCapability`) +
`RouterDongleDialog.svelte`, which offers a control in the REPORTED arm and none
at all in the refused one.

### …AND ITS OWN WEB UI IS REACHED THROUGH A DEVICE-BOUND REVERSE PROXY [EXISTS]

Every setting a router dongle really owns lives in its OWN embedded admin web
UI, and until now CeraUI could only STATE that address: the page is on the
dongle's network, which the operator's browser is not on, so an anchor would
have been a control that cannot work. `modules/network/router-admin-proxy.ts`
(pure) + `modules/ui/dongle-admin-proxy.ts` (effects) +
`modules/ui/dongle-admin-session.ts` (auth) carry that page through CeraUI's own
origin instead, at `/dongle-admin/<wireId>/…`.

**THE PATH NAMES A DEVICE, NOT AN ADDRESS, AND THAT IS THE WHOLE POINT.**
Identical units ship one factory LAN subnet, so the bench pair BOTH lease the
host `192.168.8.100` and BOTH publish `192.168.8.1` as their admin address — a
destination names a PAIR. It is worse than ambiguous: board-measured, the ZTE
(whose own gateway is `192.168.0.1`) also ANSWERED a request addressed to
`192.168.8.1`, because what selects the unit is the BINDING, not the address.
Resolution therefore runs in one direction only —
`wire id → routerCellularIfnameForWireId → that interface's own default route` —
and the request goes out `curl --interface`, the same `SO_BINDTODEVICE`
mechanism `router-cellular-admin.ts` and `device-bound-probe.ts` already use.
Proven live: the two twins' proxy paths returned serials `…872` and `…793`.

**AUTH IS A TOKEN EXCHANGED ONCE FOR A SCOPED COOKIE.** A preview is one socket,
so its single-use token authenticates the whole thing; an admin UI is a browsing
session of many requests, so a single-use token cannot. `system`-style minting
happens over the ALREADY-AUTHENTICATED RPC socket (`modems.openRouterAdmin`),
and the first request swaps it for an `HttpOnly; SameSite=Strict` cookie scoped
to `Path=/dongle-admin`, then REDIRECTS to strip the spent token so it never
lingers in history or in a referrer the dongle would see. No `Secure` — the
device legitimately serves plain HTTP on the LAN, where a `Secure` cookie would
silently never be stored.

**FIVE THINGS ABOUT THE RESPONSE, EVERY ONE OF THEM BOARD-FOUND:**

- **A CONTENT-TYPE THE DONGLE DID NOT STATE IS SNIFFED, or the page DOWNLOADS.**
  The UFI's httpd infers its type from the URL's file EXTENSION, so an
  extensionless path answers with the header ABSENT — board-measured, `GET /`
  returns 200 and a full `<!DOCTYPE html>` body with no content-type, while
  `GET /index.html` returns the same bytes WITH `text/html`. The other two
  dialects never reach that state because both REDIRECT `/` to an explicit
  `.html` path. Absence is not neutral: `Bun.serve` labels a content-type-less
  response `application/octet-stream`, so the browser is handed a positive
  "this is a file" and DOWNLOADS the admin page — and the same absence silences
  `shouldRewriteBody`, so the page's own `/static/…` refs stay pointed at
  CeraUI's origin. One defect, two symptoms. `sniffAbsentContentType` applies
  the mimesniff HTML prefixes, and ONLY when the device stated nothing — a
  dialect that named a type is byte-untouched, whatever it named. No charset is
  asserted; the document's own `<meta charset>` knows better than a sniff.
- **`--compressed` is mandatory.** The HiLink serves its scripts PRE-GZIPPED and
  answers `Content-Encoding: gzip` even to an explicit `Accept-Encoding:
  identity`. Without the flag the browser gets gzip bytes under a
  `text/javascript` label. `content-encoding` is stripped from what we forward
  ONLY because curl already decoded it — the flag and the strip belong together.
- **Header capture goes to a TEMP FILE, never `/dev/stderr`.** Against a Bun PIPE
  that form never completes: `exitCode` comes back `null` with both streams
  EMPTY, while the identical argv writing to a file exits 0 with a full header
  block. It works under a shell redirect, which is exactly why a hand-run
  `curl … 2>/tmp/h` looks fine and the same command under `Bun.spawn` does not.
- **`X-Frame-Options` / CSP / HSTS are stripped.** A dongle must not dictate
  framing or transport policy for the DEVICE's origin; an HSTS pin in particular
  would lock an operator out of a board that serves plain HTTP on the LAN.
- **`Set-Cookie` is re-pathed onto the per-device prefix.** Two identical twins
  issue cookies of the SAME name, so without it they overwrite each other's
  session on CeraUI's one origin.

**URL REWRITING IS BEST-EFFORT, AND ITS LIMITS ARE MEASURED, NOT ASSUMED.**
`rewriteAdminBody` re-points root-relative references so an opaque vendor SPA
loads under a path prefix. Three rules exist only because each was found
breaking a real page on the bench, and every one of them is a REFUSAL to rewrite:

1. **A path must name a DIRECTORY outside CSS** (`"/api/…"`), because a regex
   literal may END in a quote — jQuery 1.7.2 ships `replace(/'/g, …)` and
   `/ jQuery\d+="(?:\d+|null)"/g`, which are character-for-character
   indistinguishable from a quoted path. Rewriting them produced
   `SyntaxError: Invalid regular expression flags` and took jQuery out entirely.
2. **`(` is a delimiter in STYLESHEETS only**, because in JS it also opens a
   regex: `replace(/-/g, …)` became `replace(/dongle-admin/1001/-/g, …)`, and
   `main.js` then defined nothing and threw `create_button is not defined`.
3. **A DATA payload is never rewritten**, whatever the content-type claims — the
   HiLink API answers XML under `text/html`, so the header alone would sweep
   every session token and API document into the transform. A bare `"/"` is
   likewise left alone: it is the same three characters as `split('/')`.

So a single-segment `"/index.html"` is NOT rewritten. That is the accepted cost —
corrupting a script the device depends on is a far worse failure than one
unrewritten link, and the BINDING, which is what decides WHICH physical unit
answers, does not depend on any of it.

**TWO ADDITIONS, both forced by the UFI's Vue/webpack SPA and both narrowed
rather than generalised:**

4. **An UNQUOTED attribute is still an attribute.** Everything above keys on a
   QUOTE, and html-minifier output has none: the UFI's index is
   `<link href=/static/css/app.css>` / `<script src=/static/js/app.js>`, so every
   asset reference survived untouched. The extra pass is deliberately NOT a bare
   `=` delimiter — `re=/foo/` is exactly that shape in JavaScript, the same trap
   `(` was banned for — but is restricted to `text/html` bodies AND to the fixed
   set of attributes HTML DEFINES as URL-valued.
5. **A bundler's public path is the one assembled URL that CAN be followed.** The
   standing "a URL built at runtime out of fragments cannot be followed" caveat
   has exactly one important exception: a webpack runtime carries a SINGLE
   literal (`n.p="/"`) and composes every lazy chunk as `n.p + "static/js/" + …`.
   Board-measured, that sent chunk 0 to CeraUI's origin root, which answered with
   CeraUI's own index under a `text/html` label — so the vendor SPA loaded its
   shell and mounted NOTHING. Re-basing that one literal fixes every chunk it
   will ever assemble, and it is gated on the body positively BEING a webpack
   runtime (`webpackJsonp`/`__webpack_require__`), so an unrelated `.p="/"` is
   out of reach.

**Board-proven end to end, twice.** (2026-08-18, two Huawei E3372 twins): each
twin's button opens its own session, the vendor SPA runs its full API sequence
through the proxy with ZERO page errors, and each lands on its own unit —
`Y4QDU17621000872` (`enx0c5b8f279a64`) and `Y4QDU17621000793` (`eth1`).
(2026-08-18, Qualcomm 4G UFI `enx020a53313630`, fresh Playwright context with
`serviceWorkers: 'block'`): the button RENDERS the vendor SPA instead of
downloading it — `content-type: text/html`, zero downloads — the operator logs
into the dongle, and sub-navigating to its Wifi settings page keeps **every**
request under `/dongle-admin/1003/`: zero requests escaped to CeraUI's origin.

Coverage: `tests/router-admin-proxy.test.ts` — the bench default-route fixture
producing two different bindings from ONE address, the end-to-end binding proof,
the token/session matrix, the rewriter's refusals (the two verbatim jQuery
regex literals, the XHTML self-closing tag, the XML payload, the separator
literal), and the UFI's verbatim content-type-less index driven end to end
(served as HTML, assets re-pointed) with its stated-type and unquoted-attribute
negatives plus the webpack public-path pass. Rule-E proof: resolving the binding
by ADDRESS instead of by identity reddens exactly the two tests that carry that
correctness claim; dropping the sniff or the unquoted-attribute pass reddens
three more.

### …AND THE WRITES IT GATES ARE STAGE B [EXISTS]

`router-cellular-control.ts` (net-mode + the two proven toggles),
`router-subnet-hygiene.ts` + `router-subnet-plan.ts` (the LAN-subnet rewrite),
`router-subnet-rollback.ts` (its replay handler) and
`rpc/procedures/modems-router.procedure.ts` are everything this build writes to a
router dongle. `router-cellular-admin.ts` reads and nothing in it mutates
(808 → 683 pure LOC; the extraction todos 20, 23 and 22-Stage-A each recorded as
owed).

- **THE NET-MODE WRITE IS CAPABILITY-GATED, NOT VERSION-GATED.** It re-reads
  `/api/net/net-mode-list` in ITS OWN cycle and refuses BEFORE building any
  request document when the firmware will not name a catalog — so the bench unit,
  which answers `112008`, is never POSTed to and the operator is told `112008`.
  Reading the 30 s poll cache instead would act on a capability that was true
  minutes ago. `capability_unavailable` (the firmware declined), `not_offered`
  (the catalog exists and lacks that index) and `unsupported` (this build has no
  net-mode write for that dialect) are three different facts and are never
  collapsed. It takes the LEASE and is NOT journaled: a radio-mode selection
  cannot cost the LAN path, so there is nothing a rollback would restore that the
  next write cannot simply set.
- **THE SUBNET REWRITE IS OPTIONAL HYGIENE AND NEVER A BONDING PREREQUISITE.** A
  twin pair on one factory subnet already bonds — `bind-map.ts` describes each
  uplink by INTERFACE and the sender binds `SO_BINDTODEVICE` — so nothing on the
  bonding path may call into it. The fence is on the IMPORT GRAPH (a bonding
  module that cannot name it cannot require it), not on prose.
- **IT IS THE ONE ROUTER WRITE THAT IS JOURNALED**, under todo 25's
  `withJournaledModemMutation` with its own `router-subnet` kind, its own
  pre-state shape (the whole `/api/dhcp/settings` record + ifname + target) and
  its own registered rollback. Ordering is the safety argument: preflight (all
  reads) → journal armed → re-read under the lease and refuse `state_drifted` if
  it moved → `markExecuting` → write → DHCP renewal → confirm.
- **THE OLD ADDRESS IS RETAINED AND PROBED.** After a failed confirmation the
  device is at exactly one of two addresses — the new one (the write landed, the
  host could not follow) or the old one (it never landed) — and only asking BOTH
  can tell those apart. `locateDevice` matches on the RECORD as well as the
  address, so "something answered there" is never mistaken for "the device is
  there" on a shared factory subnet.
- **THE ROLLBACK IS CANCELLED ONLY AFTER REACHABILITY IS RECONFIRMED.** `applied`
  (reached at the new address) and `reverted` (restored AND reconfirmed at the old
  one) both leave nothing outstanding, so the journal entry is cancelled — keeping
  a device blocked that was just proven healthy would be fail-closed theatre.
  `blocked` (answered at neither) is the ONLY outcome that leaves the entry
  `failed`, which is exactly the case the journal exists for.
- **Only /24 is accepted, and only RFC1918.** Re-hosting a DHCP pool across an
  arbitrary prefix means guessing which bits are the host part, and a wrong guess
  writes a pool that does not contain the addresses it serves. Everything except
  the address family is CARRIED — pool bounds, lease time, DHCP/DNS flags — and a
  DNS entry pointing at the dongle ITSELF follows it while one pointing elsewhere
  is left alone.
- **`SUBNET_CONFIRM_ATTEMPTS` × `SUBNET_CONFIRM_DELAY_MS` (6 × 2 s) is bounded on
  purpose**: an unbounded wait is a mutation that never resolves and a lease that
  is never released.

**HONEST STATUS: none of this has been exercised against a real dongle.** The
`112008` code is a real bench measurement; every document shape is derived from
the dialect. The auto-restore path in particular is fixture-proven only, and the
`nmcli device disconnect`/`connect` renewal has never run on a board.

**The subnet rewrite DOES have an operator surface now, and the shape it takes is
what carries that honest status.** It is not a toggle: the operator names the
target address, and an explicit second act confirms it against a sentence that
SAYS the restore has been proven against recorded replies and never yet against
real hardware. It is offered only where `router_admin.controls` is published —
i.e. only for the dialect whose writes were round-trip-proven, which is the same
dialect `prepareSubnetRewrite` accepts — so a dongle that would be answered
`unsupported` never renders the field. Nothing about the device side changed:
`confirm: z.literal(true)`, the per-device lease, the durable journal and the
armed rollback are exactly as described above, and the UI is a caller like any
other. Coverage: `tests/router-net-mode-write.test.ts`,
`tests/router-subnet-hygiene.test.ts`, `tests/router-stage-b-interlock.test.ts`;
operator half: [`../frontend/AGENTS.md`](../frontend/AGENTS.md) → THE ROUTER
ACTION SURFACE.

### …AND WHETHER IT NEEDS A LOGIN IS ONE OF FIVE STATES [EXISTS — UNPROVEN ON A LOCKED DEVICE]

`modules/modems/modem-lock-state.ts` (the pure model + its session) and
`modem-credential-verify.ts` (the device-facing attempt) turn todo 7's credential
store into a state an operator can act on. The wire fields are
**`modem.lock_state`** — exactly `open` / `locked` / `unlocked` / `auth-failed` /
`locked-out` — and **`modem.lock_detail`**.

**`open` IS DETECTED, AND ITS ONLY EVIDENCE IS A DOCUMENT THAT STATES IT.** Every
dongle on this bench answers unauthenticated, so `open` is the COMMON case and
prompting for a password at one of them is the dishonesty this surface exists to
remove — but "nobody refused us" is not the same claim, because a refusal can
also be a read that never happened. HiLink's `/api/user/state-login` answers the
question directly (`State: 0` ⇒ usable with no credential presented, `-1` ⇒ a
login is required), so it rides the batch the 30 s admin cycle already spawns and
is read on a FRESH session — which is what makes `0` mean "no credential needed"
rather than "somebody logged in earlier". ZTE goform and Qualcomm HIMI publish no
equivalent, so they resolve `locked`. An UNANSWERABLE read DROPS the cached
evidence rather than retaining it — the deliberate opposite of this codebase's
usual retain-on-failure rule, because `open` is the only value that WIDENS what a
row offers and a claim we can no longer support must be withdrawn.

**`protocol-mismatch` IS NOT `auth-failed`.** Todo 6's ZTE vocabulary
(`lockout` / `auth-rejection` / `protocol-mismatch` / `auth-accepted`) maps onto
the states through `classifyAuthAttempt`, and three of the four map directly. The
fourth does not: the dialect answered a login shape this build ships no proven
implementation for, so the credential was never presented and reporting it as a
rejection would tell an operator their password is wrong. It resolves `locked`
carrying `lock_detail.sub_reason: "unsupported-profile"`.

**THE RESOLUTION ORDER IS THE CONTRACT.** A live lockout outranks everything (it
is the only state that forbids an action rather than describing one, and an
`open` device can never have produced a lockout record); positive open evidence
then outranks any session history, because a device that currently states it
needs no login needs none whatever was tried at it earlier; below that it is the
session's own last word, and a device that has said nothing is `locked` — the
honest floor.

**`unlocked` MEANS THIS SESSION, so the session map is in memory.** Todo 7's
persisted `lastOutcome` is the right shape for "what this credential last did"
and survives a reboot; a boot that has presented nothing has unlocked nothing.

**THE CAPABILITY EXPANSION RIDES THE EXISTING SURFACE, NOT A NEW ONE.**
`gateRouterAdminByLock` withholds `router_admin.capabilities` and
`router_admin.controls` — the two blocks that describe what an operator may DO to
the dongle — while the lock does not permit an authenticated session, and the
same rebuild offers them again the moment a verify lands. Every OBSERVATION on
the block (admin URL, model, SIM, signal) passes through untouched: those are
facts rather than offers, and withholding them would report a reachable device as
unreadable. Today's fleet detects as `open`, so the reading is byte-unchanged for
every device currently on the bench.

**The three procedures are `authedProcedure`, NOT `modemProcedure`**
(`rpc/procedures/modems-credentials.procedure.ts`), for the reason
`modems.getCapabilities` is: a router dongle is architecturally invisible to
ModemManager, and an operator most needs to fix a credential exactly while the
cellular stack is initializing — which is when `cellularReadyMiddleware` refuses
everything. They take no lease and touch no radio.

- **`verifyCredentials` presents the credential EXACTLY ONCE.** There is no
  retry: every dialect here counts a failed login toward a lockout the operator
  cannot clear, so a retry spends the attempts that would have let them fix a
  typo. A device already inside a lockout window is refused BEFORE a transport is
  opened, so it costs ZERO device requests.
- **A rejected device transport is `unreachable`, never an authentication
  verdict.** Both the open-detection read and the single login attempt translate
  a rejected transport promise into the typed refusal. Detection failure also
  withdraws any cached `open` evidence, because that claim widens the row and the
  device can no longer support it. Neither rejection records `auth-failed`, and
  neither is retried.
- **`setCredentials` performs zero device requests too** — it reads the open
  verdict the admin cycle already observed — and REFUSES an `open` device
  (`device_open`) rather than storing a secret nothing will ever present.
- **Clearing a credential drops the session verdict with it**: a credential that
  no longer exists cannot keep a row `unlocked`.
- **No output carries a password.** `modemCredentialsOutputSchema` is a plain
  `z.object`, so a field added upstream by mistake is STRIPPED, and
  `rpc-logging.ts` omits these three procedures' args entirely (a per-PROCEDURE
  set beside the `auth.*` namespace one, because the rest of `modems.*` is
  ordinary and blanking all of it would throw away real diagnostics).
- **`initModemCredentials()` is wired at boot**, beside `initCellularStack` and
  ahead of the modem loop: the first `modems` payload carries every row's lock
  state, and an unloaded store reports a device with a stored login as having
  none.

**HONEST STATUS: no locked device exists on this bench.** All three dialects
answered unauthenticated, so the `open` path is the only one hardware has
exercised. The HiLink login derivation is modem-stack's certified one
(`providers/huawei-hilink/session.ts`, password types 3 and 4) re-stated for Rule
D and NOT run against a device that demands it; ZTE and HIMI ship no login at all
and answer `protocol-mismatch` deliberately, because an unproven credential
derivation would burn a real operator's attempts against a real lockout counter.

Coverage: `tests/modem-credential-unlock.test.ts` — all five states reachable and
EXPLICIT on the wire (including the no-admin-surface negative), the resolution
ladder with its withdraw-the-open-claim case, the four refusal mappings with the
`protocol-mismatch` ≠ `auth-failed` assertion, the capability withhold/offer pair
and its observations-survive control, the zero-request lockout, the no-retry
proof by attempt count, the password-absence assertions (schema strip, real
verify outcome, and the derived login document), the rpc-logging omission with
its diagnosable-namespace control, and static locks that the SHIPPED producer
really calls the gate and the SHIPPED admin cycle really reads the login-state
document. Rule-E proof in both directions: neutering the capability gate reddens
2, folding `protocol-mismatch` into `auth-failed` reddens 2, moving the lockout
check below the transport reddens 1, dropping the procedures from the log
omission set reddens 1, and encoding `open` as absence reddens 2.

## …AND ONE RESOLVER DECIDES WHICH PHYSICAL DEVICE IT IS [EXISTS]

`modules/modems/physical-identity.ts` is the SINGLE resolver of a physical-device
record, and the single authority that MINTS the opaque per-link `link_id` the
bind-map writer publishes and the telemetry registry consumes. Before it, the
same stick was described by two resolutions that could not agree: `fromMmcliModem`
anchored on the udev `ID_PATH`, while `fromRouterCellularView` had no anchor at
all and keyed on the interface NAME — the one property this fleet has already
proven unusable.

**The identity ladder, and why each rung is where it is** (board-measured on
`ceralive2`, 2026-08-17, todo 2 — every rung is a reading, not a preference):

| Rung | Applies to | Why |
|---|---|---|
| `usb-serial` | the Qualcomm dual-mode sticks (`2b16081`, `c6125db3`) | a `uhubctl` power cycle flipped one from `05c6:9024`/`rndis_host` to `05c6:9091`/`qmi_wwan` under the SAME serial, so VID:PID is PROVEN not to be an identity and the serial is proven to survive the one transition that moves a device between adapter classes |
| `id-path` | the two HiLink twins | they expose NO usable USB serial (freshly re-read, not assumed) and share one factory MAC, so only the PORT separates them. Identity is SAME-PORT stability: stable across a replug into the same port and across a composition change, and DELIBERATELY different when a unit is moved to another port |
| `ifname` | anything with neither | the honest floor; the record says `anchor: "ifname"` rather than looking stronger than it is |

**There is deliberately NO alias table unifying rungs.** A port alias pointing at
a serial-anchored identity would hand the NEXT device plugged into that port the
previous unit's identity — a silent misattribution far worse than a re-minted id.

**`stable_key` is NOT `identityKey`, and this todo did not re-key it.** The wire's
`stable_key` keeps its exact meaning — the ID_PATH-derived key from the ONE shared
`deriveModemStableKey` rule — because todo 17's consumers correlate on it, the
usage-policy store files under it, and the projection fixtures lock it. What
changed is that the DIRECT router adapter now HAS one: the sysfs sweep reads the
parent USB device's `ID_PATH` out of its udev entry, so a classified dongle is
keyed by port instead of by ifname. `identityKey` is the internal correlation key
that additionally admits the serial rung, and `link_id` derives from THAT.

**`link_id` is `lnk_` + the first 16 hex chars of `sha256(identityKey)`.** A hash
rather than a counter, for three reasons the consumers require: it is stable
across reloads with NO persisted state (a counter would need a store whose failure
renumbers every link), stable across composition changes, and it carries no
secret — a USB serial must not ride the wire, and a digest stays
equality-comparable, which is the only operation consumers may perform.

**The descriptor sweep covers mm-managed devices too, and that is load-bearing.**
`scanUsbNetMarkers` now also returns a `physical` map (`UsbPhysicalDescriptor`:
vid/pid/serial/`ID_PATH`/hwdb + resolved labels) for EVERY classified USB net
device, not only router-class ones — that is what lets the same stick resolve to
ONE identity in both of its compositions. Nothing in that map reaches the `netif`
wire; the two existing markers are untouched. Its `serial` is carried
unconditionally, unlike the wire marker's twin discriminator, because an identity
anchor is needed by a lone device just as much as by a twin.

**Display-name precedence**: the MM identity observation — which IS the existing
HIMI firmware-string chain (`modem-identity.ts` `modemHardwareName`), layered on
rather than replaced — then the dongle's own admin API, then the descriptor/hwdb
labels, then `vid:pid`. The descriptor floor is NOT filtered through
`isUninformativeIdentity`: that rule judges mmcli's own answers, where a bare
numeral is measured garbage, whereas here a bare numeral is the PRODUCT ID that
the classifier deliberately chose as its honest floor (`Qualcomm 9024`).

**A router row's wire id can no longer be parsed back into an interface.** Its
allocation key is now an `ID_PATH`, which names a port, so
`routerCellularIfnameForWireId` reads a mapping the last collection recorded
explicitly and answers `undefined` for anything it did not record — never a
neighbouring interface.

`physical-identity-source.ts` is the one place that assembles an observation from
the live caches; the resolver itself reads no device.

Coverage: `tests/modem-physical-identity.test.ts` — the dual-mode stick's identity
and `link_id` across the 9024⇄9091 flip (both bench sticks, with the two-sticks
negative), its coherent titling in both compositions, the twins resolving DISTINCT
port-anchored identities, same-port replug stability under a name change, the
deliberate different-port divergence, hwdb model recovery, the minting contract
(determinism, no serial leakage), the router adapter's real `stable_key` plus its
ifname fallback, the mmcli row's byte-identical `stable_key`, and the preserved
HIMI chain.

### The two `05c6:9024` sticks are RNDIS + read-only UFI devices [EXISTS]

Historical pre-RAUC evidence below records why the kernel fix was required. Todo
61 enabled `CONFIG_USB_NET_RNDIS_HOST=m` and both units now enumerate as
`enx020754023235` and `enx020a53313630`. Todo 69 then probed each interface with
its own `curl --interface` binding: both default routes use `192.168.100.1`, and
both return HTTP 200 with an HTML page titled `4G UFI`.

The current CeraUI admin surface recognizes vendor `05c6` as the `ufi` dialect and
reads only that root HTML shell into `router_admin.model`. It publishes no status
fields and no controls: the shell is proven reachable, but no settings endpoint
or write round-trip has been proven. Keep the interface binding and the
read-only/no-fabrication rule. Evidence and tests: root
`.omo/notepads/modem-stack-phase-b/learnings.md` Todo 69 entry and
`tests/router-cellular-admin.test.ts`.

Historical pre-fix evidence (before todo 61) follows:

```
1-1.4.1:1.0  icE0isc01ip03   ← Wireless Controller / RF / RNDIS  (control)
1-1.4.1:1.1  ic0Aisc00ip00   ← CDC Data                          (RNDIS data)
1-1.4.1:1.2  icFFisc42ip01   ← vendor-specific (Android ADB)
   driver link exists: NO DRIVER BOUND   (all three, both units)
```

`icE0isc01ip03` is the RNDIS host-facing Ethernet function. The only driver that
binds it is `rndis_host`, and on the shipped kernel it does not exist:

```
$ zcat /proc/config.gz | grep RNDIS_HOST
# CONFIG_USB_NET_RNDIS_HOST is not set
$ modprobe rndis_host
modprobe: FATAL: Module rndis_host not found in directory /lib/modules/7.1.7-ceralive-rk3588
$ find /lib/modules/$(uname -r) -name '*rndis*'
/lib/modules/7.1.7-ceralive-rk3588/kernel/drivers/usb/gadget/function/usb_f_rndis.ko   ← GADGET, not host
```

`modules.alias` carries no entry claiming `ice0isc01ip03` at all, so udev never
even has a candidate to load. `cdc_ether` is loaded and cannot substitute —
`rndis_host` is a separate module that depends on it. Every other USB-net driver
IS built (`cdc_ncm`, `cdc_mbim`, `qmi_wwan`, …); RNDIS host support is the single
omission.

**Out of this repo's scope, and the fix is one Kconfig symbol.** The device
image's kernel needs `CONFIG_USB_NET_RNDIS_HOST=m` (`drivers/net/usb/Kconfig`,
depends on `USB_NET_CDCETHER`, which is already `=m`). Owner:
`image-building-pipeline` — same class of gap as todo 35's modem udev policy that
existed in source and never shipped. Nothing in CeraUI should paper over it: with
no netdev there is no `netif` key, so there is correctly no row, and inventing one
from `lsusb` would be a device the operator cannot bond, act on, or explain.

## …AND THAT IDENTITY IS PUBLISHED AS A BIND-MAP, SO TWIN MODEMS BOTH BOND [EXISTS]

CeraUI is the WRITER of `srtla-send-rs`'s ADR-003 bind-map contract
([`docs/adr/ADR-003-bind-map-contract.md`](../../../srtla-send-rs/docs/adr/ADR-003-bind-map-contract.md)).
The sender identifies an uplink by its local SOURCE IP, and two identical HiLink
twins both lease `192.168.8.100` — so the sender's pool builder silently
collapsed the second one and the operator saw ONE link with two modems plugged
in. The mapping that resolves it is information only this backend has.

**Two files, one writer, one order.** `bind-map.ts` (pure: document shape, row
validation, collision groups) + `bind-map-writer.ts` (atomic publication).
`BIND_IPS_FILE` stays **BYTE-UNCHANGED** — pinned by `streaming-bun-io.test.ts`,
which now proves the two-file publisher did not move a byte of it — and the
mapping rides a separate versioned JSON sidecar (`setup.bind_map_file`, default
`<ips_file>.bindmap.json`) that describes it **POSITIONALLY**: the Nth row
describes the Nth accepted IP line. Publication order is ips-file rename →
**sidecar rename (COMMIT POINT)** → SIGHUP, each through a unique temp sibling
(`<target>.<pid>.<n>.tmp`), `open`+`writeFile`+`fsync`+`rename`, mode **0600**
(the reader REFUSES a group- or world-writable sidecar, so `Bun.write` — which
neither fsyncs nor sets a mode — is deliberately not used here).

- **`link_id` is MINTED BY TODO 10** (`physical-identity.ts` `mintLinkId`) and
  never invented here. One id authority, or the bind-map writer and the telemetry
  registry attribute the same operator's link to two different devices.
- **…and a link it cannot answer for is UNMAPPABLE, not renamed.** A failed
  identity resolution used to fall back to `` `lnk_${ifname}` `` — a string with
  the exact shape of a minted id, keyed on the one property this fleet has
  already proven is not a device. The bench twins ship ONE factory MAC, so
  systemd can name only one of them predictably (`enx0c5b8f279a64`) and the other
  falls back to `eth1`; a replug can swap which is which, and an id keyed on the
  name follows the NAME, handing the next device in that socket the previous
  unit's telemetry row. `describeBondEntry` now answers with `bind-map.ts`'s
  `unmappableBondEntry(ip, iface)` — no id, and no way to pass one in — which
  stamps the explicit `identityState: "unmappable"`. Four properties are
  load-bearing:
  - **The entry is KEPT.** It is still returned, its IP still goes in
    `BIND_IPS_FILE`, and the link still carries traffic. What it loses is the
    CLAIM that we know which device it is — a dropped entry would be the silent
    loss this whole contract exists to end.
  - **It cannot become a sidecar row**, by construction: `isMappableEntry` is a
    type predicate answering `entry is MappedBondEntry` (an entry carrying a
    minted id), and `buildBindMapDocument` takes only those. So the writer's
    EXISTING undescribable-link path runs unchanged — the IP list is published,
    the sidecar is retired, and the launch reports `degraded` through the ONE
    normalized disposition rather than through a new vocabulary.
  - **The consequence for a DUP-IP link is deliberate, and is the documented
    rule rather than a new one:** `admitEntry` already admits a duplicate-IP link
    ONLY when it can be described, so a twin whose identity resolution failed is
    now excluded instead of joining the bond under a name-keyed id. In practice
    this is unreachable — `resolvePhysicalDevice` always resolves, falling back
    to its stated `anchor: "ifname"` rung — so the catch fires only on a genuinely
    broken descriptor read.
  - **`setBondIdentityResolverForTest` is the seam** (the `set*ForTest`
    convention) that makes the failure drivable without a module mock.
- **The degraded state RIDES THE WIRE as `linkTelemetry.links[].identity_state`**
  (`@ceraui/rpc` `bondLinkIdentityStateSchema`), emitted only as `"unmappable"`.
  `link-telemetry-rows.ts`'s `unmappableByIface` is SUPPRESSION-ONLY: it can
  never promote a row to an identity (no `link_id`, no `port_label`, no
  `serial`), so the legacy `conn_id` rung's rows stay byte-identical and the
  marker only ever answers the question the ladder's silence leaves open — is
  this link KNOWN-unidentifiable, or merely unresolved on this rung. Absence
  therefore makes NO claim in either direction. Do NOT widen it into a rung that
  resolves an identity by the derived interface name: `legacyIface` picks the
  first interface holding a shared address, which is exactly the ambiguity rung 3
  is gated on.
- **`generation` is monotonic per WRITER PROCESS** and increments on EVERY
  publication, including one whose IP bytes did not change. That is the only
  signal a MAPPING-ONLY change can produce — moving a link between interfaces
  leaves the digest identical — so the session's SIGHUP is keyed on
  `publication.changed`, never on an IP-list diff.
- **A failed sidecar write RETIRES the sidecar.** One that survives its own failed
  republication describes bytes no longer on disk, which the reader can only call
  a hash mismatch; absent is the honest state (`missing_file`).

### THE DUPLICATE-IP POLICY SPLIT

`NETIF_ERR_DUPIPV4` answered two questions with one bit, and they have OPPOSITE
correct answers once a mapping exists:

| Question | Answer | Why |
|---|---|---|
| may it be a generic SOURCE-IP? | still **NO** | an operation steering by source address cannot tell the twins apart. `probeExclusionReason` is unchanged, and a test asserts it. |
| may it join the BOND? | **YES**, when a row can be published | the row names the INTERFACE too, and the sender binds `SO_BINDTODEVICE` |

The flag stays raised on the per-interface `netif` wire, and `isBondCandidate`
answers bond membership separately. **Two identical lines in `BIND_IPS_FILE` are
LEGAL** and covered. `enabled` still governs membership — but a dup-IP link's
`enabled` is forced false by the flag itself, so the operator's own choice lives
in `operatorBondOptOut` (`setBondOptOut`, written by `handleNetif`) rather than in
a bit the error path overwrites. A link that cannot be DESCRIBED
(`isMappableEntry`: valid iface name, valid `link_id`, non-empty ip) is not made
eligible by wishing.

**…AND THE NOTICE THE OPERATOR SEES IS A SEPARATE, RE-EVALUATED DECISION.**
The flag above answers a policy question; `netif_dup_ip` answers an honesty one,
and it is decided by `decideDupIpNotice(groups, deps)`
(`network-interfaces.ts`) rather than read back off the flag. Three properties
are load-bearing, and each was a defect before it was one:

- **It is a WARNING, never an error.** An excluded twin is a DEGRADATION of the
  bond, not a failure of the device — and the retired band asserted a fault at
  `"error"` severity while its own message ended "…they can still be bonded when
  per-interface link mapping is active", i.e. it raised an alarm and then
  explained the alarm was handled.
- **A FULLY MAPPED GROUP IS SILENT.** The notice consults `isBondMappingActive()`
  — the ONE authority on whether the (ip,iface) mapping is really in force — and
  then `isBondLinkMappable()` per member, so a band is produced only for a group
  that is genuinely still ambiguous: no mapping (the sender collapses duplicate
  source IPs and one link really is missing), or a mapping in force with an
  `unmappable` member (no row can be published for it, so it is excluded from the
  very mechanism that would have disambiguated it). Silence loses nothing: the
  per-interface `error: "duplicate IPv4 addr"` still rides the `netif` wire and
  the Network page still renders it.
- **IT IS DECIDED ON EVERY PASS, OUTSIDE `intsChanged`.** Both the raise and the
  retraction used to sit inside that branch, and a bond-mapping transition moves
  no interface, no address and no flag — so nothing re-evaluated and the band
  could never clear. Same raise-but-never-retract family as
  `policy_route_missing`. `duplicateIpGroups()` is likewise recomputed from the
  live addresses each pass rather than read back off `NETIF_ERR_DUPIPV4`, whose
  flags are only refreshed on a topology change.

`DupIpNoticeDeps` is installed (`wireDupIpNoticeDeps`) rather than statically
imported, because both facts live under `modules/streaming/`, which imports this
module. The defaults answer NO to both, which is the fail-safe direction: an
unwired process REPORTS the collision rather than silently claiming it is
handled.

### THE PRE-SPAWN CAPABILITY PROBE — the backward-compat guarantee

`bind-map-spawn.ts` `resolveBindMapArgs` runs `<sender> --capabilities-json`
(`srtla-capabilities.ts`, `spawnWithTimeout`, 3 s, registered in `SPAWN_POLICY` as
`srtlaSend.capabilityProbe`) **BEFORE the argument vector is built**, and passes
`--bind-map` ONLY on a valid `bind_map: true` document. **Non-zero exit,
unparseable JSON, or a timeout ⇒ NO SUPPORT** — matched on NOTHING, not the code
and not the message, so a new CeraUI against an OLD sender emits the
byte-identical legacy vector. Passing an unknown flag would make that binary exit
with a usage error, i.e. a failed stream rather than a graceful downgrade. Do NOT
move the probe below `buildSrtlaSendArgs`, and do NOT "simplify" the probe into a
try-and-react.

### THE TYPED-DISPOSITION PRODUCER BOUNDARY

`bind-map-disposition.ts` is the ONE normalized stream the UI consumes (todo 12);
it NEVER infers. Two launch paths exist that the sender structurally cannot report
— an old binary that was never given the flag, and a mapping the writer could not
put on disk — and CeraUI knows exactly what it published and which rows collide,
so it SYNTHESIZES the verdict WRITER-SIDE using **todo 8's exact value names**:

| Cause | `bind_map_status` | `disposition` |
|---|---|---|
| bind-map passed | `active` | `mapped` |
| probe: no support | `degraded(unsupported)` | `startup_collision_excluded` + groups, else `legacy_unique_only` |
| mapping write failed | `degraded(missing_file)` | same rule |

`noteSenderBindMapReport` REPLACES the synthesized value once telemetry arrives
(`source: "sender"`); `noteWriterBindMapReport` retires a previous session's
sender claim. `bind-map-notification.ts` turns the typed disposition into the
operator band and **the second link is never dropped in silence**:
`retained_last_valid` → degraded-but-both-twins-running; `startup_collision_excluded`
→ names the colliding IP and the LINE positions (never `conn_id`s), and refuses to
name WHICH physical twin survived because legacy mode cannot know;
`legacy_unique_only` → unique links normal, a collision group would be absent.
The band is retracted on stop (`clearBindMapReport`) — a persistent notification
never expires on its own.

Coverage: `tests/bind-map-writer.test.ts` (the twin fixture producing 2 bonded
rows + a coherent file pair, the flag/probe split, the opt-out, mode 0600,
mapping-only `changed`, unmappable + failed-sidecar retirement, and the static
SIGHUP-wiring lock), `tests/bind-map-spawn.test.ts` (every probe failure mode →
legacy vector; a disposition on EVERY branch), `tests/bind-map-disposition.test.ts`
(the capability-document table, writer synthesis, sender-replaces-writer, and all
seven degraded reasons reaching a band),
`tests/bond-entry-degraded-identity.test.ts` (a forced resolution failure driven
through the REAL netif scan → `genSrtlaBondEntries` → writer → registry →
`status.linkTelemetry`: the entry is kept, carries no id, cannot become a row,
still publishes its IP, and reaches the wire as `identity_state: "unmappable"` on
both the legacy rung and a sender that echoes its interface — plus the
byte-compat control that a healthy bond gains no marker anywhere), and
`tests/link-id-authority-gate.test.ts` (the comment-stripped repo walk: no
`lnk_` template/concatenation invention anywhere including fixtures, the prefix
literal confined to `physical-identity.ts` in shipped code, a self-proving
detector, and a non-vacuity check on the scan scope).

**Honest status:** no claim here has been exercised against a real twin-modem
board. Every fixture models the contract.

## …AND A TELEMETRY ROW IS A PHYSICAL DEVICE, NOT A FILE POSITION [EXISTS]

The writer publishes `link_id`; this is the READER that keys a rendered row on
it. `conn_id` is a POSITION in `BIND_IPS_FILE` (todo 8 says so outright), so a
SIGHUP that republishes the bond in a different order hands the same modem a
different one — and a row keyed on it moves an operator's RTT/NAK onto the other
twin.

**The old resolution could not describe twins at all.** `resolveIface` looked a
`conn_id` up as an IP and then scanned `netif` for the FIRST interface holding
that address. Twins share one address, so BOTH connections resolved to ONE
interface: one row showed the wrong device's numbers and the other joined
nothing. The frontend's join is by `iface`, so this was invisible from the UI
side — the fix has to be here.

**`link-registry.ts`** holds what the writer published (`link_id` → iface / ip /
`ID_PATH` / port label / serial), replaced WHOLESALE on every publication so a
link that left the bond stops resolving instead of lingering with stale numbers.
`registerSrtlaBond` (`link-telemetry.ts`) is its ONE call site, from
`publishSrtlaBond`, and it keeps the legacy conn_id registry in step.

**`link-telemetry-rows.ts` is the ladder**, strongest evidence first:

| Rung | Evidence | Notes |
|---|---|---|
| 1 | the sender's own `link_id` echo | it names the row it really bound; nothing outranks it |
| 2 | the sender's own `iface` echo | |
| 3 | `conn_id` as a FILE LINE position | ONLY while the mapping is in force |
| 4 | `conn_id` → unique-IP order → interface | byte-identical to the pre-mapping behaviour |

- **Rungs 1-2 read fields the PINNED binding strips.** `@ceralive/srtla-send`
  2026.6.2 predates todo 8 and its Zod reader drops unknown keys, so today every
  launch resolves on rung 3 or 4 and the stronger rungs light up on a republish
  with no further change — the same defensive-read discipline `bytes_sent_total`
  already follows. Twin disambiguation therefore works TODAY off the writer's
  own record.
- **Rung 3 is GATED on the disposition, not on the telemetry's shape.** Without a
  mapping the sender collapses duplicate source IPs, so its ids count UNIQUE
  ADDRESSES rather than lines and the two numberings diverge exactly where the
  twins are. The gate reads `isBondMappingActive()`, never a guess.
- **`port_label` is derived from the published `ID_PATH`** (`USB <bus>-<chain>`,
  the kernel's own notation) and is what separates two units of one SKU. A path
  with no USB ancestry yields NOTHING rather than a raw path.
- **A serial rides a row ONLY when the device reports one.** Todo 10 measured the
  HiLink twins publishing none; the resolver answers `undefined` and no tail is
  rendered. Do not invent one.

**`link-mapping-report.ts` is the consumer of todo 11's three seams** —
`noteSenderBindMapReport` (the sender's verdict REPLACES the synthesized one),
`onBindMapReportChange` (the operator band follows the stream for the session,
subscribed in `startLinkTelemetry`) and `getNormalizedBindMapReport`. Two rules:
an ABSENT `bind_map_status` leaves the writer's verdict STANDING (a sender build
that cannot report is not a sender that retracted), and the sender's verdict is
handed over on CHANGE only, or the band re-broadcasts once a second.

`status.bond_mapping` carries that ONE normalized stream to the UI as an EXPLICIT
value — `null` when no bond is described — because the frontend status merge
preserves an omitted field, so a raise-only band could never be retracted.

Coverage: `tests/link-telemetry-registry.test.ts` (the port-label table, the twin
rows resolving to different interfaces and ports, the ORDER-SWAP reload proving
each twin keeps its own stats, the sender-echo precedence, both legacy rungs, and
the disposition's trip to the wire). Rule-E proof: keying the registry so a
reload is a no-op reddens the order-swap test; letting the file position outrank
the sender's echo reddens the precedence test.

## THE INTERFACE ADDRESS IS REPORTED, NOT SET [EXISTS]

`handleNetif` (`network-interfaces.ts`) reads `msg.ip` for exactly ONE purpose — the
echo guard `if (int.ip !== msg.ip) return;` — and then mutates `enabled` and nothing
else. **There is no apply path for an address anywhere in this backend**: no `ip
addr`, no `nmcli ipv4.addresses`, no persisted static config, for any interface kind.

The frontend used to offer a "Static IP address" field on top of that. Measured on
the bench Rock 5B+ (2026-08-16), saving `192.168.0.222` onto a dongle leased
`192.168.0.169`:

```
UI                  → toast "Saved"
ip -br -4 addr      → enx344b50000000  UP  192.168.0.169/24   (unchanged)
nmcli con show      → ipv4.method: auto   ipv4.addresses:      (untouched)
journalctl -u ceralive → not one line about the request
```

And the dead field was DESTRUCTIVE, not merely inert: a save that also flipped the
bond toggle was discarded WHOLE, because the edited address no longer matched the
observed one and the guard early-returns before touching `enabled`. Board-proven —
bonding toggled off, "Saved" toasted, row still read "In Bond".

- **The frontend now ECHOES the observed address** (`iface.ip`) rather than authoring
  one, so the guard reads as the concurrency check it is and the operator cannot trip
  it. The wire contract is unchanged; `netifConfigInputSchema.ip` stays optional and
  an address-less interface still OMITS it (`""` fails the regex).
- **A direct RPC call with a mismatched address is now REFUSED, not silently dropped.**
  This was a REAL remaining defect at the procedure layer —
  `configureNetworkInterfaceProcedure` returned `{success: true, applied}` whichever
  way `handleNetif` went, so a discarded save (including the bond toggle it carried)
  reached the caller as "Saved". `handleNetif` now returns a typed `NetifApplyOutcome`
  and the procedure forwards it as `{success:false, error}` — see THE NETIF RPC
  ANSWERS FOR WHAT IT ACTUALLY APPLIED below.
- **Do NOT re-add an address input anywhere** without first implementing the apply
  path. A control that cannot act is the defect; the missing feature is static
  addressing, and it is missing in the BACKEND, not in the dialog.

Frontend half: `apps/frontend/AGENTS.md` → "The interface address is REPORTED".

## THE NETIF RPC ANSWERS FOR WHAT IT ACTUALLY APPLIED [EXISTS]

`handleNetif` returns `NetifApplyOutcome` (`{ok:true}` or `{ok:false, reason}`),
and `configureNetworkInterfaceProcedure` forwards a rejection as
`{success:false, error}` typed by `netifConfigErrorSchema` — `unknown_interface`
/ `stale_address` / `enable_refused` / `disable_all_refused`.

Every one of those was a bare `return` reported as `{success:true}`. The
`stale_address` path is the one that mattered: it is the CONCURRENCY guard
(`int.ip !== msg.ip`), and it discards the WHOLE request — including the bond
toggle riding alongside the address it was checking — so the operator was told
"Saved" over a link whose bond state had not moved.

- **The mock branch still answers `success:true`, deliberately.** Under mocks the
  mutation genuinely applied, to the overlay `setMockNetifConfig` wrote before
  `handleNetif` ran; `handleNetif` then works the RAW map, where its IP guard
  legitimately refuses because the mock-overlaid IP differs. Reporting THAT as a
  failure would report a dev/e2e toggle that visibly worked as broken. Do not
  "unify" the two branches.
- **The four reasons are not collapsible.** `enable_refused` already carries an
  operator notification naming the blocking error; `disable_all_refused` is the
  device protecting its last link; `unknown_interface` clears when the link comes
  back; `stale_address` means re-read and retry.

## THE ETHERNET PORT ROLE — UPLINK OR SHARED LAN [EXISTS]

`modules/network/ethernet-role.ts` (leaf: persistence + the candidate rule),
`ethernet-role-transition.ts` (the NM transition + boot reconcile) and
`ethernet-role-outcome.ts` (the ONE frame builder) let an operator declare a
wired port either an ordinary bonding `uplink` or a `shared-lan` router port
that serves DHCP/DNS to LAN clients via NetworkManager's `ipv4.method shared`.

**The persisted key is `config.eth_roles`, keyed by IFNAME, and absent means
`uplink`.** An untouched device is byte-identical to before this landed, and the
boot reconciler acts on a stated `shared-lan` only — re-writing `ipv4.method
auto` onto every ordinary port at boot would touch profiles nobody asked us to
touch. The ifname key is the ONE defensible instance of name-keying in this
directory: `wifi_modes` keys on a permanent MAC because a radio's name follows a
udev rename, but this is not a claim about a DEVICE — it is an operator
statement about a SOCKET, and the NM profile it drives is itself bound by
`connection.interface-name`, so the two agree by construction.

**`NETIF_ERR_SHAREDLAN = 0x08` is the exclusion mechanism**, stamped by
`applySharedLanBondGate` in the same two places, and for the same reasons, as
`applyConcurrentApBondGate`: `isBondCandidate` refuses the port structurally so a
caller holding a hand-built entry is covered, and the gate stamps the flag into
the netif map so the wire, `probeExclusionReason`, the connectivity election and
the same-subnet grouping inherit the exclusion through the flag they already
read. It runs on EVERY pass, beside its two siblings — a role flip moves no
interface, address or counter, so a topology-gated stamp would never fire.

**It is the ONE gate here that also RELEASES.** The SIM-less gate clears its flag
and deliberately leaves `enabled` false, because a SIM reappearing is a hardware
event the operator did not ask for. A flip back to `uplink` IS the operator
asking for the port to bond again, and the flag is the only thing that lowered
`enabled` — so releasing it undoes its own effect, honouring a separate bond
opt-out and leaving the port down if any other error still stands.

**The transition is persist-first with rollback**, on `wifi-adapter-mode`'s
terms: the role is written before NM is touched (so a device that dies
mid-transition comes back trying for the operator's role) and RESTORED the moment
NM refuses, so a failed flip leaves neither the config nor the netif flags
half-applied. Every exit path publishes exactly one terminal `eth_role` frame,
preceded by exactly one `pending` frame on an admitted transition; the
already-applied branch publishes its terminal frame directly, because nothing was
dispatched and no NM answer will ever settle.

**Wire shape** (`@ceraui/rpc` `network.schema.ts`), frozen for the frontend role
UI:

```ts
netifEntry.ethRole?: 'uplink' | 'shared-lan'   // EXPLICIT on every ethernet row
rpc.network.setEthernetRole({ name, role })    // input is .strict()
  -> { success, applied?, error? }             // ethernetRoleErrorSchema, 5 members
broadcast "eth_role" -> { eth_role: { name, role?, pending?, success?, error? } }
```

`ethRole` is published EXPLICITLY on every ethernet row, `uplink` included —
never present-only-when-shared. The consumer merge preserves an omitted optional
field, so a one-directional role could be raised and never lowered (the
`policy_route_missing` latch, exactly). ABSENT means "not an ethernet port, or an
older backend", and is never read as `uplink`. Frontend ingestion allowlist:
`subscriptions.svelte.ts` `case "netif"`.

**A shared-lan port registers as a client zone for the steering layer, and
NOTHING installs a table.** The nftables client-zone work is the steering
module's (HALTED pending the Wave-0 kernel-capability verdict); this todo marks
the port and extends the READ-ONLY policy-route check only.

Coverage: `tests/ethernet-role.test.ts` (driven through the REAL
`processIfconfigOutput`, `genSrtlaBondEntries` and
`configureNetworkInterfaceProcedure`), `tests/network-mutation-action-guard.test.ts`
(the S7 device half), frontend `tests/netif-eth-role-ingestion.test.ts` (both
directions).

### …AND THE POLICY-ROUTE CHECK NOW COVERS WIRED UPLINKS, ON WEAKER TERMS [EXISTS]

`collectEthernetPolicyRouteCandidates` adds `eth*`/`en*` to the check with
`flagWhenRuleAbsent: false`, and that flag is the whole contract. The image's
routing hooks map `usb*`/`enx*` onto tables 100-107 and `wlan0-4` onto 120-124
and NOTHING else, so a plain `eth0` has no per-uplink table at all — "no source
rule" is the documented steady state, not a fault, and flagging it would amber-band
every correctly-working wired uplink in the fleet (the same reason `enx*` was
excluded from the bonded class outright). What a wired candidate CAN be judged on
is a rule that EXISTS whose table has no default route — the fault todo 9's
steering module would produce once it installs one.

- **`collectPolicyRouteCandidates` is UNCHANGED**, deliberately: its answer is
  the dispatcher-mapped class, a contract other code and its tests read directly.
  The two classes are collected separately because they are judged differently.
- **An ethernet candidate on an ambiguous address is dropped BEFORE the spawn** —
  it could only ever be withheld, and asking `ip` a question whose answer is
  already known costs a spawn on the 5 s netif cadence for nothing. It is also
  what keeps the bench-twins case spawning zero `ip` calls.
- **A `shared-lan` port is excluded for free**: the netif gate lowers its
  `enabled`, and the collector already requires an enabled interface. A port
  serving its own clients is not an uplink and has no source-routing to verify.

## AN EXCLUDED DEFAULT ROUTE IS NOT A CONNECTIVITY VERDICT [EXISTS]

`updateGw` (`modules/network/gateways.ts`) probes the Internet through the
current default route and, on failure, re-probes each interface before electing
a new one. The decisions it makes are the pure
`modules/network/connectivity-candidates.ts`; the effects (spawning `ip`,
issuing probes, raising/retracting `no_internet`) stay in `gateways.ts`.

**The kernel elects a default route from whatever DHCP hands it, including an
interface CeraUI has already excluded.** Board-confirmed on a Rock 5B+ carrying
the duplicate-MAC HiLink pair (two physically distinct dongles, one factory MAC,
both leasing `192.168.8.100`): their lease installs `default via 192.168.8.1 dev
enx0c5b8f279a64` with NO metric — metric 0, outranking `eth0`'s metric 101 — so
every probe went out an interface `NETIF_ERR_DUPIPV4` had already suppressed from
the bond, hit the dongle's captive `307`, and raised **"No Internet connectivity
via the default connection, re-checking all connections…"** while `eth0` answered
a clean `204`. The operator saw a standing offline warning on a device with four
working paths.

- **`probeExclusionReason(entry)`** is the single eligibility rule: a netif error
  (`NETIF_ERR_DUPIPV4` / `NETIF_ERR_HOTSPOT`) or no address disqualifies an
  interface. **`enabled === false` deliberately does NOT** — it is overloaded
  (the error flags set it, but so does the operator toggling a link out of the
  BOND), and "do not send bonded video over this link" is not "this link may not
  be used to check for Internet". Both error flags already imply `enabled:
  false`, so nothing dup-IP or hotspot escapes through that.
- **`decideConnectivityClaim`** returns `default-failed` (the elected default
  route is eligible and failed — the original message, unchanged),
  `no-eligible` (nothing is probeable, so there is no re-check to promise; this
  outranks every other arm), or `suppressed` (the default route sits on a
  known-excluded interface — say nothing, re-elect).
- **`suppressed` NEVER escalates**, even when every candidate probe then fails.
  A candidate probe steers by SOURCE ADDRESS, which selects a route only where
  the kernel supports policy routing — and this board's does not: `ip rule show`
  answers `Operation not supported`, `curl --interface eth0` (device-bound)
  returns 204 while the same request bound to eth0's ADDRESS times out, and
  `ip route get <addr> from 192.168.78.132` still resolves via the excluded
  dongle. A failed probe there is evidence about STEERING, not about
  connectivity, so claiming the device is offline would swap one false alarm for
  another. It is logged at `warn` instead, and the excluded interfaces are
  already surfaced with their reasons on the Network page.
- **`httpGet` now honours `localAddress`.** It accepted the option, threaded it
  through `HttpGetOptions`, and dropped it in its destructure — so every
  "per-interface" probe silently egressed the CURRENT default route and the
  fallback loop re-tested the very path that had just failed. Bun's `fetch` has
  no source-address option, so a BOUND probe goes through `node:http` (the one
  sanctioned exception to this app's `fetch`-only rule; the unbound probe still
  uses `fetch`, so the existing suite is unaffected). Do not "restore" the
  convention here.
- **An IPv6 literal is bracketed** (`formatUrlHost`) before it reaches a URL.
  `www.gstatic.com`'s AAAA records each produced an
  `Internet connectivity HTTP check error ERR_INVALID_URL` before the probe ever
  left the device.
- **The notification is retracted on PROVEN CONNECTIVITY, not on route
  installation.** `setDefaultRoute` reads a per-interface routing table and the
  shipped image provisions those only for `modem0-7`/`wlan0-4`, so on a board
  reaching the Internet through `eth0` it fails with "table id value is invalid"
  — and the old code, which retracted only after a successful install, left "No
  Internet connectivity" standing over a working link. The claim is about the
  DEVICE's connectivity; an eligible interface answering `204` settles it, and
  the route install is attempted afterwards and merely logged on failure.

Coverage: `tests/connectivity-exclusion-aware.test.ts` — the exclusion table
(incl. the operator-disabled negative), the candidate list against the board's
real roster, the `ip route show default` parser against the board's verbatim
output (metric ordering, `dev`-only routes, no-`dev` and empty negatives), the
claim matrix in all four arms, the no-escalation lock, and a REAL-socket proof
that a bound probe egresses the address it was given (the defect type-checked, so
a mocked assertion could not catch it).

## …AND A PROBE THAT MUST NAME A DEVICE BINDS ONE [EXISTS]

The section above ends the "blame the default connection" false alarm by
EXCLUDING the duplicate-IP twins from the probe set. That was right while the
only steering CeraUI had was a source address — and it left the twins with no
connectivity verdict at all, which the bond now needs: todo 11 made them
BONDING-ELIGIBLE, so a link the device is willing to send video over was one it
refused to ask about.

**Two addresses, and neither one names a twin.** The bench pair ships ONE factory
MAC, both lease `192.168.8.100`, and both answer their admin API on the SAME
`192.168.8.1`. So a SOURCE address selects a pair, and a DESTINATION address
selects a pair. `SO_BINDTODEVICE` is the only thing that selects a device, and
`curl --interface` is the only client on this box that speaks it —
`router-cellular-admin.ts` already needed exactly that to read two different
serials off the two units, so this is that proven pattern applied to the WAN
question rather than a second mechanism.

`modules/network/device-bound-probe.ts` is that probe, and the split it feeds is
the connectivity twin of todo 11's bonding split:

| Question | Rule | Dup-IP answer |
|---|---|---|
| may it be a generic SOURCE-IP? | `probeExclusionReason` | still **NO** — unchanged, and a test asserts it |
| may it be probed AS A DEVICE? | `deviceBoundProbeExclusionReason` | **YES** |

`probeBindingFor` returns the binding a candidate must be probed with, so
`ProbeCandidate` now carries `binding` and `electConnectivityCandidate`
(`connectivity-election.ts`) dispatches on it. Every non-dup-IP interface keeps the
byte-identical `localAddress` probe.

- **A DEVICE-BOUND PROBE IS PER DEVICE, AND THAT IS THE POINT.** Two interfaces
  holding one address get two INDEPENDENT verdicts, so a WAN outage behind one
  twin marks that twin unreachable and leaves its sibling electable. A
  source-address probe could only ever have answered for the pair.
- **ADMIN REACHABILITY IS NOT WAN TRUTH, and neither may stand in for the
  other.** A SIM-less HiLink answers its own `192.168.8.1` happily and
  captive-portals everything else — board-measured, as an `apt-get` that fetched
  the dongle's error page. So the probe targets ONLY the externally-resolved
  check address and demands the exact `204` + EMPTY BODY contract; a `307` portal
  page and a `204` that carried a body are both unreachable. No gateway, admin
  URL or LAN address is ever a probe target, and a test asserts the probe-target
  set equals the resolved address set.
- **FAIL-SOFT, because it is a new binary dependency.** A missing/failing `curl`,
  a timeout, or a non-204 all resolve `false`: the interface loses an election
  round, which is byte-identical to the behaviour before dup-IP links were
  probeable at all. It never throws into the 2 s gateway loop. Registered in
  `SPAWN_POLICY` as `connectivity.deviceBoundProbe` (bounded-probe): curl's own
  `--max-time` inside a `spawnWithTimeout` outer cap.
- **The ifname reaches argv as its OWN element**, guarded by `SAFE_IFNAME_RE` —
  which `router-cellular-admin.ts` now imports instead of keeping a second copy,
  so the two `curl --interface` sites cannot disagree. Its first character
  excludes `-`: `--upload-file` is otherwise a well-formed member of the old
  character class and curl would read it as a flag rather than as the value of
  `--interface`.
- **The `suppressed` claim is untouched.** `decideConnectivityClaim` still reads
  `probeExclusionReason` for the DEFAULT route, so a default route sitting on a
  dup-IP dongle still withholds the offline claim rather than blaming the device.

### THE TWIN-GATEWAY ELECTION (two × `192.168.8.1`)

Which twin's `192.168.8.1` does a probe talk to? **Neither — a probe never dials
it.** The election is decided by the socket's DEVICE binding, and the route that
follows is installed BY DEVICE:

- `setDefaultRoute` reads a PER-INTERFACE table (`ip route show table <ifname>`),
  so the line it gets back already belongs to that device;
- `parseDefaultRouteLine`/`buildRouteAddArgv` replay EVERY token of that line, so
  the `dev <ifname>` clause survives into `ip route add` verbatim — two twins
  produce two DIFFERENT argvs from two identical `via` addresses;
- `parseDefaultRouteInterface` reads the `dev` clause, never the gateway.

Do NOT "simplify" `buildRouteAddArgv` to a `via`-only form, and do NOT identify
an uplink by its gateway address anywhere on this path.

**Honest status:** no claim here has been exercised against a real twin-modem
board. Every fixture models the contract. Coverage:
`tests/connectivity-device-binding.test.ts` (argv binding, the 204/portal/killed
response table, per-twin independence, the WAN-down-on-one-twin fixture, the
never-dial-the-gateway assertions, and the unchanged ordinary roster) +
`tests/connectivity-exclusion-aware.test.ts` (both exclusion rules on one
roster).

## …AND AN INFERENCE THAT CANNOT NAME A DEVICE IS WITHHELD [EXISTS]

`policy-route-check.ts` matches a rule's `from <srcip>` back to an interface.
That is a source-IP inference, and it holds only while an address names ONE
interface. `ambiguousSourceIps` measures the exception off the live snapshot —
every address held by more than one interface, counting DISABLED holders too,
since a disabled twin still owns the address that makes its sibling's rule
unattributable — and `derivePolicyRouteMissing` WITHHOLDS a verdict for it (and
for a source that dispatches to several tables) instead of guessing. The
withheld interface reports as un-flagged, never as "checked and faulty": a fault
claim about an interface the check cannot identify is a guess, and the condition
that produces it already has its own operator-visible band.

It is measured from the SNAPSHOT rather than read off `NETIF_ERR_DUPIPV4` for
two reasons: `network-interfaces.ts` imports this module, so importing the flag
back would cycle; and the flag lags the condition (a station↔AP transition, a
suppressed pair) while the snapshot does not.

**MEASURED, and worth knowing before you reason about this check: the bench
HiLink twins are NOT in its candidate class at all.** They enumerate as
`enx0c5b8f279a64` and `eth1`, and the class is `wlan|usb|ww` plus the netns
veth — `enx*` is deliberately excluded (the NM dispatcher maps only
`enx*0`..`enx*7`) and `eth*` never was. So this check has never published a
verdict about a twin and the amber band cannot be attributed to one. The
ambiguity guard is therefore about any same-address pair INSIDE the class — two
same-model `usb*` modems on a vendor-default lease — and about todo 14's `.link`
renaming prototype, which could move cellular NICs into it. A fixture that uses
the twins' real names asserts nothing; a test pins that fact so it is not
re-derived wrongly.

**The `dg<N>h` netns branch is REMOVED (phase-C todo 39).** Todo 13 isolated the
naming convention behind one predicate precisely so that retiring the image's
router-dongle netns layer would be a single deletion here, and todo 39 made it:
`isNetnsDongleVeth` and `DONGLE_VETH_RE` are gone, and `dg*` is no longer in the
bonded class, so it is no longer a candidate and no verdict about it can be
published. Do NOT re-add it. An OLD-image board caught mid-retirement can still
be holding a `dg0h` veth WITH its source rule installed — that state belongs to
the image's own teardown path (`ceralive-dongle-netns-retire.service`), not to a
check whose dispatcher no longer has an opinion about the interface, and flagging
it amber would report a layer being removed as a routing fault. Coverage:
`tests/policy-route-check.test.ts` — the ordinary / dup-IP / no-netns matrix, the
withhold cases, the twins-out-of-class pin, the retired-seam locks, and a
STALE-netns board (its `dg0h` rule still in the fixture, its table deliberately
default-less) getting the control's verdict and never being queried.

## DNS ON THE STREAM-START CRITICAL PATH [EXISTS]

`dnsCacheResolve` (`modules/network/dns.ts`) sits INSIDE the per-attempt launch
deadline: `streaming.start` → `session.start` → `updateConfig` → `resolveSrtla`
→ `dnsCacheResolve`, all before the sender spawn and any engine IPC. It is the
only network round-trip CeraUI itself adds to a start.

It runs TWO lookups — a `wellknown.belabox.net` health check (the captive-portal
/ hijacked-DNS gate) and the caller's own query. **They are independent: the
check only GATES whether the answer is trusted, it is never an input to it.**
Awaiting them in series therefore put a second full DNS round-trip on every
stream start for no ordering reason, and on a bad link cost up to
`2 × DNS_TIMEOUT` (4 s) of a 10 s `attemptTimeoutMs` budget — time the engine
start then no longer had, turning a start that would have succeeded into a
deadline-cancelled retry. They now fly concurrently and the call costs
`max(check, query)` instead of `check + query`.

- **The gate is byte-identical.** The caller's answer is used ONLY when the
  well-known name resolved to `DNS_WELLKNOWN_ADDR`. A speculative answer from a
  network that failed the check is discarded unread and `dnsResults[name]` is
  deleted, exactly as before. Its error is deliberately NOT logged — the serial
  version never issued that query, so logging it would invent a new failure line.
- **Separate `Resolver` instances are REQUIRED, not an optimisation.** A c-ares
  channel's `cancel()` on timeout aborts every pending query on that channel, so
  sharing one would let a timing-out leg kill its sibling mid-flight. `resolveP`
  now always builds its own; the old "reuse the resolver after a successful
  validation" path is gone.
- **`setDnsResolverFactoryForTest(factory | null)`** is the test seam (mirrors
  `setIfaceResolverForTest` / the `set*Runner` seams) — a `DnsResolverLike`
  double, no process-wide `mock.module` on `node:dns`.
- Unchanged: the literal-IPv4 short-circuit (a raw-IP relay address still issues
  ZERO queries), the `DNS_TIMEOUT`, and the persisted-cache fallback.

Do NOT re-serialise these two lookups, and do NOT "simplify" the two resolvers
back into one shared instance.

Coverage: `tests/dns-parallel-resolve.test.ts` (the caller's query is dispatched
before the health check settles, distinct resolver ids per leg, both bad-DNS
branches discard the speculative answer, query-failure falls back, the IPv4
short-circuit, and the A+AAAA path).

## SOFTWARE-UPDATE START CONTRACT [EXISTS]

`modules/system/software-updates.ts` owns whether an apt update may run, and it
never refuses in silence.

- **`aptUpdatesEnabled()` is the ONE predicate.** Discovery
  (`getSoftwareUpdateSize`), the apt package-list refresh
  (`checkForSoftwareUpdates`), the periodic loop, and the install path all read
  it, so the UI can never advertise an update the install path would refuse.
- **`apt_update_enabled` defaults to TRUE** (`SETUP_CONFIG_DEFAULTS`,
  `helpers/config-schemas.ts`). The shipped `setup.json` carries no such key and
  the field is `z.boolean().optional()`, so "absent ⇒ falsy" left the install
  path dead on 100% of field hardware while discovery — which was never gated —
  kept offering an Update button. Confirmed live on a Rock 5B+: `debug.log`
  recorded `System: software update started` and then nothing at all. Only an
  explicit `"apt_update_enabled": false` opts a device out.
- **`startSoftwareUpdate(): UpdateStartOutcome`.** Every refusal is a typed
  `UpdateStartRefusal` — `updates_disabled` / `streaming` / `already_updating` /
  `check_unavailable` — logged at `warn` and returned to the caller.
  `rpc/procedures/system.procedure.ts` `startUpdateProcedure` forwards it as
  `{success:false, error:<reason>}` and does NOT re-check the guards itself;
  duplicating them is what let a refusal answer `{success:true}`.
- **A skipped pre-check no longer wedges the latch.** `defaultSoftwareUpdateRunner`
  routes through the `softwareUpdateCheckRunner` seam and latches `softUpdateStatus`
  only once the check has actually started. The check's callback is the ONLY
  thing that ever clears that latch, so latching it after a declined check left
  `isUpdating()` true for the lifetime of the process — refusing every later
  update and silently killing the periodic loop with it.
- **`resetSoftwareUpdateState()`** is a test seam (mirrors the `reset*Runner`
  seams): it drops the in-flight latch and the last terminal outcome. Never call
  it from production code — it would discard a real in-flight update.

Coverage: `tests/software-updates-start-refusal.test.ts`.

## SOFTWARE-UPDATE CHECK CONTRACT [EXISTS]

The install path above never refuses in silence; the CHECK path now never
*answers* in silence either. A manual "Check for updates" used to change nothing
observable at all — confirmed live on a Rock 5B+, where the button produced no
spinner, no result and no error for 11 s while `debug.log` recorded
`System: manual software update check started` and `apt-get update: success`
1.8 s later. The check ran; only its result was unpublished.

- **A check has THREE outcomes, never zero.** `update_state` gains
  `check_failed` (typed `UpdateCheckFailureReason`: `refresh_failed` /
  `discovery_failed`) and a `checked_at` epoch-ms stamp on
  `idle`/`checking`/`available`/`check_failed`. `check_failed` is DISTINCT from
  `failed` — the latter is an install that ran and failed; the former means the
  device could not establish whether an update exists at all.
- **`checked_at` is load-bearing, not decoration.** Without it a successful check
  that finds nothing rebroadcasts a byte-identical state, so a working check and a
  dead button are indistinguishable. It is also the ONLY completion signal the
  frontend can latch on: `checking` sits below `available` in precedence, so a
  device that already knows about an update never publishes a `checking` frame.
- **Precedence** (`deriveUpdateState`): `check_failed` sits BELOW `available` — a
  proven-available update stays installable even when a later refresh could not
  confirm it — and ABOVE `idle`, because "we could not check" must never render as
  "up to date".
- **The operator-visible verdict keys on the apt EXIT CODE, never stderr.**
  `classifyAptUpdateResult`'s stderr rule is retained for the RETRY CADENCE only.
  apt writes benign warnings on a healthy refresh, and one unreachable repo among
  several still exits 0 (verified on the board) — escalating either would
  false-alarm and would break the documented "a noisy-but-nonfatal `apt-get
  update` must not suppress the broadcast" invariant.
- **A failed refresh is NOT cleared by a later successful discovery.** Only the
  START of a new cycle clears it. Otherwise `dist-upgrade --assume-no` parsing the
  STALE package lists reports "0 upgraded" and erases the very failure that made
  the answer untrustworthy — that is exactly how the device came to answer
  "System is up to date" when it had reached no repository at all.
- **`runUpdateDiscoveryAndReport()` is the ONE landing seam** for both the
  periodic loop and the manual re-check: it stamps `checked_at` BEFORE discovery
  (so discovery's own broadcast already carries it) and ALWAYS emits a terminal
  frame, because discovery has several early returns that broadcast nothing.
- **A refused check restores what it did not replace.** `triggerManualUpdateCheck`
  save/restores `lastUpdateFailure`/`lastUpdateSucceeded` around dispatch, so a
  skipped check no longer wipes the failed-install state the operator was reading
  and then broadcasts nothing in its place.

Coverage: `tests/software-updates-check-visibility.test.ts` + the frontend half in
`apps/frontend/src/main/dialogs/UpdatesDialog.check.test.ts`.

## PER-CORE ENCODER LOAD — TWO KERNELS, AND ONE OF THEM HAS NO NUMBER [EXISTS]

`modules/system/encoder-load.ts` reads the RK3588's two VEPU580 encoder cores and
publishes its own `encoder-load` broadcast. It is the producer half of the
three-state model the Device Health panel renders
(`apps/frontend/src/lib/streaming/encoder-load.ts` — that module is the CONTRACT,
and this collector conforms to it, never the other way around).

**The two kernels CeraLive ships report this incomparably**, and both were
re-verified live on the bench board rather than assumed:

| Kernel | Interface | What it reports |
|---|---|---|
| vendor 6.1 BSP | `/proc/mpp_service/load` | a REAL per-core percentage — but only once `load_interval` is armed |
| mainline / edge 7.1 | `/sys/kernel/debug/clk/clk_rkvenc{0,1}_core/clk_enable_count` | the core's clock ENABLE STATE — a busy/idle bit, and nothing more |

- **Which one is live is PROBED, never inferred.** No `uname` test, no board-id
  test, no hardware-kind lookup: a device can be moved between the two kernels by
  swapping boot media (the bench board has been, repeatedly), so the only honest
  question is which interface answers right now. Probe order is richest-first, and
  **a reality only wins when it produced a usable core reading** — a vendor `load`
  file that exists but parses to nothing (the driver prints
  `please set load_interval first!!!` until it is armed) still falls through to the
  busy/idle bit rather than reporting an instrumented-but-empty device.
- **THE INVARIANT: a `clk_enable_count` is never turned into a percentage.** It is
  a reference count, not a magnitude — the measured 2-and-1 under four concurrent
  sessions does not mean "core 0 is twice as busy". There is deliberately no code
  path from an enable count to a number, and `tests/encoder-load.test.ts` pins that
  absence the same way the frontend contract test does.
- **`load_interval` is armed ONCE, idempotently, and only when it is off.** The
  vendor driver reports nothing until it is non-zero, but arming it is a WRITE into
  `/proc`, so the current value is READ first and an already-armed device is left
  exactly as found. A refused write never breaks the read.
- **Ordering is derived from the block's base ADDRESS, not from file order or a
  hardcoded address table.** The addresses are the SoC memory map, so ascending
  address IS hardware order (`fdbd0000` = core 0, `fdbe0000` = core 1), and
  deriving it keeps the parser off a specific board's addresses. Only
  `rkvenc-core` rows are encoder cores — the decoders, JPEG unit and RGA share the
  same file and must be ignored.
- **Privilege: none is escalated.** The backend runs as root
  (`deployment/ceralive.service` `User=root`), so both reads use the same plain
  `Bun.file()` seam as the `sensors.ts` `/sys/class/thermal` read. Do not introduce
  a helper, a `sudo`, or a capability for this.
- **Degradation follows `sensors.ts`/`device-stats.ts`:** every read is wrapped in
  its own try/catch, one unreadable core degrades only that core, and a device
  where neither interface answers reports the honest unavailable floor
  (`source: null`, no cores) rather than a shaped guess.
- **It is its OWN broadcast, NOT a sixth `device-stats` field** — that payload is
  frozen by the S1 lock, and this reading is structured per core rather than a
  scalar. It is likewise not foldable into `sensors`, which is a flat
  `Record<string, string>` of display strings. Wire schema: `@ceraui/rpc`
  `encoderLoadSchema`. Cadence 2 s, coalesced at 2 s, and seeded into the
  post-auth initial-state push so a fresh client does not sit on the unavailable
  band waiting for the first tick.
- **`initEncoderLoad` is `isRealDevice()`-gated.** A dev/emulated host has no
  VEPU580, so it publishes NOTHING rather than a synthetic reading — and that
  silence is precisely what keeps the frontend's dev-only `?health-mock=` fixture
  the single mocking mechanism for this signal. A backend mock provider here would
  be a parallel mechanism, not the established one.

Coverage: `tests/encoder-load.test.ts` (both realities, the arming contract, the
address ordering, the fall-through, the emulated-host gate, and the
never-a-number regression lock) + the frontend halves
`apps/frontend/src/tests/encoder-load-source-precedence.test.ts` and
`apps/frontend/src/main/dialogs/DeviceHealthDialog.test.ts`.

## CPU TOPOLOGY — THE DENOMINATOR `cpuLoad1` WAS MISSING [EXISTS]

`modules/system/cpu.ts` publishes a `cpu` event carrying `{ cores: number | null }`
— the online CPU count, `nproc`-equivalent, read from `os.cpus().length` through
an injected `CpuDeps.cpuCount` seam.

It exists because a 1-minute load average is a count of RUNNABLE TASKS, so it says
nothing on its own. On an 8-core RK3588 a reported `1.00` is roughly an eighth of
the board, but it reads as saturation to an operator who does not already know the
core count — reported live while a single software (non-accelerated) encode pegged
one core.

- **ITS OWN BROADCAST, not a sixth `device-stats` field.** That payload is frozen
  by the S1 lock and THREE tests assert its keys EXACTLY, so this follows the
  precedent `encoder-load` and `fan` already set. It is likewise not foldable into
  `sensors`, a flat `Record<string, string>` of display strings.
- **A BOOT FACT, not a sample.** Core count cannot change without a reboot on this
  hardware, so it is resolved ONCE in `initCpu()` and re-served from the post-auth
  initial-state push (`sendInitialStatus`) — the same treatment `revisions.kernel`
  gets, for the same reason. There is deliberately no polling loop and no coalesce
  entry.
- **NOT `isRealDevice()`-gated**, unlike `fan`/`encoder-load`. Those read
  board-specific sysfs nodes a dev host genuinely does not have; every host has
  CPUs, so gating this one would leave the dev and CI paths rendering the bare load
  average the signal exists to replace. For the same reason it needs no mock
  provider — the real reader already works everywhere.
- **NEVER ASSUMED.** A count that is not a positive integer — a throwing reader, a
  zero-length list, a non-integral value — degrades to `cores: null`, and the UI
  then falls back to the raw load average. Substituting a plausible count would
  fabricate the very denominator the signal exists to supply, which is the same
  class of lie as rendering a busy/idle encoder core as a percentage. Do NOT
  hardcode 8, and do NOT derive it from the board kind.

Frontend half: `apps/frontend/AGENTS.md` → "CPU load is a SHARE OF CAPACITY".
Coverage: `tests/cpu.test.ts` (the read, every unusable-count degradation, the
never-throws contract, and a no-seam case proving the shipped wiring resolves a
real count rather than only the injected double).

## FAN — A DUTY CYCLE, AND THE FILES NAMING IT MOVE [EXISTS]

`modules/system/fan.ts` reports whether the board has a controllable fan at all
and, if it does, what duty cycle it is being driven at. It publishes its own
`fan` broadcast on a 5 s cadence (coalesced at 5 s, seeded into the post-auth
initial-state push). Wire schema: `@ceraui/rpc` `fanSchema`.

- **It is its OWN broadcast, NOT a sixth `device-stats` field** — that payload is
  frozen by the S1 lock, so extending it is a deliberate contract change rather
  than a tweak. Same decision, same reason, as `encoder-load`. It is likewise not
  foldable into `sensors`, a flat `Record<string, string>` of display strings
  that cannot express present-vs-absent.
- **DISCOVERY IS BY TYPE STRING, NEVER BY INDEX.** The scan reads every
  `/sys/class/thermal/cooling_device<N>/type` and keeps the one that reads
  exactly `pwm-fan`, then follows that device's `device` symlink to the platform
  device that owns it and reads `pwm1` from the hwmon listed underneath. Both
  index spaces are registration-order artefacts: the reference Rock 5B+ was
  measured at `hwmon8` = `pwmfan` bound to `cooling_device4`, and BOTH indices
  SHIFTED across a reboot in the same session. A hardcoded `cooling_deviceN` or
  `hwmonN` is how a working reading silently starts reporting an unrelated
  device. This is the same algorithm the shipped `ceralive-fan-curve` service
  already uses (`image-building-pipeline/v2/mkosi/runtime/ceralive-fan-curve.sh`),
  in TypeScript. Kernel ABI: `Documentation/ABI/testing/sysfs-class-thermal`.
- **…AND THAT `device` BACKLINK DOES NOT EXIST ON EVERY KERNEL.** Board-confirmed
  on the reference Rock 5B+ running `7.1.5-ceralive-rk3588` (mainline/edge, NOT
  the vendor 6.1 BSP): `cooling_device4` lists `cur_state max_state power/
  subsystem type uevent` and NO `device` entry at all (nor `of_node`), because
  that driver's `thermal_cooling_device_register()` sets no parent `struct
  device`, so the class-device machinery never creates the backlink. The FORWARD
  link is fine — `/sys/devices/platform/pwm-fan/hwmon/hwmon8` exists and
  `hwmon8/device -> ../../../pwm-fan` — it is only the cdev→device direction that
  is missing. The first shipped collector therefore reported `unknown` forever on
  a board whose fan was present, running and measurable at `pwm1=120`. So a THIRD
  step exists: when the cooling device carries no `device` entry of its own, scan
  `/sys/class/hwmon/hwmon<N>/name` for the exact string `pwmfan` and read `pwm1`
  from the single hwmon that matches. Note the two strings are spelled
  DIFFERENTLY (`pwm-fan` cdev type vs `pwmfan` hwmon name) — neither may be
  derived from the other. Three scoping rules are load-bearing:
  - it is GATED on an already-confirmed `pwm-fan` cooling device, so it never
    becomes a "find any fan on the system" mechanism;
  - it fires ONLY when the backlink is ABSENT. A backlink that exists but whose
    `pwm1` read failed reports `unknown` — starting a class-wide scan there could
    adopt a different fan on a multi-fan board;
  - MORE THAN ONE `pwmfan` hwmon is genuinely ambiguous and reports `unknown`
    rather than resolving by order.
- **THE INVARIANT: the only sanctioned magnitude is `pwm1 / 255`.** That is a
  real fraction with a real denominator — the register's own 8-bit full scale.
  Two derivations are banned outright:
  - **RPM.** The reference fan is 2-wire: its hwmon exposes `pwm1` and
    `pwm1_enable` and NO `fan1_input`, so there is no tachometer and no speed to
    report. No field, log line, or comment here names one.
  - **`cur_state / max_state`.** Those levels are an INDEX into the devicetree
    `cooling-levels = <0 120 150 180 210 240 255>` table, not a linear scale of
    airflow, so `2 / 6 = 33 %` fabricates a denominator the hardware never
    produced — the exact sin the three-state encoder-load model forbids for a
    busy/idle core. The collector does not read those nodes AT ALL, which is the
    cheapest way to keep the derivation unreachable, and a test pins that.
- **FOUR states, and `absent` is a positive claim.** `running` (duty > 0), `off`
  (a MEASURED zero — a real reading, never a gap), `absent` (this board has no
  `pwm-fan` cooling device: a real shipping configuration, cf. x86-minipc), and
  `unknown` (a fan is present but its duty could not be read this tick). A shape
  that cannot tell `absent` from `unknown` is the whole defect this signal exists
  to avoid, so the two are never collapsed: a MISSING `/sys/class/thermal`
  (ENOENT) is a statement about the BOARD and reports `absent`, while any other
  read failure is a statement about the READ and reports `unknown`.
- **`initFan` is `isRealDevice()`-gated.** A dev/emulated host publishes NOTHING
  — not even `absent`, which would be a claim about hardware it does not have.
  The frontend renders `unknown` for a broadcast that never arrives, and that
  silence IS the real-vs-mock seam (same rule as `encoder-load`; do not add a
  backend mock provider or a build-flag branch for this signal).
- **Degradation follows `device-stats.ts`/`encoder-load.ts`:** every sysfs read
  is in its own try/catch, one unreadable candidate falls through to the next,
  and a tick can never throw. Privilege: none is escalated — these are sysfs
  nodes read through the same plain `Bun.file()` seam as `sensors.ts`.

Coverage: `tests/fan.test.ts` — every fixture tree deliberately numbers its
cooling device and hwmon DIFFERENTLY from the reference board (and two of them
number the same board differently from each other), so a collector that hardcoded
an index could not pass. Plus the four states, the ENOENT-vs-EACCES split, the
per-read degradation, the emulated-host gate, and the negative locks that no
export or code path names an RPM or touches `cur_state`/`max_state`. The
backlink-less kernel has its own describe block driven by a fixture that OMITS
the `device` entry from the cooling device's listing exactly as the kernel omits
it (never merely made to throw), with the three negatives that matter: a
differently-named hwmon is not adopted, two `pwmfan` hwmons are ambiguous, and a
backlink that EXISTS but failed its `pwm1` read does not start the scan.

## SIM PIN AUTO-UNLOCK [EXISTS]

Opt-in boot auto-unlock for a PIN-locked SIM. Two modules under `modules/modems/`:

- **`sim-secrets.ts`** — the secret store. `storeSimPin` / `loadSimPin` / `clearSimPin`
  read/write the PIN to a **chmod-600 tmpfs** file `/run/ceralive/sim-pin.secret`
  (override `CERALIVE_RUN_DIR` in tests — same pattern as `kiosk-token.ts`).
  Content I/O is `Bun.write` / `Bun.file`; the 0600 mode is enforced with a
  `node:fs/promises` chmod afterwards (Bun.write ignores mode on an existing file).
  **The PIN is NEVER in `config.json`** — `runtimeConfigSchema` has no `simPin` field.
- **`sim-autounlock.ts`** — the boot hook `maybeAutoUnlockSimPins(deps)`, wired into
  `initModemUpdateLoop` (after the initial discovery, gated by the `autoUnlock`
  option, default true). Contract: gated on `isRealDevice()`; submits the stored
  PIN **at most once** per locked modem; on the FIRST non-success it **clears the
  stored PIN and stops** (no loop toward a PUK lockout — the modem surfaces for
  manual entry via the `unlockSim` RPC); a success triggers one re-discovery.

The opt-in is performed via `storeSimPin` (persist a **confirmed-correct** PIN) /
`clearSimPin` (opt back out) — only a PIN the SIM has accepted is ever stored, so
boot never resubmits a known-wrong PIN. The unlock flow is the intended caller
(store on a successful unlock when the user chooses "remember"). Coverage:
`tests/sim-autounlock.test.ts` (mode-600 + config-untouched, boot unlock, bounded
wrong-PIN, and the no-op gates).

**A successful manual unlock retracts the lock in the same response cycle.**
`unlockSim`, `unlockSimPuk`, and `unlockSimPin2` clear the affected modem's cached
`sim_lock` and call `broadcastModems({ [modemId]: true })`. The targeted full
descriptor is load-bearing: status-only modem frames cannot retract an omitted
optional lock field in the frontend merge, so without it the dialog closes while
the row remains locked until a reload. Coverage:
`tests/mock-pin-unlock-rpc.test.ts` plus the `modem-pin-locked` browser scenario.

### AN UNLOCK DOES NOT PERSIST — WHICH IS WHY THIS HOOK EXISTS [EXISTS]

Investigated for todo 46 against the ModemManager 1.24.2 D-Bus API + source and
re-confirmed on the bench board (`busctl introspect …/SIM/0`). Recorded here
because "can the device just remember the unlock" is the first question anyone
asks of this module, and the honest answer is architectural rather than a
missing feature.

- **`Sim.SendPin` is a VERIFICATION, not a setting.** The unlocked state lives in
  the UICC's own security state, so it is re-applied whenever the card is
  re-initialised after a power cycle. A host reboot and a modem power cycle
  therefore both require re-entry; a `Modem.Enable(false)`/`Enable(true)` cycle
  is modem-firmware dependent (`Enable(false)` is documented as low-power, NOT as
  a durable-unlock promise), and a USB replug only preserves it on hardware that
  happens to keep the UICC powered — never something to rely on.
- **ModemManager caches NO PIN.** The generic backend formats the PIN into
  `AT+CPIN`, submits it, and frees the string with the request context
  (`src/mm-base-sim.c`); the D-Bus handler copies it only for the in-flight
  request. There is no daemon-wide cache, so nothing replays a PIN after a modem
  reset and nothing survives an MM restart. Any "it remembered my PIN" behaviour
  on a Linux box is NetworkManager's `gsm.pin` connection secret (governed by
  `pin-flags`) or a vendor quirk — host-side credential storage, exactly like
  this hook's own `/run/ceralive/sim-pin.secret`, and NOT an MM feature.
- **The ONE persistent mechanism is `Sim.EnablePin(pin, false)`** — it turns the
  card's PIN-verification facility off (generic backend: `AT+CLCK="SC",0,"PIN"`)
  and survives power cycles because it changes the SIM rather than the session.
  **CeraUI deliberately never calls it.** Disabling a SIM lock outright is the
  operator's security decision, not a side effect of using a streaming encoder.
- **There is NO `EnablePin2`.** `EnablePin` takes no PIN-kind argument and the
  protocol backends hardcode PIN1 (`mm-sim-qmi.c` selects `PIN1` explicitly), so
  a PIN2/FDN lock cannot be persistently cleared through ModemManager at all. It
  returns on EVERY boot for as long as FDN is enabled on the card — the bench
  Quectel shows exactly that (`enabled locks: fixed-dialing`, `lock: sim-pin2`,
  `sim-pin2 (3)` attempts intact).

**Consequences that are load-bearing elsewhere:**

1. This PIN1 hook is the only available answer for "come up bonded after a
   reboot without an operator present", short of the operator disabling their
   SIM lock on a phone. That is what justifies the stored-secret exposure.
2. **A PIN2 prompt can never be permanently satisfied**, which is why the UI does
   not intercept the operator with one. That decision and its rationale live in
   `apps/frontend/src/main/NetworkView.svelte` (`openModemConfig`) and
   `apps/frontend/AGENTS.md` → "A SIM LOCK IS REACHED FROM ITS OWN ROW".

## THE BLUETOOTH DOMAIN IS WIRED [EXISTS]

`modules/bluetooth/` shipped as a drivable foundation that nothing called. This
is its first live wiring: one process-wide `BluetoothStack`
(`bluetooth-runtime.ts`), a boot phase, a `bluetooth` broadcast, and the ten
`bluetooth.*` procedures. Wire contract:
[`packages/rpc/AGENTS.md`](../../packages/rpc/AGENTS.md) → THE BLUETOOTH DOMAIN
REUSES THE LADDER WITHOUT JOINING THE REGISTRY.

**The RPC layer TRANSLATES and GATES; it never re-implements.** The per-adapter
S5 lock, the S7 pending stamps, the bounded discovery window and every typed
BlueZ degradation are applied INSIDE the stack, so a handler that took its own
lock would be a second, drifting guard over one radio. `bluetooth-wire.ts` is the
pure projection (the Bluetooth twin of `modem-wire-projection.ts`).

Seven decisions carry weight:

- **"The operator switched it off" is checked BEFORE the stack's own
  unavailability.** The stack records an operator-disabled device as
  `bt_unavailable{bluez_unavailable}` — correct from its own point of view (it is
  not observing BlueZ) and misleading to an operator, for whom a switch they can
  flip and a service fault are opposite facts. Every mutating handler answers
  `bluetooth_disabled` first, and only past that gate does a cause mean what it
  says. `unit_missing` is the one cause that folds (into `service_start_failed`),
  because both mean the switch did not take.
- **The pairing agent is a real inbound D-Bus object.** The production
  `bluez-agent-exporter.ts` uses `@httptoolkit/dbus-native`'s existing
  `exportInterface` capability and issues `RegisterAgent` from that same
  connection, because BlueZ keys the registration on the caller's unique bus
  name. Export happens first; if it fails, no path is registered. The
  `NoInputNoOutput` policy answers `RequestAuthorization` only for the device in
  the operator-opened pairing window and rejects passkey/PIN requests.
- **A pairing is ATTEMPTED, not pre-refused, when no agent is registered.** A
  host that registers its own agent, or a peer needing no authorization, can
  still complete one, so refusing up front would withdraw a control that
  sometimes works. What changes is the LABEL: a BlueZ rejection with
  `agent.reason === "exporter_unavailable"` answers
  `pairing_agent_unavailable`, and `getStatus().agent` carries the same fact
  before the operator ever taps. `exporter_unavailable` remains a valid injected
  degradation, but the production default now supplies the exporter.
- **Live BlueZ signals omit a local sender predicate.** D-Bus `AddMatch` accepts
  the well-known `org.bluez` sender, but delivered messages identify the daemon
  by its unique `:1.x` name. The shared transport compares that sender literally
  after the daemon match, so naming `org.bluez` in the local spec discarded every
  `PropertiesChanged` / `InterfacesAdded` / `InterfacesRemoved` event.
  Interface+member matching keeps the live registry current; the initial
  `GetManagedObjects` snapshot remains unchanged.
- **The broadcast is on-change and trailing-debounced.** `onChange` fires on
  every registry edge and a discovery window turns every advertisement into one,
  so edges collapse onto a 250 ms trailing timer and the payload is compared
  before it is sent — the same on-change cadence `sources` follows. The timer is
  `unref`'d: a scan window must never hold the event loop open.
- **`enable`/`disable` REBUILD the stack rather than re-`start()`ing it.** The
  boot-reconnect latch is per-instance, and an operator who has just switched
  Bluetooth back on wants their trusted devices reconnected — the one moment
  "once per process" would be wrong.
- **The boot phase is FIRE-AND-FORGET behind `guardNonCritical`.** It enables
  systemd units and dials the system bus, so awaiting it would put a radio on the
  boot critical path. A dev host, a board with no controller and a masked
  `bluetoothd` all resolve to a typed `bt_unavailable` inside the stack, and the
  payload is also seeded into the post-auth initial-state push
  (`modules/ui/status.ts`) so a fresh client never waits for an edge.

Coverage: `tests/bluetooth-wire.test.ts` (the explicit recoverable booleans, the
omitted-vs-measured battery, the positive-evidence transport table, the claim
matrix incl. `no_adapter` ⇒ `unavailable` vs an unread stack ⇒ `enabled`, the
agent gap ⇒ `unavailable`, and the whole payload parsed against the published
schema) plus `packages/rpc/src/schemas/bluetooth.schema.test.ts`.

### …AND A MICROPHONE THAT DROPS MID-STREAM IS TOLD, NOT REPAIRED [EXISTS]

`modules/streaming/bluetooth-audio-resilience.ts` is the operator-facing half of
a Bluetooth microphone vanishing. It repairs NOTHING, and that is the design.

**The engine already survives this, unasked.** cerastream's program audio is a
device⇄silence `fallbackswitch` whose actuator loop
(`cerastream/crates/cerastream/src/engine/audio.rs` `audio_actuator_loop`, over
the table-tested `crates/cerastream/src/audio.rs` `AudioActuator::poll`) polls
the device leg's `is-healthy` every 250 ms and answers `SelectSilence` on a
starve, `RebuildDevice` on a 3 s cadence while failed, and `SelectDevice` the
moment the leg is healthy again. The rebuild is opaque-spec aware and its failure
log is rate-limited to `OPAQUE_REBUILD_LOG_INTERVAL` (30 s), so a BlueALSA PCM
that is permanently gone costs one line per 30 s rather than an `eprintln` per
retry. **Do NOT add a second silence-on-disconnect mechanism in CeraUI, and do
NOT add a "re-promote the device leg" RPC** — none exists on the engine, and one
issued from here would race the actuator that already owns the decision.

**A reconnect therefore costs EXACTLY TWO things**: re-assert the idle-meter
preference (the engine holds none across a device leaving its registry, and
`set_preferred_device` early-returns on an unchanged value), and clear/emit the
notifications. `tests/bluetooth-audio-resilience.test.ts` proves the absence of
everything else against a REAL `audio-meter-bridge` over an injected engine
client: the only method that ever reaches it is `reload-config`.

- **`dropped` and `gone` are different registry facts.** BlueZ flips `Connected`
  for a link that dropped and retires the whole `Device1` row for a device that
  is gone. A drop the engine is still rebuilding for gets a retractable
  `bluetooth-source-dropped` warning; a retired row gets the TERMINAL
  `bluetooth-source-lost` error, which REPLACES a standing drop band in place
  rather than stacking on it. Both are `isDismissable` — the documented safety
  net, never the mechanism; the retraction evidence is the device's own return.
- **The verdict is HYSTERETIC, mirroring `capture-presence.ts`.**
  `BLUETOOTH_SOURCE_LOSS_GRACE_MS` (3 000) is sized against the ENGINE's own
  failover cadence, so a drop the actuator absorbs is silent. The clock starts at
  the FIRST degraded observation and a later edge inside the window never extends
  it. `BLUETOOTH_REASSERT_INTERVAL_MS` (5 000) is a leading-edge floor, so a
  radio that flaps five times in two seconds costs ONE re-assert, zero
  notifications and zero extra engine calls.
- **A device we never saw CONNECTED can never be "lost".** A trusted microphone
  simply switched off at boot is exactly that case and must stay silent — the
  same "absence is not evidence" rule the capture-presence grace follows.
- **DROPPED is stream-gated, GONE is not.** A drop is a claim about the live
  program leg; a retired row is a standing fact whether or not a stream is up.
- **The publish order in `bluetooth-runtime.ts` is the contract**: registry
  projection → picker re-fold → presence reconcile. Refreshing before publishing
  would re-derive the picker from the PREVIOUS registry view — at boot the empty
  one, so a trusted mic that just reconnected would be missing from the first
  source list an operator sees. Pinned by a source-order lock.

Coverage: `tests/bluetooth-audio-resilience.test.ts` (the presence table, both
hysteresis directions, the terminal escalation and its no-downgrade rule, the
never-seen-connected and non-Bluetooth-pick negatives, the exactly-two reconnect
duties, the storm bound, the engine-surface measurement, the boot reconnect's
once-per-process latch plus its re-arm on a module re-init, and the publish-order
lock). Rule-E proof in both directions: neutering the grace window reddens 2
tests, neutering the re-assert floor reddens 2.

**Honest status:** no claim here has been exercised against a real Bluetooth
microphone — every fixture models the BlueZ registry contract.

## THE CELLULAR SUBSYSTEM — ONE COMPOSITION ROOT, ONE WIRE [PARTIAL]

`modules/cellular/` plus the `modem-wire-*` trio under `modules/modems/` are one
subsystem, and this is the section to read before touching any part of it. It
exists because "which backend describes this device's modems" stopped being a
constant: the legacy answer is `mmcli` shelling out per poll, the Phase-B answer
is a read-only `@ceralive/modem-control` D-Bus observer, and a router-mode dongle
is described by NEITHER — it is claimed into a netns by the image and reported
through a metadata file.

```
config.modem_backend ──▶ initCellularStack()        ─┐  boot, guardNonCritical
config.modem_shadow  ──▶ startModemShadowIfEnabled() ─┘  BEFORE initModemUpdateLoop
                                   │
       ┌───────────────────────────┴───────────────────────────┐
       ▼                                                       ▼
  modem-wire-producer.ts  (composition root)          cellular/shadow.ts
       │  mmcli modems + ID_PATH cache                 (mutation-free evidence,
       │  D-Bus views                                   never on the wire)
       │  netns dongles (dongle-metadata.ts)
       ▼
  modem-wire-adapters.ts ──▶ modem-wire-projection.ts ──▶ buildModemsWireMessage()
```

### BOOT ORDER IS A CONTRACT, NOT A PREFERENCE

`main.ts` runs, in this order and no other:

```ts
await guardNonCritical("cellular-stack", initCellularStack);
await guardNonCritical("cellular-shadow", startModemShadowIfEnabled);
void initModemUpdateLoop({ monitor: networkMonitor });
```

- **The stack MUST precede the loop.** `initModemUpdateLoop` runs its first
  discovery and `modems` broadcast immediately, and every modem RPC gates on the
  readiness snapshot the stack commits. A loop that wins that race publishes a
  snapshot built by whichever backend happened to be default and refuses every
  modem procedure with `CELLULAR_STACK_INITIALIZING` until the stack lands.
  That refusal window is REAL and not hypothetical: `initCellularStack` publishes
  `{ready:false}` synchronously and only commits after an awaited backend start.
- **The stack MUST precede shadow.** Shadow snapshots the mmcli side through
  `getModems()`; started first, its first heartbeat window would cover a backend
  selection that had not been made yet.
- **Both are NON-critical, and both stay after the critical WS bind (S6).** The
  dbus→mmcli fallback lives INSIDE `initCellularStack`, so a throw reaching
  `guardNonCritical` means the whole cellular subsystem is unavailable — the
  device must still reach its modem loop and keep its UI.

**AND THE WINDOW IS NOW ON THE WIRE.** That refusal window used to be invisible
to the operator: the roster is legitimately empty while it lasts, so the Network
destination reported "No SIM cards detected" — a claim the device cannot make
about hardware its own modem service has not finished enumerating.
`status.cellular_initializing` (additive-optional, `statusResponseSchema`) is
`!getCellularStack().ready`, emitted by BOTH status producers
(`modules/ui/status.ts` `sendStatus`, `rpc/procedures/status.procedure.ts`
`getStatusProcedure` + `buildInitialStatus`).

It is published as an EXPLICIT boolean on every frame, never present-only-when-
true. The frontend status merge preserves an omitted field, so a true-only flag
could be raised and never lowered — the `policy_route_missing` latch, exactly.
Absence therefore means "an older backend", and the frontend reads it strictly
`=== true`. On the default mmcli backend it is `false` from process start, so a
device that never opts into `dbus` sees the band never once. Frontend half:
`apps/frontend/AGENTS.md` → "A BOOTING cellular stack is a STATE".

**One modem path does NOT run through `cellularReadyMiddleware`:** the remote
`modem.reconfig` command. `command-router.ts` intercepts it at the self_fencing
branch, so it never reaches `modemProcedure`. Its gate lives in
`modules/remote-control/self-fencing.ts` (`isSubsystemReady` /
`READINESS_GATED_TYPES`) and is checked BEFORE `snapshot`/`apply` — see the
control-plane section for the full contract. Gating a modem surface means asking
which of the TWO routes it arrives on.

Pinned two ways in `tests/cellular-boot-order.test.ts`, and neither half is
sufficient alone: a STATIC assertion over `main.ts`'s own source (the device
`udev-rules-sigusr2-scope.test.ts` uses, because a top-level-`await` entry module
cannot be imported and run), plus a behavioural `simulateBoot` model of the
consequences. A behavioural model alone stays green through a reorder inside the
real file.

### THE PROJECTION IS WHAT REACHES THE WIRE — AND THE LEGACY BUILDER IS THE ORACLE

`modem-status.ts` exports TWO builders, and picking the wrong one is silent:

| Function | Role |
|---|---|
| `buildModemsWireMessage()` | what every consumer gets — broadcast, post-login push, `modems.get`, `status.get` |
| `buildModemsMessage()` | the PRE-Phase-B builder. NOT on the wire, deliberately NOT deleted |

The legacy builder is retained because `tests/modem-wire-projection.test.ts`
asserts the projection is byte-identical to it. Rewrite it in terms of the
projection — the obvious "de-duplication" — and that assertion silently starts
comparing the projector to itself. It is also the wire builder's FAIL-SAFE: a
throwing projection serves the legacy message rather than blanking the modem
list, because the additive fields are enrichment and the legacy ones are how an
operator sees their modems at all.

### THE COMPOSITION ROOT OWNS THE THREE THINGS THE PURE MODULES REFUSE TO

`modem-wire-producer.ts` is the only stateful half:

1. **`ID_PATH` resolution is ASYNC; the wire build is SYNC.** `stable_key` needs
   the udev `ID_PATH` behind each modem, and `buildModemsWireMessage` is called
   from a post-login push and a monitor-driven diff — neither can await a
   `udevadm` spawn. So it follows the `policy-route-check.ts` precedent exactly:
   `refreshModemIdPaths()` writes a cache, `getModemIdPath()` reads it. An
   unresolved ifname yields NO `stable_key`, which is the pre-Phase-B wire and the
   honest answer for a device we cannot anchor — never a fabricated key.
   A failed refresh RETAINS the previous map: an unreadable udev database is a
   statement about the read, not about the devices, and clearing it would make
   every row look like new hardware to a frontend correlating a mode switch.

   **THE MAP IS BUILT FROM udev's NET RECORDS** (`modem-id-path-source.ts`
   `readModemIdPaths` / the pure `parseNetIdPaths`), NOT from
   `@ceralive/modem-control`'s `createUsbEnumerator()`. That enumerator's
   `UsbDeviceSnapshot.ifname` is declared on the type and **never populated** —
   `parseUdevDatabase` keeps only `DEVTYPE=usb_device` records, and a
   `usb_device` record does not carry `INTERFACE`; the netdev is a separate child
   record under the `net` subsystem. Board-measured on `ceralive2`
   (2026-08-18): **24** `usb_device` records, **0** of them carrying an
   `INTERFACE`. So the map was EMPTY on every real board, `getModemIdPath()`
   answered `undefined` for every interface, no modem resolved a `stable_key`,
   and the fail-closed mutation contract therefore refused EVERY modem mutation —
   config save, network scan, SIM unlock, USB-mode switch — with
   `identity_unresolved`, on hardware whose modems all publish a good `ID_PATH`.
   The guard was right; its input was dead. A ZERO-length result is now logged at
   `warn`, because "no modem has an identity" and "this board has no modems" were
   otherwise indistinguishable. The netdev's interface-level path
   (`…-usb-0:1.4.4:1.4`) reduces through the unchanged `deriveModemStableKey` to
   the SAME `usb_device` parent MM's sysfs `Modem.Physdev` mints, so the two
   sources still agree by construction. A netdev with no `ID_PATH` (the
   duplicate-MAC HiLink twin, whose rename collides and leaves udev with only
   `ID_RENAMING=1`) is OMITTED — never keyed on its name.
2. **It refreshes on PRESENCE edges only** — `discoverModems()` and
   `handleModemAdded`, never the 30 s status poll. An `ID_PATH` names where a
   device is plugged in, so a poll cannot move it.
3. **It retains `syntheticIds` across snapshots.** `projectModemWire` returns the
   allocation it made and expects it back as `previousSyntheticIds`; drop that
   round-trip and every poll renumbers the dongles under the operator.

4. **It joins the mmcli-side 3GPP SCAN RESULTS onto a D-Bus row**
   (`withScanResults`). A scan is an mmcli operation writing into mmcli state,
   MM publishes no scan-result property for the fold to read, and `"dbus"` is the
   default backend — so a scan ran, succeeded, and reached the operator as an
   unchanged (empty) network list. The composition root is the only place that
   sees both halves. A modem the mmcli side never scanned is left UNCHANGED
   rather than given an empty list, which would claim a scan found nothing.

**Which adapter produces a radio row follows the backend that COMMITTED, never
the config key.** A `dbus` request that fell back to mmcli must project mmcli
rows — advertising the additive detail block would put confident values on the
wire that nothing observed.

**The fold now EXISTS, and it reads the TREE, not the `ObservationList`.**
`readDbusViews()` serves `modules/cellular/dbus-modem-cache.ts`, which is filled
by `dbus-view-fold.ts` from the decoded `GetManagedObjects` payload the observer
hands to `onEpochRefresh`. Two upstream facts force that input choice and both
are easy to get wrong: the package's `mapModem` is deliberately conservative
(registration always `unknown`, empty RAT set, no signal / operator / ifname /
modes at all — a row folded from it would be strictly POORER than the mmcli row
it replaces), and the observer emits a list ONLY when a row FINGERPRINT changed,
a fingerprint that ignores signal quality — so a signal-only refresh delivers a
tree and NO list, and a list-driven cache would never publish the single most
frequent update on the wire. The `ObservationList` is used for exactly two
things: `start()`'s `ok` commit test, and telling the two failure classes apart.

Full contract — snapshot/subscription API, the fold's field-by-field source
table, the bounded refresh + publication coalescing, the two SEPARATED failure
classes, source precedence / authoritative keys, the cutover and its rollback,
and the startup cancellation contract — is
[`docs/DBUS-OBSERVATION-CONTRACT.md`](../../docs/DBUS-OBSERVATION-CONTRACT.md).
Read it before changing any part of this path.

### THE POST-RESTART EMPTY SNAPSHOT MUST NEVER REACH THE WIRE

Measured on real hardware (todo 16, gate 4): a ModemManager restart's resnapshot
fires **18 ms** after MM re-acquires its bus name — before the daemon has
re-probed a single port — and legitimately answers `modemCount: 0`. The roster
then refills over the next **~20 s** via `InterfacesAdded` from the new owner.

**A consumer that published that snapshot verbatim would blank the operator's
modem list for ~20 s on every MM restart.** So `dbus-modem-cache.ts` does not
give a new epoch authority immediately: it enters `settling`, keeps serving the
retained rows marked `availabilityReason: "mm-restarting"`, MERGES each partial
refill over them (matching on the `ID_PATH` anchor, because MM renumbers the
whole roster across a restart — measured `11,13,14,15 → 0,1,2,3`), and only
commits when the roster refills or `EPOCH_SETTLE_MS` (25 s, chosen above the
measured ~20 s) elapses. A genuine "everything was unplugged during the restart"
therefore takes up to 25 s to reach the wire — the deliberate trade against a
guaranteed 20 s false blanking on every restart.

### THE TWO FAILURE CLASSES ARE NOT INTERCHANGEABLE

They look identical in a log line and have OPPOSITE correct responses:

| `ObservationList` reason | What it means | Response |
|---|---|---|
| `bus-error` | our client failed while MM stayed answerable | mmcli IS a real second opinion — demote below it, serve `[]`, let the wire producer project mmcli rows |
| `source-unavailable` | the MM bus name has no owner (or the bus dropped) | **mmcli talks to the same dead daemon** — there is NO backstop. Retain the rows, mark them `availabilityReason: "mm-unavailable"`, make NO fallback-healthy claim, and require a full resnapshot to complete (per the settle rule above) BEFORE authority returns |

### SIGNAL CADENCE — A DOCUMENTED DEVIATION, WITH EVIDENCE

The plan called for `Signal.SetupThresholds` (else `Signal.Setup` at 5-10 s).
**Neither is called on the shipped path, deliberately.** `dbus-audit-transport.ts`
is fail-closed and refuses `Modem.Signal.Setup` BY NAME because it WRITES, and
that fail-closed guarantee is the single property that makes it safe to point the
fleet default at a path observing the same daemon mmcli drives — opening a write
member in the very commit that flips the default would remove the reason the flip
is safe. It costs nothing measurable: `Modem.SignalQuality` is MM's own polled
property and is published via `PropertiesChanged` with no `Setup` call at all
(todo 16 recorded 66 such signals in a session that issued none), and
`DbusModemView.signal` reads that 0-100 value, not the extended `Modem.Signal`
interface `Setup` governs. Adopting extended metrics means adding the member to
`CELLULAR_READ_ONLY_MEMBERS` as its own reviewed change, never as a side effect.

### SHADOW MODE IS EVIDENCE, NEVER A SOURCE

`config.modem_shadow === true` starts a mutation-free comparison of the D-Bus
observer against the live mmcli reads (`docs/MMCLI-RETIREMENT-GATE.md`). It never
touches the wire — a boot-integration test asserts the projected message is
byte-identical with shadow on and off. The opt-in is strict: absent, `false`, and
a non-boolean truthy all return BEFORE the D-Bus client is imported.

### DEV MOCK SEAMS (cellular)

`mocks/providers/cellular.ts` makes all three surfaces reachable with no
hardware, and every seam is deliberately placed so the PRODUCTION rule still
runs:

| Seam | Where it enters | What still runs for real |
|---|---|---|
| `getMockModemIdPaths()` | the producer's `ModemIdPathReader` | `deriveModemStableKey`'s parent-`usb_device` strip |
| `listMockDongleFiles` / `readMockDongleFile` | `dongle-metadata.ts`'s OWN deps seam, as file CONTENT | the real schema, staleness and ambiguity rules — and it feeds BOTH the netif marker and the modems row from one place |
| `getMockDbusModemViews()` | `setMockDbusModemViews()`, installed by `main.ts`'s dev block | the full adapter + projection path |
| the mock dbus BACKEND | `loadDbusBackendFactory()` | the same try, `withDeadline` race and `result.ok` commit test |
| `getMockShadowDeps()` | `startModemShadowIfEnabled` | the audit wrapper, classifier, redactor and evidence writer — `startModemShadow` applies the wrapper itself, so the fake stays BELOW the guard |

Two fixture rules are load-bearing and were both learned the hard way:

- **`updated_at_ms` is stamped at READ time.** A frozen timestamp reads as stale
  within 90 s and the dongle rows silently vanish from the dev UI.
- **The mmcli side's `deviceKey` must go through `opaqueDeviceKey`**, because the
  observer side does. A raw ifname produces a matched `only-in-mmcli` +
  `only-in-dbus` PAIR every cycle instead of the one field divergence the fixture
  demonstrates — which is the "the two sides never actually joined" state the
  retirement runbook calls a gate blocker.

The fixtures also reproduce the bench's duplicate-MAC HiLink pair verbatim (two
physically distinct dongles, ONE factory MAC `0c:5b:8f:27:9a:64`): that collision
is the reason identity is `ID_PATH`-keyed, so a fixture that quietly gave them
different MACs would teach the opposite lesson.

Coverage: `tests/cellular-boot-order.test.ts` (the source-order lock + the
fail-soft consequences) and `tests/cellular-boot-integration.test.ts` (the
`bootLikeCellular` parity harness — `stable_key` reaching the wire through the
real composition root, both dongle rows with their honest omissions, synthetic-id
stability, backend selection in BOTH directions, the refusal window, and shadow's
non-interference). The per-module suites from the wave below it are unchanged:
`cellular-stack`, `cellular-audit-transport`, `cellular-gate`,
`cellular-shadow-{divergence,audit,redaction,retention}`,
`modem-wire-projection`, `modem-set-usb-mode-gate`,
`modem-usb-mode-transition`, `streaming-lifecycle-interlock`.

### THE `dbus` PATH IS NOW THE DEFAULT — AND THE FULL PATH IS STILL BOARD-UNPROVEN

`config.modem_backend` (`z.enum(["mmcli","dbus"])`, `.optional()`, still no
`RUNTIME_CONFIG_DEFAULTS` entry) now resolves through `DEFAULT_MODEM_BACKEND`,
which is **`"dbus"`**. Absence is what every board in the field has, so an
UNMODIFIED production config takes the cutover; `"modem_backend": "mmcli"` is the
operator's explicit rollback value and still selects the byte-identical legacy
path (synchronously ready, no D-Bus import). CI proves the cutover the way a
field device experiences it — `tests/cellular-dbus-adoption.test.ts` deletes the
key rather than setting it.

**Read what IS and IS NOT hardware-proven, because they are different claims.**

- **PROVEN on the bench** (`ceralive2`, todo 16, 6/6 gates): the D-Bus TRANSPORT
  under Bun in the real packaged service identity — system-bus connect, a
  `GetManagedObjects` roster identical to `mmcli -L`, all four signal classes
  received AND decoded across a real USB port cycle, survival of a ModemManager
  restart, clean SIGTERM with no orphaned match rules, and a full observed hour
  with zero fd or subscription growth.
- **NOT proven on a board**: everything ABOVE the transport — this cache, the
  fold, the settle guard, the failure-class split, and the flipped default
  serving real `modems` rows to a real operator. Every assertion about them is a
  unit/integration test against a fake bus. That is a gap in HARDWARE EVIDENCE,
  not in coverage, and the two are not interchangeable.

**Two things are owed before this default should be trusted in the field:**

1. **Board-run the flipped default.** Deploy, restart `ceralive` WITHOUT editing
   `/etc/ceralive/config.json`, and confirm: `status.cellular_initializing`
   clears, the `modems` broadcast carries every real modem with `stable_key`
   populated, a `systemctl restart ModemManager` does NOT blank the list (the
   settle guard's whole purpose), and an unplug still removes its row.
2. **The ≥ 8 h soak.** Todo 16's one-hour soak was leak-free on descriptors and
   match rules but left an unresolved ≈5.6 MiB/h residual RSS slope a one-hour
   window cannot distinguish from heap warm-up. It was measured against the raw
   transport harness, not this cache. ~5 MiB/h sustained is ~120 MiB/day on a
   device that runs for weeks.

**And note the tension with the retirement gate below, honestly.** That gate's
condition 5 describes flipping the default away from `"mmcli"` as a later
decision gated on ≥14 days of shadow evidence on ≥2 devices plus a HIL parity
run. **The flip has now shipped ahead of that evidence, by plan decision.** What
that changes is which safety net is load-bearing: it is no longer the shadow
comparison but the runtime fallback — a `dbus` start that rejects, returns a
non-authoritative snapshot, or outlives `DEFAULT_INIT_TIMEOUT_MS` commits mmcli
in a ready-but-degraded state visible at `/api/health`, and the operator rollback
value is one config line. `buildModemsMessage` therefore stays exactly where it
is; condition 5 has NOT been satisfied, it has been overtaken, and deleting the
legacy builder is further away rather than closer.

### THREE PARALLEL MODEM-TOUCHING PATHS NOW EXIST, AND ONLY ONE IS LIVE

This session's audit surfaced that CeraUI's backend now carries three
independent code paths that each talk to modem hardware for a DIFFERENT purpose.
They do not compete for the same job, but they DO overlap in the sense that a
future reader could reasonably ask "why are there three ways this backend talks
to a modem" — so the answer is recorded here rather than left to be
re-discovered:

1. **`modules/modems/` — the original Phase-A direct-`mmcli` path.** This is the
   ONLY one of the three actually exercised on real hardware. Every modem row on
   the wire today (this session's live Quectel/SIMCom/HiLink/ZTE verification, the
   todo 45 PIN2 flow, the todo 43 router-cellular classification) came from this
   path. It shells out to `mmcli`/`qmicli` per poll (`mmcli.ts`,
   `modem-update-loop.ts`, `sim-pin2.ts`, `sim-autounlock.ts`, `sim-secrets.ts`)
   and is what `modem_backend: "mmcli"` (now the operator ROLLBACK value, no
   longer the default) selects inside `initCellularStack`. It also still runs
   under the D-Bus default as the 30 s reconciliation backstop, so a demotion has
   warm rows to serve. Everything it reads from `-K` output passes through
   `mmcliUnescapeValue` — mmcli escapes EVERY value it prints, so this is a
   property of the CLI and not of any one command (SMS INBOX §5).
2. **`modules/cellular/` — the Wave-4 composition root over
   `@ceralive/modem-control`'s D-Bus observer.** `cellular-stack.ts`,
   `dbus-backend.ts`, `dbus-audit-transport.ts`, `shadow.ts`,
   `modem-wire-adapters.ts`, `modem-wire-projection.ts`, plus the observer
   adoption layer (`dbus-modem-cache.ts`, `dbus-view-fold.ts`,
   `dbus-mm-enums.ts`). This is now the DEFAULT path — its transport is
   board-proven (todo 16) but everything above it is still fixture-proven only;
   see the section above for exactly which claim is which.
3. **`modules/modems/sim-pin2.ts` — a direct-`qmicli` path, found this session
   (todo 45), that neither of the other two paths can reach.** Neither `mmcli`
   (ModemManager's own D-Bus API declares exactly five `Sim` methods —
   `SendPin`/`SendPuk`/`EnablePin`/`ChangePin`/`SetPreferredNetworks`, all
   PIN1-only, confirmed against both the MM 1.24.2 source and a live `busctl
   introspect` on `ceralive2`) nor `@ceralive/modem-control`'s D-Bus surface
   exposes SIM **PIN2** submission at all — MM's own maintainers say so
   explicitly ("we really don't care about PIN2 in MM, at least for now"). So
   `sim-pin2.ts` bypasses BOTH modem-facing abstractions and calls `qmicli
   --uim-verify-pin=PIN2,<code>` directly over the shared `qmi-proxy` socket,
   deliberately alongside a live ModemManager rather than through it. This is not
   a design inconsistency to "fix" by routing PIN2 through one of the other two
   paths — as of this writing NEITHER can carry it, so a third, narrower path was
   the only available option for a real operator need (see todo 45's full
   write-up in the session notepad for the PIN2/PIN1 distinction and why boot
   auto-unlock deliberately excludes it).

The three paths are NOT redundant with each other: (1) is the live production
path, (2) is evidence-gathering infrastructure for a FUTURE production path, and
(3) fills one specific real gap neither (1) nor (2) can reach. A future reader
tempted to "consolidate" them should first re-read this paragraph — consolidating
(1) into (2) is exactly what the mmcli-retirement gate below exists to make safe,
and consolidating (3) into either is blocked by an upstream ModemManager
limitation, not a CeraUI design choice.

### WHY `buildModemsMessage` (LEGACY) STAYS ALONGSIDE THE PROJECTION — AND WHEN IT CAN GO

The "PROJECTION IS WHAT REACHES THE WIRE" section above already states the
mechanical reason `buildModemsMessage` is retained: it is the fail-safe a
throwing projection falls back to, and the oracle `modem-wire-projection.test.ts`
asserts against. Restated plainly for anyone weighing whether to delete it: it is
a **byte-compat regression guard for the `mmcli` path** — the path that is
actually running on every real device today (see above). Deleting it would remove
both the safety net AND the only independent check that the new
projection/adapter/wire-producer trio (todo 22) reproduces the pre-Phase-B wire
exactly, for the backend that 100% of the fleet currently uses.

**Retirement condition (dated, measurable — not "someday" or "when ready"):**
`buildModemsMessage` may be deleted only once ALL of the following hold
simultaneously, mirroring the shadow-mode retirement gate's own N-day/
divergence-count mechanism (todo 21, `docs/MMCLI-RETIREMENT-GATE.md`):

1. `config.modem_backend: "dbus"` has actually run in production (not fixtures)
   on **at least one** real CeraLive board for **at least 14 consecutive days**
   (`MIN_HEARTBEATS_PER_COMPLETE_DAY = 72` per the shadow evidence retention
   rule already documented above), collecting shadow evidence the entire time
   via `config.modem_shadow: true`.
2. Zero unexplained divergences recorded in that evidence window — a
   `field-mismatch`/`only-in-*` entry is "explained" only if it is one of the
   already-known, already-documented absent-dimension gaps (see "the observer and
   mmcli do NOT observe the same dimensions" above); any NEW divergence class
   blocks retirement until it is understood.
3. `unjoinable` count in the shadow heartbeat stays at (or returns to) zero for
   that same window — a persistently non-zero `unjoinable` count means parts of
   the fleet were never actually compared, which the runbook already calls a gate
   blocker.
4. The MMCLI-RETIREMENT-GATE runbook's own `distinctModems ≥ 2` criterion is met
   across **separate physical CeraLive units**, not two modems on one board (the
   runbook's own explicit distinction, restated above in "COMPOSITION ROOT").
5. `mmcli` retirement itself (flipping the DEFAULT away from `"mmcli"`) is a
   SEPARATE, later decision gated on a successful HIL parity run and one full
   dbus-default release cycle (per the root plan's binding annex — "mmcli-
   retirement criteria: ≥14 days shadow on ≥2 devices, zero unexplained
   divergences, HIL parity, rollback drill, one dbus-default release"). Deleting
   `buildModemsMessage` may happen only AFTER that flip has shipped and proven
   stable — the legacy builder is the safety net for exactly the transition
   window between "default flipped" and "confidently redundant", not for the
   flip decision itself.

**None of these five conditions have been met as of this session.** Condition 1
alone requires the NEXT STEP two sections above (setting `modem_backend: "dbus"`
on a real board) to have even started, and it hasn't. This todo documents the
condition; it does not — and must not — trigger any part of it.

## PRESENCE IS POLLED, BECAUSE NOTHING IN PRODUCTION EMITS `modem-added` [EXISTS]

`handleMonitorEvent` (`modem-update-loop.ts`) switches on `modem-added` /
`modem-removed` / `device-state`. **The first two arms are unreachable on real
hardware.** The production emitter is `NmcliMonitorManager`, and its
`parseMonitorLine` can return nothing but `connection-state` and `device-state`
— `nmcli monitor` reports NetworkManager devices and connections and has no view
of the ModemManager modem lifecycle at all. Only the scripted
`MockMonitorEmitter` ever emits the modem arms, which is exactly why the whole
suite stayed green while the device did not.

So presence was established ONCE, by the boot `discoverModems()`, and the
retained 30 s poll deliberately "never re-lists / re-registers". A modem that
appeared after boot was therefore never registered — and registration is the
step that resolves, and where absent CREATES, its NetworkManager GSM profile
(`registerModem` → `getModemConfig` → `addConnectionForModem`). No registration,
no profile; no profile, nothing to activate.

**Board-measured on `ceralive2` (Rock 5B+, 2026-08-19).** ModemManager dropped
modems 3 and 5 at 23:58, created modem9 (Quectel RM530N-GL) at 23:59:52 and
modem10 (Fibocom FM350-GL) at 00:00:21. An hour later:

```
mmcli -L                    → modems 0, 6, 9, 10
ceralive journal (last 30m) → mmcli -K -m 3 , mmcli -K -m 5     ← and nothing else
                              zero lines naming modem 9 or 10
                              zero "Modem N removed" warnings
mmcli -m 10                 → state: registered, home, Movistar, packet service attached
nmcli connection show       → NO gsm profile whose gsm.device-id is the FM350's
ip -4 addr show enx000011121314 → (none)
```

The operator's report — *"it's registering to the network but apparently is not
able to connect, and it's got signal"* — was precisely this: a radio-attached
modem CeraUI had never heard of.

`runModemStatusPoll()` now runs the same `reconcileModemPresenceLocked()` as
discovery, so it re-lists every tick. Three properties are load-bearing:

- **An unreadable `mmcli -L` RETAINS every modem.** `mmListWithRetry()` answers
  `undefined` after exhausting its retries, and the old `?? []` read that as an
  empty roster. That was survivable while only boot called it; at 30 s it would
  evict the entire registry — and with it every modem's resolved profile — on one
  transient failure, then re-register everything on the next tick. `undefined` is
  a statement about the READ; `[]` is authoritative and really does remove.
- **ID_PATHs refresh on a presence EDGE only** (discovery excepted, being the
  boot seed). An ID_PATH names where a device is plugged in, so a quiet tick
  cannot move it.
- **A poll-discovered modem reconciles as a genuine `added`**, so the existing
  diff pipeline resets the cached gsm connections exactly as an event-driven add
  did. Nothing downstream needed to change.

Cost is ONE `mmcli -L` spawn per 30 s tick. Do NOT restore the
event-driven-only form without first giving the production monitor a real
modem-lifecycle source — and note the `mmcli` backend, still the supported
rollback value, has none at all.

**This fixes CeraUI's half only.** The FM350 that exposed it needs a second,
separate fix outside this repo: it enumerates in an RNDIS composition
(`option` + `rndis_host`, no MBIM/QMI port), so MM assigns `plugin: generic` and
its dial fails. With a correct profile hand-created, MM reached
`simple connect state (9/10): connect` and the bearer answered
`NotSupported: 0,NONE` on all three attempts — with the APN correctly
auto-resolved to `internet.movistar.com.co`. See the evidence note in
`.omo/notepads/modem-phase-c-quality/evidence/`.

Coverage: `tests/modem-presence-reconcile.test.ts` (the board's own 3/5 → 0/6/9/10
drift driven through the REAL poll, the FM350 registering, the retention rule,
the empty-roster control, the quiet-tick vs presence-edge ID_PATH split, and a
static lock proving `parseMonitorLine` cannot answer `modem-added` for any real
`nmcli monitor` line). Rule-E proof captured in both directions: restoring the
status-only poll reddens 4 tests; dropping the retention rule reddens 1.

## A DEVICE IS ANNOUNCED BEFORE ANY MODEM SERVICE CAN DESCRIBE IT [EXISTS]

Between a USB attach and ModemManager exporting the modem there is a real gap —
the daemon has to probe ports, talk to the radio, and only then publish — and the
authoritative paths above cannot shorten it. Until it closes, an operator who has
just plugged a stick in is looking at a device list that does not mention it, and
the 30 s reconciliation poll means the WORST case is a full poll interval of
apparent nothing.

`modules/cellular/` closes that gap with an OPTIMISTIC row and three modules:
`udev-cellular-events.ts` (pure decoding), `udev-provisional-cache.ts` (the rows
+ the precedence rule), `udev-monitor.ts` (the supervised child). The row claims
exactly ONE thing — this device exists — and carries `availability_reason:
"modem_initializing"`, which the frontend bands as "Modem detected"
(`apps/frontend/src/main/network/cellular-row.ts`).

**PRECEDENCE IS ONE-DIRECTIONAL, AND IT IS STRUCTURAL.** The provisional rows are
appended LAST in `collectSources()` (`modem-wire-producer.ts`) and are handed the
set of keys the authoritative sources have ALREADY claimed, so an mmcli row, a
D-Bus row or a classified dongle for the same identity replaces the optimistic
one inside the SAME synchronous wire build. A provisional row can never displace,
enrich or delay a real observation, because it is never consulted until they have
all been collected. A superseded entry is RETIRED rather than hidden — keeping a
shadow alive would let the row reappear the moment that observation blinked.

**The merge key is the `ID_PATH`-derived `stable_key`, NOT todo 10's identity
key**, and that is a deliberate divergence. The identity ladder is `usb-serial` >
`id-path` > `ifname` with no alias table between rungs, which is right for
identity and wrong here: a udev `usb_device` add publishes `ID_SERIAL_SHORT` and
would anchor on the serial rung, while a D-Bus row carries only `Modem.Physdev`
and anchors on the path rung — so comparing identity keys would never match and
the provisional row would sit BESIDE its own authoritative row. `stable_key` is
the one key both sides always carry, it is what todo 17's consumers correlate on,
and it survives the Qualcomm `9024`⇄`9091` flip for free: that transition changes
VID:PID and the interface name but keeps the device in the same USB port.

**…BUT "both sides always carry it" only became true once the two ENCODINGS were
reconciled.** ModemManager anchors on `Modem.Physdev`, which it publishes as a raw
sysfs DEVPATH, while the udev side publishes an `ID_PATH` — two spellings of one
socket, and `claimedKeys.has(entry.stableKey)` is a string-equality test. Measured
on `ceralive2` (todo 24, 2026-08-18): `platform-xhci-hcd.0.auto-usb-0:1.4.1`
against `/sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.4/1-1.4.1`
for port `1.4.1`, so the authoritative row could never retire the provisional one
and TWO rows for one stick reached the wire on 10 of 10 power cycles. The
supersession logic was right; its INPUTS were not.
`deriveModemStableKey` now normalizes a sysfs path into the `ID_PATH` shape before
reducing it (`@ceraui/rpc` `sysfsDevpathToIdPath` — udev's own `path_id` USB rule,
not a fuzzy match), and `dbus-view-fold.ts` `readIdPath` stores the normalized
anchor, so both sides MINT the same key. Todo 18's fixtures paired ID_PATH against
ID_PATH on BOTH sides, which is exactly why its suite stayed green while the board
did not; the pairing the board actually produces is now covered in
`udev-provisional-rows.test.ts` §4 with those two verbatim strings.

**Four refusals do the ghost-prevention work**, and each is load-bearing:

- only `DEVTYPE=usb_device` is read. A composite modem publishes one of those and
  several `usb_interface` children, so keying on anything else draws one stick as
  three to seven rows;
- only `add`. `bind`/`change` describe a device that is already present;
- an attach with NO `ID_PATH` is DROPPED, because the merge key is what makes the
  row retirable and a row nothing can supersede is precisely the ghost class this
  must not introduce;
- a repeat `add` for a key already held is a no-op, not a timer reset, so a
  modeswitching composite cannot extend the window its first event opened.

**The bound is DERIVED: `PROVISIONAL_TIMEOUT_MS = 40 000`.** The mmcli backstop
polls every 30 s with ±10 % jitter, so the last scheduled moment a device could
still reach the authoritative path is ~33 s after the attach, plus that poll's
read and broadcast. Expiry REMOVES the row — no tombstone, no dimmed
"expired" state, because "we said a modem was coming and it never did" is not a
fact about hardware worth keeping on screen.

**The source is a SUPERVISED `udevadm monitor --property --udev` CHILD, never the
npm `udev` binding.** That binding is an unmaintained native addon compiled
against the running ABI, which a `bun build --compile` single binary shipped to a
toolchain-less device cannot use; `udevadm` ships with systemd. `--udev` is
load-bearing — the `--kernel` events that precede rule processing carry no `ID_*`
properties at all, so a monitor without it would see every attach and be able to
say nothing about any of them. The supervisor is the direct twin of
`NmcliMonitorManager` (same backoff, same `watcher` spawn class,
`monitor.udevMonitor` in `SPAWN_POLICY`), and **every restart CLEARS the cache**:
the monitor has no historical replay, so a detach that happened while the child
was down would otherwise leave a row nothing could ever retire.

`initUdevProvisionalMonitor` is `isRealDevice()`-gated and skipped under mocks,
and `readProvisionalSources` answers mocks with NOTHING — this row exists to
close a hardware latency gap a dev host does not have, so a mock fixture would be
a parallel mechanism rather than the scenario roster.

Coverage: `tests/udev-provisional-rows.test.ts` — the decode/refusal table, the
precedence and retirement rules, the `9024`⇄`9091` flip folding onto one row,
detach, the derived timeout, the non-extending repeat attach, the supervised
child (split chunks, EOF flush, malformed block, respawn-and-drop, stop), and the
row reaching the REAL `buildModemsWireMessage()` payload plus its replacement
there by an mmcli row for the same port. Rule-E proof: deleting the claimed-key
check reddens 3 tests; dropping the cache clear on restart reddens 1.

**Board-measured, no longer modelled.** On `ceralive2` (RK3588, SIMCom
SIM7600G-H, 9 plug cycles) the optimistic row reaches an authenticated WebSocket
client a **median 2 ms** after the udev attach, and the authoritative MM row
replaces it a **median 16 ms** after `InterfacesAdded`. Both are budgeted and
asserted — see PLUG-TO-UI LATENCY HARNESS below. What the row is covering is
ModemManager's own probe time, measured at **~29.3 s** on that hardware.

## PLUG-TO-UI LATENCY HARNESS — a BOARD TOOL, not shipped code [EXISTS]

`scripts/modem-latency-harness.ts` + `scripts/lib/` time the whole path an
operator waits on: udev attach → ModemManager export → the row reaching a
WebSocket client on the device's own origin → a property update → detach.

```
sudo bun run modem-latency-harness --plug-cycle 4-1.3:4 --cycles 3 --assert
sudo bun run modem-latency-harness --observe-ms 420000 \
     --budgets ./scripts/lib/modem-latency-budgets-observe.json --assert
```

- **It lives in `scripts/`, not `src/`, deliberately.** It is never compiled into
  the `ceralive` binary, so it is outside the exec-guard's `SPAWN_POLICY`
  registration scope — registering it would assert it runs in production. It is
  also SELF-CONTAINED (no `src/` imports) because it has to run on a board that
  carries only the compiled binary and no source tree.
- **It measures the SHIPPED path.** The WebSocket client authenticates and
  consumes exactly what the frontend consumes, so a regression in the wire
  producer shows up as a real latency miss rather than as a passing unit test.
- **NEITHER pipe source is read-time stamped, and that was measured.**
  `busctl monitor` block-buffers when stdout is not a tty — an exploratory
  capture had a whole cycle's signals arrive in one burst ~40 s late — so both
  tools' OWN clocks are parsed instead: `busctl`'s per-record
  `Timestamp="… UTC"`, and `udevadm`'s `UDEV [<monotonic>]` header projected onto
  the epoch axis by a median-sampled `/proc/uptime` boot offset.
- **A row event is a transition between CONSECUTIVE FRAMES, never a diff against
  a fixed snapshot.** This is the correctness core. The frame a udev event causes
  arrives within milliseconds of it and carries a timestamp from a DIFFERENT
  clock, so it can sort just before its own cause, be adopted as the baseline,
  and hide the change it carried — measured on real captures as a 3 ms removal in
  one cycle and 11 s in the next, from identical hardware doing an identical
  thing. Small negative spans are CLAMPED to 0 rather than discarded, because
  discarding drops the fastest samples and biases every median upward.
- **`property_to_ui` is paired change-first, not signal-first** — the latest
  `PropertiesChanged` at or before a visible row change is its proximate cause.
  Walking signals forward pairs a first, inert signal (MM emits many that change
  nothing the wire projects) with a change some later signal produced, and
  reports the whole dead interval as latency.
- **NOT MEASURED is not a pass.** A budgeted interval with no samples returns
  `pass: null` and fails `budgetsAllGreen()`. That is why there are TWO committed
  budget files: a plug-cycle phase structurally cannot produce the steady-state
  property sample, and the observe phase cannot produce the attach/detach spans.
- **`mm_probe` and `end_to_end` carry no budget.** MM probe time is exempt by
  plan, and `end_to_end` is its sum with a budgeted span, so asserting it would
  double-count the exemption and fail the harness for ModemManager's behaviour.
- `--dump-dir` writes the raw `udev.txt` / `busctl.txt` / `status-frames.jsonl` /
  `derived.json` so every number is re-derivable offline. Both derivation bugs
  above were found and proven fixed by replaying a saved capture.

Committed budgets, derived from 9 measured cycles rather than chosen:

| Interval | Budget | Observed worst | Rationale |
|---|---|---|---|
| `optimistic_row` | 250 ms | 3 ms | 4× tighter than the plan's 1 s; approaching it means a poll or coalesce window was reintroduced |
| `authoritative_row` | 500 ms | 23 ms | deliberately the loosest — this path crosses the observer's snapshot refresh and `events.ts` coalescing — yet still 60× tighter than the 30 s poll it replaced |
| `removal` | 250 ms | 3 ms | cheapest path (cache delete + broadcast); 0 ms on 8 of 9 cycles |
| `property_to_ui` | 1000 ms (observe file) | no sample | UNTIGHTENED on purpose: never measured, because the bench's modems are SIM-less/searching so no property changes |

Coverage: `src/tests/modem-latency-harness.test.ts` (24 tests over verbatim board
captures — the parser table, the row-facts rules, the transition derivation
including a fixture whose frames precede their own cause, and the budget verdicts
incl. the not-measured arm).

## USB-COMPOSITION SWITCH — GATES, THEN CATALOG, THEN THE ENGINE [PARTIAL]

`modems.setUsbMode` (`rpc/procedures/modems.procedure.ts`) switches a modem's USB
composition mode. The switch re-enumerates the device and drops its bond link, so
the gates are the safety contract rather than UI polish — and they live at the
PROCEDURE, so a direct RPC call is refused exactly as a UI one is. Hiding the
control would only hide it from the UI.

Gate order is itself the contract:

1. **`config.modem_provisioning !== true` ⇒ `provisioning_disabled`.**
   DEFAULT-ABSENT, with NO entry in `RUNTIME_CONFIG_DEFAULTS` — absent and `false`
   refuse identically, so the mutation is unreachable on a device nobody
   deliberately provisioned. This runs FIRST and outranks every other condition.
2. **`!isRealDevice()` ⇒ `unavailable_in_emulated_mode`**, ahead of the streaming
   check: there is no hardware to transition either way, and answering
   `streaming_active` on a dev host would be a lie about the reason.
3. **`getIsStreaming()` ⇒ `streaming_active`.**
4. **The `"modem-transition"` lifecycle lease ⇒ `streaming_active` (held by an
   admission) or `transition_in_progress` (held by another transition).** This is
   the reciprocal side the interlock primitive deliberately left unwired. It sits
   ALONGSIDE gate 3, not instead of it, because the two cover DISJOINT windows: a
   stream that has been admitted but has not yet reached PLAYING has already
   spawned its sender against a link list a re-enumeration is about to invalidate,
   and `getIsStreaming()` is false for exactly that window.

Everything past the lease is `modules/modems/usb-mode-transition.ts`
(`runUsbModeTransition`), and **its internal order is the TIER-A guarantee**:

1. **IDENTIFY** — a real `udevadm`/sysfs enumeration
   (`createUsbEnumerator().enumerate()`) resolves the physical device behind the
   modem id: VID:PID, model, firmware revision, current composition mode, the
   `ID_PATH`-derived `stable_key`, and the physical UID needed to re-find the
   device AFTER it re-enumerates. The modem id and ifname are used ONLY as the
   one-instant lookup that finds the device; everything downstream correlates on
   `stable_key`, and a device with no `ID_PATH` is REFUSED rather than transitioned
   into something we could not then recognise.
2. **CERTIFY** — `matchCertifiedEntry` against `@ceralive/modem-control`'s catalog,
   then `findPermittedTransition`. Both are pure reads.
3. **DISPATCH** — and only now is the engine touched at all.

**Nothing may call the transition engine before step 3**, which is what makes the
Phase-A TIER-A rule ("an entry refusal fires ZERO engine calls") spy-provable
rather than a comment. The engine re-checks its own preconditions twice (entry +
in-actor); our catalog check PRECEDES that rather than replacing it, so a doomed
request never queues behind real hardware in the per-modem actor.

**The firmware discriminator is matched by PREFIX, never by truncation.** A
catalog entry certifies a firmware FAMILY, and the length separating a family from
a build is a per-SKU judgement made by whoever reviewed the evidence bundle — a
device cannot compute it. `matchCertifiedEntry` therefore runs `startsWith` against
the device's FULL revision, and the matched entry's own discriminators become the
request's `sku` so the engine's catalog re-check resolves to the SAME entry.

**ON SUCCESS the backend fires EXACTLY ONE re-discovery + `modems` broadcast**
(`discoverModems()` — the `sim-autounlock` precedent). The regular loop broadcasts
only every 30 s, so without this the confirming snapshot lands long after any
reasonable UI bound and a genuinely-successful switch reads as a timeout. Not zero,
and not a loop. A refused/failed transition re-discovers nothing.

**`transition_failed` carries a TYPED reason** (`setUsbModeFailureReasonSchema`):
`identity_unresolved` / `engine_unavailable` / `preconditions_refused` /
`postcondition_mismatch` / `transaction_error`. The last two are deliberately
distinct — "the device came back as something else" and "the transaction blew up"
call for different operator actions.

**A dependency that THROWS is NOT caught inside `runUsbModeTransition`.** The
procedure catches it instead, so `withLifecycleLock`'s `finally` release is
exercised by a real escaping throw. Todo 23 learned this the hard way: a body that
always returns normally never exercises a `finally`, so a release test built on a
merely-FAILING engine proves the ordinary return path and nothing else.

**The transition ENGINE is now WIRED.** `modules/modems/transition-engine.ts`
builds modem-stack's certified `UsbModeTransition` from CeraUI-local ports: the
`NmcliNmPort` adapter, an MM inhibit lease that IS a live
`mmcli --inhibit-device` child (MM scopes an inhibition to the caller's bus
connection, so releasing it is killing that child — a one-shot D-Bus call would
un-inhibit the moment it returned), and a raw AT sender writing to the modem's own
tty (the transaction sends AT only while the modem is inhibited, which is exactly
when ModemManager has RELEASED the port). `TransitionInterlock` — bidirectional by
design — is bridged onto CeraUI's own lifecycle interlock rather than a second
guard, which is what made the wiring possible without a parallel lease. A modem
with NO AT control port yields NO engine and the typed `engine_unavailable`,
never a fabricated transition. The rollback is ARMED before the first
connectivity-losing call and cancelled only after the engine's postcondition AND a
confirmed re-registration with a live data path.

**Re-enumeration is not complete until NetworkManager exposes the returned
connection on a concrete device.** USB composition switches can make the physical
modem visible before its replacement netdev appears in NetworkManager. The engine's
request-scoped enumeration wrapper therefore withholds the returned target snapshot
and polls `GENERAL.CON-UUID,GENERAL.AVAILABLE-CONNECTIONS` for the transaction's NM
connection id. Only after that bounded resolver finds the owning interface is the
snapshot returned with the resolved ifname injected. Expiry throws a transaction
error, leaves the failed journal outcome intact, and never reports a switch as
successful merely because the USB device reappeared. Coverage is split between
`tests/modem-transition-engine.test.ts` (delayed success plus bounded timeout) and
`tests/modem-usb-mode-nm-device.test.ts` (the production NM connection-to-device
resolver).

Historical note (superseded): `UsbModeTransition`
needs MUTATION ports — MM inhibit/uninhibit, an AT sender, an NM quiesce/activate
adapter — and CeraUI's only D-Bus surface is the deliberately mutation-FREE audited
transport (`dbus-audit-transport.ts`), so there is nothing to build them from. The
`createEngine` seam resolves `undefined` and that is reported as the typed
`engine_unavailable` reason — never as a silent success and never as a fake
transition. Every gate, mapping, postcondition path and re-discovery above it is
live; wiring a real engine is a matter of supplying `createEngine`.

**In practice `uncertified` is what every real modem answers today**, and that is
a first-class rendered state rather than a stopgap: the shipped catalog carries one
synthetic bench SKU because no shipping modem has a reviewed evidence bundle yet
(Phase-A Must-NOT-Have 7 — no catalog entry without one).

The RM530N-GL catalog entry remains **BLOCKED-ON-HARDWARE and belongs to Todo 42**.
Do not infer or synthesize its discriminators, commands, or postconditions from model
names: admission requires a captured `certify` bundle and human review. This deferral
does not weaken the generic transition transaction or its post-re-enumeration race
handling.

Wire contract (strict input, `confirm: z.literal(true)`, the six switch-specific
typed refusals plus the four shared mutation-safety ones, and the typed failure
reason): [`packages/rpc/AGENTS.md`](../../packages/rpc/AGENTS.md)
→ "A MODEM IS CORRELATED BY `stable_key`". Coverage:
`tests/modem-set-usb-mode-gate.test.ts` (the entry gates + the two strict-input
negatives) and `tests/modem-usb-mode-transition.test.ts` (the TIER-A zero-engine
spy matrix, the catalog table incl. the prefix-vs-truncation contract, the
outcome→reason mapping, the exactly-one re-discovery, and the lease release under
an escaping throw) and `tests/modem-transition-engine.test.ts` (the wired engine
driven over mock transport — the AT-port resolution, the certified command sent
exactly once, an `OK` that re-enumerates wrong FAILING on the postcondition, a
switch that lands but never restores its data path, and the zero-engine-call proof
for an uncertified firmware). Frontend half: [`../frontend/AGENTS.md`](../frontend/AGENTS.md)
→ "A USB-MODE SWITCH IS CONFIRMED BY THE DEVICE, NOT BY THE REPLY".

### …AND WHICH MODES MAY BE OFFERED IS ASKED BEFORE ANYTHING IS RENDERED [EXISTS]

`modems.getUsbModeOptions` (`usb-mode-certification.ts`) is the pure-READ half of
the same contract: it resolves the device through `getUsbModeDispatchDeps()` — the
SAME `resolveIdentity` and the SAME catalog `runUsbModeTransition` gates on — and
answers the certified TARGET set for the mode the device is in right now
(`entry.permittedTransitions.filter(t => t.from === currentMode)`).

- **One lookup, not two.** A UI gated on its own certification rule is a UI that
  offers what the device refuses; that is the defect this closes, so there is
  deliberately no second catalog read. `from` is matched on the LIVE mode, never on
  the entry's `canonicalMode` — a device already switched is not in the mode its
  entry was written around.
- **It is a READ: no mutation lease, no engine.** It joins `modems.getAll` /
  `getSms` as a deliberate non-entry in todo 25's mutation-entrypoint inventory,
  and a test asserts zero `createEngine` calls.
- **It does NOT answer the provisioning question.** That gate is a SETTING the
  operator can turn back on, so its control renders disabled-with-reason; folding
  it in here would withdraw a control that is merely blocked and make the two
  states indistinguishable.
- **`certified: []` with NO `suppressed` is its own state** — the SKU is in the
  catalog and this mode simply has no certified exit. Reporting it as `uncertified`
  would tell an operator their model was never reviewed.
- **`identity_unresolved` covers native-PCIe and router-mode dongles**, and
  correctly so: neither has a USB composition a switch could act on.
- **Mocks answer with a fixture** (`getMockUsbModeOptions`), because a dev host has
  no udev device to resolve and would otherwise make the whole switch surface
  unreachable in dev and in every e2e spec.

Coverage: `tests/modem-usb-mode-certification.test.ts` (the target table incl. the
one-character-short firmware negative, the per-mode scoping, the wire answers, the
zero-engine proof, and the two-enum vocabulary containment) +
`tests/usb-tether-fence.test.ts` (the PERMANENT `sethimiusbtether` fence: a
comment-stripped repo-wide walk plus the shipped catalog, with a self-proving
detector and a non-vacuity check on its two fence-file exemptions).

## THE DATA-USAGE POLICY IS A LOCAL WRITE [EXISTS]

`modems.configure` accepts two additive fields — `data_usage_cycle_day` and
`data_usage_threshold_bytes` — and persists them through
`@ceralive/modem-control`'s `setUsagePolicy`. They are the WRITE half of the usage
meter; `modem.data_usage` is the read half.

**ModemManager has no data-usage API, so this cannot be a modem write.** Verified
against the bench board's live MM 1.24.2 rather than recalled: a D-Bus
introspection of a real `…/ModemManager1/Modem/N` shows the only `Setup`/threshold
surface on the whole object is `Modem.Signal.Setup` / `Signal.SetupThresholds`,
whose keys are `rssi-threshold` and `error-rate-threshold` — RADIO QUALITY, not
bytes. The only byte counters MM offers are the per-BEARER read-only `Stats`, which
reset with every connection and so cannot carry a monthly cycle. The policy is
therefore durable local state in a versioned, 0600, fail-soft file owned by the
package (`modem-usage-policy.json`, beside `config.json` so it survives an OTA slot
swap). `Modem.Signal.Setup` is separately forbidden by the shadow-mode
mutation-freedom contract; nothing here goes near it.

- **The package is imported STATICALLY.** `setUsagePolicy` landed in
  `@ceralive/modem-control@1.0.0`, so while `package.json` pinned the `0.2.0`
  floor this module resolved it through a lazy `import()` plus a structural probe
  and answered a typed `usage_policy_unsupported` refusal when the pinned release
  did not publish it. The pin is now `1.2.1` EXACTLY, so `tsc` and `bun install`
  answer that at build and install time — both strictly stronger than a
  `typeof === "function"` check, which can only report the gap after a write has
  been attempted. `isUsagePolicySupported()` is therefore constant, and it stays a
  named function only because `supported` is an EXPLICIT wire field.
- **`modem.data_usage_policy` is its OWN wire block, not more fields on
  `data_usage`.** `data_usage` is produced only by the D-Bus backend's observation
  fold, and no shipped device runs that backend, so on every board in the field it
  is ABSENT — a policy folded into it would be unreportable, and therefore
  unsettable, on exactly the devices this exists for. A policy is knowable before a
  byte is counted.
- **`supported` is published EXPLICITLY on every row**, never
  present-only-when-true: the frontend merge preserves an omitted optional field,
  so a true-only flag could be raised and never lowered — the
  `policy_route_missing` latch, exactly.
- **Both input fields are TRI-STATE.** `undefined` leaves the persisted value
  alone, so an APN-only save cannot silently drop a cycle day it never mentioned;
  an explicit `null` clears it. A request mentioning NEITHER field writes nothing
  and is never refused, so an ordinary APN save still succeeds on a device whose
  pinned package cannot write a policy.
- **The policy is filed under `stable_key` when the device has one**
  (`usagePolicySlotKey`), because it is a durable statement about hardware and the
  legacy numeric id is an MM index a re-enumeration re-issues. A device with no
  ID_PATH falls back to the legacy id — worse, but still stable within a boot, and
  the alternative is no policy at all.
- **The write runs OUTSIDE the modem lock and only after the radio config landed**,
  so a save that failed at the radio never leaves a meter bound half-changed. It is
  stamped onto the wire by an injected projector dep, so a status-only partial
  broadcast stays status-only.
- **The cache exists because the wire build is synchronous**
  (`buildModemsWireMessage` cannot await a file read): an async
  `refreshUsagePolicies` writes a snapshot and a sync getter serves it — the
  `policy-route-check.ts` precedent. It refreshes once, before the first discovery,
  so the operator's bounds are on the very first `modems` payload a client sees.

Board-verified on `192.168.78.132` (Quectel RM530N-GL): set day 17 + 10 GiB → both
in the applied echo and read back on `modems.getAll`; an APN-only save preserved
them; an explicit-null save cleared both; the file landed mode `600` and the policy
survived a `systemctl restart`. Coverage: `tests/modem-usage-policy.test.ts` (which
drives the REAL pinned package throughout, and asserts that the exact pin
GUARANTEES the write the wire advertises). Frontend half:
`apps/frontend/src/main/dialogs/modem-usage-policy.ts`.

## THE READ-ONLY SMS INBOX [EXISTS]

`modules/modems/mmcli-sms.ts` + `modems.getSms`. Two mmcli verbs, both reads:
`--messaging-list-sms` for the object paths, then `-s <path>` per message. mmcli
is a client of the SAME ModemManager daemon both cellular backends talk to, so
this behaves identically under `modem_backend: mmcli` and `dbus` and adds ZERO
modem-control surface — which is why it carries no provisioning gate, no
lifecycle interlock, and no confirmation. It is `modemProcedure`-gated like every
modem procedure.

**READ-ONLY IS PERMANENT, AND IT IS ENFORCED BY A TEST.**
`tests/modem-sms-readonly-gate.test.ts` greps the whole modem surface (both
`modules/modems/` and `modules/cellular/`, the modem procedure, the mocks, and
the `@ceraui/rpc` modem schema + contract) for `--messaging-create-sms`,
`--messaging-delete-sms`, `--create-sms`, `--delete-sms`, a quoted `--send` /
`--store`, and any `sendSms`/`deleteSms`/`createSms`/`smsSend`/`smsDelete`
identifier — and asserts that the ONLY `--messaging-*` flag anywhere in that
scope is `--messaging-list-sms`. It scans code with comments stripped, so the
prose in this file and in the contract may name the forbidden verbs freely.
Adding a send/delete path means arguing with that test, which is the point:
sending or deleting is billable and irreversible, and it is out of scope
permanently rather than "not yet".

**Five things are easy to get wrong here.**

1. **`MODEM_PATH_RE` does NOT match an SMS path.** Its path branch is anchored on
   `/Modem/`, so `/org/freedesktop/ModemManager1/SMS/36` fails it outright.
   `SMS_PATH_RE` is the same precedent retargeted at the SMS object tree; using
   the modem regex would refuse every message on the device.
2. **mmcli's timestamp is not valid ISO 8601.** The board emits
   `2025-08-21T17:20:16-05` — an HOURS-ONLY offset — and `Date.parse` returns NaN
   for it. `smsTimestampEpoch` widens it to `-05:00` first. Skip that and EVERY
   message scores as undated and "newest first" silently degrades to object-index
   order, which is the one ordering this module must not trust (ModemManager
   reuses freed indices).
3. **The record parser does not use `mmcliParseSep`.** That parser logs the
   offending LINE VERBATIM whenever a line does not split cleanly, so any drift
   in how mmcli frames a message body would print the body into `debug.log`.
   `parseSmsRecord` has its own splitter, and its `ParseError.raw` carries the
   KEY NAMES it found and nothing else. The LIST parse does reuse
   `mmcliParseSep`; that output is only D-Bus paths. It DOES share
   `mmcliUnescapeValue` with it — see 5.
4. **A refusal is never an empty list.** `{success: true, messages: []}` means
   this modem has an inbox and it is empty. A modem with no Messaging interface
   answers `unsupported`, a radio that has not come up answers `not_enabled`, and
   CLI drift answers `read_failed` — all typed, all distinct operator facts.
   `unsupported` is decided from mmcli's own "modem has no messaging
   capabilities", never guessed from an empty read.
5. **mmcli never prints non-ASCII text — it prints the octal escape's LITERAL
   characters.** `cli/mmcli-output.c` runs every `-K` value through
   `g_strescape()`, so a Spanish message arrives on stdout as
   `\302\241Disfruta…` — the eight ASCII characters, where the wire carried the
   two UTF-8 bytes `0xC2 0xA1`. `mmcliUnescapeValue` (in `mmcli.ts`, shared by
   `mmcliParseSep` and `parseSmsRecord`) rebuilds the BYTES and then reads them
   back as UTF-8; decoding each escape to a code unit instead turns `á` into
   `Ã¡`. Two rules: the decode runs AFTER the key/value split, never before, so
   a decoded `\072` can never forge the `:` the line was split on; and the
   decoder stays total and silent — it neither throws nor logs, because the
   value it holds is message content.

Bounded and fail-loud: the list is cut to the 50 highest-indexed paths BEFORE any
per-message read, so a modem holding hundreds of messages costs at most 50 mmcli
invocations. A record that does not parse aborts the whole read with
`read_failed` and is NEVER retried; a message that vanished between the list and
the read is skipped (that is ordinary storage rotation), logged by path only.

Redaction is layered: the module never puts content in a log at all, and
`helpers/logger.ts` additionally scrubs SMS content by key (`isSmsSensitiveKey` —
whole-key, not the substring rule `SENSITIVE_KEY_RE` uses, so `smsCount` and a
`from` bound survive) and by value (a raw `sms.content.text:` / `.number:` record
in any free-text log line is replaced wholesale). Coverage:
`modules/modems/mmcli-sms.test.ts` (parsers over verbatim board fixtures, the
scripted-runner flow incl. zero-retry and the 50-read cap),
`tests/modem-sms-redaction.test.ts` (drives the REAL logger),
`tests/modem-sms-readonly-gate.test.ts`. UI half: todo 39.

## A USSD REPLY IS ASYNCHRONOUS, AND THE PROPERTY THAT HOLDS IT IS RETAINED [EXISTS]

`mmcli-ussd.ts`'s two hardest rules are both measured rather than reasoned, from a
live `*611#` dialogue on bench `ceralive2` (Movistar Colombia, MM 1.24.2,
2026-08-18). BLOCKER B4 — "the exact framing of a USSD reply has NOT been verified
against a real carrier answer" — is resolved by that run, and the answer was that
**both previously-accepted shapes were wrong**.

**1. mmcli uses the word "reply" as a KEY nowhere.** An action prints
`… new reply from network: '<raw text>'` — a whole SENTENCE before the colon, with
the carrier's text spanning REAL newlines and closed by the LAST quote — and
`-K --3gpp-ussd-status` keys the same text `modem.3gpp.ussd.network-request`, note
*request*, g_strescape()d onto one line. `parseUssdReply` accepts both; the legacy
`…reply` suffix is retained only as forward tolerance, and a test pins that the
fabricated `Reply: '…'` shape the retired parser was built around does NOT match.

**2. `--3gpp-ussd-respond` DOES NOT BLOCK on the network.** `initiate` does (2.2 s
measured, reply on stdout). `respond` returns in **60 ms** with an EMPTY reply:

```
21:27:56.894  --3gpp-ussd-respond=4 dispatched
21:27:56.954  returned — 60 ms, reply EMPTY
21:27:56.958  status: idle,          request = the PREVIOUS turn's menu
21:27:57.238  status: idle,          request = the PREVIOUS turn's menu
21:27:57.524  status: user-response, request = this turn's answer   (+570 ms)
```

So reading the status ONCE, immediately, is wrong twice over: the state is
transiently `idle`, which reports a live dialogue as `closed`, and the property —
which is RETAINED across turns and even across a cancel — still holds the previous
turn's text, which is then served as this turn's reply. **A plausible, wrong menu
is worse than no menu**, and this was observed end-to-end on the board before it
was fixed.

`runTurn` therefore snapshots the property BEFORE dispatching (the only way to
tell this turn's answer from the last one's), and when stdout carried no reply it
polls `readUssdStatus` for a bounded `REPLY_WAIT_MS` (8 s, ~14× the measured
arrival) at `REPLY_POLL_MS` (250 ms). **Arrival is detected two ways and the second
is not redundant**: the text CHANGING is primary, but a menu can legitimately
repeat itself (answering `00:inicio` re-serves the root menu byte-identically), so
an observed `idle → not-idle` edge counts as arrival independently of the text. A
bound that elapses with no arrival yields NO reply — never the retained value.

**Never log a value on this path.** `parseUssdNetworkRequest` deliberately does not
route through `mmcliParseSep`, which logs an unsplittable line VERBATIM; every
value here is subscriber content. Verified live: a `debug.log` covering a full
four-turn dialogue contains 0 occurrences of the MSISDN or of any menu text.

Board-proven end to end through CeraUI's OWN authenticated RPC: `ussdInitiate`
`*611#` → the root menu (carrying the SIM's number), `ussdRespond` `4` → the
balance submenu, `ussdRespond` `1` → its submenu, `ussdRespond` `1` → `Total:$0`,
`ussdCancel` → `closed/cancelled`, session `idle`. Every reply byte-identical to
the manual `mmcli` walk. Coverage: `tests/modem-ussd.test.ts` (both real shapes,
the empty-respond negative, the two-turn dialogue over the board captures, and the
answer-never-lands case asserting NO reply rather than the retained one).

### …AND THE READ THAT PROVES THE CAPABILITY RE-PUBLISHES IT [EXISTS]

`readModemUssd` wrote `capabilityCache` directly and never called
`noteCapabilityEvidenceChanged()` — the one implemented capability module that
did not. `gps.ts`'s `recordCapability` and `band-capability.ts`'s refresh both
do, for the reason `capability-gates.ts` states: the wire build is SYNCHRONOUS,
so a probe that first proves a capability only reaches an operator on the next
30 s roster poll.

That window is not cosmetic for USSD, because the verbs are gated on the SAME
evidence. Until the claim moves, `withCapabilityModuleMutation` refuses every
one of them `module_unavailable` — so CeraUI's USSD section, which reads on
open and is withheld below `capable`, reported "not established yet" with no
control for up to half a minute on hardware that supports USSD, and any verb
forced through in that window was refused.

`recordUssdCapability` is that notifier, mirroring `gps.ts` exactly: it is
CHANGE-GATED, so the dialog's read-on-open costs one map lookup once the modem
is proven and broadcasts nothing. Both call sites go through it — the
`unsupported` read that records `absent` as well as the successful one that
records `present` — because a modem that positively LOSES the capability must
lower the claim just as promptly as one that gains it.

Frontend half: [`../frontend/AGENTS.md`](../frontend/AGENTS.md) → USSD IS A
SESSION, SO IT CARRIES A SECOND MACHINE.

## `no_sim` REPORTS A SLOT, NOT A NETWORKMANAGER PROFILE [EXISTS]

`modules/modems/sim-presence.ts` (pure) is the ONE rule behind the wire's
`no_sim`, and both builders route through its `claimsNoSim`.

The wire's `no_sim` was derived from the absence of an NM GSM connection
profile. That is a different fact: a profile is provisioned only once a SIM has
been READ **and** a connection created for it, so a modem holding a working card
that has not registered yet has none. Board-measured on a Quectel RM530N-GL
(2026-08-18): `mmcli -m 3` reported `modem.generic.sim:
/org/freedesktop/ModemManager1/SIM/0`, an occupied slot, `lock: sim-pin2`, the
SIM's own number, and `state: searching` under a `gprs-and-non-gprs-not-allowed`
network rejection — while CeraUI rendered **"No SIM card detected"** in the modem
dialog and simultaneously offered that same card's SMS inbox and its optional
PIN2 unlock band. Three operator-visible surfaces, exactly one of them reading
the wrong fact.

**THREE ANSWERS, and the third is not a synonym for the second.** `present` (MM
named a SIM object — the ONLY value that suppresses the claim, regardless of
profile, lock or registration state), `absent` (MM's own
`state-failed-reason: sim-missing`, a positive statement rather than an
inference from silence), and `unknown` (neither — the read could not answer).

- **`unknown` keeps the pre-existing behaviour**, so no modem class silently
  stops reporting a genuinely missing SIM. It is also what a poll that could not
  answer resolves to, and `mergeRefreshedModem` then RETAINS the previous value
  — the same withhold-on-unknown rule `deriveNetworkTypes` follows, for the same
  reason: a statement about the READ must not demote a card that was seen.
- **`sim_lock` follows the same three-answer merge discipline.** A stated lock
  replaces the previous value; `unlock-required: none` positively clears it; an
  unreadable or unknown lock answer retains the previous value. The `none` arm is
  explicit — omitting a fresh field while spreading the previous modem would
  otherwise latch "SIM locked" forever after a successful unlock.
- **AN EMPTY SLOT IS PUBLISHED AS `/`, not dropped.** Board-measured on the
  SIMCom SIM7600G-H, whose two `sim-slots` values both read `/`. So the test is
  the object-path SHAPE (`isSimObjectPath`), never "is this string non-empty" —
  the latter reports every empty-slot modem as holding a card.
- **The failed-reason is consulted LAST**, so a modem reporting both a SIM object
  and a stale `sim-missing` failure resolves `present`: a card MM can NAME is a
  card that is physically there.
- **BOTH backends read the SAME three MM facts.** `dbus-view-fold.ts`
  `readSimPresence` is the D-Bus twin (`Modem.Sim` / `Modem.SimSlots` /
  `Modem.StateFailedReason`), so the mmcli and D-Bus paths cannot disagree about
  whether a modem holds a card. This matters more on the D-Bus path than on
  mmcli: the fold never populates `config` at all, so under the old rule EVERY
  D-Bus-backed row claimed `no_sim`.
- **A SIM-present modem with no profile emits no `config` and no `no_sim`** —
  the honest "SIM present, not yet configured" state. The row then renders the
  radio's real state (`searching` plus the network's own rejection reason), its
  PIN2 lock badge, and a usable config dialog.
- The `simVisibility: "opaque"` router-dongle rule is UNCHANGED and orthogonal:
  it still emits NONE of the slot keys for a device whose SIM the host cannot see
  at all.

### …AND THE READING THE FOLD CONSUMES NOW RIDES THE WIRE BESIDE IT

`claimsNoSim` is `presence !== "present"`, so `absent` and `unknown` leave this
module as ONE `no_sim: true`. That fold is correct for its consumer — bonding is
binary, a link either joins the pool or does not — and lossy for every other
consumer: "we know the slot is empty" and "the read could not answer" are
different facts with different operator actions, and a modem with no NM profile
AND an unreadable slot published the same claim as a genuinely empty one.

`modemSchema.sim_presence` (`present` / `absent` / `unknown`,
additive-optional) is that fold's INPUT, published beside it by BOTH wire
builders. Four rules:

- **`claimsNoSim`, `isSimlessForBond` and bond membership are UNTOUCHED.** The
  gate still reads the binary claim, so the same device is refused exactly as
  before. Making `claimsNoSim` positive-evidence-only would change which links
  bond and is still its own change; this one is additive by construction.
- **It is emitted EXPLICITLY, including `unknown`.** The internal `Modem` state
  OMITS `sim_presence` when the read could not answer (that omission is what
  `mergeRefreshedModem`'s retain-on-unknown rule needs), so the builders resolve
  absence to `"unknown"` rather than dropping the key — the consumer merge
  preserves an omitted optional field, so a present-only-when-known field could
  be raised and never lowered (the `policy_route_missing` latch, exactly).
- **It rides the `simVisibility === "visible"` branch**, so an opaque device
  emits it no more than it emits `no_sim`: its slot is not unknown, it is
  unreadable from this host, which is a different claim.
- **The legacy oracle emits it too**, because `buildModemsMessage` is asserted
  byte-identical to the projection. A field added to one and not the other is a
  red suite, which is the point of keeping the oracle.

`ModemInfo` gained `modem.generic.state-failed-reason` and
`modem.generic.sim-slots` (both optional — mmcli drops a `--` value), and `Modem`
gained `sim_presence`. Coverage: `tests/modem-sim-presence.test.ts`, driven
through the REAL parser, the REAL refresh merge and BOTH wire builders against
verbatim board captures — the Quectel for `present`, and the SIMCom /
HiMi U01 / Fibocom FM350-GL for `absent` — plus "the pre-collapse reading rides
the wire beside the fold" (the unreadable slot carrying `unknown` AND `no_sim`,
the re-asserted `isSimlessForBond` verdict on that same fixture, the stated
`absent`/`present` pair, and the opaque-device negative). Rule-E proof: forcing
`claimsNoSim` to `true` reddens 4 tests; dropping the explicit `unknown` emission
reddens 1. Frontend half: `apps/frontend/AGENTS.md` → "…AND THE `unknown`-AS-
`absent` ASYMMETRY IS NOW CLOSED".

## THE SIM'S OWN NUMBER IS DISPLAYED, AND NEVER LOGGED [EXISTS]

ModemManager publishes the SIM's own number (MSISDN) as `Modem.OwnNumbers`, and
nothing in this stack read it — an operator holding four identical sticks had no
way to tell which SIM was in which slot. It now rides the wire as the
additive-optional `modem.own_numbers` and is rendered behind an explicit reveal.

**It is read on BOTH backends, from the same property.** mmcli's
`modem.generic.own-numbers` (`mmcli.ts` → `deriveOwnNumbers`,
`modem-registration.ts`) and the D-Bus fold's `Modem.OwnNumbers`
(`dbus-view-fold.ts` `readOwnNumbers`) produce the same field, so the two paths
cannot disagree about which SIM is in the slot.

Five decisions carry weight:

- **ABSENT, EMPTY and BLANK all read as NOT REPORTED.** Most SIMs carry no
  MSISDN in their elementary files, so an empty answer is the ordinary case;
  publishing `[]` would invite the UI to render "no numbers" as a finding rather
  than as silence. `own_numbers` is `z.array(z.string().min(1)).min(1)
  .optional()` — the schema cannot express the empty list at all.
- **It is an ARRAY, and the tail is not dropped.** MM's property is `as` and a
  dual-number SIM is expressible; collapsing to a first element would be a silent
  loss. The bench Quectel RM530N-GL reports exactly one.
- **A refresh REPLACES it, it does not retain.** This is the deliberate opposite
  of `sim_presence`'s withhold-on-unknown rule, and the reason is that the two
  absences mean different things: `parseModemInfo` already rejects a record with
  no `modem.` key at all, so a successful parse that omits this one is the modem
  saying "none" rather than a read that could not answer. Retaining would latch a
  swapped-out subscriber's number on screen — the `policy_route_missing` latch,
  with PII in it. `mergeRefreshedModem` therefore drops the previous value before
  spreading.
- **mmcli's `-K` array indices are ONE-BASED.** The bench capture reads
  `modem.generic.own-numbers.value[1]`, as do `drivers`, `ports` and
  `unlock-retries`. `mmcliParseSep` pushes in encounter order, so nothing may
  key on the index number.
- **It is its OWN redaction class** (`helpers/logger.ts`
  `isOwnNumberSensitiveKey`, plus the `OWN_NUMBER_RECORD_RE` value-side
  backstop for a raw `-K` record). It cannot join `SENSITIVE_KEY_RE`, which is a
  SUBSTRING match: `number` there would blank a slot index, a band count and
  every unrelated `numbers` on the device. `msisdn` stays in the SMS set, its
  historical home, and is not duplicated. `shadow-redaction.ts` gained the same
  keys for the mutation-free evidence collector.

**DISPLAYED is not LOGGABLE.** The UI shows the number behind a reveal because
the subscriber owns that surface; the device still scrubs it from every
transport, exactly like a PIN. Both halves are asserted — the render side in the
frontend suite, the log side by driving the REAL winston transport.

Engine-side half: `modem-stack` `AGENTS.md` → THE SIM'S OWN NUMBER. Frontend
half: `apps/frontend/AGENTS.md` → THE SIM'S OWN NUMBER IS HIDDEN BY DEFAULT.
Coverage: `tests/modem-own-number.test.ts` (the one-based-index parse, the three
absences, the multi-number case, the swap-clears-it merge, the additive
byte-compat diff against the legacy oracle, the D-Bus fold, and the redaction
matrix incl. the real-logger proof and the no-over-redaction control).

## A MODEM SAVE SPENDS A RECONNECT ONLY WHEN IT MUST [EXISTS]

`applyModemConfig` used to end with an UNCONDITIONAL `nmDisconnect(connUuid)` —
one line, no guard — so re-saving an untouched dialog, or toggling roaming and
putting it back, tore the bearer down exactly as hard as a real edit. Operator
report: "disabling and enabling the roaming or the automatic APN shouldn't
trigger another search reconnection."

**Both halves of the question were answered on the board** (Rock 5B+,
NetworkManager 1.42.4, 2026-08-17), and the second one is the reason this is a
SCOPING fix rather than a removal:

- The tear-down really was unconditional, and the board's own journal shows it
  firing at a modem holding nothing:
  `nmDisconnect err: … '091ca73b-…' is not an active connection`.
- And no lighter apply path exists for a modem that IS connected. NM keeps a
  per-property reapply allowlist and refuses everything outside it
  (`Can't reapply changes to '802-3-ethernet.mac-address' setting`), the gsm
  device answers `Device is not activated`, and a bare profile write moves
  nothing — NM logs `gsm-6: connection profile changed` and leaves the device
  alone. Every field here is consumed by ModemManager at `Simple.Connect`:
  `gsm.home-only` becomes the bearer's allow-roaming, `gsm.auto-config` decides
  whether the APN is looked up at all, `gsm.apn`/`username`/`password`/
  `network-id` are connect parameters. So the reconnect is unavoidable for a
  real edit on a live bearer — which is precisely why it must not be spent on
  anything else.

**The rule lives in `@ceraui/rpc` (`modem-apply-scope.ts`), not here**, because
the dialog warns the operator BEFORE the save and this module decides whether to
act. Two copies would drift into a UI promising no interruption while the device
causes one. `decideModemReactivation` answers in a fixed order: unchanged ⇒
never; NM not holding the profile ⇒ never; otherwise reconnect and say which
fields forced it.

- **The comparison is of NORMALIZED values** (`normalizeModemConnectionFields`,
  mirroring `sanitizeModemConfigForNetworkManager`). A stale APN behind an
  enabled automatic-APN switch, an operator lock behind a disabled roaming
  switch, and an automatic-APN toggle on a device that cannot honour it are all
  written identically, so none of them is a change. Comparing raw form values
  would reconnect for all three.
- **The hold is READ, never assumed** — `readModemConnectionHold` runs
  `nmcli --get-values GENERAL.STATE connection show <uuid>`, which prints
  `activated` for an attached profile and NOTHING for a detached one (both
  measured). Non-empty means NM has it in hand, including `activating`, where a
  bearer is being built from the values about to be replaced.
- **`unknown` is treated as HELD.** A failed read is not evidence of an idle
  profile, and skipping there would leave the operator's setting unapplied with
  nothing on screen saying so — worse than an interruption they were warned
  about.
- **The hold is only read once a change is established**, so an untouched save
  costs no nmcli spawn either.
- **The profile WRITE stays unconditional.** Todo 50's ranking can re-point a
  save at a different duplicate, so skipping it would leave the operator's
  values on a profile NetworkManager is not using. Only the tear-down is gated.
- **A write that FAILED reconnects nothing** and still reports `write_failed`.
- **The network-type half is untouched.** `--set-allowed-modes` is mmcli's own
  path with its own guard (`msg.network_type !== modem.network_type.active`) and
  must not start depending on the connect-time diff, or one save would
  re-establish the radio twice.

`modems.configure` now reports what it actually did (`reconnected`, additive-
optional on `modemConfigOutputSchema`) rather than what the dialog predicted.
The effectful surface is injected through `ModemApplyDeps` /
`defaultModemApplyDeps` so the decision is provable with no nmcli on the host.

**Honest status:** the not-held and unchanged arms are board-proven (three saves
including two real edits produced ZERO `nmcli conn down` and no mmcli state
transition at all, while `nmcli` confirmed the new values landed). The HELD arm
is proven by the state-string discriminator measured on the board plus the unit
table — the bench Quectel is rejected by its network (`searching`, todo 49), so
no gsm bearer has ever been up on it to interrupt.

Coverage: `@ceraui/rpc` `modem-apply-scope.test.ts` (the decision table),
`tests/modem-config-reconnect-scope.test.ts` (the wiring, driven through the
REAL `applyModemConfig`). Frontend half:
`apps/frontend/src/main/dialogs/ModemConfigDialog.reconnect.test.ts`.

## …AND EVERY PROFILE BOUND TO THE SIM CARRIES THE SAME ANSWER [EXISTS]

Todo 50 fixed WHICH NetworkManager profile a modem save writes to, and disarmed
`connection.autoconnect` on the clones its retired duplicate-factory had left
behind. That narrows NetworkManager's own selection race; it does not close it,
because nothing forbids NM from activating a DISARMED profile — an explicit
`nmcli connection up <uuid>`, an autoconnect-priority change, a boot-time
reconnect. Board-measured on the bench Quectel RM530N-GL: ONE SIM, **FOURTEEN**
gsm profiles sharing an identical `gsm.device-id` + `gsm.sim-id`, **eleven** of
them still reading `gsm.home-only: no` while the operator had roaming DISABLED.

That is a safety defect rather than an untidiness one. `gsm.home-only` becomes
the bearer's allow-roaming flag at ModemManager's `Simple.Connect`, so activating
any of those eleven registers a roaming session — no error, no notification, and
a UI still reporting the value of the one profile CeraUI wrote.

**The guarantee comes from the profiles AGREEING, not from predicting which one
NM picks.** `modules/modems/gsm-duplicate-reconcile.ts`
(`reconcileDuplicateGsmProfiles`) runs three ordered steps, and only the first is
the guarantee:

1. **ENFORCE** — write the operator's own gsm fields to EVERY profile sharing
   this (device, SIM). After this, "which profile does NM activate" cannot change
   any operator-visible behaviour.
2. **DEMOTE** — disarm `connection.autoconnect` on the duplicates (todo 50's fix,
   preserved verbatim).
3. **PRUNE** — delete only what `classifyGsmDuplicate` can PROVE is abandoned.

- **The order is load-bearing in both directions.** Enforcing before demoting
  means a profile NM activates DURING the reconciliation already carries the
  right values; classifying from the PRE-demotion audit means step 2 cannot
  manufacture the evidence step 3 acts on. A prune that fails costs nothing,
  because step 1 already holds.
- **Deletion is now permitted — todo 50's "demote, never delete" is SUPERSEDED
  by decision, not by drift — but only on positive evidence.** Todo 50 stopped
  because "created by us" was inferred from a shared device+SIM alone; this adds
  the missing evidence rather than dropping the requirement. A duplicate is
  prunable only when it is not the selected profile, NM is not holding it (an
  EMPTY `GENERAL.STATE`), `connection.autoconnect` is already `no` (CeraUI's own
  footprint — nothing else writes it on a same-(device, SIM) clone), AND
  `connection.timestamp` is `0`, i.e. NetworkManager has never successfully
  activated it. Nothing reasons from absence: an unreadable timestamp parses to
  NaN and RETAINS.
- **Convergence is two-pass by construction.** An armed clone is enforced and
  demoted on one pass and can only become prunable on a LATER audit that observes
  the demotion — so a profile is never deleted on the strength of a flag we set
  moments earlier.
- **A different SIM is untouched.** NM matches a gsm profile on
  `gsm.device-id`/`gsm.sim-id`, so a second SIM in the same slot carries a
  different `sim-id`, falls outside the reconciled set entirely, and still gets
  its own profile from `addConnectionForModem`. Consolidation here removes no
  per-SIM capability.
- **The audit is READ FRESH, never from `gsmConnections`.** That cache is a
  snapshot taken for a different purpose at an unrelated moment, and this is the
  input to a destructive decision. A prune calls `resetGsmConnections()`, because
  the cache it invalidated is what the caller read its `keepUuid` from.

**Two call sites, and both are needed.** `applyModemConfig` fans the save out
(`enforceAcrossProfiles`, injected — it runs immediately after the primary write
and BEFORE any reconnect, so the profile NM brings back up already agrees), and
`registerModem` reconciles at discovery from the SELECTED profile's own values —
which is what covers a duplicate that appeared, or drifted, since the last save.
The registration call sanitizes a COPY of the config; normalizing the live one
there would rewrite state the operator did not touch.

**Todo 50 and todo 57 are unaffected.** `preferGsmConnection`'s ranking is
untouched (pruning only shrinks its candidate set), and `decideModemReactivation`
still reads the SELECTED profile's hold — enforcement adds no `nmcli conn down`.
An unchanged save still reconnects nothing and still re-asserts the answer
everywhere, which costs no bearer interruption and is exactly the case a drifted
duplicate needs.

Coverage: `tests/modem-roaming-enforcement.test.ts` (the classifier table incl.
every retain arm, the board's own 14-profile fixture ending with roaming
disabled everywhere, the enforce-before-delete ordering, the failed-prune
fallback, the armed-clone two-pass rule, the foreign-SIM and consolidated-modem
negatives, and the `applyModemConfig` wiring driven through the REAL procedure) +
the retargeted policy locks in `tests/modem-config-save-reliability.test.ts`.

## THE RADIO MODE AN OPERATOR READS MUST BE A LIVE READ [EXISTS]

The 3G/4G/5G selector's apply path is REAL — board-proven on a Rock 5B+
(Quectel RM530N-GL, mmcli 1.24.2, 2026-08-16): five modes driven through
`modems.configure` each landed at the device
(`--set-allowed-modes=3g|4g|5g --set-preferred-mode=5g` →
`modem.generic.current-modes: allowed: 3g, 4g, 5g; preferred: 5g`). What was
wrong was everything around it.

**`refreshModemStatus` carried DISCOVERY's `network_type` forward, forever.** It
rebuilt `status` and `sim_lock` from each fresh `-K` payload and spread the rest
of the previous modem — so `current-modes`, which rides that SAME payload, was
read once at registration and never again. Measured: the modem was moved to
`allowed: 3g` and 40 s later, past the 30 s poll, `modems.getAll` still answered
`active: "5g4g"`. Nothing re-registers an already-known modem, so the wrong label
stood for the process lifetime.

**That latch was not cosmetic — it disabled the write.** `applyModemConfig` asks
`msg.network_type !== modem.network_type.active` before spending an mmcli call,
so a save of the mode the dialog was SHOWING compared equal to a value the radio
had left behind and skipped `--set-allowed-modes` entirely. Board-measured:
`configure({network_type:"5g4g"})` answered `{"success":true}` while the modem
stayed on `allowed: 3g`. Same family as todo 47's interface-address field and
todo 50's APN save — a control that looks wired and silently does nothing.

- **`deriveNetworkTypes(modemInfo)`** (`modem-registration.ts`) is now the ONE
  derivation, shared by registration and refresh. It costs no extra spawn: both
  mode fields are already in the payload the refresh fetched.
- **`undefined` means the PAYLOAD could not answer**, and the caller keeps what
  it had. A read that names no mode fields, or a `current-modes` line that does
  not parse, is a statement about the READ — blanking a modem's whole mode list
  over one unreadable poll would be the opposite error. `mergeRefreshedModem` is
  the pure merge that applies that rule, so it is provable with no mmcli on the
  host.
- **A parse failure no longer aborts REGISTRATION.** The old code called
  `mmConvertNetworkType` bare, so a malformed line threw out of `registerModem`
  and `registerModemSafe` swallowed it — the modem never appeared at all. It now
  registers with an empty mode list, which the next poll fills in.
- **Residual window: one poll interval.** An out-of-band change is reflected
  within 30 s rather than never. Do NOT "fix" that by deleting the skip guard —
  it is what stops every save re-establishing the bearer (see A MODEM SAVE SPENDS
  A RECONNECT ONLY WHEN IT MUST).

**And a refused write no longer reports "Saved".** `mmSetNetworkTypes` answers
`false` when mmcli did not print its confirmation and `undefined` when the spawn
threw, and both were dropped on the floor — the retired comment claimed the
outcome rode "the ordinary configure-echo", but that echo parrots the REQUEST
(`applied.network_type: input.network_type`), and the dialog locks its form to
`applied`. So a mode the modem rejected reached the operator as a success toast
with the rejected value selected. It is now the existing wire-stable
`write_failed` refusal — no new token, no locale change — and `active` is still
left untouched, so the next poll's live read is what settles the display.

Coverage: `tests/modem-network-type-truth.test.ts` (the derivation against the
board's verbatim 12-row supported-modes list, the out-of-band re-read, both
withhold cases, the merge that replaces the latched value, the
everything-else-survives control, and the refused/threw/accepted write matrix
driven through the REAL `applyModemConfig`).

## THE STREAMING-ADMISSION ↔ MODEM-LIFECYCLE INTERLOCK [PARTIAL]

`modules/streaming/lifecycle-admission.ts` is a process-wide, fail-fast lease with
exactly two mutually-exclusive holders — `"streaming"` and `"modem-transition"`.
A USB-composition switch re-enumerates a modem and tears its bond link down
mid-flight, so it must never overlap a stream, in EITHER order.

**`getIsStreaming()` cannot express the dangerous half of that.** It is false for
the whole ADMISSION window — from the moment a start is admitted until the engine
confirms PLAYING — which is exactly the window a transition must not land in: by
then `startStream` has already spawned `srtla_send` against a link list a
re-enumeration is about to invalidate. The interlock covers that window; the live
guard covers the rest. Nothing else changes: `modems.setUsbMode`'s existing
`getIsStreaming()` gate is untouched.

- **The acquisition point is load-bearing.** It sits in
  `stream-session-orchestrator.ts` `start()` AFTER the `state !== "idle"`
  duplicate-start rejection — so a genuine duplicate keeps its own `busy` →
  `START_IN_PROGRESS` instead of decaying into a generic lease-busy answer — and
  BEFORE the attempt goes in-flight (`generation`/`active`/`starting`). It is at
  the ORCHESTRATOR rather than in `streaming.procedure.ts` because all five
  launch origins (ui / autostart / remote-control / set-profile / restoration)
  enter through that one mutex.
- **Refused as a typed, non-retriable `failed` StartResult** carrying
  `code: MODEM_TRANSITION_ACTIVE`, which `startResponse` surfaces as the wire
  `error`. `leaseRefusal()` is the ONE table both directions read, so the
  streaming side and the modem side can never disagree about what happened; the
  modem side's token is deliberately the SAME `streaming_active` the procedure
  already answers for a LIVE stream.
- **Released in a `finally`, and idempotently.** Release is keyed on a per-grant
  TOKEN, not on the holder, so a double-release and a stale `finally` are no-ops
  rather than a way to free whoever holds it now. Note the coverage subtlety a
  mutation exposed: a throwing LAUNCH is caught by the retry runner and returned
  as a typed `failed`, so it exercises the ordinary return path — the `finally`
  needs its own fixture (a dep that throws mid-admission).
- **`admitLifecycle` is an OPTIONAL orchestrator dep, wired only at the
  production singleton.** The lease is process-wide and `bun test` runs one
  process, so defaulting it on inside the factory would let any unit test that
  leaves a start pending strand every later test's admission.

**The `"modem-transition"` holder is now acquired by `modems.setUsbMode`**
(`rpc/procedures/modems.procedure.ts`, gate 4 — see USB-COMPOSITION SWITCH above).
Both directions are therefore live in production. No autonomous cellular recovery
loop acquires it, and none is wired anywhere.

**The refusal has its OWN failure class and its own operator copy.**
`MODEM_TRANSITION_ACTIVE` used to ride the generic `start_invalid` class, which the
frontend renders as "The stream configuration or device is invalid. Check your
settings." — wrong advice for a modem that is merely re-enumerating, and the reason
the class split exists. `START_FAILURE_CLASSES` gained `modem_transition_active`
(non-retriable on every phase: the transition is bounded and operator-initiated, so
an automatic retry would race a mutation of the very links the start is bonding),
with copy in all 10 Paraglide catalogs
(`live.startFailure.class.modem_transition_active` +
`notifications.streamStartModemTransitionActiveFailed`).

Coverage: `tests/streaming-lifecycle-interlock.test.ts` — the primitive's refusal
table and both exclusion directions, race order A (a start during a transition is
refused and NEVER launches), race order B (a transition during an admitted start
is refused until it settles), the duplicate-start ordering lock, finally-release
under a throw, the idempotent/stale release, and the production `streaming.start`
wiring driven through the REAL procedure.

## MODEM-CONTROL COMPATIBILITY PROJECTIONS [EXISTS]

Todo 29 moved the frozen Todo-17 pure-logic set behind the published
`@ceralive/modem-control` package without raising CeraUI's install floor above
`0.2.0`. **The pin is now `1.2.1` EXACTLY**, and the three probes that
floor forced — the SMS port, the usage-policy setter, the band catalog — are
STATIC imports with no runtime fallback left.

`modules/modem-control-compat.ts` REMAINS, and that is deliberate rather than an
unfinished cutover. It is already a static namespace import, so it is not a lazy
`import()`; and two of its names — `hilinkConnectionBody` and `vidPidOf` — are
exported by NO release, which `modem-control-skew-matrix.test.ts` pins and the
installed 1.2.1 confirms. Their local implementations are PERMANENT, so deleting
the seam would delete the implementation. Each of the 14 MIGRATE modules asks for
its package function through it and keeps its own as the answer when the package
has none. Public CeraUI exports, wire fields, parser outcomes, and refusal
strings are unchanged.

The 14 modules are exactly the frozen ledger entries: five under `modems`
(`usb-mode-identity`, `sim-presence`, `five-g-preference`, `physical-identity`,
`modem-identity`), two under `cellular` (`dbus-mm-enums`,
`shadow-divergence`), and seven under `network` (`router-details`,
`hilink-documents`, `router-capabilities`, `usb-net-classifier`,
`router-signal-model`, `router-signal`, `vendor-xml`). No transport, session,
cache, RPC, wire, or router-admin proxy ownership moved with them.

Package operations receive CeraUI's existing stream-coupled policy through
`modules/modems/mutation-admission-port.ts`. It implements the package's
structural `MutationAdmissionPort` over `tryAcquireModemMutation`; a stream-active
request is refused as `admission-refused` with detail `streaming_active`, and an
admitted package lease releases the existing CeraUI lifecycle lease. The policy
therefore remains consumer-owned rather than moving into modem-stack.

`tests/modem-control-projections.test.ts` is the committed boundary gate. It
asserts all 14 modules use the named seam, every projection imports against the
exact `1.2.1` pin (asserted as a bare version, never a range — a resolved release
missing the statically-imported exports must fail at import rather than degrade),
direct `dbus|mmcli|qmicli|goform|hilink` references
remain inside the Todo-17 ledger allowlist, and stream-active admission preserves
the refusal vocabulary. Never add a direct modem transport/model/dialect path
outside that allowlist; add package consumption through a named projection
instead. Never replace the registry pin with `link:` or `file:`.

`@ceralive/modem-control@1.2.1` also exports the frozen
`MODEM_OPERATION_IDS` array from the existing root entry point. The frontend
parity gate resolves the backend's exact installed package, reads that registry
from emitted JavaScript without importing the D-Bus runtime graph, and holds the
local disposition manifest to set equality. The gate is unskipped: a missing
registry, an undispositioned package id, or a stale local id fails the suite.
The seven public package entry points are unchanged. `hilinkConnectionBody` and
`vidPidOf` remain absent from the package and permanently local behind
`modem-control-compat.ts`.

The same release activates the fifteenth compatibility consumer:
`modems/usb-mode-runtime.ts` resolves
`resolveRuntimeCompositionCapability` from the package. The module retains its
local implementation as the fallback and executable parity oracle;
`tests/usb-mode-runtime-compat.test.ts` proves the runtime candidate is selected,
assignable in both directions, and returns the same shapes for all four vendors
plus unsupported and malformed responses. This is deliberately read-only.
Although 1.2.1 also exports `buildRuntimeCompositionSetCommand` and
`RUNTIME_COMPOSITION_SET_REGISTRY`, CeraUI consumes neither; adding package-backed
composition writes is a separate feature requiring its own safety review.

## THE MODEM MUTATION-SAFETY CONTRACT [EXISTS]

The interlock above is the PRIMITIVE. This is the contract built on it, and it
covers every path that mutates a modem — MM/NM config, SIM PIN/PUK/PIN2, a
network scan, a router-admin write, the remote `modem.reconfig` op, and the
USB-composition switch.

**It is an EXTENSION of `lifecycle-admission.ts`, not a second guard beside it.**
A parallel lease plus a `getIsStreaming()` check would reopen the admission-window
race that module exists to close: `getIsStreaming()` is false for the whole
admission window, which is precisely the window a mutation must not land in. So
the `"modem-transition"` holder was GENERALIZED to a per-physical-device lease:
two devices may be mutated concurrently, a stream admission is refused while ANY
lease is held, and every mutation is refused while an admission holds the
interlock.

### The lease, and the ONE helper every entrypoint routes through

`modules/modems/mutation-lease.ts` has two shapes, and the difference is exactly
whether the mutation can cost connectivity:

| Helper | Use |
|---|---|
| `withModemMutation` | lease only — a SIM PIN submit, a network scan, a router-admin write. Nothing a rollback would have to restore. |
| `withJournaledModemMutation` | lease PLUS a durable armed journal entry written BEFORE the mutation and cancelled only after it is confirmed. APN/roaming/band/5G/USB-mode. |
| `beginModemMutation` | the lease alone, for a transaction whose confirmation is DEFERRED past the caller's return (see LEASE LIFETIME below). |

**IDENTITY IS FAIL-CLOSED.** The identity contract permits an omitted
`stable_key`, and a target with no resolvable physical key cannot be journaled,
cannot be rolled back and cannot be re-found after a re-enumeration — so EVERY
mutating entrypoint answers the typed `identity_unresolved` before anything is
written and before anything is mutated. It is deliberately not a throw: this runs
at an RPC boundary, where a throw becomes an opaque failure nobody can act on.
`mutation-identity.ts` is the one resolver (mmcli index / MM object path / ifname
→ `ID_PATH` → `deriveModemStableKey`).

### The durable journal

`modules/modems/mutation-journal.ts`, at the PINNED location
`/data/ceralive/modem-mutations/<sha256(stable-key)>.json` — `/data` because it
survives an OTA slot swap, hashed because an `ID_PATH` is not a safe filename, one
file per physical device because two devices' mutations are independent. Mode
0600; the directory 0700.

**THE DURABILITY SEQUENCE IS THE CONTRACT**, in this exact order per transition:

```
write temp -> fsync(temp) -> rename() over the journal path -> fsync(parent dir)
```

and a durable deletion is `unlink()` + `fsync(parent)`. `rename` over an existing
path is atomic on every filesystem the device ships, so NO injection point can
leave a torn document. A failure anywhere REJECTS and the caller must not proceed:
the parent-directory fsync is INSIDE the boundary rather than best-effort after
it, because until the directory entry is durable the rename can be lost by a power
cut. That makes the failure mode fail-CLOSED — the visible on-disk state may
already be the new, more-restrictive one while the caller is told it did not
commit.

**Every filesystem primitive is injected** so the fault-injection harness can fail
each of the four steps independently against a REAL temp directory. An unparseable
or wrong-version slot is reported and LEFT IN PLACE — a mutation record that
cannot be read is exactly what fail-closed exists for.

**On a dev host there is no `/data`.** `resolveJournalDir()` reads
`CERALIVE_MODEM_MUTATION_DIR` (the `CERALIVE_RUN_DIR` precedent) and otherwise
falls back to a cwd-relative directory in development/mock mode. A real device
sets no override and is not in development mode, so it gets the pin.

### The VERSIONED state machine

`mutation-journal-state.ts` is the machine as pure data — no I/O, no clock, no
device — so every legal and illegal transition is enumerable in a unit test, and
so the durability harness can inject faults around transitions without also faking
a state machine.

`armed -> executing -> completed | failed -> acknowledged` is the ordinary life.
The remaining three states exist because a physical device can LEAVE:

- **`device-absent-quarantine`** — the device is not present at replay or
  acknowledgement time. That identity stays mutation-blocked and its entry is
  RETAINED, so fail-closed handling resumes if it returns (return-of-device goes
  BACK to `failed`).
- **`decommissioned`** — the operator's journaled confirmation that it is gone.
  ONLY that physical identity stays mutation-blocked; GLOBAL streaming is
  unblocked, so a destroyed modem can never permanently strand the remaining
  links. It is deliberately NOT irrevocably terminal.
- **`recommission-pending`** — a device is present at a decommissioned identity.
  Identity is PORT-based for serial-less devices, so a REPLACEMENT modem in the
  same port inherits the key; mutations stay refused until an explicit operator
  REBASELINE captures, validates and journals the current device as the new
  baseline.

`blocksMutations` and `blocksStreaming` are DIFFERENT questions and the second is
a strict subset — that asymmetry is the whole decommission escape hatch. Blocking
is DERIVED from the state and published by `mutation-blocks.ts` alone; a second
source of "is this device blocked" is how a fail-closed guard drifts open.

### THE STARTUP REPLAY TABLE

| State | Replay action |
|---|---|
| `armed` | execute the rollback (restoring the pre-state is safe by construction — it had not been dispatched) |
| `executing` | execute the rollback |
| `completed` | prune |
| `failed` | remain blocked awaiting acknowledgement |
| `acknowledged` | resume the archive + unblock |
| `device-absent-quarantine` | re-check presence (present ⇒ `failed`; absent ⇒ remain) |
| `decommissioned` | re-check presence (present ⇒ `recommission-pending`; absent ⇒ no action) |
| `recommission-pending` | remain awaiting the rebaseline |

`mutation-replay.ts` is the table's executor and NEVER throws: a replay that
cannot complete still LOWERS the barrier, because a barrier nobody will lower is
worse than a device that honestly reports its blocks — the blocks are what keep it
safe.

### THE REPLAY BARRIER AT THE ADMISSION CHOKEPOINT

`modules/streaming/recovery-barrier.ts` is an AWAITABLE PROMISE, not a boolean,
and that is the point. The WS control server binds BEFORE subsystem
initialisation (`main.ts` — it is the operator's only lifeline), so an RPC can
arrive mid-replay. A boolean gives exactly one answer to that race, and refusing
is the WRONG answer for the two INTERNAL boot origins:

- stream restoration converts an unhandled refusal into a terminal `start_failed`
  and retires its one-shot marker (`stream-restoration.ts`), so a refusal does not
  defer the intent — it destroys it;
- boot autostart records a failed result with no retry at all (`autostart.ts`).

So `startStreamSession` gates EVERY origin with TWO semantics: `autostart` and
`restoration` AWAIT the promise; `ui`, `remote-control` and `set-profile` get the
typed `recovery_pending` refusal, which costs only a retry. Both internal sites
ALSO await at their own trigger — restoration before it READS its marker (not
merely before it launches), autostart as its first statement.

A modem whose failed rollback holds streaming is refused at the same chokepoint
with the `mutation_blocked` class. Both classes are non-retriable on every phase
and carry keyed operator copy in all 10 locales.

### ACKNOWLEDGEMENT SEMANTICS — acknowledging is NOT unblocking

A failed rollback means the modem's true state is UNKNOWN, so a bare alert-dismiss
must never clear it. `mutation-acknowledge.ts` offers exactly two typed paths, and
both END in a state the device has proven:

- **VERIFIED-ROLLBACK** — re-read the device and CONFIRM it equals the journaled
  pre-state. A mismatch REFUSES and the device stays blocked.
- **FORCE-REBASELINE** — the operator explicitly accepts the CURRENT hardware,
  which is captured, validated as coherent, and journaled as the new baseline.

Both write `acknowledged` durably FIRST and archive SECOND, so a crash between
those two writes is replayable rather than a lost operator decision. `ifname` is
excluded from the state comparison on purpose: a predictable name is derived from
a MAC this fleet has proven can collide, and it legitimately changes across a
re-enumeration that restored the correct mode.

### LEASE LIFETIME spans the TRANSACTION, not the entrypoint call

`modem.reconfig` applies and then leaves a 30 s confirm/auto-revert watchdog live
AFTER the handler returns (`self-fencing.ts`). Releasing on return would leave a
stream admissible during exactly the window in which the modem is half-applied or
being rolled back — so the lease is stored on the pending entry and released on
confirm, on successful auto-revert (AFTER the revert runs — the rollback is itself
a mutation), or on a discarded/terminal failure.

The wire payload for `modem.reconfig` names no target device, so a payload without
one takes the SUBSYSTEM-WIDE holder; a payload that DOES name one is keyed on it,
and a named-but-unresolvable device is refused rather than silently widened.

### FAIL-CLOSED TERMINAL POLICY

A rollback that cannot complete keeps stream autostart AND new mutations for that
device BLOCKED until explicit operator acknowledgement — never a silent fail-open.
A kind with no registered rollback handler answers `unavailable`, which is
visible; it is never inferred as success.

Coverage: `tests/modem-mutation-state-machine.test.ts` (the FULL cross product of
states — every legal transition accepted and every remaining pair refused, plus
the blocking sets and the replay table), `tests/modem-mutation-durability.test.ts`
(the four injection points over a real temp dir, the step ORDER, the 0600 mode,
and the never-torn assertion), `tests/modem-mutation-replay.test.ts` (one test per
journal state, incl. the returning original modem AND a replacement in the same
port), `tests/modem-mutation-acknowledge.test.ts` (5a-5e: verified rollback,
mismatch, force-rebaseline, the crash between ack and archive, and every path that
must NOT unblock), `tests/modem-mutation-entrypoints.test.ts` (one enforcement test
per inventoried entrypoint plus its `identity_unresolved` branch, and the lease
lifetime across confirm/auto-revert), `tests/modem-mutation-admission.test.ts` (the
two refusal semantics and the delayed-replay proofs), and
`tests/modem-transition-engine.test.ts` (the REAL modem-stack transaction over mock
transport).

**Honest status:** none of this has been exercised against a real modem. Every
fixture models the contract; the board drill is a separate, still-owed step.

## THE CAPABILITY FEATURE-GATE FRAMEWORK [EXISTS]

Seven modules are GATED (band-lock / SMS / 5G-pref / FCC-auto-unlock / GPS / USSD
/ eSIM); FOUR of them ship a probe and a mutation path today
(`IMPLEMENTED_MODEM_CAPABILITY_MODULES` — `five-g-pref`, `band-lock`, `gps`,
`ussd`), and the rest resolve `unavailable` everywhere. What every one of them
routes through is the framework below, whose two halves live in different places
for a reason: the LADDER is `@ceraui/rpc` (`capability-modules.schema.ts` +
`capabilities/capability-matrix.ts`), shared verbatim with the frontend and the
support matrix; the DEVICE BINDING is `modules/modems/capability-gates.ts` +
`capability-mutation.ts`.

**The gates are DEFAULT-ABSENT, and that is a safety property.**
`config.modem_capabilities` (`helpers/config-schemas.ts`) carries one optional
boolean per module and has NO entry in `RUNTIME_CONFIG_DEFAULTS` — the
`modem_provisioning` precedent, for the same reason: every module either mutates
the radio in a way that can cost the bond link or reaches a billable/irreversible
surface, so absent and `false` must be equally inert. Adding a default would
silently enable seven radio-mutating modules on every device in the fleet.

**`capability-gates.ts` is where the gate meets the evidence.** It reads the
persisted gates, asks an injected evidence reader what THIS modem can do, and
resolves the total seven-module claim matrix. The reader has a deliberately empty
default (no module ships yet, so every modem resolves `unavailable` — the honest
answer), it is FAIL-OPEN on a throw (a broken probe is a statement about the READ,
which leaves the ladder at `enabled`: surfaced by nothing, mutated by nothing), and
each of the seven modules registers its own probe when it lands.

**`capability-mutation.ts` is the SHARED helper every mutating module must use.**
It is a WRAPPER over the mutation-safety contract, never a second guard beside it:
`withCapabilityModuleMutation` checks the feature gate and then hands off to
`withModemMutation` / `withJournaledModemMutation`, so the lease, the reciprocal
streaming refusal, the durable journal and the crash-surviving rollback all remain
`mutation-lease.ts`'s.

- **The gate runs FIRST**, on a pure read, before a lease is taken and before
  anything is journaled — the same ordering the USB-mode catalog check follows. An
  operator who has not enabled a module must be told THAT, not that the device is
  busy.
- **Which modules are journaled is enforced by the TYPE SYSTEM.** The request is a
  discriminated union in which a journaled module MUST carry a `preState` and a
  lease-only one cannot, so a module that can cost the bond link has no way to opt
  itself out of a rollback — it would not compile. The split is exactly
  "can this re-register the radio": band-lock / 5G-pref / FCC-unlock / eSIM are
  journaled; GPS and USSD take the lease alone.
- **An UNPROVEN capability fails CLOSED** into `module_unavailable`. A mutation
  nobody can show the hardware supports must not be dispatched at it.
- **The refusals are their own superset** (`capabilityMutationRefusalSchema`), not
  new members of the shared mutation enum — see `packages/rpc/AGENTS.md`.

**The matrix reaches the wire as `modem.capability_modules`**, stamped by
`modem-wire-projection.ts` from an injected resolver (the `usagePolicyFor`
precedent: it is durable state resolved from config, never anything an adapter
observed). It is TOTAL — every module carries an explicit state — because the modem
merge preserves an omitted optional field, so a present-only-when-supported claim
could be raised and never lowered.

Coverage: `tests/modem-capability-framework.test.ts` — the off-by-default matrix,
per-modem capability gating, the throwing-probe degradation, the wire stamp plus a
legacy-wire regression lock and a static producer-wiring lock, and the enforcement
suite: every refusal arm asserts BOTH the typed refusal AND that the effect
provably never ran, with a NEGATIVE CONTROL proving a module that bypasses the
helper mutates freely under identical conditions. Engine-side half:
`modem-stack/control/src/capability/`.

### …AND THE OPERATOR CAN ACTUALLY SET THOSE GATES [EXISTS]

`modems.getCapabilities` / `modems.setCapabilities` are the write path. Before
them `config.modem_capabilities` was default-absent with no RPC and no UI, so
band-lock and GPS told operators to enable a feature "in settings" and pointed at
nothing — a board sweep of `#settings` matched zero relevant testids
(`.omo/evidence/task-49-full-stack-board-validation.md`).

- **They are `authedProcedure`, NOT `modemProcedure`.** The gates belong to the
  DEVICE, so they must answer while the cellular stack is still initializing and
  with no modem attached; the readiness middleware would make the settings surface
  unreachable in precisely the state an operator opens it to fix. They join
  `modems.getAll` / `getSms` / `getUsbModeOptions` as non-entries in the
  mutation-entrypoint inventory: they take no lease and touch no radio.
- **A module absent from `IMPLEMENTED_MODEM_CAPABILITY_MODULES` is REFUSED**
  (`module_not_implemented`) before anything is written. Its gate key is read by
  nothing, so persisting it hands the operator a switch that can never act.
- **Writing a gate proves nothing.** It is one of four `resolveSupportClaim`
  inputs, so an enabled gate on an unprobed modem stops at `enabled`, on a
  positively-absent one stays `unavailable`, and `certified` is unreachable from
  here — band-lock's stricter certification floor included.
- **`broadcastModems()` runs after `saveConfig()`**, so the control the gate
  unblocks moves on the device's own next answer rather than on the reply.
- **A PROBE that changes evidence re-publishes too, change-gated.**
  `noteCapabilityEvidenceChanged` (`capability-gates.ts`) is called by
  `gps.ts`'s `recordCapability` and `band-capability.ts`'s refresh when the stored
  evidence actually MOVES. Without it a read that first proves a capability leaves
  the claim stale until the 30 s poll — the window an operator lands in right
  after enabling the gate. The notifier DEFAULTS TO INERT and is installed at
  module scope by `capability-evidence.ts` through a DYNAMIC `import()` of
  `modem-status.ts`: that module reaches this one via the wire producer, so a
  static edge back would cycle. Re-reading an already-proven modem is silent.

Coverage: `tests/modem-capability-settings.test.ts`. Operator surface and its
render rules: [`../../AGENTS.md`](../../AGENTS.md) → THE GATES HAVE AN OPERATOR
SURFACE.

### …AND THE IDENTITY IT GATES ON COMES FROM udev's NET RECORDS [EXISTS]

Every gated module resolves the modem to a `stable_key` FIRST — the USSD session,
the GNSS session and the lease that guards them are all filed under it. That
resolution was `defaultResolveIdentity` (`usb-mode-identity.ts`), which matched
`createUsbEnumerator().enumerate()` on `device.ifname`. **That field is declared
on `UsbDeviceSnapshot` and never populated**, for the reason
`modem-id-path-source.ts` already documents: the enumerator keeps only
`DEVTYPE=usb_device` records and such a record carries no `INTERFACE`.
Re-measured on `ceralive2` (2026-08-18): **24** `usb_device` records, **0** with
one, while **9** net records carry an `INTERFACE` AND an `ID_PATH`.

So this was the SECOND half of a defect that was only ever half-fixed. The wire
producer's `stable_key` map was repaired by reading udev's net records; this
resolver was not, so `stable_key` was correct on the wire while every capability
RPC answered `unknown_modem` **on the same board, in the same second**.
Board-measured before/after on the Quectel RM530N-GL:

| RPC | before | after |
|---|---|---|
| `modems.getUssd` | `unknown_modem` | `{session:{state:"idle"}}` |
| `modems.ussdInitiate` | `unknown_modem` | the carrier's real `*611#` menu |
| `modems.getGps` | `unknown_modem` | the modem's real GNSS capability set |
| `modems.getUsbModeOptions` | `identity_unresolved` | `active:"qmi"`, `uncertified` |

- **`resolveModemIdentityAnchor` (`mutation-identity.ts`) is the ONE resolver the
  capability modules use**, and it is a thin reuse of `modemStableKeyForId` —
  the same fixed source, not a third mechanism. It answers `{stableKey}` and
  nothing else, so a PCIe-attached or momentarily-unenumerable modem is not
  refused for lacking catalog discriminators it never needed.
- **`defaultResolveIdentity` still enumerates USB**, because the catalog
  discriminators (`vid:pid`, model, firmware revision, composition mode) exist
  nowhere else — but it now derives the key from the net records and MATCHES the
  USB snapshot against it. The snapshot's `physicalUid` is the parent
  `usb_device`'s `ID_PATH`, which reduces through the shared
  `deriveModemStableKey` to the SAME key the netdev's interface-level path does,
  so the two sources agree by construction rather than by coincidence.
- **`five-g-pref` was never affected** — `five-g-apply.ts` already resolved
  through `modemStableKeyForId`. That is what makes the split a fix rather than a
  new convention: one module had it right and the rest did not.
- **A capability MUTATION still needs its READ first.** The evidence cache is
  process-local, so on a fresh boot `ussdEvidence` answers `unknown` and the gate
  fails closed with `module_unavailable` until `modems.getUssd` has run once.
  Confirmed live. That is the framework's fail-closed rule working, not a
  regression — but it means an operator surface must probe before it offers.

Coverage: `tests/modem-capability-identity.test.ts`, whose fixtures are VERBATIM
`udevadm info --export-db` records from the board — the `usb_device` one carrying
no `INTERFACE` and its netdev carrying both. That shape is the point: the retired
code passed its suite because its fixtures were hand-built snapshots holding an
`ifname` udev does not put there. `setUsbUdevDatabaseReaderForTest` is the seam.

### THE 5G PREFERENCE IS A RANKING, AND ITS ECHO IS A READBACK [EXISTS — UNCERTIFIED]

`five-g-pref` is the module that ranks 5G against LTE. Its read half is
`modules/modems/five-g-preference.ts` (pure), its write half
`modules/modems/five-g-apply.ts`, and its wire block `modem.five_g_preference`.

**IT EXISTS BECAUSE THE NETWORK-TYPE SELECTOR CANNOT EXPRESS THE QUESTION.** That
selector's vocabulary is the ALLOWED SET, and `mmConvertNetworkTypes` keys its
catalog by allowed-set LABEL — keeping exactly one `preferred` per label and
discarding the rest. So "allow 4G and 5G, prefer 5G" and "allow 4G and 5G, prefer
4G" are ONE entry there, and the second is precisely what an operator on a
marginal 5G cell wants. `Modem.radio_modes` is the same `-K` payload UNFOLDED
(`deriveRadioModeCatalog`, derived beside `deriveNetworkTypes` from the one read,
so the two cannot disagree about what the modem said), and this module reads that
and never the folded map.

**`prefer-5g` and `prefer-4g` emit an IDENTICAL allowed set.** Two consequences
that are easy to lose: nothing may decide "no write is needed" by diffing allowed
sets, and the rollback compares BOTH fields — an allowed-only comparison would
report a `prefer-4g` restore as successful when the radio came back on
`prefer-5g`.

**THE ECHO IS A READBACK, NOT THE REQUEST.** This is the sibling defect to THE
RADIO MODE AN OPERATOR READS MUST BE A LIVE READ, and it is designed out rather
than guarded against: `mmSetNetworkTypes` answering `false`/`undefined` is a
typed `write_failed`, and a write mmcli DID confirm is then re-read and compared,
because MM accepting the call is not the radio taking the mode set. Four typed
failures, none collapsible: `write_failed` (mmcli did not confirm),
`readback_mismatch` (accepted, landed elsewhere — the operator's next action
differs), `readback_failed` (accepted, unreadable, so nothing may be claimed),
`not_offered` (the radio never advertised it, refused BEFORE any lease is taken).
`applied` is present only on success and carries the READ-BACK posture, so a UI
that locks its form to `applied` cannot show a rejected value as selected.

**Absence is honest at three levels.** A posture the radio cannot express resolves
`undefined` and is REFUSED, never substituted with a neighbour. A current pair no
posture names reads `null`, never the nearest one. And the wire block is OMITTED
entirely unless the claim is surfaceable — an empty `offered: []` would be
indistinguishable from a 5G modem that advertised no postures.

**SA/NSA is stated unsupported.** MM 1.24.2 exposes no standalone-vs-non-standalone
selector at all (its only NR member is `Modem3gpp.SetNr5gRegistrationSettings` —
`mico-mode` + `drx-cycle`), and the vendor AT commands that do are uncertified
per-SKU writes this build does not open. `nr_mode` therefore rides every block as
`{supported: false, reason: "not-exposed-by-modemmanager"}`: a missing field reads
as "nobody asked".

The rollback handler is registered at MODULE SCOPE (`usb-mode-rollback.ts`
precedent) and `capability-evidence.ts` installs the live probe reader the same
way — a boot step that must be remembered is one a refactor drops silently, and
here that would answer `unknown` for every probe and withhold every control with
no error anywhere.

**Status: `implemented-but-uncertified`** — the plan's own predicted outcome. No
5G SIM/plan and no verified 5G coverage exist at the bench (todo 2's BLOCKER B3),
so the readback/registration/data/fallback drill on the RM530N-GL has NOT run.
Code, gates and tests are complete; the certification step is hardware-blocked.

Coverage: `tests/modem-five-g-preference.test.ts` (33 tests — the model incl. both
`prefer-*` postures, the gate matrix reaching the wire, every failure arm asserting
BOTH a typed answer and `success: false`, lease/streaming/journal routing, and the
restoration matrix incl. the sibling-posture negative). Rule-E proof captured in
both directions: dropping the readback comparison reddens 2 tests, and comparing
only `allowed` on rollback reddens 1. Frontend half:
`apps/frontend/src/main/dialogs/modem-five-g.ts`.

## PREVIEW WEBSOCKET PROXY — single-origin (Task 20) [EXISTS]

The cerastream engine serves its video preview over a WebSocket on a loopback
port, but the browser NEVER dials the engine directly. The backend proxies the
preview through its OWN origin at `/preview` (`modules/ui/preview-proxy.ts`), so
the preview travels the same authenticated, single-origin path as the RPC socket.

**Remote-access rationale (the decision):** a device reached through a reverse
proxy / cloud tunnel exposes exactly one origin. A direct engine-port dial from
the browser would require a second exposed port (and mixed-origin/CORS handling)
that a remote operator does not have. Proxying through the backend keeps the
preview reachable wherever the RPC socket is reachable — no extra port, no
divergence between dev and prod dial targets.

- **Fork order (`rpc/server.ts`):** the `fetch` handler branches on
  `pathname === PREVIEW_WS_PATH` BEFORE the generic oRPC upgrade — the oRPC path
  would otherwise adopt every WS into the RPC handler. Bun exposes ONE `websocket`
  handler, so `rpc/adapter.ts` `createServerWebSocketHandler()` dispatches by the
  `ServerSocketData` `kind` discriminant (`isPreviewSocket`).
- **Auth AFTER upgrade (pinned):** a fresh WS upgrade starts unauthenticated, and
  RPC auth is per-socket, so "same auth as RPC" is NOT reusable. The route ALWAYS
  upgrades on a pathname match, then validates+consumes a single-use token on
  `open`, closing `PREVIEW_CLOSE_UNAUTHORIZED = 4401` when it is
  invalid/expired/consumed — NEVER a pre-upgrade HTTP refusal (a browser
  WebSocket cannot distinguish a pre-upgrade HTTP error from a network failure).
- **Token (`modules/ui/preview-token.ts`):** in-memory, single-use, TTL 30s,
  minted by the authed `system.mintPreviewToken` RPC and passed as the `?token=`
  query param — the RPC password/credential never appears in the URL. Mirrors the
  kiosk single-use token pattern; raw entropy, never persisted, never logged.
- **Upstream + close codes:** the proxy dials the engine loopback socket
  (`ws://127.0.0.1:<preview.port>` from the capability snapshot
  `preview {enabled, port, bound}`), or the mock preview server
  (`getMockPreviewPort()`) under `shouldUseMocks()` — dev and prod dial the
  identical URL/token flow. `PREVIEW_CLOSE_UPSTREAM_DOWN = 4502` (loopback
  unreachable), `PREVIEW_CLOSE_UPSTREAM_UNAVAILABLE = 4503` (preview
  unbound/disabled). Close-code constants live once in `@ceraui/rpc/schemas`.
- **`start` frames resolve their `input_id` by STABLE IDENTITY (Todo 19a):** the
  ONE frame that is not a byte-for-byte passthrough. `streaming.start` resolves
  the persisted `config.source` through `resolveSourceRouting` →
  `resolveSourceIdentity` before dispatching, but PREVIEW had no such step —
  `PreviewCanvas` puts the applied `config.source` on its `{action:"start"}`
  frame verbatim and this proxy forwarded it unchanged. So a device that
  re-enumerated under a new node path streamed fine and would not preview.
  Confirmed live: de-authorizing the RØDE renumbered the Osmo `/dev/video3` →
  `/dev/video2`, the UI still showed it "Selected" (it matches by stable id), and
  preview answered `SourceUnavailable` **0/5**.
  `resolvePreviewStartFrame(frame, resolveInputId)` closes it at the proxy —
  the choke point EVERY preview start frame crosses, whichever client sent it —
  so the rule lives at one seam instead of in each client. The injected
  `PreviewProxyDeps.resolvePreviewInputId` defaults to the SAME
  `resolveSourceIdentity` the stream path runs, against `getSourcesMessage()` +
  `config.last_seen_devices`. **It resolves, it never rejects:** an id with no
  live stable-identity match (a TRUE unplug, or a different device that merely
  took the freed node) passes through UNCHANGED, so the engine still answers its
  own typed `source-unavailable` and the `lost` row is untouched. Do NOT
  "harden" this into a `resolveSourceRouting` call — that one refuses
  lost/unavailable sources and would replace the engine's typed reason with a
  silent drop. An unchanged id returns the ORIGINAL frame object (no
  reserialization), and anything that is not a well-formed `start` frame with a
  non-empty string `input_id` — binary access units, WebRTC signaling, `stop`,
  malformed JSON, a coarse-source start that omits `input_id` — is untouched.
  The resolver is FAIL-OPEN: any throw yields the original id. Config self-heal
  is unchanged and still persists the migration via
  `reconcileConfiguredSourceIdentity` on the `sources` broadcast.
  Coverage: `tests/source-renumber-dedup.test.ts` → "preview start — resolves to
  the CURRENT node, not the saved one" (the renumber fixture, the self-heal
  assertion, the true-unplug + wrong-device negatives, and the passthrough table).
- **Backpressure — bounded drop-oldest (Todo 14):** frames are a transparent
  passthrough BOTH ways (text control frames + binary access units). The
  downstream (browser) leg is backpressure-aware — when the client's
  `getBufferedAmount()` exceeds `PREVIEW_BACKPRESSURE_HWM_BYTES` (1 MiB) forwarding
  pauses and upstream frames are held in a BOUNDED DROP-OLDEST queue
  (`modules/ui/preview-frame-queue.ts` `BoundedDropOldestQueue`), resuming on
  `drain`. Above `PREVIEW_MAX_PENDING_FRAMES` (256) or `PREVIEW_MAX_PENDING_BYTES`
  (1 MiB) the OLDEST media frame is evicted — the queue PLATEAUS, the socket stays
  OPEN (a live-edge skip-on-lag), and the browser resumes at the freshest media,
  paired with the frontend live-edge seek policy (`preview-live-edge.ts`). This
  REPLACES the previous close-on-overflow ("NEVER drop-oldest") contract: a
  permanently-slow consumer no longer tears the preview down. The newest MSE init
  segment (codec-config text frame) is PINNED — never dropped, dequeued first — so
  the latest fragments stay decodable. Socket close frees every buffered frame
  (`freePreviewProxyState` clears the queue).
- **WebRTC signaling relay — never-dropped control lane (Todo 16, ADR-0006):** the
  preview WS ALSO carries WebRTC signaling. Server→client control frames
  (`webrtc-offer`/`webrtc-ice`/`webrtc-connected`/`webrtc-failed`/`preview-error`,
  classified by `isPreviewControlFrame`) are relayed transparently like every other
  frame, but routed into the queue's separate never-dropped CONTROL LANE
  (`BoundedDropOldestQueue` `isControl`): they are forwarded AHEAD of any queued
  media, in FIFO arrival order, and a backpressure eviction can NEVER drop a
  handshake frame (dropping an offer or ICE candidate would break the WebRTC
  session). Media still drop-oldest; the pinned MSE init still newest-wins — the
  control lane is orthogonal. WebRTC media itself rides the browser↔engine peer
  connection, NOT this WS, so a WebRTC session puts almost nothing on the WS media
  path. Client half: `apps/frontend/.../PreviewCanvas.svelte` + `preview-tier-ladder.ts`.

Coverage: `tests/preview-token.test.ts` (mint/consume/expire/single-use) +
`tests/preview-proxy.test.ts` (pipe, 4401/4502/4503, authed mint gate) +
`tests/preview-frame-queue.test.ts` (drop-oldest by count/bytes, pinned init,
never-drop control lane) + `tests/preview-proxy-bounded.test.ts` (slow-consumer
plateau, socket stays open, signaling frames survive backpressure, teardown frees
buffers).

## DEV MOCK SEAMS [EXISTS]

These seams let tests and dev mode exercise real code paths without hardware. All
are gated by `shouldUseMocks()` or `isDevelopment()` — never active in production.

### isDevelopment() power-gate (T1)

`isDevelopment()` (`mocks/mock-config.ts`: `NODE_ENV==="development" ||
MOCK_MODE==="true"`) gates all dev-only side-effects. The `system.poweroff` and
`system.reboot` handlers skip the real OS spawn when `isDevelopment()` is true.
The post-update reboot in `software-updates.ts` is gated via `rebootAfterUpdate()`.
DI runner seams (`setPowerCommandRunner`, `setRebootRunner`) let tests assert the
exact command without touching the host.

### simulateDevReboot (T2)

`simulateDevReboot()` (`rpc/events.ts`) reproduces the real-device reboot effect in
dev: snapshots `getAuthenticatedClients()` and closes each socket after a macrotask
delay (`setTimeout(..., 0)`). The delay lets the in-flight `system.reboot` reply
flush before the socket drops, matching the real-device sequence. Gated by
`isDevelopment()` — the early return means no production call site can schedule
socket teardown through this helper.

### Adapter diagnostics (T3)

`extractValidationDetails(error)` (`rpc/error-enrichment.ts`) turns an opaque
oRPC/Zod validation failure into `ValidationDetails`:
`{ phase: "input" | "output" | "unknown", issues: ValidationIssueDetail[] }`.
The WS adapter attaches the result as a `validation` field on the `RpcCallTrace`
log record. These adapter diagnostics surface which schema field failed and whether
it was an input or output validation error — visible at `LOG_LEVEL=debug`. Phase is
classified from the oRPC wrapper message then the error code. Issue paths are schema
field names (safe); messages are scrubbed through `logRedact`. Returns `undefined`
when the error has no issue list.

### The scenario is the `sources` truth — and deliberately NOT the switch-reachability truth

`main.ts` injects `getMockEngineDevices()` into the capability fold and the boot
`sources` seed. That is not sufficient, and the gap is silent: the readers that
REBUILD `sources` afterwards — `sources.ts` `refreshSourcesForHotplug` (fired by
the device registry's own device-SET change) and `recheckSourceSignals` (the 5 s
tick) — take DEFAULT deps, i.e. a cerastream control socket that cannot exist
under `MOCK_SCENARIO`. A failing probe then hands over to the registry's
observation, which in dev is the HOST's own `/sys/class/video4linux` + ALSA scan:
hardware the scenario says nothing about.

Measured on a dev host with no `/dev/video*`: the registry's first scan is empty
and correctly skipped as the initial scan; ~2 s later the host's ALSA cards land
in `getAudioSources()`, the device SET changes, and the hotplug refresh publishes
that observation — erasing every simulated capture device from `sources`. Because
`sources` is on-change only, the coarse-only list then stood for the life of the
process, and a page that authenticated afterwards got it in its post-login
snapshot. Nothing failed loudly.

Two seams carry the repair, and BOTH are scoped to the `sources` rebuild:

- `defaultFetchEngineDevices` (`capabilities.ts`) serves `getMockEngineDevices()`
  under `shouldUseMocks()`. Its only consumers are the capability service and the
  engine-device cache — the build path, never a gate.
- `observedForSourcesRebuild` (`sources.ts`) substitutes the scenario list for the
  registry's host observation in the two rebuild entry points above. The scenario's
  own hotplug seam is `setMockDeviceAttached`, so the scenario IS the observation.

**`defaultGetEngineDevices` (`devices.ts`) is deliberately NOT redirected.** The
registry's `scan()` is also `switchInput`'s reachability gate
(`deviceRegistry.switchInput` re-scans and answers `SOURCE_LOST` when the target
is absent), and picker-VISIBILITY and switch-REACHABILITY are allowed to diverge:
a scenario device is visible in the picker while still having no engine or v4l2
node behind it, and the honest answer to a live switch there is `SOURCE_LOST`.
Widening the registry too — the first attempt at this fix — erased that divergence
and broke `tests/e2e/input-picker.spec.ts`'s deliberate negative coverage. Do not
redo it; if a new reader needs the scenario, route it through
`observedForSourcesRebuild` or take injected deps.

Production is byte-unchanged (every gate requires `isDevelopment()` AND an
initialised mock state) and the imports are lazy, so the mock graph stays off
these modules' load paths. Coverage: `tests/mock-engine-devices-wiring.test.ts`,
whose second describe is the negative half (the registry must NOT adopt the
scenario, and a live switch to a scenario-visible device must still refuse before
commanding the engine).

### Scenario-seeded capability profiles (T5)

Three `MOCK_SCENARIO` values seed the engine-capability state:

| Scenario | Behaviour |
|----------|-----------|
| `caps-full` | Full engine profile: H265 + hw accel, audio-capable HDMI source, `audio_live_switch`, `transports: ["srtla","srt"]` |
| `engine-starting` | Mock fetcher throws with empty cache → minimal safe floor + `engineStarting: true` |
| `engine-unavailable` | Mock fetcher throws after seeding last-known-good → cached snapshot + `engineUnavailable: true` |

`setMockEngineCapabilities(partial)` (`mocks/providers/streaming.ts`) merges a
`Partial<ScenarioCapabilities>` onto the active scenario's profile and immediately
re-broadcasts the `capabilities` event. Gated by `shouldUseMocks()`. Use in tests
that need a specific capability combination without switching the full scenario.

### Bluetooth dev seam (`mocks/providers/bluetooth.ts`)

An in-memory BlueZ stand-in — adapter, discoverable roster, pair/trust state
machine, bounded TIMED scan window — so the whole surface is drivable with no
controller. It is a PARALLEL layer: `modules/bluetooth/` never imports it, and it
imports only that module's PURE halves (`deriveCapability`,
`buildBluetoothStatus`) so the mock's `deviceClass` / `scoCapable` / `transport`
and its whole wire payload come from the production derivations rather than from
a second, driftable copy. Its refusals are the shared
`bluetoothMutationRefusalSchema` set, in `bluetooth.procedure.ts`'s own gate
order. `setMockBtScenario(partial)` / `setMockBtAgentRegistered(bool)` are the
override seams; `resetMockBluetoothState()` is wired into `resetMockState()` and
drops every scan timer. Full contract: [`../../AGENTS.md`](../../AGENTS.md) →
MOCK SUBSYSTEM.

### Kiosk dev-seam gate (T6)

`resolveActiveKioskDeps()` (`modules/system/kiosk.ts`) returns the mock kiosk
harness under `shouldUseMocks()`, else the production `activeDeps`. The kiosk RPC
handlers call `kioskStart(resolveActiveKioskDeps())` etc. so dev exercises the full
state machine against in-memory fakes without touching `systemctl`. The gate in
`system.procedure.ts` was widened to `if (!shouldUseMocks() && !(await
isRealDevice())) return UNAVAILABLE` so dev bypasses the emulated-mode guard.
`peekMockKioskHarness()` returns the singleton without building it — use in prod
tests to assert the mock double was never constructed.

### Add-on dev-seam gate (T7)

`resolveActiveAddonManagerDeps()` (`modules/addons/manager.ts`) returns a
lazily-built mock `AddonManagerDeps` singleton under `shouldUseMocks()`, else the
production `activeDeps`. `resolveReconcilerDeps()` (`modules/addons/reconciler.ts`)
mirrors the same pattern for the post-boot reconciler. Both are the default-parameter
values for their respective public functions, so existing tests that pass deps
explicitly are unaffected.

### Software-update + SSH dev mock seams (T8)

- `simulateMockSoftwareUpdate()` (internal, called by `startSoftwareUpdate()` under
  `shouldUseMocks()`) broadcasts a realistic sequence of `{updating: SoftUpdateStatus}`
  frames without spawning `apt-get`. The in-flight promise is accessible via
  `getMockSoftwareUpdatePromise()` for test awaiting.
- `setSoftwareUpdateRunner(runner)` (`modules/system/software-updates.ts`) replaces
  the default apt spawn with an injected function. Use in prod tests to assert the
  runner was called without running a real update.
- `setSshServiceRunner(runner)` (`modules/system/ssh.ts`) replaces the default
  `systemctl start/stop ssh` spawn. The `shouldUseMocks()` branch in `startStopSsh()`
  flips `mockSshActive` and broadcasts `{ssh}` without touching `systemctl` or `passwd`.
  On device, `ceralive` is the default SSH account when `setup.json` has no override;
  start, stop, and reset RPC responses settle only after the privileged action completes.
- `MessageSocket` (`modules/ui/message-socket.ts`) is exactly
  `{ readonly data?: { readonly senderId?: string }; send(message: string): void }`;
  SSH, log, and notification producers accept Bun `AppWebSocket` structurally
  without casts.
- Kiosk start/stop RPCs likewise await the cog-display add-on lifecycle before reporting
  their applied status. Background status refresh and software-update scheduling remain
  deliberately asynchronous because their responses acknowledge a refresh/scheduled job,
  not completion.

### SSH password sync on boot — OTA slot-swap fix [EXISTS]

`ensureSshPasswordSynced()` (`modules/system/ssh.ts`, wired into `main.ts` via
`guardNonCritical("ssh-password-sync", …)` immediately before the boot
`getSshStatus()` probe) fixes an operator lockout confirmed on real Rock 5B+
hardware: an OTA A/B slot swap silently invalidated SSH login. `config.json`
(`ssh_pass` + `ssh_pass_hash`) is `/data`-persisted and survives the swap, but the
OS-level `/etc/shadow` entry is **rootfs-local** — baked fresh into each image and
NOT carried across slots — so a freshly-activated slot holds the build-time
password while config.json still remembers the operator's real one. Nothing
re-applied it, so the operator had to click "Reset SSH Password" after every single
OTA.

The sync mirrors image-building-pipeline's
`ceralive-ssh-firstboot.sh::ensure_host_keys()` restore pattern for host keys:
compare the persisted `ssh_pass_hash` (cached via `getSshPasswordHash()`) against
the live `/etc/shadow` hash (`probeSshUserHash`), and on a mismatch RE-APPLY (never
regenerate) the EXISTING persisted `ssh_pass` through the same stdin-only
`runWithStdin("passwd", …)` path `resetSshPassword()` uses. It is additive and does
NOT touch `resetSshPassword()` (still generates a fresh secret on explicit reset)
or `startStopSsh()`'s "generate when `ssh_pass` is undefined" branch. Contract:
never throws (BOOT FAIL-SOFT); a clean no-op under `shouldUseMocks()`, when
`ssh_pass` is undefined (nothing persisted yet), or when the OS already matches (the
common same-slot boot). It NEVER generates a new password and NEVER calls
`saveConfig()` — the credential is unchanged, only the OS shadow entry catches up.
Effectful surface (`readShadow` / `applyPassword`) is injected via
`SshPasswordSyncDeps` (mirrors `SshStatusDeps`) so `tests/ssh-password-sync.test.ts`
drives it without a real `passwd`/`/etc/shadow`.

### SSH password provisioning on first boot [EXISTS]

`ensureSshPasswordProvisioned()` (`modules/system/ssh.ts`, wired into `main.ts` via
`guardNonCritical("ssh-password-provision", …)` immediately BEFORE the
`ssh-password-sync` step) mints an INITIAL `ssh_pass` on a device that has never
had one. SSH is enabled-by-default at the OS/systemd level, but CeraUI only ever
generated a password on an explicit operator "Start SSH" / "Reset" action — so a
fresh device ran `sshd` with `ssh_pass` permanently `undefined` and the account
effectively unreachable until a manual reset. Provisioning closes that gap: when NO
`ssh_pass` is persisted it mints one through the SAME credential path the operator
reset uses.

The generation is shared between the operator reset and boot provisioning by the
single private `mintAndApplySshPassword()` helper (random `ssh_pass` → stdin-only
`passwd` apply → persist → re-probe hash → broadcast config + status), so both
routes emit and persist the secret through EXACTLY the same code — never logged.
`resetSshPassword()` wraps it with an operator notification on failure;
`ensureSshPasswordProvisioned()` wraps it with a boot broadcast. It is called
UNCONDITIONALLY at boot (independent of the `ssh.service` active/enabled state), so
even a production device shipping with SSH disabled-by-default has a ready
credential the instant SSH is enabled from the UI. Contract: never throws (BOOT
FAIL-SOFT); a clean no-op under `shouldUseMocks()` or when a password is ALREADY
persisted — it NEVER regenerates an existing credential (that stays
`ensureSshPasswordSynced()`'s restore-only job). Effectful surface (`readShadow` /
`applyPassword` / `persist` / `refreshStatus`) is injected via
`SshPasswordProvisionDeps` so `tests/ssh-password-provision.test.ts` drives it
without a real `passwd`/`/etc/shadow` (and without persisting to disk).

## CONVENTIONS

- Runtime: Bun only. No Node-specific APIs (`fs/promises` ok; `node:cluster` not).
- Build: `bun build --compile --minify --sourcemap --target=bun-linux-{arm64|amd64}` — single binary, no runtime on device. `--sourcemap` is deliberate and EMBEDDED in the binary (device stack traces stay symbolicated); the frontend's maps follow the opposite policy — emitted `hidden` and relocated out of the packaged tree, see `apps/frontend/vite.sourcemaps.ts`. **There is no `--bytecode`, and it cannot be added as a flag**: `bun build --bytecode` forces `--format=cjs`, and `main.ts`'s boot ladder is 20 top-level `await`s (`runCritical`/`guardNonCritical` phases), so the build fails outright. Adopting it means restructuring boot away from top-level await first.
- Tests: `bun test` (not vitest). Files in `src/tests/`.
- Config files (`config.json`, `setup.json`, `auth_tokens.json`) read/written from working dir — path-sensitive in production.
- `MOCK_SCENARIO` env activates mock providers. Scenarios: `single-modem`, `streaming-active`, `multi-modem-wifi` (default dev), `modem-pin-locked` (2 modems, modem 0 SIM PIN-locked, fixture PIN `0000` — the `unlockSim`/`unlockSimPuk` RPCs route to the mock SIM state machine). Three additional scenario-seeded capability scenarios: `caps-full`, `engine-starting`, `engine-unavailable` (T5).
- Frontend dependency `bits-ui` is at v2.19.0 (frontend concern only; backend has no direct bits-ui dep).
- Use `shouldUseMocks()` — never raw `isDevelopment()` — to gate mock-hardware paths. `shouldUseMocks()` requires both `isDevelopment()` AND `mockState.initialized`.
- **Frontend store-ownership mirror [EXISTS]:** the frontend's legacy `websocket-store.svelte.ts` wrapper is deleted; `rpc/procedures/auth.procedure.ts` (`auth.login`/`auth.setPassword`/`auth.logout`) is now called exclusively through the frontend's `lib/stores/auth-status.svelte.ts` (`authenticate`/`createPassword`), and every other push event is consumed exclusively through `lib/rpc/subscriptions.svelte.ts`'s single `rpcClient.onMessage` handler. Don't casually rename/reshape these procedure signatures or add a second push-consumption path on the frontend side — see `apps/frontend/AGENTS.md` → CONVENTIONS (store ownership).

## A VERSION AN OPERATOR READS MUST BE A LIVE READ [EXISTS]

`modules/system/revisions.ts` feeds Settings → Versions. It gained two rows the
operator previously could not see — the board's running kernel and the cerastream
engine version — and one contract that is easy to break from either side.

- **`revisions.kernel` is `os.release()`** (`node:os`, kept per the Bun-native
  policy: fully supported, no Bun gain), i.e. the running `uname -r`. It is a
  boot-time read because a kernel cannot change without a reboot.
- **`revisions.cerastream` is NOT.** cerastream is systemd-owned (ADR-0005): it
  can be stopped, crash, or be apt-upgraded underneath a running backend, and
  CeraUI connects to it rather than owning it. A version observed once is
  therefore not something the device can still vouch for, so
  `refreshEngineRevision()` RE-READS it and an unreachable engine publishes
  `ENGINE_UNREACHABLE_REVISION` instead of retaining the last-known value. A
  cached-forever version would keep naming a build that may no longer be
  installed — the same latched-stale family as `policy_route_missing` and
  `active_encode`.
- **The read costs no new IPC.** `engine_version` has always ridden the `hello`
  handshake; it was simply never surfaced. The default probe is the SAME
  short-lived connect → `hello` → close that `checkEngineCompatibilityOnStartup`
  uses (`cerastreamBackend.probeEngine()`), so no connection is held open for a
  version string and the systemd-owned engine is never spawned or stopped. The
  import is lazy, mirroring `capabilities.ts`'s `setup.ts` import, so this
  module's load path does not pull the streaming graph.
- **`getRevisionsProcedure` is `async` and re-probes before answering.** The
  login-time `revisions` push is a snapshot: an engine that came up (or was
  upgraded) after the operator logged in would otherwise be reported unreachable
  for the rest of the session. The push and the pull are both kept — the push
  seeds the dialog instantly, the pull corrects it.
- `setEngineVersionProbe(probe | null)` is the test seam (the `set*Runner`
  convention). Coverage: `tests/revisions-kernel-engine.test.ts`.

Board-proven on a Rock 5B+ across a full engine stop/start with NO backend
restart: `2026.7.2` → `engine unreachable` → `2026.7.2`.

## TERMINATION CLEANUP [EXISTS]

`helpers/shutdown.ts` owns the process-level `SIGTERM`/`SIGINT` lifecycle. The first
signal latches shutdown and runs the existing sequential order — SRT ingest, dmesg
watchers, then streaming processes. Each cleanup is settled independently and any
failure is logged before the next step runs; `exit(0)` is still attempted after all
three steps. Later signals remain ignored. The direct regression coverage lives in
`src/main.test.ts` under `termination shutdown lifecycle`.

## SIGUSR2 UDEV HOTPLUG HOOK [EXISTS]

`main.ts`'s `process.on("SIGUSR2", udevDeviceUpdate)` re-scans Cam Link USB2 +
audio devices on an Elgato/USB-audio hot(un)plug. The signal is delivered by two
udev rules in `deployment/` (`98-ceralive-audio.rules`,
`99-ceralive-check-usb-devices.rules`) that MUST target the unit's main pid:

```
RUN+="/usr/bin/systemctl kill --kill-whom=main --signal=SIGUSR2 ceralive.service"
```

NOT `pkill -f ceralive` (the retired form). `pkill -f` substring-matched
avahi-daemon's process title `avahi-daemon: registering [ceralive.local]` (the
device hostname is `ceralive.local`) and killed mDNS on every hotplug.
`--kill-whom=main` scopes the signal to the tracked MAIN pid via the unit cgroup —
mirroring the old `pkill -o` single-process intent — so the whole-cgroup default
 (`all`) can never collaterally SIGUSR2-terminate `srtla_send` (which shares
`ceralive.service`'s cgroup while streaming and do NOT handle SIGUSR2). `systemctl
kill` from a udev `RUN+=` is safe: it creates no systemd job (returns after the
PID-1 D-Bus request), so the `--no-block` / deadlock caveats that apply to
`start`/`stop`/`restart` do not apply. Regression lock:
`src/tests/udev-rules-sigusr2-scope.test.ts` (static assertion on the shipped rule
files). Do NOT reintroduce a broad `pkill`, and do NOT drop `--kill-whom=main`.

**SIGUSR2 does NOT rebuild the unified `sources` list — video hotplug does.** The
handler only re-scans audio + Cam Link USB2 (a generic UVC capture dongle like a
RØDE is not even covered by the Elgato-scoped `99-ceralive-check-usb-devices.rules`).
The live video-hotplug → `sources` reactivity is owned by `modules/streaming/
devices.ts`: its `/dev` `fs.watch` + 2 s `VIDEO_HOTPLUG_POLL_INTERVAL_MS` poll
already detected the device-set change but previously only rebroadcast the legacy
`devices` event. It now also fires the injected `onDevicesChanged(observed)`
(default → `sources.ts` `refreshSourcesForHotplug()`) on a genuine device-SET
change — keyed on the device array alone, so a live `active_input` switch (same
set) never re-probes and the boot seed (already covered by `main.ts`) is skipped.
This is why unplug/replug updates the Live Sources list with no page refresh.
cerastream's own `GstDeviceMonitor` DOES watch add/remove but the production
engine wires it to a `NullSink`, so the engine emits no device-change IPC push
today — CeraUI's `/dev` watch is the live trigger.

**The rebuild prefers the engine probe but never LOSES a removal to it.**
`refreshSourcesForHotplug(observed)` first re-fetches the AUTHORITATIVE engine
`list-devices` (idle-safe short-lived probe) so the correct engine kind labels
(e.g. `mjpeg`) are preserved — the local v4l2 scan's display-name heuristic is
still not what feeds `sources` on the happy path. But that probe is a SECOND,
separately-fallible round-trip, and `tryRefreshEngineDeviceCache` deliberately
RETAINS the last-known cache when it throws (a transient outage must not erase
the device list). For a REMOVAL that retention is exactly wrong: it rebroadcasts
the device the operator just unplugged as still available until some later poll's
probe happens to answer — observed live on a board as a stale, still-selectable
source row that self-corrected only after ~a minute. So a FAILING probe now hands
over to `applyObservedDevicesAndBroadcast(observed)`, applying the list the
registry's own scan already proved current. The engine-fetch path itself is
unweakened — retain-on-failure is still its contract for every caller that has no
independent observation (`main.ts` boot seed, `engine-reconnect.ts` heal). Do NOT
"simplify" the hotplug path back to a bare `refreshAndBroadcastSources()`.

**On the hotplug path the OBSERVED set is authoritative for MEMBERSHIP; the probe
supplies METADATA only.** A probe that answers is not the same as a probe that is
right. Its `list-devices` reflects whatever the engine could enumerate at the
moment it was asked, and a just-replugged USB device the kernel has not finished
re-enumerating is truthfully ABSENT from a successful answer. Overwriting the
cache with that reply hid a device the registry's own scan had already proved
present — confirmed live: a RØDE HDMI-to-USB-C came back at the kernel level but
its row stayed `lost:true`, and because `lost` is never explicitly cleared (a live
row simply wins) and the registry only re-pokes on a device-SET *change*, the row
stayed stuck rather than self-correcting. This is the mirror of the probe-FAILURE
case above and needed its own fix: `mergeObservedWithProbe(observed, probed)`
(`sources.ts`) now takes video membership from `observed` and metadata from
`probed` — a probe entry matching an observed `input_id` wins outright (typed
kind, caps, `stable_id` all survive), a video device the probe never mentions
keeps its observed row instead of vanishing, and a video device the probe still
lists but the scan no longer sees is dropped. NON-video entries follow the probe
verbatim: the observed list's audio rows are in CeraUI's own `audio:<id>`
namespace, not the engine's, and `buildSources` overlays video only. The
`engineAudioDeviceCache` is still refreshed from the probe on this path — it is
the one cache the local scan cannot populate.

**A SIGNAL change is invisible to every hotplug detector, so it gets its own
tick.** All three triggers above — `fs.watch` on `/dev`, the 2 s poll's
device-SET comparison, and the boot/reconnect seeds — key on a device
APPEARING or DISAPPEARING. A capture device that stops or starts carrying a
usable picture does neither: same node, same `input_id`, same place in the set.
Confirmed live on a Rock 5B+ whose HDMI-RX answered `VIDIOC_QUERY_DV_TIMINGS`
with `ENOLINK` for the ~6 s its link spent retraining (`dmesg`:
`hdmirx_query_dv_timings port has no link!` ×3 → `hdmirx_phy_register_write
wait cr write done failed!` ×15 → `signal lock ok` → `New format:
1920x1080p59.94`). cerastream drops a signal-less receiver's degenerate range
caps entirely, so `fromEngineDevice` stamped `signal: 'absent'` from that
retraining answer — and 45 minutes later the engine's `list-devices` reported
`1920x1080 @ 60000/1001` while the UI still read "No signal", because nothing
had asked it again. While IDLE nothing can: `listDevicesIfActive()` returns
`null` with no live control session, so the registry's own poll is the local
v4l2 scan, whose output is byte-identical every tick forever.

`recheckSourceSignals(observed)` (`sources.ts`), fired by the registry's
`onSignalRecheck` on a `VIDEO_SIGNAL_RECHECK_INTERVAL_MS` (5 s) interval, is the
re-poke that closes it. It is device-agnostic BY CONSTRUCTION — no driver name,
no controller string, no HDMI special case anywhere in the path; it re-reads
whatever the engine's `VIDIOC_QUERY_DV_TIMINGS` result projected into `caps[]`,
so any device whose engine-reported caps change is picked up identically. It
reuses `refreshSourcesForHotplug`'s membership rule, metadata rule and
generation fence verbatim, with THREE deliberate divergences:

- **A probe that says nothing changes nothing.** A hotplug tick MUST fall back
  to `observed` (it holds a detected removal the retained cache would mask);
  this tick holds no detected transition at all, so falling back would
  republish the scan's coarse guess over the engine's last real answer for no
  reason. An unreachable engine simply leaves the last-known view standing.
- **It broadcasts only on change** (`broadcastSourcesIfChanged`), so `sources`
  keeps its documented on-change cadence instead of pushing an identical
  snapshot to every client every 5 s.
- **A tick that finds one already in flight YIELDS** (`signalRecheckInFlight`).
  This is the one caller that fires unconditionally on a fixed interval, so it
  is the one that can supersede ITSELF: a probe slower than the 5 s interval is
  fenced out by the very next tick, whose probe is fenced out by the one after
  it, and the loop publishes nothing for as long as the engine stays slow. An
  enumeration is exactly what gets slow when a receiver loses its link (the
  kernel re-runs `VIDIOC_QUERY_DV_TIMINGS` against a retraining PHY), so the
  direction this tick exists to report is the direction that starves it. Do NOT
  "simplify" this away by leaning on the generation fence — the fence orders
  DIFFERENT views, and two consecutive ticks of the same periodic loop are not
  that.

While STREAMING this tick is redundant-but-harmless: a live control session
makes `getEngineDevices()` engine-backed, so a signal change DOES alter the
device-SET serialization and the ordinary hotplug trigger already fires. Both
paths commit the same engine-authored rows, so they cannot disagree.
Coverage: `tests/hdmi-signal-recheck.test.ts`.

**Overlapping hotplug refreshes are ordered by a generation fence.** Each
`onDevicesChanged` starts its own probe, so an unplug and a replug moments apart
run two round-trips concurrently and the OLDER one can answer LAST — republishing
the world it asked about over the newer, correct view. `refreshSourcesForHotplug`
therefore takes a monotonic `hotplugRefreshGeneration` ticket before probing and
drops its result (no cache write, no broadcast, on BOTH the success and the
observed-fallback branch) if a newer refresh has since started. The counter is
deliberately NOT reset by `resetEngineDeviceCache()` — a superseded probe must
stay superseded. This is why the probe round-trip (`probeEngineDevices`) is split
from the cache write (`commitEngineDevices`): the fence has to be checked between
them. `tryRefreshEngineDeviceCache` is the unchanged probe+commit composition for
every caller that has no ordering concern.

**Staying PRESENT is not the same as staying ITSELF — an observed row falls back
to the engine's LAST ANSWER before it falls back to the scan's guess.** The
fallback is id-safe: `buildDeviceList()` keys the fallback scan `/dev/<card>`,
byte-identical to the engine's own `input_id` (verified on a real Rock 5B+:
cerastream reports `/dev/video0` + `/dev/video1`, and de-dupes the RØDE's two
nodes exactly as the scan does), so a fallback row can never split into a
duplicate or orphan a persisted `config.source`. What the scan CANNOT supply is
`kind`: `deriveKind()` guesses it from the card name, and for a UVC dongle named
`RØDE HDMI to USB-C: RØDE HDMI` the guess is `usb` — which bridges to NO
pipeline. This was previously written off as a bounded cosmetic degradation; it
is not. An unbridged row is DROPPED by `buildSources` (no capture row) and is
simultaneously live enough to suppress its own `lost` row, so its coarse slot
renders as **"USB MJPEG · not connected"** — a device that is physically present,
enumerated, and named, reported as absent under a generic label. And the same
"nothing re-pokes a stable device set" fact that made the #215 bug permanent
makes this one permanent too. Confirmed live and reproduced byte-for-byte from
the board's own `list-devices` + `/sys/class/video4linux/*/name` payloads.

`lastEngineVideoDevices` (`sources.ts`) is the fix: the last ENGINE-AUTHORED row
per `input_id`, recorded in `probeEngineDevices` and monotonic (a device leaving
the list must not erase what the engine said about it — the whole case is a
device that left and came back). A video device the probe omits, on BOTH the
merge path and the #214 probe-failure path, is restored from it.
It is **guarded by display name, not `input_id` alone**: the kernel recycles node
paths, and inheriting an identity is worse than showing a coarse one. Both lists
read the name from the same kernel string (byte-identical on the bug hardware),
so an equal name is real evidence of the same device and an unequal one leaves
the observation untouched. `resetEngineDeviceCache()` clears the map.

**What it restores is IDENTITY (`kind` + `stable_id`) — never the remembered
`caps` or `signal`.** Restoring the whole remembered row was the second half of
the latch above, in the other direction: a capture input that LOSES its signal
and drops out of `list-devices` had its last locked answer re-asserted on every
tick, so the payload never changed, `broadcastSourcesIfChanged` correctly stayed
silent, and an already-open UI kept rendering a live 1080p59.94 source for an
unplugged cable — indefinitely, because nothing else re-pokes a stable device
set. `kind`/`stable_id` are properties of the HARDWARE (and `kind` is the whole
point of the memory — a `usb` guess bridges to no pipeline); `caps` and the
`signal` projected from them are one probe's reading of what the cable was
carrying when it was asked. This is the same provenance rule `fromEngineDevice`
states: only the engine's own answer authors a verdict, so a row the engine did
not confirm THIS time carries no caps because nothing probed it — which reads
`unknown` (no badge, no modes), never a remembered `present`. Do NOT widen the
restore back to a whole-row `{...remembered}` copy.

**Staying ITSELF is not the same as keeping its NODE PATH, and the persisted id
must follow the hardware.** A replug WHILE STREAMING cannot reuse the old node —
the engine still holds it open — so the device returns on a new one. Confirmed on
a Rock 5B+: `config.source` stayed `/dev/video1` while the RØDE came back as
`/dev/video2`, and `last_seen_devices` carried BOTH ids under one `stableId`. Every
consumer matches that id LITERALLY against a `sources[]` row, so ONE stale string
stranded four operator surfaces at once (stuck lost-alert, raw `/dev/videoN`
labels, dead audio meter, vanished Switch card). Two fixes, both in `sources.ts`:

- **`liveStableIds` is recorded only AFTER the bridge check.** Todo 34 drops a
  remembered `lost` row when a live successor shares its stable identity — but "the
  successor owns the row" is false for a device whose kind bridges to no pipeline,
  because it renders NO row. Recording it earlier suppressed the `lost` row for a
  successor that never appeared, so the device vanished from the list entirely.
  Keeping the `lost` row is the honest floor.
- **`reconcileConfiguredSourceIdentity(sources)`** (called from `broadcastSources`)
  PERSISTS the migration: it runs the same `resolveSourceIdentity` rule PR #197
  already used read-only at the routing choke point, writes the successor to
  `config.source` (and to `selected_video_input` when that field still names the
  old id), `saveConfig()`s, and rebroadcasts `config`. `broadcastSources` rebuilds
  the payload after a migration because `config.source` feeds
  `collectLostCandidates`. Match is by STABLE IDENTITY only — a different device
  that merely took the freed slot is never adopted, and a true unplug (no
  successor) keeps its `lost` row untouched.

The retired id is ALSO published on the wire as `previousIds` on the successor's
capture row (`captureSourceSchema`, additive-optional), because the engine keeps
reporting the node it opened at start: without the alias every consumer holding the
old id resolves to nothing and reports a live device lost. Frontend half:
`apps/frontend/AGENTS.md` → "Re-enumeration is MOVED, not GONE".

The audio twin is `reconcileConfiguredAudioIdentity()` (`audio.ts`) — `config.asrc`
stores a kernel-assigned ALSA card key and the kernel recycles those identically.
It is backed by `rememberedAudioIdentities` (monotonic `asrc → stable_id`, the
mirror of `lastEngineVideoDevices`) and runs BEFORE the `reportActiveAudioSource`
lost verdict, because a card that only changed id is not lost and reporting it lost
raises a persistent alert nothing can clear.

The specific USB-as-HDMI mislabel this seam was originally warned about still
cannot recur (`deriveKind` tests usb/uvc BEFORE hdmi), and a device seen for the
FIRST time while cerastream is unreachable still has no memory to draw on — it
keeps the coarse fallback, which is the accepted degradation.
Coverage: `tests/source-identity-renumber.test.ts` + `tests/audio-identity-renumber.test.ts`.
Coverage: `tests/devices.test.ts` (`fires onDevicesChanged on a hotplug set
change…` + `hands onDevicesChanged the list this scan observed…`) and
`tests/lost-device-retention.test.ts` (`refreshSourcesForHotplug — a failing
engine probe never masks a removal` + `refreshSourcesForHotplug — a stale
successful probe never masks the observed set`, which covers the replug-vs-empty-
probe case, the removal-vs-pre-removal-probe case, metadata preference, the audio
cache, and both out-of-order fences).

## LIBUVC-HELD DEVICES — THE `/dev` SCAN IS NOT ALWAYS A PRESENCE ORACLE [EXISTS]

Everything above rests on one premise: the device registry's own
`/sys/class/video4linux` scan truthfully answers "is this device plugged in".
For ONE family of capture devices that premise is simply false, and CeraUI kept
reporting a working camera as disconnected because of it.

`libuvch264src` never opens a v4l2 node. It drives its camera through **libuvc**,
i.e. through **usbfs**, which unbinds the kernel `uvcvideo` driver from the USB
interface for the whole session. So while the engine is streaming or previewing
such a camera, `/dev/videoN` is **legitimately gone** — and on release the device
comes back under a DIFFERENT number. Absence from `/dev` is what a *working*
libuvc capture looks like.

cerastream already knows this about itself: a leg whose resolved `InputKind` is
`UvcH264`/`UvcH265` records the device it holds, and both `capture_rebind_tick`
and `list_devices` union that set over the v4l2 registry (cerastream PR #84 for
the streaming leg, PR #86 for the idle preview). Its `list-devices` is therefore
**correct** — proven live, retaining `/dev/video1` for a whole session.

CeraUI has a **second, independent** presence signal that had no such notion, and
`mergeObservedWithProbe` takes video membership from it. So the engine answered
"present, I am holding it", the local scan said "no such node", membership won,
and the row was dropped — surfacing as a `Lost` / "Device disconnected" badge on
a camera whose preview was live on screen at that moment.

- **`modules/streaming/held-devices.ts` `releasesV4l2Node(kind)`** is the
  CeraUI-side mirror, scoped exactly like the engine's rule: on the resolved
  device **KIND** (`uvc_h264` / `uvc_h265` — the two kinds
  `DEVICE_KIND_TO_PIPELINE_ID` bridges to `libuvch264`), **never** on a vendor
  id, product id, serial, or display name. Every UVC-H.264/H.265 camera behaves
  this way and no other kind does.
- **A probe-listed device of such a kind survives the membership filter.** Every
  other kind keeps the byte-identical observation-wins rule, including the two
  cases that rule exists for (a failing probe must not mask a removal; a stale
  probe must not mask a replug) — this only ever ADDS a device the engine
  positively vouches for.
- **A real unplug still reports lost.** An unplugged camera is in neither the
  engine's v4l2 registry nor its held set, so it is absent from the probe too.
  The exemption cannot manufacture a device the engine did not name.

Do NOT try to fix this class of symptom by suppressing the `lost` badge, by
special-casing a model, or by having CeraUI track preview/stream state to guess
at a hold — the engine already tracks the hold authoritatively and reports it;
CeraUI's job is only to stop overruling that answer with a scan that cannot see
the device. Coverage: `tests/source-renumber-dedup.test.ts`.

## A DEBOUNCE IS NOT AN ABSENCE GRACE [EXISTS]

The section above fixes the HOLD. The same rebind has a second half — the
RELEASE — and nothing in the chain absorbed it.

Measured on a Rock 5B+ (2026-07-30, DJI Osmo Pocket 3 `2ca3:0023` on `usb5`/EHCI)
by polling cerastream's `list-devices` and the kernel together across one
ordinary preview open/close. The rebind is emphatically NOT a device reset:
`devnum` never changes, only interfaces `1.0`/`1.1` move `uvcvideo → usbfs →
uvcvideo`, the camera's ALSA card stays bound with its PCM node inode unchanged,
and `/proc/asound/card5/pcm0c/sub0/status` reads `RUNNING` throughout. During the
HOLD, `held_devices.rs` reports `/dev/video1` with its `physical_group_id`
intact — no UI impact, exactly as designed. **On RELEASE the engine drops the
held record BEFORE it rediscovers the re-registered node**: `list-devices`
answers with 2 devices instead of 3 while the kernel node already exists again.
Measured at ≈400 ms, bounded above by the 2.0 s close→node-back re-registration,
and observed firing spontaneously twice more within 30 s of the preview closing —
so this is hit in ordinary operation, not only on operator action.

**Every existing defence in the chain is an EVENT DEBOUNCE, and that is a
different thing.** The `/dev` watch waits 200 ms for quiet before re-reading, the
audio scan 500 ms, cerastream's registry debounces adds/removes by 250 ms. Those
are all *wait-for-quiet-before-re-reading*. None of them is
*wait-before-believing-it-is-gone*, so a hole of any length propagates straight
to a verdict. Auto-audio resolution had no hysteresis at all
(`auto-audio.ts`), and `lifecycle-indicators.ts` still flips `bad` the instant a
selected id is missing from a non-empty scan.

The operator-visible result was a derived-state artifact, not an audio fault.
With `config.asrc = "Auto"`, `resolveAutoAsrcFromLiveState()` looks the VIDEO
source up first and rule 5 joins it to its own card on `physical_group_id`. In
the window that join has nothing to match, so Auto resolved
`no-same-device-audio`, `resolveMeterPreference` returned `null`,
`isMeterPreferenceDevicePresent` returned `false`, and the meter rendered
**"Meter unavailable · No audio device"** for a microphone that was bound,
enumerated and streaming into cerastream the entire time.

`modules/streaming/capture-presence.ts` `resolveSelectedSourceWithGrace()` is the
hysteresis, and it is deliberately NARROW — it is read by
`resolveAutoAsrcFromLiveState()` and nothing else. The `sources` broadcast, the
`lost` row, `resolveSourceRouting`, and the picker are all untouched.

- **It is hysteresis on the VERDICT, not on the sampling.** Distinct from every
  debounce above by construction: nothing here changes when the device list is
  read or what it contains, only how long a degraded view is tolerated before it
  is believed.
- **There are TWO windows, and they are not interchangeable.** The board proved
  why. `CAPTURE_ABSENCE_GRACE_MS` (2 000 ms) governs a row that is ABSENT or
  `lost` — a real presence question, kept short because a genuine unplug must not
  be held longer than the transient it absorbs. `CAPTURE_METADATA_GRACE_MS`
  governs a row that is PRESENT but has lost its `physical_group_id`, which is
  NOT a presence claim at all: CeraUI's own scan sees the node and the engine
  listed it, so holding the remembered join key there **cannot** mask a
  device-gone failure — the row's own presence is the positive evidence.
- **`CAPTURE_METADATA_GRACE_MS` is DERIVED, not chosen**:
  `VIDEO_SIGNAL_RECHECK_INTERVAL_MS + 1 500`. Nothing refills that field until
  the next engine-authored commit, and while idle the only thing that produces
  one is the `recheckSourceSignals` tick — so CeraUI's VIEW can stay
  under-identified for a full recheck interval even though the engine's own hole
  was ≈400 ms. Measured across three preview cycles on the board: 434 ms, 258 ms
  and **5 077 ms**, the last being one interval plus a 77 ms probe round-trip. A
  window sized from the engine-side measurement alone (2 000 ms) demonstrably
  broke through on that third cycle — do not "simplify" the two constants back
  into one, and do not re-derive this one from the engine-side gap.
- **The clock starts at the FIRST DEGRADED OBSERVATION, never at the last healthy
  one.** Our knowledge of the device is refreshed on someone else's cadence (the
  5 s signal recheck, a hotplug tick), so a window measured from the memory's
  AGE would be expired in steady state and would never fire when it is needed.
  "How long we have tolerated a degraded view" is the quantity that matters.
  Do NOT rewrite this as a staleness check on the remembered value.
- **"Is the row there" is NOT the question.** `degradationOf()` answers `absent`
  (row gone, or a `lost` placeholder) or `under-identified` (row present, join key
  gone). The second is the one the window actually produces on this board — when
  the `/dev` scan sees the node return first, the hotplug merge restores the row
  through `withKnownEngineMetadata`, which restores durable IDENTITY
  (`kind`/`stable_id`) and deliberately refuses to re-assert a same-moment
  topology relation. That refusal is correct and must not be "fixed"; the row is
  simply useless to rule 5, and the grace is what covers it.
- **Bounded and self-clearing, with no renewal path.** After the applicable window
  of UNINTERRUPTED degradation the memory is dropped and the live view is
  reported verbatim — a true unplug reads exactly as it did before this module
  existed. Only a genuinely healthy observation resets the run, so polling the
  window at the meter's 5 Hz cadence extends nothing.
- **Stable identity OUTRANKS the node path, in BOTH directions.** Two rows that
  both carry a `stableId` settle the question outright: equal proves the renumber
  (a libuvc camera renumbers on every cycle — the very cycle this exists for),
  UNEQUAL proves a different device took the freed node and the memory is dropped
  on the spot. A borrowed `physical_group_id` must never bind Auto audio to the
  microphone of a device the operator is no longer pointing at. Only when the
  evidence runs out does the node path decide.

Coverage: `tests/capture-absence-grace.test.ts` — the real live-state resolver
driven across the window with both degraded shapes, plus the negative controls
that matter: a sustained absence resolving honestly again, a repeatedly-observed
absence failing to renew the window, the boundary millisecond, a `lost` row, a
substituted device, a renumber, and the coarse/unset selections.

## FLOW-STICKY SHARED-CLIENT STEERING [PARTIAL — backend complete; image carrier + board drill pending]

`modules/network/uplink-steering/` is the desired-state controller for hotspot and
Ethernet `shared-lan` client traffic. It owns only `inet ceralive_share`, the
priority-110 namespaced fwmark rules, and private route tables 30000–95535. The
image's `inet ceralive_ingest_fw` table (input hook priority -10) is foreign and is
never named by generated rule text. The carrier effects are isolated in
`modules/network/uplink-sharing.ts`: fsynced temp → `nft --check` → atomic rename
→ systemd start/reload, with prior-file reload on failure.

**The invariant in one sentence: only forwarded client-zone traffic is steered or
NATed, and only the client band is ever capped.** Everything below is how that is
made structural rather than intentional. Every mode transition that can create or
retire a client zone — station / hotspot / hybrid, and the Ethernet `uplink` /
`shared-lan` role — runs under the one permanent-MAC adapter lock described in
EVERY WIFI MUTATION SHARES ONE ADAPTER LOCK, so a zone can never be registered
against a half-applied adapter state.

**Client provenance is structural.** New-flow selection, conntrack mark restore,
and masquerade all require a positive registered client-zone `iifname`; NAT also
requires the zone prefix and the namespaced conntrack mark. There is no output
hook. A locally-originated packet therefore cannot enter this path even when its
source is inside a client prefix, and a WAN reply never restores the client flow's
mark and recirculates out the WAN.

**Marks are physical-identity keyed.** The high byte `0xca` proves client-zone
provenance, the next 16 bits select the uplink, and the low byte is preserved.
The fixed 10000-bucket verdict map uses largest-remainder apportionment. Reorder,
add/remove, and reweight never change a surviving mark, so established flows keep
their original route while only new flows see the new weights.

**The emitted nft syntax targets Debian bookworm's nftables 1.0.6.** A set
expression may read only one runtime mark when applying a bitwise OR, so save and
restore lift the known uplink value into a literal per-uplink statement; combining
`meta mark` and `ct mark` dynamically is forbidden even though newer nftables parses
it. Whole-table replacement is `add table` then `delete table`, never the newer
`destroy table`. Both rules are production compatibility constraints, not CI
workarounds; the packet low byte and conntrack high 24 bits remain byte-identical.

**A hard-down is three phases:** publish a transition ruleset excluding the mark
from new-flow selection while retaining its NAT/route support → delete conntrack
entries carrying exactly that mark → remove route support and publish the final
ruleset. The transient `uplink-flows-reset {iface,linkId}` follows successful
route removal and is never hydrated. `uplink-steering` is persistent and carries
the shared `@ceraui/rpc` typed availability/refusal state.

The coordinator is single-flight, re-reads the latest model before every apply,
skips byte-identical state, and retries at 100/500 ms only. On process restart it
inventories its priority-110 rules, publishes the latest model first, then flushes
and removes stale support. Any overlap, mark collision, foreign priority owner,
missing route, nft failure, or rollback failure is fail-soft and surfaces
`steering_unavailable`; it never blocks the already-bound WS server.

The CeraUI half is complete and kernel-netns tested. It cannot activate on a fleet
image until image-building todo 12 ships `ceralive-share.service`, its teardown
script, nftables/conntrack packages, and the CeraUI unit ordering. Full contract and
hardware gate: [`../../docs/UPLINK_STEERING.md`](../../docs/UPLINK_STEERING.md).

## STREAMING-FIRST UPLINK SHAPING [PARTIAL — backend complete; image backstop + board drill pending]

`modules/network/uplink-shaper/` consumes `readDesiredSteeringState()` as the single
authority for which uplinks currently carry shared client traffic. Its explicit
idle/streaming machine is lifecycle-edge driven: stream start installs a conservative
bootstrap client cap before telemetry, stale telemetry holds, and stream stop removes
ceilings without waiting for telemetry absence.

The streaming hierarchy is root `prio`: tc band 1 is the design's zero-indexed
local band 0 and carries only `fq_codel`; tc band 2 is selected by the steering
`CLIENT_FLOW` fwmark/mask and alone receives CAKE `bandwidth`, or HTB `rate == ceil`
plus an `fq_codel` leaf when the bounded CAKE child apply is refused. AIMD uses RTT
inflation, NAK delta, and sustained client-child backlog on a 5 s cadence. All
constants are in `SHAPER_CONFIG`; current `bitrate_bps` is never treated as capacity.

Root ownership is fail-closed: recognized kernel defaults may be recorded and
replaced under reserved handle `ca00:`; that handle is restart-idempotent; a custom
foreign root produces `shaper_unavailable` before any mutation. Removed interfaces
and module shutdown restore their recorded roots. The persistent `uplink-shaper`
wire state reports the realized CAKE/HTB algorithm or `priorityDegraded: true` while
steering and sharing continue independently. Full command, ownership, controller,
failure, and netns proof is in [`../../docs/UPLINK_SHAPING.md`](../../docs/UPLINK_SHAPING.md).

## …AND THE TWO NAT LAYERS ARE WATCHED, NEVER ARBITRATED [EXISTS]

`modules/network/sharing-diag/` is the read-only coexistence diagnostic for the
two masquerade layers the shared-client path deliberately runs at once:
NetworkManager's own shared-mode NAT (the working FLOOR, which keeps the hotspot
usable even while the steering layer is down or degraded) and CeraUI's
per-uplink, `CLIENT_FLOW`-scoped NAT inside `inet ceralive_share`. It is the
sibling of `policy-route-check.ts` and inherits its discipline verbatim: an
indeterminate reading is withheld, never guessed, and the strongest verdict the
whole module can reach is `degraded` — nothing here gates a stream, an
interface, a bond or a mutation.

**IT IS READ-ONLY BY CONSTRUCTION.** Four readers, no writer: the NM config
files, `ip rule show`, `nft list ruleset`, and an `nmcli` enumeration of the
ACTIVE `ipv4.method shared` profiles. There is no apply, no rollback and no
teardown anywhere in the module, and a failed read degrades exactly ONE check.

**FOUR CHECKS, EACH AN EXPLICIT TRI-STATE** (`ok` | `degraded` | `unknown`), on
the `sharing_diag` broadcast (`@ceraui/rpc` `sharingDiagSchema`). `unknown` is
EMITTED, never expressed as an omitted field — the consumer merge preserves an
omitted optional, so a raise-only check is the `policy_route_missing` latch
again. The rollup is `degraded` ≻ `unknown` ≻ `ok`, so it can never claim `ok`
while a check is withheld.

| Check | `degraded` when | Withheld when |
|---|---|---|
| `firewallBackend` | no explicit `firewall-backend` pin (`firewall_backend_unpinned`) or an explicit non-`nftables` one (`firewall_backend_mismatch`) | no NM config file could be read |
| `steeringRules` | an owned fwmark rule runs at or before source routing (`steering_rule_shadows_source_route`) or off `FWMARK_RULE_PRIORITY` (`steering_rule_priority_drift`) | `ip rule show` unreadable or unparseable |
| `sharedNat` | an active shared prefix has no NM masquerade (`shared_nat_missing`) or more than one (`shared_nat_duplicated`) | ruleset unreadable, NM unenumerable, or a shared interface holds no address yet |
| `foreignTables` | `ceralive_ingest_fw` moved its declared hook/priority, or now carries CeraLive client-flow rules (`foreign_table_modified`) | ruleset unreadable, or the ingest firewall is not installed |

Six decisions carry weight, and each was the tempting wrong answer first:

- **A PRE-PIN IMAGE IS `degraded`, NEVER A MISMATCH AND NEVER AN ERROR.** The
  `firewall-backend=nftables` pin ships in the image (plan todo 12), so a device
  that predates it is a normal, expected state — it simply cannot be confirmed.
  It is also deliberately NOT resolved to NetworkManager's compiled-in default:
  what that default is depends on the daemon's build and on whether it found an
  `nft` binary at start-up, so substituting one would be a claim this reader
  cannot support.
- **THE SHARED PREFIX IS THE INTERFACE'S LIVE ADDRESS, never `10.42.0.0/24`.**
  NetworkManager picks a shared subnet itself unless `ipv4.addresses` is set, so
  the PROFILE usually states none — the profile answers WHICH interface is
  shared, and the netif map answers what prefix it actually leased. An interface
  that has not leased its gateway yet is INDETERMINATE, never missing NAT.
- **THE FLOOR IS IDENTIFIED BY TABLE PROVENANCE.** `ceralive_share` masquerades
  the same prefix by design, so a masquerade rule inside it can never stand in
  for NM's floor — the reader excludes the owned table before counting. A test
  removes NM's table and asserts the floor still reports missing.
- **THE ORDERING FLOOR IS THE HIGHER OF THE CONSTANT AND THE OBSERVED RULES.**
  `SOURCE_ROUTE_RULE_PRIORITY` is the contract, but an image whose own source
  rules moved must still be protected, so a steering rule legal against the
  constant alone and yet ahead of the real source rules is still a shadow.
- **AN ABSENT `ceralive_ingest_fw` IS `unknown`, NOT `degraded`.** The ingest
  gateway is operator-disable-able and is not provisioned on every image, so its
  absence is a statement about the IMAGE rather than evidence that the steering
  layer touched it. Only an installed table that no longer matches
  `FOREIGN_NFT_TABLES`' declared hooks — or that now carries client-flow rules —
  is degraded.
- **EVERY CONSTANT IS READ, NEVER RE-DERIVED.** `FWMARK_RULE_PRIORITY`,
  `SOURCE_ROUTE_RULE_PRIORITY`, `SHARE_TABLE`, `FOREIGN_NFT_TABLES`,
  `CLIENT_FLOW_NAMESPACE` and `UPLINK_MARK_MASK` all come from
  `uplink-steering/contracts.ts`, and the provenance-byte regex is BUILT from
  `CLIENT_FLOW_NAMESPACE` so a change to the mark layout cannot leave this reader
  hunting for a marker the steering layer no longer writes.

**Its `ip rule` reader is deliberately NOT a re-use of `route-policy.ts`.**
Those readers are scoped to `FWMARK_RULE_PRIORITY` because their job is to find
the rules the steering layer OWNS; this one must see a steering rule that has
DRIFTED off that priority, which is exactly the fault it exists to report. The
line shapes are the same and are shared by regex shape, not by import.

**Cadence + spawn class.** Its own `SHARING_DIAG_INTERVAL_MS` (30 s) `unref`'d
interval, `isRealDevice()`-gated, wired at boot through
`guardNonCritical("sharing-diag", …)`. `nft list ruleset` is registered
separately in `SPAWN_POLICY` as `network.nftRead` (**bounded-probe**), distinct
from the steering layer's `network.nft` (**bounded-command**) write: a read on
its own slow cadence has neither that site's caller nor its failure semantics,
and collapsing the two would let a future write inherit a read's justification.

**Wire registration is all four steps, deliberately.** Schema in
`packages/rpc/src/schemas/network.schema.ts`, event re-exported from
`rpc/events.ts`, a `case "sharing_diag"` + state slot + `getSharingDiag()` in the
frontend `subscriptions.svelte.ts`, and post-login hydration on the PRODUCTION
path — `buildInitialStatus()` plus an explicit emission in
`rpc/adapter.ts::sendInitialStatusToClient`, NOT the legacy `modules/ui/status.ts`
relay enumeration. The signal broadcasts on CHANGE only and its slowest input is
a 30 s poll, so a missed hydration leaves a fresh browser on the pre-check
all-`unknown` state indefinitely; `tests/sharing-diag-initial-push.test.ts` pins
both halves for the same reason `cpu-initial-push.test.ts` does.

**`checkedAt` is excluded from the broadcast change key**, or an identical
verdict would re-broadcast on every tick; the cached status still carries the
fresh stamp.

Coverage: `tests/sharing-diag.test.ts` (the verdict table — healthy, shadowed,
priority drift, duplicated NAT, missing NAT, missing backend pin,
foreign-table-modified, and every ambiguous arm, plus the nft reader's priority
spellings and its null contract), `tests/sharing-diag-ordering.test.ts` (the band
ordering, built ENTIRELY from the two constants — that file contains no priority
literal), `tests/sharing-diag-initial-push.test.ts` (both hydration halves and the
end-to-end shadowed-device wire proof), and the frontend half
`apps/frontend/src/tests/sharing-diag-ingestion.test.ts`.

**Honest status:** every fixture models captured device output; no verdict has
been produced against a real board's `nft list ruleset`. The image-side
`firewall-backend=nftables` pin this diagnostic checks for ships in plan todo 12,
so on today's images the `firewallBackend` check is expected to read
`firewall_backend_unpinned` — that is the tri-state tolerance working, not a
finding.

## BROADCAST EVENTS

### Per-uplink health (`uplinks`) [EXISTS]

`modules/network/uplink-health/` owns the client-steering health verdict. Its one
exported config object fixes the 5 s cadence, three-failure down threshold,
five-success recovery threshold, 15 s hold-down and three-probe concurrency cap.
While streaming, interfaces present in SRTLA telemetry receive zero active probes:
RTT/NAK/staleness can degrade them, while only definitive carrier/route/disconnect/
expiry evidence removes them from client steering. Captive interception is
`degraded/captive_portal`, never `down`; modem signal is not an input.

The engine publishes `uplinks` records and `gateways.ts` filters default-route
candidates through their steering eligibility. The engine never edits routes;
`gateways.ts` remains the sole `ip route del default` owner. Post-login hydration
replays the current records immediately.

The backend pushes typed events to all connected clients via `rpc/events.ts`. Each event type carries a monotonic `seq` counter (`Map<string, number>`) that resets to 0 on server restart.

| Event type | Interval | Source |
|------------|----------|--------|
| `netif` | 5 s | `modules/network/network-interfaces.ts` |
| `sharing_diag` | 30 s, on-change + post-login snapshot | `modules/network/sharing-diag/` (real devices only — `isRealDevice()`-gated) |
| `sensors` | 1 s | `modules/system/sensors.ts` |
| `encoder-load` | 2 s | `modules/system/encoder-load.ts` (real devices only — `isRealDevice()`-gated) |
| `fan` | 5 s | `modules/system/fan.ts` (real devices only — `isRealDevice()`-gated) |
| `cpu` | boot + initial-state push | `modules/system/cpu.ts` (core count; NOT gated — every host has CPUs) |
| `gateways` | 2 s | `modules/network/gateways.ts` |
| `modems` | 30 s | `modules/modems/modem-update-loop.ts` |
| `status` | on-change + 5 s | streaming state transitions; carries `linkTelemetry`, `network_ingest`, and the typed `audio_sources` beside legacy `asrcs` |
| `config` | on-change | `setConfig` / `start` / `stop` |
| `wifi` | on-change | WiFi scan / connect / disconnect |
| `relays` | on-change | relay list mutations |
| `acodecs` | on-change | audio codec list changes |
| `pipelines` | on-change | pipeline list changes; each entry carries `requires_gateway` (rtmp/srt) + `audio_kind` (`selectable`/`embedded`/`none`) — **deprecation shim**, see "Device-First Source Model" below |
| `sources` | on-change + post-login snapshot | unified device-first source list (`modules/streaming/sources.ts`), folds pipelines+devices+device_modes into one `StreamSource[]` |
| `capabilities` | post-login snapshot | engine capability contract; carries `transports`, per-device `device_modes` (Tier-2 caps folded from `list-devices`, kbps-normalized bitrate — **deprecation shim**, see below), and `network_embedded_audio` |
| `notifications` | on-demand | user-facing toast events |
| `log` | on-demand | `system.getLog` / `system.getSyslog` — diagnostic journal for download |
| `ping` | 5 s | heartbeat emitter |

### Observable logs (`getLog` / `getSyslog`) [EXISTS]

`system.getLog` (device/application log, defaults to the `ceralive.service` unit)
and `system.getSyslog` (full boot journal) both invoke `modules/system/logs.ts`
`getLog(conn, service?)`, which `journalctl`s the journal, pushes it as a `log`
event the frontend `LogsDialog` turns into a file download, AND returns
`{ name, contents }` so the RPC is a real data source (NOT the former
`{ log: "" }` stub that fired no push). On a dev/CI host there is no systemd
journal, so under `shouldUseMocks()` `getLog` serves the in-memory log ring
buffer (`helpers/logger.ts` `getRecentLogLines`) — a bounded mirror of the same
backend records fed by a Winston `Stream` transport after `redact()` — so the
whole getLog → `log` push → download path is exercisable end-to-end without
hardware (`tests/observable-logs.test.ts`, e2e `logs-dialog.spec.ts`).

`notifications.getPersistent` returns the live persistent set via
`getPersistentNotifications(true)` (not an empty stub). The frontend
NotificationsPanel reads the live `notification` push cache; this RPC is the
pull-equivalent (same data) for any consumer asking for the snapshot directly —
keep it even though the panel does not call it.

### Post-login initial-state push

After a client authenticates, the backend immediately broadcasts a full snapshot of every event type. Clients don't need to wait for the first periodic tick to render.

### Heartbeat emitter

`rpc/events.ts` emits `{ ping: { t: number } }` every 5 s to all connected clients. This lets the frontend detect half-open connections (no ping for ~15 s triggers a reconnect) without relying on TCP keepalive alone.

### Sensor coalescing

High-frequency sensor ticks (1 s) are coalesced before broadcast — only the latest value within a tick window is sent, preventing queue buildup under slow clients.

### Applied-state returns

All RPC setters return `{ success: boolean, applied: <fields> }`. The `applied` object reflects post-clamp, post-validation values actually written to config — not the raw client input. Clients must lock fields to `applied`, not to their intended value.

### Store-and-forward buffering (`status.buffering`)

`CerastreamBackend.handleEvent` (`cerastream-backend.ts`) reads the additive
store-and-forward fields off the cerastream `status` event (cerastream Task 32:
`buffering` / `spooled_bytes` / `data_headroom_bytes` / `disk_warning`) via the
pure `extractBufferingStatus()` and re-broadcasts them on the EXISTING `status`
event bus through `bridge.broadcastBuffering()` — it rides the engine event bus,
NOT the 5-signal `device-stats` channel (S1 lock untouched). `extractBufferingStatus`
returns `null` when the engine does not advertise `buffering` (the capability gate
the HUD honors), so an older engine surfaces no indicator. The wire shape lives in
`@ceraui/rpc/schemas` (`bufferingStatusSchema`, `buffering` on `statusResponseSchema`);
fields are read defensively so a partial frame never throws. Coverage:
`tests/buffering-status.test.ts`.

### srtla link telemetry (`status.linkTelemetry`)

`modules/streaming/link-telemetry.ts` folds `srtla_send`'s per-uplink telemetry
into the existing `status` flow as a `linkTelemetry` field — no new endpoint.
`startStream` passes `--stats-file` (`srtlaStatsFile()` → `/tmp/srtla-send-stats-9000.json`,
the binding's `senderTelemetryPath` convention) and starts the binding's
`watchTelemetry`; the watcher stops when `srtla_send` exits or the stream stops.
`broadcastLinkTelemetryIfChanged` is wired onto the 5 s heartbeat tick and emits
a `status` message only when the payload changes.

Shape (`null` when unavailable):

```ts
linkTelemetry: {
  links: Array<{
    conn_id: string;       // srtla tlm_id, stringified
    iface: string;         // human name from the backend-owned IP list
    rtt_ms: number;        // sender reports 0 (RTT is receiver-side)
    nak_count: number;
    weight_percent: number; // link's normalized share of total selection weight (0-100, active links sum to ~100; lone link = 100). Source: srtla-send-rs src/telemetry_file.rs weight_share_percent
    bytes_sent_total?: number; // CUMULATIVE wire BYTES this uplink sent this session (srtla_send ADR-002). Absent = UNKNOWN.
    stale: boolean;
  }>;
  bytes_sent_total?: number;   // CUMULATIVE wire BYTES the whole bond sent this session. Absent = UNKNOWN.
} | null
```

**`bytes_sent_total` is BYTES and is NOT summed here.** It sits beside
`bitrate_bps` (bits/s, ×8) and carries no multiplication — a count, not a rate.
The bond-level value is **forwarded verbatim** from the sender's own session
accumulator: a link torn down by a SIGHUP IP-list reload leaves `connections[]`
while its bytes stay banked, so summing the live links would make an operator's
"total transferred" run **backwards**. It survives a per-link reconnect and a
backend restart that re-adopts a running stream (the sender owns the counter, not
CeraUI), and restarts at 0 only on a genuinely new stream — `srtla_send` is
spawned once per session, so process lifetime IS session lifetime. Full contract:
`srtla-send-rs/docs/adr/ADR-002-session-bytes-telemetry.md`.

**It reads `undefined` until `@ceralive/srtla-send` is republished**, and that is
expected, not a bug: the pinned binding's Zod reader strips unknown keys, so
`asCumulativeBytes` (which reads the field defensively, like the audio join keys
in `sources.ts`) finds nothing. Absent means UNKNOWN, never zero — the same
convention `bitrate_bps` already uses. Coverage:
`tests/link-telemetry.test.ts` → "cumulative session bytes".

Three observable states: `srtla_send` not running (or no fresh snapshot yet) →
`null`; last read stale/absent while running → cached links flagged `stale: true`;
fresh read → values populated, `stale: false`.

**conn_id → iface mapping is backend-only.** `srtla_send` assigns each link a
stable numeric `tlm_id` in source-IP-file order on first appearance (monotonic,
reset on process restart). CeraUI WROTE that file, so it is the only component
that can map a `conn_id` back to an interface name. `registerSrtlaIpList`
(called from `setSrtlaIpList`) mirrors srtla's assignment exactly so SIGHUP
reloads stay correlated. Do not change `SRTLA_LISTEN_PORT` (9000) without
updating both the spawn site and the stats-file path.

See [`docs/RPC_COMMUNICATION.md`](../../docs/RPC_COMMUNICATION.md) for the full wire-protocol reference.

## STREAMING ENGINE SEAM [EXISTS]

`stream-session-orchestrator.ts` is the sole owner of public start/stop state.
UI, autostart, remote control, and set-profile restarts enter the same synchronous
admission boundary; only one launch can move `idle → starting`, and stop during
start cancels that generation before a later launch can be admitted. The legacy
`is_streaming` flag changes only after the awaited engine start confirms success.
At boot and after an engine reconnect, `reconcileRuntimeState()` subscribes to the
engine's actual status and adopts an engine-held session. Only concordant
`streaming` or `idle` status is authoritative. A successful subscription that sees
no event for 2.5 seconds resolves idle because an active stream emits status every
2 seconds; query/subscription failure, transitional state, or contradictory fields
remain `reconciling`, and late events from a completed probe are fenced. The additive
`status.stream_lifecycle` field exposes `idle | starting | streaming | stopping |
stop_failed | reconciling`; `is_streaming` remains backward compatible.

The launch transaction owns rollback and phase deadlines. The retry runner starts
the next connect attempt only after rollback resolves, caps attempts and elapsed
time, and exposes a cancellable timer to the same generation. Reporting suppresses
transient toasts only during existing update/restart/boot windows; terminal
failures are never suppressed and carry keyed 10-locale copy plus journal guidance.

The `StreamingBackend` interface (`modules/streaming/streaming-backend.ts`) has
**one** implementation behind the seam (the legacy ceracoder engine is fully
retired):

- `CerastreamBackend` (`cerastream-backend.ts`, Task 32) — the Rust `cerastream`:
  every op is a structured JSON-RPC call over the control socket via the
  `@ceralive/cerastream` npm package (NOT a sibling `link:` — see below). Config
  is the unified config serialized by the binding + pushed over IPC (no INI);
  errors arrive as **structured** Tier-2 events mapped onto Task-7's code table by
  `cerastream-error-mapping.ts` (zero stderr regex on this path); telemetry /
  device / status events are bridged into the existing `status` broadcast, and the
  engine telemetry snapshot is surfaced through the optional `getTelemetry()`
  hook. cerastream is systemd-owned (ADR-0005) — CeraUI connects, never spawns, so
  `start`/`stop` drive the pipeline over IPC. Additive cerastream-only RPC
  passthroughs (`switchInput`, `listDevices`) live on the concrete class, off the
  frozen seam. All effectful collaborators are injected (`CerastreamBackendDeps`)
  so the contract suite drives a real backend against an in-memory fake client.

**Engine selection** is the `engine` flag in `setup.json` (`"cerastream"` only,
schema in `helpers/config-schemas.ts`; a persisted legacy value is coerced to
`"cerastream"` at parse time with one warning — boot never crashes on it). Every
streaming call site still routes through `getStreamingBackend()`
(`streaming-engine.ts`) so a future engine can slot in behind the same seam.

**`@ceralive/cerastream` is a public-npm registry dependency** (`@ceralive` scope on
npmjs.org, pinned to a CalVer version — `2026.6.1` at time of writing) — NOT a
sibling `link:` like srtla and no longer a vendored `file:` tarball (cerastream
ARCHITECTURE §7 / ADR-0002 Decision 13: it ships to CeraUI as a published npm
package, so the backend builds standalone with no sibling checkout).
`tests/cerastream-bindings-skew.test.ts` guards the exact imported surface against
drift on a version bump.

Contract coverage: `tests/streaming-backend-contract.test.ts` runs the
structural contract over the production singleton + the cerastream behavioural
contract, error-mapping, status-bridge, passthroughs, engine-crash, and engine
selection.

## REMOTE CONTROL PLANE [EXISTS]

The remote control plane (v2.0) adds a **second, independent outbound WebSocket** from the device to the cloud platform hub. It does NOT multiplex onto the existing BCRPT relay socket (`modules/remote/remote.ts`) and does NOT touch the proto-v16 relay protocol.

### Architecture

```
modules/identity/index.ts          # initIdentity() — resolves device_id + paired at boot
modules/remote/control-endpoint.ts # resolveControlChannelEndpoint() — reads CERALIVE_CONTROL_HUB_URL (build-time pin)
modules/pairing/paseto-v4.ts       # Ed25519 sign/verify primitives (node:crypto, synchronous)
modules/pairing/device-token.ts    # verifyDeviceControlToken — purpose gate BEFORE claim-shape validation
modules/remote-control/
├── protocol.ts          # THIN re-export of @ceralive/control-protocol (device-tolerant variants + tolerantParse* helpers)
├── channel.ts           # initControlChannel — second outbound WS; exponential backoff; WS-level keepalive ping
├── command-router.ts    # routeCommand — NEVER_REMOTE → unknown → role → self_fencing → streaming dispatch
├── status-relay.ts       # relayStatusToGateway — wired into broadcastMsg; 7 relayable types; per-type seq
├── telemetry-recorder.ts # batched per-link telemetry → `telemetry` status frames (spec §8.1); non-blocking
└── self-fencing.ts      # handleSelfFencingOp / handleSelfFencingConfirm — 30 s watchdog; revertible + non-revertible
```

### Wire schema — shared `@ceralive/control-protocol` package [EXISTS]

`modules/remote-control/protocol.ts` is now a **THIN re-export** of the canonical
`@ceralive/control-protocol` npm package (`@ceralive` scope, pinned to an exact
CalVer version in `apps/backend/package.json`). The package is the single Zod
derivation of the control-channel wire contract
(`openspec/specs/remote-relay-support/spec.md`), consumed identically by BOTH this
device and the cloud hub (`ceralive-platform`) — it replaces the two previously
hand-written, independently-drifting per-repo `protocol.ts` derivations.

- **Device-tolerant posture preserved byte-for-byte.** The package ships an explicit
  `*Strict*` (hub) and `*Tolerant*` (device) variant of every frame/payload that
  differs between the two sides. `protocol.ts` binds each historical un-suffixed
  device name (`CommandSchema`, `StatusSchema`, `FrameSchema`, `AckSchema`,
  `DeliveryAckSchema`, `HandshakeSchema`, `HandshakeDeviceSchema`,
  `HandshakeHubSchema`, `IngestSlotSchema`, `IngestSlotsPayloadSchema`) to the
  DEVICE-TOLERANT variant, so every downstream importer (`channel.ts`,
  `command-router.ts`, `status-relay.ts`, `set-profile.ts`, `ingest-slots.ts`,
  `self-fencing.ts`, `active-profile-reporter.ts`) keeps the exact schema and
  behaviour it had before — no import-site change beyond the re-export. The
  package's un-suffixed alias for a colliding name resolves to the STRICT (hub)
  variant, so the device MUST use the `*Tolerant*` schema (which `protocol.ts` does).
- **`tolerantParse*` helpers** (`tolerantParseFrame`, `tolerantParseCommand`, …,
  `tolerantParseSetProfilePayload`, `parseHandshakeDeviceBody/HubBody`) are
  re-exported alongside so new call sites can name the device-posture parser
  directly.
- **Registry-dep, Rule-D-compatible.** `@ceralive/control-protocol` resolves through
  the package registry identically whether or not the sibling repo is checked out —
  a CalVer registry dep like `@ceralive/cerastream` / `@ceralive/srtla-send`, NOT a
  sibling `link:` or a `../` path. Evolution is **additive-optional forever**: a
  change that would make a currently-optional field required is a new protocol `v`,
  never a package version bump.
- **RC bridge + merge gate.** During the W2/W3 integration bridge the pin is an
  EXACT prerelease (`2026.7.0-rc.1`). `scripts/check-rc-pins.sh` (root script
  `check:rc-pins`, wired into the `build-check.yml` BE job) FAILS the build while any
  `package.json`/`bun.lock` still carries an `-rc.` pin of
  `@ceralive/control-protocol` or `@ceralive/cerastream` — it MUST be swapped for the
  exact stable CalVer before merging to a canonical branch.
- **Contract coverage.** `protocol.export-surface.test.ts` is a regression lock over
  the module's runtime export surface (every symbol + typeof); `protocol.contract.test.ts`
  parses the package-exported §14 fixtures with the device schemas;
  `protocol.frame-exchange.test.ts` is the device half of the frame-exchange contract
  (tolerant accepts every hub-strict-emitted fixture; v1-minimal; unknown-field
  tolerance).

### Key invariants

- **Gate = `canDialControlChannel()`** (`paired && deviceId !== undefined`). An unpaired device or one whose `device_id` is missing never dials the hub.
- **`CERALIVE_CONTROL_HUB_URL`** is the build-time-pinned hub URL. It is NOT operator-configurable and is NOT derived from `custom_provider` or `remote_provider`.
- **Two token audiences** (`purpose: "device-control"` vs `purpose: "relay-config"`). The purpose check runs BEFORE claim-schema validation — a validly-signed relay-config token is rejected by purpose, not by signature failure.
- **Real-device fail-closed (Task 20)** — `verifyDeviceControlToken(token, now, { isRealDevice })` REFUSES the token on a real device (`isRealDevice()` true) when `PASETO_PUBLIC_KEY` is absent: a real device can't verify a signature, so it never accepts the unsigned/opaque path. The key-less unsigned dev path stays available only on dev/mock hosts (`isRealDevice` false, the default). `channel.ts` resolves `isRealDevice()` once at `initControlChannel` and threads it into the default `verifyToken`. Wire format + verification order are unchanged — the gate slots into the existing key-presence branch.
- **Control-token source is the persisted `config.remote_key`** — the default `getControlToken` seam reads the same claim/control credential the pairing claim stored. `resolveAuthToken` still self-verifies it via `verifyToken` (`verifyDeviceControlToken`, purpose + signature) BEFORE presenting it, so a non-device-control or unverifiable token is dropped and the channel falls back to the key-less path; a valid device-control token is presented as `Authorization: Bearer …` on the dial (so the LAN gateway accepts an authenticated socket). Wiring the token source did NOT change the verification contract.
- **Post-pairing reconnect (no reboot)** — `completePairingProcedure`, after a successful claim, calls an idempotent `initIdentity()` + `initControlChannel()` (`reconnectControlChannelAfterClaim`). A freshly claimed device re-resolves identity from the now-persisted `remote_key`/`device_id` and re-dials the control channel WITHOUT a reboot — the boot-time identity had resolved it as unpaired. Both calls are idempotent (`initControlChannel` tears down any prior channel first), so a repeated claim never double-connects.
- **`RELAYABLE_TYPES`** = `[status, config, sensors, netif, modems, device-stats, notifications]`. No auth/token/secret-bearing type is ever in this set. The no-secrets contract test enforces this. **`telemetry` is intentionally NOT in `RELAYABLE_TYPES`** — it is a `STATUS_TYPES` member (protocol.ts) emitted directly over the control channel by the telemetry recorder, not a `broadcastMsg` event. (`STATUS_TYPES` = 8: the 7 relayable broadcast types + `telemetry`.)
- **Telemetry recorder is batched + non-blocking** (`telemetry-recorder.ts`, spec §8.1). It folds `buildLinkTelemetry()` per-link rows into `telemetry` status frames on a size (`DEFAULT_TELEMETRY_MAX_BATCH=30`) or age (`DEFAULT_TELEMETRY_MAX_AGE_MS=10s`) boundary; every tick is synchronous and exception-safe so it never stalls the heartbeat/live loop. It carries NO bitrate (platform owns that) and NO secret. Wired onto the heartbeat in `main.ts` (`startTelemetryRecorder` + `onHeartbeatTick(recordTelemetryTick)`).
- **`self_fencing: true`** is a TOP-LEVEL frame flag, NOT inside payload. Revertible ops emit two result frames (apply + commit/revert). Non-revertible ops do NOT execute until an explicit `self_fencing.confirm` arrives.
- **`modem.reconfig` is readiness-gated ON THE SELF-FENCING ROUTE, not by `cellularReadyMiddleware`.** `routeCommand` intercepts it at the `SELF_FENCING_TYPES_SET` branch, so it never reaches `modemProcedure` and the RPC middleware never sees it — the gate therefore lives in `handleSelfFencingOp` (`isSubsystemReady`, defaulting to `getCellularStack().ready` for that one type). It is checked BEFORE `snapshot`/`apply`, so an initializing stack leaves nothing half-applied and NO watchdog armed, and the refusal (`ok:false, error:"cellular_stack_initializing"`) rides out AFTER the delivery-ack the router already sent — never a silent drop. Adding a new modem-scoped self_fencing op means adding it to `READINESS_GATED_TYPES`; wiring it to the RPC middleware instead would be a no-op. Pinned in `tests/control-modem-reconfig-self-fencing.test.ts`, which also re-proves the untouched wire semantics (ack/de-dup, snapshot-before-mutation, 30 s auto-revert, cid-matching confirm) under BOTH `modem_backend` selections.
- The control channel grants ZERO local UI-client authority — it never calls `addAuthedSocket` and has no import of `modules/remote/remote.ts`.

### Boot wiring order (main.ts)

```
runCritical("config", loadConfig)            # CRITICAL — abort on failure
runCritical("ws-control-server", initServer) # CRITICAL — bind the operator lifeline FIRST
guardNonCritical("identity", initIdentity)            # resolves device_id + paired
guardNonCritical("control-channel", initControlChannel) # gates on canDialControlChannel()
guardNonCritical("pipelines", initEngineConnection)   # streaming engine init + reconnect loop
guardNonCritical("rtmp-ingest", initRTMPIngestStats)  # RTMP bandwidth poller
```

The `pipelines` init is now `initEngineConnection` (`modules/streaming/engine-reconnect.ts`),
NOT the raw `initPipelines`. See ENGINE CONNECTION RESILIENCE below.

## BOOT FAIL-SOFT [EXISTS]

`main.ts` is a top-level-`await` module. S6 hardened its boot chain so a failed
init can no longer brick the device in the field. Two helpers classify every
awaited init (`helpers/boot-guard.ts`):

- **`runCritical(name, fn)`** — config load + WS-control-server bind. A failure is
  logged loudly and re-thrown so the process aborts (systemd restarts cleanly).
  The WS control server is bound **before** any non-critical init — it is the
  operator's only lifeline, so it must come up even when identity, the cloud
  channel, or the engine never do (and even if a non-critical init *hangs*).
- **`guardNonCritical(name, fn)`** — identity, control-channel, pipelines, RTMP
  ingest. A throw/rejection is logged, flags the subsystem on the boot-readiness
  surface (`markBootDegraded`, `modules/system/readiness.ts`), and is swallowed so
  boot continues in a readiness-reduced (degraded-but-up) state.

The degraded flag is surfaced read-only on the local `/api/health` endpoint
(`getLocalObservability().readiness = { degraded, degradedSubsystems }`) — no
remote egress. Contract coverage: `src/main.test.ts`. Do NOT move a non-critical
init ahead of the critical WS-server bind, and do NOT downgrade the config /
WS-bind classifications to fail-soft.

## ENGINE CONNECTION RESILIENCE [EXISTS]

The capability contract is fetched over a SHORT-LIVED probe to the systemd-owned
cerastream control socket (`capabilities.ts` → `defaultFetchEngineCapabilities`:
connect → get-capabilities → close). Before this module that probe was attempted
exactly ONCE at boot (`guardNonCritical("pipelines", initPipelines)`); if cerastream
was not up yet — a real systemd-ordering race / slow engine start — the fallback
ladder served `engineUnavailable`/`engineStarting` and the engine stayed marked
unavailable PERMANENTLY (no retry, no recheck), so the "Streaming engine offline"
banner never cleared until an operator restarted `ceralive.service`.

`modules/streaming/engine-reconnect.ts` (`initEngineConnection`) closes that gap.
It is the boot `pipelines` init now (main.ts) and owns ONE self-rescheduling loop:

- **Bounded boot retry** — the first attempt is awaited (so the pipeline registry is
  populated before `reconcilePersistedPipeline` / the boot sources step read it —
  boot ordering unchanged). If the engine is reachable → return, no loop. Else the
  first backoff steps (~2s, 4s, 8s, 16s → ceiling) are the short exponential backoff
  that resolves a normal engine-not-ready-yet race with no operator action.
- **Periodic background recheck** — once backoff caps at `ENGINE_RECONNECT_MAX_MS`
  (30 s) it is a slow periodic health-recheck that keeps running so a device
  self-heals minutes/hours later. BOUNDED (30 s ceiling, never a tight loop): a
  masked/disabled cerastream just gets a cheap 30 s poll, never hammering.
- **Heal broadcast** — on the unavailable→reachable transition it re-broadcasts
  `capabilities` + `pipelines` + `sources` to already-connected clients (the SAME
  trio the `setMockHardware` RPC uses), so the offline banner clears LIVE with no
  page reload, then SETTLES (stops polling). Settling is gated on the broadcast
  actually completing: a reachable engine whose heal broadcast throws (a transient
  broadcast-collaborator error) does NOT settle — it reschedules under the same
  backoff — so clients are never stranded on the offline banner while the loop
  silently gives up.

Reachability = `getLastCapabilities()?.engineUnavailable === false` (a live snapshot).
It feeds INTO the existing `engine-unavailable`/`engine-starting` capability tier — it
does NOT create a parallel state machine. Backoff mirrors
`modules/remote-control/channel.ts` `backoffDelay` (equal-jitter). All collaborators
are injected (`EngineReconnectDeps`); `settleEngineReconnect()` / `stopEngineReconnect()`
are the test/teardown seams. main.ts threads the dev/e2e mock fetchers via the
`capabilities`/`sources` override bags (same fetchers the boot `initPipelines`/
`refreshAndBroadcastSources` already used) so dev exercises the identical loop.

The `@ceralive/cerastream` client's `ConnectOptions.autoReconnect` does NOT cover
this: it only rescues an already-established connection that later drops and throws
immediately on the first connect failure — useless for a fresh per-fetch probe, and
it emits no "became available" event. Recovery therefore lives backend-side here.

Coverage: `tests/engine-reconnect.test.ts` (boot-retry heal, later out-of-band
reconnect, backoff-ceiling cadence, and the permanently-unavailable case through the
REAL capability ladder — no regression to `engineUnavailable`/`engineStarting`).

## DEVICE TRUTH IS ENFORCED AT THE SAVE PATH, NOT THE DIALOG [EXISTS]

cerastream ADR-0008 §10 settles the contract: a device's per-`media_type` mode
ladder is the ONLY truth, the engine reports it VERBATIM, and "the UI and the save
path may never invent or union". The frontend already honoured it for what it
OFFERS; nothing honoured it for what gets PERSISTED, so a 1080p60 written against a
device whose H.264 ladder tops out at 30 survived on disk, was re-sent on every
start, and failed `not-negotiated` every time with no operator-visible reason.

**The rule lives ONCE, in `@ceraui/rpc` (`capabilities/device-mode-truth.ts`)** —
`evaluateDeviceMode` / `nearestDeliverableMode`, shared verbatim with the frontend
`ValidationAdapter`. An offering the save path would reject is a lie told to the
operator; a save the offering would have disabled is a bypass. Two implementations
of one rule drift, and the #244 defect was exactly that class one layer up. Do NOT
fork a second copy.

**`modules/streaming/device-mode-guard.ts`** is the backend binding of that rule:
it resolves WHICH ladder governs (through `resolveSourceIdentity`, so a persisted
id that went stale across a replug still finds its device) and hands it to the
shared evaluator.

- **SAVE-TIME (`verifySaveDeviceMode`)** — called from `streaming.setConfig`
  (`rpc/procedures/streaming.procedure.ts`) and returning the typed
  `device_mode_unsupported`. Three orderings are load-bearing: it runs BEFORE the
  first config mutation (a refusal leaves disk byte-identical); both axes resolve
  `input.X ?? config.X`, because a half-save is still a full pairing against the
  hardware; and the source checked is the one being SAVED, since validating the
  persisted one waves through exactly the ladder switch that makes the combo
  illegal. It lives at the PROCEDURE, not the dialog, so a direct RPC call is
  covered too.
- **LOAD-TIME (`modules/streaming/persisted-mode-clamp.ts`)** — for the fleet that
  already has a bad pairing on disk. There is no "config load" moment at which this
  can run: `loadConfig()` is at boot, long before `list-devices` answers, and only
  the ladder can judge the pairing. The first moment it is known is the first
  `sources` build, so `reconcilePersistedDeviceMode` hangs off `broadcastSources`
  beside `reconcileConfiguredSourceIdentity`. The clamp is DOWNWARD-biased —
  clamping up would hand the operator a mode they never chose — and both axes come
  from ONE real enumerated mode, so the result is never a synthesised pairing. It
  reports once via the keyed `notifications.encoderModeClamped`.

**Fail-open is deliberate and load-bearing.** A source with no reported ladder, a
coarse/virtual/network source, and an un-normalizable payload all PASS. Refusing on
an unknown would block a save the hardware can honour — the same dishonesty in the
other direction. Do not "harden" these into refusals.

**The rejection is rendered, never swallowed.** `setConfig` RESOLVES with
`{success:false}` rather than throwing, so a caller that only try/catches reports a
refusal as "Saved". Both save paths read the flag and route the reason through
`lib/streaming/encoderSaveError.ts` (`apps/frontend`). The dialog itself is
unchanged: options are still rendered DISABLED WITH A REASON, never hidden.

Coverage: `tests/capability-truth-save.test.ts` (the per-`media_type` rejection
table driven through the REAL procedure, the persistence-untouched guarantee, and
the fail-open negatives) + `tests/capability-truth-clamp.test.ts` (the Osmo
1080p60-on-H.264 migration, the one-time notification, and the never-clamp cases).

## A LIVE CAPTURE DEVICE IS NEVER SILENTLY DROPPED [EXISTS]

`buildSources` folds each device into the coarse capability entry its kind bridges
to. That is an INTERSECTION of two INDEPENDENTLY-VERSIONED vocabularies — the
engine's `capabilities.sources[]` ids and `DEVICE_KIND_TO_PIPELINE_ID` — and when
they disagree the intersection is EMPTY, so EVERY camera disappears at once.

Board-confirmed on a Rock 5B+ (operator-reported): the device ran the released
cerastream `2026.7.2` (commit `5544fe3`, `SCHEMA_VERSION 0.4.0`), whose catalog
advertises the retired `camlink` / `v4l_mjpeg` ids, against a CeraUI that bridges
`hdmi` / `usb_mjpeg`. A connected, locked **1920x1080@59.94** HDMI-RX input and a
connected RØDE USB camera BOTH vanished, and because `SUPPRESSED_COARSE_PIPELINE_IDS`
drops the legacy coarse rows unconditionally, the picker collapsed to the single
virtual test pattern — indistinguishable from "no hardware attached".

Diagnostic note worth keeping: the engine's `devices` list was CORRECT throughout
(`/dev/video1`, `kind: "hdmi"`), and `v4l2-ctl --query-dv-timings` reported the real
signal. The loss was entirely in this projection. The USB camera disappearing
alongside the HDMI one is what rules out any kernel/HDMI-RX explanation — a
receiver fault cannot unlist a USB webcam.

`buildUnofferedCaptureEntry` renders such a device `available: false` with
`live.education.reason.pipelineNotOffered` instead of `continue`-ing past it. This
is the same FAIL-CLOSED-AND-VISIBLE rule `networkAvailability` already applies to an
inactive gateway ("still emitted, just unavailable, never dropped") and the house
rule that an unsupported option is disabled-with-a-reason, never hidden.

Three scoping rules are load-bearing:

- **Only when NOTHING in the catalog speaks for the pipeline** (`basePipelineIds`).
  A `test`-kind device bridges to `test`, which exists as the VIRTUAL row and
  already represents it; without this check that row doubles. A regression test
  caught exactly this.
- **Only for kinds that DO name a video pipeline.** An unrecognised engine kind
  collapses to `"other"` in `mapEngineDeviceKind`, which is the SAME bucket as the
  SoC codec/scaler nodes (`rockchip-rga`, the `hantro-vpu` dec/enc/av1 nodes), so
  CeraUI cannot tell an unknown camera from a non-camera there. Rendering them all
  would put four codec blocks in the operator's picker. Dropping stays correct —
  this is a KNOWN, accepted boundary, not an oversight.
- **Appended last, never interleaved**, so it displaces and reorders nothing.

It is a SAFETY NET, not a substitute for a current engine: the row is deliberately
not selectable, because the pipeline really is not offered and a start would fail at
`pipeline_not_in_offered_set`.

Coverage: `tests/unoffered-capture-visibility.test.ts` (the real board payload, the
`test`-only regression lock, the conservative-facet and wire-schema assertions, and
the four negatives: codec nodes, audio class, the virtual/network double-render, and
row-order stability).

## …AND NEITHER IS A LIVE AUDIO CARD [EXISTS]

The section above is about VIDEO, and its cause was two independently-versioned
vocabularies disagreeing. The audio list has the same shape of defect from a
different pair, and it is worse: it loses EVERY card at once with no row left to
render a reason on.

`updateAudioDevices` reads `setup.sound_device_dir` as a sysfs CLASS directory
(`cardN/id`, `cardN/pcmC<N>D<M>c`). `setup.json` is a STATIC value packaged
verbatim into the `ceralive-device` `.deb` — the same drifting artifact
`warnOnHardwareIdentityDrift` exists for — so a value naming any other layout
yields ZERO cards and `audio_sources` collapses to its two pipeline
pseudo-sources, indistinguishable from a board with no sound hardware.

Board-confirmed on a Rock 5B+ running current CeraUI against `ceralive-device
2026.7.2-20260719T181141`, whose packaged `setup.json` still carries the pre-#166
`"sound_device_dir": "/dev/snd"`. That directory holds ALSA's DEVICE NODES
(`controlC0`, `pcmC0D0c`, `timer`) and NO `cardN` directory at all, so a
connected, capture-ready RØDE HDMI-to-USB-C —
`0 [usbaudio]: USB-Audio - RØDE HDMI to USB-C`, `00-00: USB Audio : capture 1` —
was absent from the picker entirely. `debug.log` recorded the whole story in one
line: `audio devices: {"No audio":…,"Pipeline default":…}`.

Diagnostic note worth keeping: the ENGINE's audio enumeration was correct
throughout (the fixed board's `audio_sources` carries `transport: "usb"` and
`stable_id: "card:usbaudio"`, both of which come from the engine join), so this
was never an engine gap. And fixing `setup.json` — PR #166 already did — only
reaches a device on the NEXT full `.deb` upgrade, so the code has to survive the
disagreement in the meantime.

**`resolveConfiguredAlsaCards` (`alsa-card-scan.ts`) is the reconciliation, and
it is POSITIVE-EVIDENCE-ONLY.** A configured directory naming at least one card
answers unreconciled; a configured directory that IS the canonical one has
nothing to fall back to; otherwise it read cleanly and named no card, which is a
statement about the PATH and never about the hardware, so
`/sys/class/sound` is asked and answers only if IT names cards. A board that
genuinely has none is byte-identical to before. The rescue scan can never throw —
it exists to recover from a bad configuration, not to turn one fault into another.

**The `dir` argument of `updateAudioDevices` is honoured VERBATIM, and that is
load-bearing.** Only the OMITTED (production) argument reconciles. The drift is
between `setup.sound_device_dir` and the kernel, so a caller that names a
directory has already stated the answer — and second-guessing it would make every
sysfs-shaped test fixture report the HOST's own sound cards instead of the
fixture's. `getResolvedAlsaCardDir()` is what proves the production path really
routes through the resolver rather than around it.

**A card the kernel proves is an OUTPUT is dropped structurally, not by name.**
The hand-maintained `exclude` list has always meant exactly this —
`rockchipdp0`, `rockchiphdmi0/1/2` are the SoC's DisplayPort and HDMI PLAYBACK
cards — but a card-id list is itself a vocabulary, and the kernel's is not the
same one: this board names those blocks `hdmi0` / `hdmi1` (simple-card), which
the list does not match. So the moment the scan started finding cards again, two
speakers would have rendered as selectable microphones. `isPlaybackOnlyCard`
(`audio.ts`) asks the structure instead: ALSA names a substream
`pcmC<card>D<device><p|c>`, and a card owning at least one `p` node and NO `c`
node has told the kernel it plays and does not record. The list is KEPT as a
back-stop; it is simply no longer the only defence.

**The zero-PCM case is deliberately NOT an output.** That is the RK3588 HDMI-RX —
an INPUT that enumerates permanently and exposes no substream at all until a
cable locks (see "LISTED IS NOT RECORDABLE" above). Absence of evidence is not
evidence: a card that has claimed no direction keeps its picker row exactly as
before, and only `audioCaptureCardIds` gates claims about what it can deliver.
Inverting this would silently delete the HDMI-RX row, so do NOT "simplify"
`isPlaybackOnlyCard` into `!hasCapturePcmNode`.

`rk3588es8316` joins `ONBOARD_AUDIO_DISPLAY_RULES` as `Onboard Audio` for the
same reason PR #274 added `snps_hdmirx` to the video rules: the board's onboard
codec has no human string to clean, and the fix is what made its row reachable.

Coverage: `tests/audio-card-scan-drift.test.ts` (the board repro driven through
the real resolver, the `isPlaybackOnlyCard` table, the board's own card tree
through the real scan, the wiring lock, and the negatives that matter: a
configured directory that DOES name cards is never second-guessed, a genuinely
card-less board stays empty, the rescue scan cannot throw, a non-ENOENT error on
the configured directory still rejects, and a signal-less capture card keeps its
row).

## ONE ROW PER PHYSICAL CAMERA + PER-DEVICE MODE SELECTION [EXISTS]

A capability source is a PIPELINE; an operator points at a DEVICE. Conflating the
two put a permanent, unactionable row in the picker — `usb_mjpeg` rendered as
"USB MJPEG · not connected" forever — and let ONE dual-format camera answer to
TWO coarse rows at once.

**`SUPPRESSED_COARSE_PIPELINE_IDS` (`sources.ts`) drops the USB-capture coarse
rows in EVERY state**, not merely when a device bridges to them: `libuvch264`,
`usb_mjpeg`, `v4l_mjpeg`, `camlink`. `v4l_mjpeg` is the starkest case — NO device
kind bridges to it at all, so it can never be replaced by a concrete row and is a
phantom by construction. `hdmi` / `rtmp` / `srt` / `test` are deliberately NOT in
the set: each names a real, always-present port or capability of the board, so a
coarse row for it is truthful with nothing plugged in. The empty state is the
picker's single generic message, never a per-pipeline phantom. Board-proven A/B on
a Rock 5B+: 6 rows → 5, the phantom `libuvch264` gone, the other five byte-identical.

**A capture row carries every format the device advertises, each with its OWN
ladder.** `captureDevice.modes[]` (cerastream schema `0.11.0`) is threaded verbatim
through `fromEngineDevice` — the one engine-authored seam — and projected onto the
row as `inputModes[]`. Three properties are load-bearing:

- **A family is published only when its pipeline is OFFERED.** `buildInputModes`
  gates on the coarse capability set, exactly the rule `buildSources` already
  applies to a whole device. Without it a camera offers MJPEG on a board whose
  engine never advertised `usb_mjpeg`, and the pick dies at
  `pipeline_not_in_offered_set` AFTER the operator committed to it.
- **The ladders are never unioned** (ADR-0008 §10). Each family projects its own
  `caps` through the same `groupDeviceCaps` the flat list uses.
- **Parsing is per-FAMILY, not per-device.** An engine that reports an `InputKind`
  this build does not know drops that family; refusing the whole device would lose
  the camera.

**`config.input_mode` is a single field SCOPED to `config.source_stable_id`, not a
map.** "Per device" is satisfied by scoping: an operator pick that lands on
DIFFERENT hardware (compared by stable identity — node paths are recycled) CLEARS
the mode, so a choice made for one camera can never govern another. A keyed map
would need its own retention/eviction policy and would silently evict a stated
intent. Absent ⇒ the engine's own precedence, which is H.264 first — byte-identical
to every start before modes existed. Only an operator who explicitly picked a mode
sends one.

**Routing is mode-aware, because the two formats are two pipelines.** The same
camera reaches the engine through `libuvch264` in H.264 mode and `usb_mjpeg` in
MJPEG mode, so `deriveEngineRouting` re-answers the pipeline question against the
selected family (`pipelineIdForInputMode`, the mode-aware sibling of
`deviceKindToPipelineId`). A mode-only `setConfig` therefore re-routes the
PERSISTED selection without rewriting `config.source`.

**A mode switch mid-stream rides the EXISTING apply-now transaction.**
`input_mode` is an `APPLY_NOW_FIELDS` member and a `StreamConfigChangeDelta` field;
the engine owns the libuvc-release → re-enumeration-barrier → open transaction and
rolls it back honestly. Do NOT build a second transaction in CeraUI.

**Save-time validation intersects the SELECTED mode's ladder only.** This is ONE
substitution, not a fork: `@ceraui/rpc` `device-mode-truth.ts` already scopes a
ladder by "the media type the KIND names", so `device-mode-guard.ts`
`governingKind()` hands it the selected mode instead of the device's scalar kind.
`capabilities.ts`'s per-`media_type` split is untouched. The pick is trusted only
while the device still ADVERTISES it. An EXPLICIT `input_mode` the device does not
offer is REFUSED (`input_mode_unsupported`); a merely CARRIED one is silently
dropped — a refusal answers the operator's own action, but applying it to a value
they are not touching would let a device that stopped advertising a mode block
every unrelated save.

Coverage: `tests/one-row-per-camera.test.ts`.

## LAST-STREAMED-CONFIG RETENTION — ONE REMEMBERED DEVICE [EXISTS]

An absent capture device is worth an unavailable `lost` row only if somebody
wants it back. The retired rule inferred that from ENUMERATION: every device the
process had ever seen became a lost candidate, uncapped, for the whole backend
lifetime. So a colleague's webcam plugged in once, or a dongle moved to another
machine, left a permanent unusable row in the operator's picker with no way to
clear it short of a restart.

**Exactly ONE device is remembered: the one an outcome-gated start last committed
to.** Going live with a device is the evidence that was missing; merely seeing it
is not. Everything else leaves the list the moment it is live-absent — its
`last_seen_devices` entry stays, invisible, because identity migration still needs
it.

- **`config.last_streamed_source` (+ `_stable_id`) is the slot**, and it is
  DELIBERATELY DISTINCT from `config.source`. A save-only edit moves the
  operator's selection freely and must not move the slot; a restart restores the
  row from the slot, never from the selection.
- **`noteStreamedSourceCommitted()` (`sources.ts`) is the only writer.** It is
  idempotent — a start landing on the SAME source writes nothing at all, which is
  what keeps an automatic restoration of an interrupted session from disturbing
  it — and it resolves the persisted id through `resolveSourceIdentity` first, so
  the slot names the hardware that actually went live rather than a node path the
  device has since left behind.
- **The commit signal is the ORCHESTRATOR's `transition("streaming")`, not
  `PLAYING`.** `onStreamCommitted` fires only after `runStartWithRetry` resolves,
  i.e. downstream of the `playing-wait` phase, which is satisfied by a direct
  `state:"streaming"` reply or a concordant `state:"streaming"` + `streaming:true`
  heartbeat. A graph reaching PLAYING says a pipeline was built, not that it
  delivered — moving the slot there would move it for attempts that then fail.
  `reconcile()` deliberately does NOT fire it: adopting a session the engine was
  already running is not a new commitment.
- **It is wired as a LAZY `import()`.** `stream-session-orchestrator.ts` is
  already reachable from the source graph, so a static edge back into
  `sources.ts` reorders module initialisation and leaves the boot-time source
  build reading a half-initialised module — observed as an EMPTY device list at
  boot, i.e. every capture row silently missing. Same hazard, same fix, as the
  engine-audio-change handler in `sources.ts`.
- **A non-camera source SUPERSEDES by taking the slot EMPTY.** A coarse, virtual
  or network source has no `resolveSelectionAnchor` identity, so nothing resolves
  to a remembered snapshot and the previously-held camera stops being remembered.
  Superseding and clearing are one operation; there is no separate clear path.
- **PRESENCE ALWAYS BEATS RETENTION.** The lost loop is unchanged: a remembered
  device that is live by node path or by stable identity renders as a normal
  selectable row. A device unplugged for two seconds and back is never
  unpickable — it is simply absent from the list while it is absent from the
  hardware.
- **`mergeLastSeenLru` retains TWO ids, not one.** `config.source` was always
  exempt from eviction; `config.last_streamed_source` now is too, because its
  snapshot IS the lost row. The two are usually the same id and come apart on a
  save-only edit — without the second exemption a dozen devices of churn could
  evict the very snapshot the slot points at. The LRU cap (12) and the
  `previousIds` cap (8) are untouched.
- **The session-seen snapshot map is no longer a lost-row source.** It survives as
  the process's own observation record (it is what proves a renumbering camera
  folded onto ONE identity instead of accumulating a row per node path) and as
  `resetEngineDeviceCache()`'s test-isolation surface. Nothing renders from it.

Coverage: `tests/lost-device-retention.test.ts` — one dedicated test per row of
the policy's state-transition table (save-only, failed gate, committed start,
non-camera supersede, stop, renumber, restoration re-commit, replug, restart)
plus the blip negative control and both LRU exemptions. Frontend half:
`apps/frontend/tests/e2e/lost-device.spec.ts` (a source must be STREAMED before
it can be lost).

## THE DEGRADED-SELECTED CAPTURE SNAPSHOT [EXISTS]

`capture_degraded` is NOT a wire event — `grep capture_degraded` across the
published `@ceralive/cerastream` bindings returns nothing. cerastream reports it as
the EXISTING `capture_video_error` runtime error additionally carrying
`selected: true`. That pair IS the signal, and no other code may raise it.

`modules/streaming/capture-degraded.ts` holds it as a persistent SNAPSHOT rather
than a one-shot notification, because CeraUI otherwise maps engine errors only onto
notifications and a client that connects afterwards never sees them — a backend
restart or a frontend reconnect must not lose the state. It rides the `sources`
payload: `degraded` on the row it is about, plus `degradedSelected` mirrored at the
top level so the state survives the row (a device that degrades and is THEN
unplugged has no row left to hang it on). The row is matched by stable identity
first — the snapshot is taken at stream start and a libuvc camera renumbers on the
very next release.

**It inherits `ENGINE_ERRORS_CLEARED_BY_HEALTHY_SESSION`'s retraction and has NO
clearing path of its own.** `clearSelectedCaptureDegraded()` is called from
`clearRecoveredEngineError()` and nowhere else; `stop()` was added as a third call
site of that SAME seam (it already treats a stop as a session boundary for
`active_encode`). Three boundaries clear it: a concordant `streaming` status frame
(rejoin), an operator stop, and a new session start.

**It is dropped AHEAD of the standing-error gate, and that ordering is
load-bearing.** `resolved.channel` is ONE notification slot shared by every
non-srtla engine error, so `capture_video_error{selected}` → `srt_connection_lost`
→ healthy session would return EARLY (the srt code is not in the membership table)
and latch a capture claim the boundary disproved. The notification stays behind the
gate, unchanged.

**The re-publisher lives in `capture-degraded.ts`, not in the backend that raises
it.** `cerastream-backend.ts` is pinned by a regression test to never name
`./sources.ts` — the start choke point stays isolated from the source builder — and
the import is dynamic because `sources.ts` imports this module statically.

Coverage: `tests/one-row-per-camera.test.ts`.

## APPLY-NOW CONFIG CHANGE — TRANSACTION + STAGED PERSISTENCE [EXISTS]

Resolution, framerate, codec and source are baked into the engine graph at build
time, so changing one mid-stream means REPLACING the session. cerastream's
`change-config` (engine schema `0.10.0`) makes that replacement recoverable;
this is the CeraUI half.

**The operator always chooses.** `streaming.setConfig` takes an additive
`apply_now` DIRECTIVE (`streamingSetConfigInputSchema` — deliberately NOT a
member of `streamingConfigInputSchema`, because it is never persisted and never
echoed in `applied`). Absent/false is the unchanged apply-on-next-start path, so
no existing caller changes behaviour and a save can never restart a live
broadcast by itself. `apply_now` while NOT streaming degrades to an ordinary
save — it never dispatches a transaction.

**Everything routes through the orchestrator seam.** `changeStreamSessionConfig`
→ `stream-session-orchestrator.ts` → `config-change-bridge.ts` → the pinned
`@ceralive/cerastream` `changeConfig()`. There is NO direct streamloop
manipulation on this path, and `cerastream-backend.ts` gains only the additive
`changeConfig` passthrough beside `switchInput`/`listDevices`.

**`reconfiguring` is its own lifecycle state, and its deadline is DERIVED.**
`RECONFIGURE_DEADLINE_MS` (`start-lifecycle-timing.ts`) =
`CHANGE_CONFIG_WORST_CASE_BOUND_MS` (65 000, `@ceraui/rpc`
`config-change.schema.ts`) + `STOP_DEADLINE_MS` (12 000) = **77 000 ms**. The
65 000 is NOT typed as a literal: `config-change.schema.ts` reproduces cerastream
`docs/adr/schema.md` §11's phase table (`3 × teardown + 2 × start`) and a test
asserts the total, so shrinking a phase budget fails the build instead of
silently invalidating the published bound. It is **not 60 000** — the intuitive
`attempt × 2` reading, which a healthy transaction can legitimately exceed.

**A stop during `reconfiguring` is QUEUED, never raced.** The ~12 s stop deadline
is ~5× shorter than a legitimate worst-case change, so applying it to a
transaction reports healthy hardware as `stop_failed`. `stop()` therefore returns
a deferred promise while `reconfiguring` and is answered against whatever state
the transaction settled into. Concurrent stops share one queued resolution.

**But QUEUED is not UNBOUNDED, and it is never silent.** Only a settling
transaction releases a parked stop, so a transaction that breaks its own contract
strands the operator's Stop with nothing left to answer it. Measured on a Rock
5B+ (2026-07-31): a stop fired 0.7 s into an apply-now change sat **3.5–4.4 s**
unanswered while `stream_lifecycle` stayed frozen on `reconfiguring`, an
independent probe RPC on the same socket answered in 2–5 ms throughout, and
`journalctl -u ceralive` carried **not one line** about the stop for the whole
window — the exact "RPC never answered, nothing logged, event loop fine"
signature a previous investigation could not place. Unbounded, that silence had
no ceiling at all.

`parkStop()` therefore gives the wait its own deadline of
`RECONFIGURE_DEADLINE_MS + STOP_DEADLINE_MS` (89 s). That total is DERIVED, not
tuned: it is the transaction's full declared bound plus the one stop bound the
released stop still gets afterwards, i.e. by construction the latest instant a
healthy queued stop can answer — so it can only ever fire on a transaction that
already broke its contract, never on slow-but-working hardware. On expiry the
orchestrator logs, transitions `reconfiguring → reconciling` and adopts the
engine's truth (the same rule `settleConfigChangeState` applies to the
transaction's own deadline — the engine's state is unknown, so ask rather than
assert), and answers `stop_failed` with the distinct
`RECONFIGURE_STOP_TIMEOUT_REASON` (`reconfigure_stop_timeout`) — distinct from
`stop_timeout`, which means the engine WAS asked and did not finish.

Parking is announced at `warn` with the attempt id and the budget, and a release
cancels the deadline so a late tick can never overwrite the honest answer. `warn`
is deliberate: the production console transport runs at `warn`, so an `info` line
reaches the log FILE but never the journal the in-app Logs dialog downloads — an
`info` here would have been invisible in exactly the investigation that needed it.
The ordinary stop's `stop_failed` catch logs for the same reason; a 12 s
`stop_timeout` used to produce zero journal output.

**The BUS settles the transaction, not only the RPC.** When the engine publishes
`rollback_failed{teardown_timeout}` and then exits, the in-flight RPC rejects on
a dead control socket. `noteStreamSessionConfigChangePhase` (fed from
`handleEvent`'s `config-change` case) settles the transaction with the HONEST bus
reason, which wins the race against the dead-socket rejection. Both are fenced on
`attemptId`, so a phase from a superseded transaction can never settle the
current one. Every outcome LEAVES `reconfiguring` — `applied`/`reverted` →
`streaming`, `rollback_failed` → `idle`, deadline → `reconciling` (adopt the
engine's truth) — so there is no stuck `applying` state.

**THE ENGINE SPEAKS PIXELS, AND A REFUSAL IS NOT A FAILED ROLLBACK.** Both halves
of this paragraph were green across the whole automated suite and failed on the
first live transaction, because the fake engine the suite drives accepts whatever
CeraUI sends. Only a board could disprove them.

- **`config-change-bridge.ts` maps `resolution` through `toEngineResolution`.**
  `cerastream-backend.ts` has always done this on the START path; the bridge
  forwarded the UI rung verbatim, so EVERY apply-now resolution change was
  rejected with `invalid params: unsupported resolution '720p' (expected pixel
  form WxH matching a supported preset)`. The two paths now encode the axis
  through the ONE map. A token outside the ladder is forwarded VERBATIM rather
  than dropped — the engine is the authority on what it supports, and silently
  omitting an axis would apply a change the operator did not request.
- **A structured engine rejection settles as `reverted`, never
  `rollback_failed`.** The engine returns a JSON-RPC error ONLY when the
  transaction never began, so a `CerastreamRpcError` proves the live session was
  never touched — nothing was torn down, so there was no rollback to fail.
  `classifyConfigChangeDispatchError` splits it out; every OTHER rejection (dead
  socket, timeout, unknown fault) leaves the engine's state unprovable and keeps
  `rollback_failed{engine_connection_lost}` as the fail-safe DEFAULT. Collapsing
  both told the operator their broadcast may be dead while the engine kept
  encoding without a dropped frame. The reason is the typed
  `CONFIG_CHANGE_REASON_REJECTED` (`change_rejected`), keyed to operator copy in
  all 10 locales — the raw engine string is never rendered.

Coverage: `tests/config-change-engine-contract.test.ts` (the wire value per
ladder rung, the untouched sibling axes, the verbatim unknown token, and the
three classification branches) + the orchestrator's
`a REFUSED transaction reverts and keeps streaming` case, which asserts the
lifecycle stays `streaming` and `stopRuntime` is never called.

**STAGED PERSISTENCE — `config.json` describes what the ENGINE IS RUNNING.**
`config-change-staging.ts` holds the apply-now candidate in memory plus an
on-disk marker (`config.inflight.json`, atomic write); the restart-requiring
fields are deleted from `input` so the existing merge block skips them (ONE write
path, no parallel one to drift). Non-restart fields in the same save persist
immediately, unchanged. `config.json` is written ONLY on `applied`
(`commitStagedConfigChange`); `reverted`/`rollback_failed`/`busy`/`rejected` all
leave the persisted values byte-identical, because those values are still the
ones the engine is running.

**CRASH-WINDOW RECONCILIATION IS MARKER-ONLY.** `reconcileInflightConfigChange`
does nothing at all without the marker. A bare params-vs-config mismatch WITHOUT
a marker is a legitimate "apply on next start" the operator chose, and
reconciling it would silently overwrite their intent on every boot. With the
marker present, `judgeInflightMarker` (PURE) has THREE outcomes: engine live on
the CANDIDATE + outcome gate satisfied (`pipeline_playing` and frames advancing)
⇒ persist the candidate; engine on the PREVIOUS params or idle ⇒ retain the old
values; transitional/unreachable/neither ⇒ write NOTHING and KEEP the marker for
the next reconnect. Guessing in either direction persists a config the operator
never got or discards one they did.

**AND IT IS ARMED — `config-change-reconcile-wiring.ts` is what calls it.** For
one wave the paragraph above described behaviour that could not happen: the only
importer of `reconcileInflightConfigChange` was its own unit test, so a marker
left by a process that died mid transaction was never judged, the staged
candidate was lost, and the marker file leaked. The reconciler was correct and
simply unreachable, which is why the regression lock is on the CALL SITES.

There are TWO seams, and both are needed:

- **boot** (`main.ts`, immediately after `reconcileStreamSession()`) — the first
  moment the persisted config and the engine's own session are both known; and
- **engine reconnect** (`engine-reconnect.ts` `buildDefaultBroadcastEngineState`,
  after the same call) — where a marker that DEFERRED at boot is re-judged.

Four properties are load-bearing:

- **Marker-only is enforced BY CONSTRUCTION, not by convention.** The runner
  reads the marker FIRST and, finding none, returns `no_marker` without ever
  asking the engine anything. That is asserted directly (`h.asked === 0`) — a
  behavioural test, not a comment.
- **The snapshot speaks CONFIG space.** `judgeInflightMarker` compares
  `config.json` values with `===`, and the engine speaks PIXELS (`"3840x2160"`)
  and exact rates (`29.97`) — the read-side twin of the apply-now dispatch bug in
  "THE ENGINE SPEAKS PIXELS". `buildEngineEncodeSnapshot` normalizes at the one
  seam that knows it is talking to the engine, and `judgeInflightMarker` folds
  BOTH sides onto the rung ladder as a backstop (so a persisted `"4k"` matches a
  reported `"3840x2160"`), literal equality first so an unplaceable token never
  widens silently.
- **A NON-ANSWER IS NOT "NOT STREAMING".** The lifecycle comes from the
  orchestrator, never the bare `is_streaming` flag — that flag is false both for a
  genuinely idle engine AND for one reconciliation has not reached yet. Only
  `idle` is decisive; `reconciling`/`starting`/`stopping` yield `undefined`, which
  the judge answers with `wait`. Reading the flag would retain the previous values
  off a non-answer, discarding a change the operator DID get.
- **Bounded, and idempotent two ways.** With a marker it polls
  `INFLIGHT_RECONCILE_DEADLINE_MS` (15 s) at `INFLIGHT_RECONCILE_POLL_MS` (1 s),
  because the frame evidence (`frames_emitted` / `pipeline_playing`) rides the raw
  `active_encode` bridge, whose first status frame lands a second or two after
  boot reaches this point. Expiry defers, which KEEPS the marker. A decisive
  verdict retires the marker, so a repeat call is a plain no-op; and concurrent
  callers (boot racing a heal) share ONE in-flight run rather than judging in
  parallel. Both hooks are fire-and-forget and the runner never throws, so neither
  boot nor the heal broadcast can be delayed or broken by it.

Coverage: `tests/config-change-reconcile-wiring.test.ts` (a REAL on-disk marker
through the REAL writer and REAL `config.json`: persist-candidate, retain-previous,
the undecided-then-decisive re-ask, the never-decisive defer that keeps the marker,
the no-marker zero-side-effect case, double-apply, the overlapping-run join, the
config-space normalization table, and the two call-site locks),
`tests/config-change-orchestrator.test.ts` (admission, the four typed
outcomes, stop-during-applying, stop-during-rollback, the teardown_timeout →
engine-exit escalation chain, attempt fencing, deadline reconcile, and the
deadline-sizing assertion), `tests/config-change-staging.test.ts` (the pure
marker/judgement table), `tests/config-change-persistence.test.ts` (the REAL
procedure: applied-writes vs reverted/rollback_failed-don't, the delta contents,
both apply-now fallbacks, and marker-present vs marker-absent reconciliation).

## ONE-SHOT STREAM RESTORATION AFTER ENGINE DEATH [EXISTS]

`noteConnectionLoss` retires a session whose control connection died (see SESSION
CONTROL CONNECTION above) and, until now, that was the end of it: systemd
restarted `cerastream`, nothing tried again, and wave3 measured **0/6**
stream-level resumptions after a SIGKILL. `modules/streaming/armed-stream-marker.ts`
(the durable state + the PURE gate table) and `modules/streaming/stream-restoration.ts`
(the wiring + the runner) close that, with a deliberately narrow guarantee:
**exactly one restart attempt, scoped to the current boot.**

**The ARMED-STREAM MARKER is `stream.armed.json`**, written at the orchestrator's
`transition("streaming")` outcome gate — the SAME commit point todo 22's
`noteStreamedSourceCommitted` hooks, through a second dep (`onStreamArmed`)
rather than more work inside the first, because the two answer different
questions and each has to be provable alone. It carries the stream-defining
config snapshot plus the current `boot_id`, and nothing else that matters.

- **The snapshot is the RUNNING config, not `config.json`.** A save with no
  `apply_now` persists a restart-requiring field while the live session keeps
  encoding the previous one, so restoring from disk would apply an edit the
  operator explicitly deferred to their next start. `startStream` therefore takes
  an optional `configOverride` (absent for every other caller — byte-identical
  behaviour) and restoration passes the snapshot.
- **It is schema-parsed on WRITE, not only on read.** The snapshot is built by
  copying from the runtime config, which also holds `password_hash`, `ssh_pass`
  and `remote_key`; Zod strips everything outside the declared shape so a future
  copy-loop mistake cannot put a credential on disk. Do NOT "simplify" the
  write-path `parse()` away — it is the credential barrier, and a test asserts it.
- **The engine session id is DIAGNOSTIC ONLY and can never be a gate.** Four
  facts, each re-verified against current code rather than inherited: the
  adoption seam answers `"streaming" | "idle" | "unknown"` and nothing else
  (`streaming-backend.ts` `EngineRuntimeState`); `CerastreamBackend.start()`
  parses the engine's `StartResult` for its `state` alone and drops the
  `session_id` it really does carry (`grep session_id` across the backend hits
  test fixtures only); the engine's `Event::Status` carries no session identity
  (only the unrelated `Event::Preview` does); and the engine's ids are
  process-local counters (`format!("cs-{}", inner.counter)`), so a restarted
  engine re-issues `cs-1` for a DIFFERENT session — comparing them would be worse
  than not comparing them.

**ADOPTION WINS, UNCONDITIONALLY AND FIRST.** The runtime-state check runs ahead
of every marker gate and short-circuits: if the engine reports ANY streaming
session it is adopted via the existing `reconcile()` path and restoration does
not happen. This is what makes a backend-only restart safe — a marker survives a
backend restart exactly as it survives an engine death, and only the engine can
say which occurred. Asking about the marker first is how a device ends up with
two sessions.

**Restoration fires only when ALL of these hold**, and each is independently
blocking (one test per condition, each proven load-bearing by neutering it):
marker present ∧ engine authoritatively IDLE ∧ `marker.bootId === current boot_id`
∧ not cleared by an operator stop ∧ no planned-shutdown stamp ∧ no prior attempt.

**STOP-CAUSE PLUMBING.** The engine-loss path calls the SAME
`stopStreamSession()` as an operator Stop, so the stop now carries an explicit
`StreamStopCause` and the orchestrator reports it from the INTENT, ahead of the
outcome (an operator who pressed Stop meant it whether or not the engine
answered, and a stop parked behind a config-change transaction must not leave the
marker armed for the minute it waits). `operator` CLEARS the marker;
`engine_loss` and `reconfigure` PRESERVE it. A parked stop replays its own
recorded cause on release.

**`boot_id` fails CLOSED.** An unreadable `/proc/sys/kernel/random/boot_id` is
treated exactly like a mismatch, and a start that cannot read one arms nothing at
all. Failing closed costs a restoration; failing open auto-restarts a stream
across a power cycle, which is a separate product decision and out of scope.

**The planned-shutdown flag is stamped ONTO the marker**, not kept as a
standalone file, so it can never outlive what it suppresses: no armed stream
means nothing to write, and the next armed stream starts from a clean marker. A
separate flag needs its own clearing rule, and getting that wrong disables
restoration permanently and silently. Written by `startSoftwareUpdate()` and the
`system.reboot`/`system.poweroff` procedures. The update case is the real one: an
apt update restarts `ceralive` WITHOUT changing the boot id, so a stream armed
before an engine crash earlier in the same boot would otherwise be restored by
the post-update backend.

**`unknown` triggers NEITHER, with a declared sub-deadline.** The engine answers
`unknown` both while it is down and while a probe is transitional, so the runner
polls at `RESTORATION_POLL_MS` (1 s) for up to `RESTORATION_UNKNOWN_DEADLINE_MS`
(10 s). Resolving to `idle` proceeds to eligibility, resolving to `streaming`
adopts, and expiry writes a terminal `stream_recovery_failed{runtime_state_unknown}`
that does NOT re-arm on a later restart. A busy LIFECYCLE (a config-change
transaction settling, a stop finishing) waits the same way rather than racing it.

**ONE-SHOT IS THE FEATURE.** Both outcomes write a terminal attempted-state onto
the marker, so the answer to "what happens on the next backend restart" is always
"nothing". There is no retry and no backoff; a device that cannot restore lands in
an honest `idle` with a published reason. Typed events:
`stream_recovered` / `stream_recovery_failed` (keyed operator copy in all 10
locales; the machine-readable `reason` rides `params` and is never interpolated
into operator text).

**DECLARED RESTORATION BOUND: 30 s** (`RESTORATION_BOUND_MS`) from the reconnect
event, RECORDED per attempt (`elapsedMs` + `withinBound`) rather than enforced as
a second deadline — the launch already owns its own bounded retry machinery, and
racing a competing timer against it would report a healthy-but-slow start as a
failure.

**THREE TRIGGERS, ONE SELF-SERIALISING RUN**: the engine-loss retirement
(`cerastream-backend.ts` — the only seam that sees a SIGKILLed engine come back,
because `engine-reconnect.ts` settles at boot and never re-arms), backend boot
(`main.ts`, immediately AFTER `reconcileStreamSession()` so adoption has already
happened), and the engine-reconnect heal. A second caller JOINS the in-flight run.

**It does NOT move todo 22's `last_streamed_source` slot.** Restoration re-runs
the configuration that was already live, and `noteStreamedSourceCommitted` is
idempotent on the same source — so the slot is untouched by construction rather
than by a special case. Restoration deliberately goes through the ordinary commit
hook so that stays true.

**The two markers coexist and neither reads the other.** `config.inflight.json`
(apply-now transaction) and `stream.armed.json` (a stream was live) are different
files with different lifetimes; an engine that died mid-transaction legitimately
leaves both, and each is judged on its own.

Coverage: `tests/stream-restoration.test.ts` — the pure gate table with one case
per independently-blocking condition, the adopt/restore/neither discrimination
table driven through the REAL runner against REAL on-disk markers, the stop-cause
table, one-attempt-only in both outcome directions, planned-shutdown suppression,
boot_id mismatch, the credential-barrier assertion, the two-marker coexistence
pair, and the orchestrator commit/stop seams.

## DEVICE-FIRST SOURCE MODEL [EXISTS]

`modules/streaming/sources.ts` is the single builder behind the `sources`
broadcast (experience-simplification plan). It folds the coarse pipeline
registry, the engine's `list-devices` result (cached via
`refreshEngineDeviceCache`/`getEngineDeviceCache`), and the network-ingest
gateway status into ONE ordered `StreamSource[]` list — `getSourcesMessage()` =
`{hardware, sources}` (schema: `packages/rpc/src/schemas/sources.schema.ts`).
Every row is one of four `origin` variants (`capture`/`coarse`/`virtual`/
`network`); a bridged capture device REPLACES its coarse base entry in place
(order-preserving) via `DEVICE_KIND_TO_PIPELINE_ID` (`@ceraui/rpc`
`intersect-caps.ts`).

- **`config.source`** persists the operator's pick as a single id. Legacy
  configs (no `source` field) are coerced ONCE at load
  (`coerceLegacySource`, `helpers/config-schemas.ts`) — a pure exported
  function (not a schema `.transform`, so `runtimeConfigSchema` stays a
  `ZodObject` and `validateConfig` can keep calling `.partial()`), never
  throws, logs once.
- **`deriveEngineRouting(sourceId, sources)`** resolves a source id to the wire
  pair the engine needs (`{pipeline, selected_video_input}`) — capture routes
  to its bridged pipeline + `input_id`; coarse/virtual/network route to their
  pipeline id with `selected_video_input` explicitly `undefined` (clears a
  stale capture selection; the engine's existing `config.selected_video_input
  ?? getActiveInput()` fallback fills it). `resolveSourceRouting()` wraps this
  with the `unknown_source` rejection and is the seam BOTH
  `streaming.setConfig` and `streaming.start` call BEFORE any config mutation
  or engine dispatch — `cerastream-backend.ts` is untouched by this entire
  model (a `git diff`-based regression test proves it byte-for-byte).
- **Shim policy**: the legacy `devices` broadcast (`modules/streaming/
  devices.ts`), the `pipelines` broadcast (`rpc/procedures/
  streaming.procedure.ts`), and the coarse `capabilities.device_modes` field
  (`modules/streaming/capabilities.ts`) are kept running byte-for-byte
  unchanged as a rollback safety net. Only `SourceSection`/`StreamSetupChain`
  read `getSources()` exclusively today — `EncoderDialog.svelte`
  (`getPipelines`+`getDevices`), `AudioDialog.svelte` (`getPipelines`),
  `LiveView.svelte` (`getPipelines`), and `StreamingStateManager.svelte.ts`
  (`getPipelines`) all still consume the legacy getters directly
  (`GoLiveCard.svelte`, which this note originally named, is now an unmounted
  migration shim; see frontend `AGENTS.md`). The real exit condition: migrate
  those four consumers off `getPipelines`/`getDevices` onto `getSources()`-
  derived data, THEN ship one release with no rollback needed, THEN delete the
  producers/fields. Tracked as `TD-legacy-source-broadcasts` in
  `docs/TECHNICAL_DEBT.md`; do not delete the producers until that entry's
  exit condition is met.
- **Hotplug re-enumeration reconciliation (Todo 34)**: a capture device that
  re-enumerates under a new node path (video1→video2, e.g. a USB reset or
  module unbind-rebind) is reconciled by STABLE IDENTITY, not node path. The
  engine's `stable_id` (cerastream Todo 20, `usb:<vid>:<pid>[:serial|@port]`) is
  threaded verbatim through `fromEngineDevice()` → the engine-device cache →
  the persisted `last_seen_devices` snapshot (`stableId`). In `buildSources`,
  a remembered snapshot absent from the live list by node path but PRESENT by
  stable identity is dropped (the live successor owns the row) — so a rename
  migrates the row instead of leaving a stuck `lost:true` row. A TRUE unplug
  (no live device shares the snapshot's stable id) still yields a `lost` row,
  and an engine that never emits `stable_id` degrades to the prior node-path
  behavior. Coverage: `tests/sources.test.ts` ("hotplug re-enumeration
  reconciliation (Todo 34)").
- **A REMEMBERED device is keyed by stable identity too, not just the live row.**
  Todo 34 reconciled the rendered row; the persisted memory behind it was still
  keyed on the node path, so `mergeLastSeenLru` and the session-seen snapshot map
  treated every renumber as a NEW device. That was harmless while renumbering was
  rare — and stopped being rare the moment libuvc capture landed, because a
  libuvc-driven camera renumbers on EVERY open/close cycle. Confirmed from a live
  board's own `config.json`: THREE `last_seen_devices` entries (`/dev/video1`,
  `/dev/video2`, `/dev/video3`) under one identical
  `stableId: "usb:2ca3:0023:…"` — one camera, three operator-visible rows, and
  three separate `lost` candidates when it was absent.
  `identityKey()` (stableId when present, else the node path) is now the key for
  BOTH the persisted merge and `collectLostCandidates`, so a renumber updates the
  existing entry's `id`/`devicePath` IN PLACE. Two properties are load-bearing:
  - **It self-heals.** The fold runs over the observed AND persisted halves
    together, so a `config.json` that already carries duplicates collapses on the
    next observation — a device does NOT need a hand-edited config.
  - **The retired paths are KEPT, on `previousIds`.** Folding without them would
    strand a `config.source` still holding a retired path: `resolveSourceIdentity`
    looks the id up in `last_seen_devices` to recover its stable identity, and a
    folded-away entry answers nothing. This is the persisted twin of the
    `previousIds` already published on the live capture row, for the same reason.
    Capped at `RETIRED_ID_MEMORY` (8) — a libuvc camera renumbers indefinitely.
  Scoped on the engine's `stableId` alone: a device the engine gives no stable
  identity for still keys on its node path, byte-identically to before.
  Coverage: `tests/source-renumber-dedup.test.ts`.
- **Source-routing self-heal across a renumber (PR #197)**: Todo 34 migrates the
  source-list ROW by stable identity, but the persisted operator selection
  (`config.source`) is a literal engine id (e.g. `video1`). When that device
  re-enumerates under a new node (`video1`→`video2`, same hardware), the routing
  seam used to resolve `config.source` by literal id only, so the stale id failed
  closed as `unknown_source` and the chosen device stopped routing until the
  operator re-picked it. `resolveSourceRouting()` now runs a `resolveSourceIdentity()`
  step: when the persisted id is no longer live, it recovers the id's stable identity
  from `last_seen_devices` and routes to the live capture source that shares it. A
  genuinely different device (no stable-identity match) is NEVER adopted, and a
  missing identity still fails closed. This is additive — it consumes the
  already-published cerastream `stable_id` (no binding change) and is the UI-side
  mirror of the engine's operator re-promotion (cerastream PR #66). The stable id is
  threaded additive-optional through `StreamSource` (`sources.schema.ts`). Coverage:
 `tests/sources.test.ts`.
- **THREE capture-row states, not two (`signal`)**: a capture row is one of
  **healthy** / **lost** / **signal-absent**, and the third one is new. `lost`
  (`buildLostEntry`) means the device DISAPPEARED — it is not in the engine's
  device list at all. `signal:'absent'` means the device IS enumerated and IS
  bound but the engine projected ZERO capture modes for it: exactly what an idle
  HDMI-RX port looks like (`v4l2-ctl --query-dv-timings` answers "Link has been
  severed", yet `list-devices` still returns the node). Found live on a board,
  where such a row rendered with NO negative marker at all and read as healthy.
  The field is ADDITIVE-OPTIONAL on both `captureDeviceSchema` and
  `captureSourceSchema` (`sourceSignalSchema` in `streaming.schema.ts`), so a
  consumer that does not know it is unaffected.
- **The verdict is stamped at `fromEngineDevice`, and PROVENANCE — not
  absent-vs-empty caps — is the discriminator.** Verified on a real Rock 5B+:
  cerastream **OMITS** `caps` entirely for the severed-link node (the live UVC
  device beside it carries 64), so "empty array" and "no array" are
  indistinguishable on the wire and a rule keyed on that difference would report
  the signal-less device as `unknown` and render nothing. What actually
  distinguishes the two cases is WHO authored the row: `fromEngineDevice`
  (`devices.ts`) is the one seam that knows the engine answered, so zero caps
  there is a real finding (`absent`) rather than a gap. `buildDeviceList`'s v4l2
  fallback scan and the hotplug path's observed-but-unprobed rows leave the field
  UNSET — stamping them `absent` would mark every device signal-less during an
  engine outage — and `buildCaptureEntry` reads `device.signal ?? "unknown"`. Do
  NOT move this derivation into `sources.ts`/`buildCaptureEntry`: that layer
  cannot see provenance. This is the same "apply it at the device-construction
  seam, not per-consumer" rule as ONBOARD VIDEO DISPLAY NAMES above.
- The new state changes nothing else: the row stays `available:true`, stays
  selectable, and `resolveSourceRouting` still routes it (a signal can appear at
  any moment). `capabilities.ts` `foldDeviceModes` is untouched — it still drops
  capless devices from `device_modes` for its own consumers. Frontend half:
  `apps/frontend/AGENTS.md` → "No-signal capture row". Coverage:
  `tests/devices.test.ts` ("fromEngineDevice — signal verdict", incl. the
  fallback-scan negative) + `tests/sources.test.ts` ("capture signal state").
- **`getLinkTelemetry` null-on-stop** is a backend-locked contract:
  `stopLinkTelemetry()` clears the source state so the NEXT heartbeat tick's
  `broadcastLinkTelemetryIfChanged()` emits `{linkTelemetry: null}` exactly
  once (the dedupe cache is deliberately NOT reset in the stop path, so a
  second consecutive `null` tick is suppressed). See `apps/frontend/AGENTS.md`
  → "Telemetry-clears-on-stop" for the matching frontend-side guarantee.

## NETWORK-INGEST OPERATOR ENABLE/DISABLE (live-correctness-pass Todo #6–9) [EXISTS]

`modules/network/network-ingest-control.ts` adds a topology-aware desired-state
layer on top of the always-on gateway probe (`network-ingest.ts`, above):

- `readIngestDesired(config) → {rtmp, srt}` — the SOLE defaulting point
  (`?? true`); a missing config key defaults both protocols to enabled.
- `persistIngestDesired(protocol, enabled)` — mutates `getConfig().network_ingest`
  and calls `saveConfig()`; the singleton-only writer.
- `planIngestUnitActions(desired, markers) → {start, stop}` — PURE resolver.
  Topology-aware: the NEW shared `ceralive-rtmp-gateway.service` topology stops a
  unit only when BOTH protocols are off and starts it when EITHER is on; the OLD
  `srtUnitPresent` topology keeps rtmp↔rtmp / `ceralive-srt-gateway.service`↔srt
  independent. The apply step is isActive-GATED (only issues `systemctl
  start/stop` when current state differs from target) — that gating, not the pure
  resolver, is what makes reconcile idempotent.
- `setIngestEnabled(protocol, enabled)` — persist FIRST, then systemctl-apply
  (apply errors are swallowed; persisted desired-state is the truth, reconciled
  next boot), then re-broadcast BOTH `status` and `sources`.
- `reconcileIngestDesiredState()` — fire-and-forget boot reconcile; never throws,
  self-serialising, emulated no-op. Wired in `main.ts` beside
  `runAddonReconciler()`.
- `rpc.network.setIngestEnabled({protocol, enabled})` — persists first (even in
  the `shouldUseMocks()` branch, which also flips the mock's SEPARATE
  `networkIngestActive`/`gatewayActive` maps so the toggle and the
  `streaming.start` gate agree), else `{success:false, error:
  NETWORK_INGEST_UNAVAILABLE_ERROR}` when `!isRealDevice()`, else the real
  `setIngestEnabled` path.
- `status.network_ingest.{rtmp,srt}.operator_disabled?: boolean` — additive,
  present only when `true`, DISTINCT from `service_active` (a shared unit can
  stay active while a sibling protocol is operator-disabled).

**The fail-visible three-mirror predicate** — "start-eligible = unit-active AND
NOT operator-disabled" — is enforced identically in three places that MUST
agree: the real gateway probe (`network-ingest.ts` `buildGatewayProbe()`), the
mock gate (`mocks/providers/streaming.ts` `isMockGatewayActive()`, dev/CI
parity), and the frontend `pipelineAvailability()` (operator intent checked
FIRST, reason `live.education.reason.disabledInSettings`). See root `AGENTS.md`
→ "LIVE-CORRECTNESS-PASS FIXES" for the frontend-side contract
(`NetworkIngestDialog.svelte`, `SourceSection.svelte`'s visible-row filter).

## A SCAN IS COALESCED, AND FORGET REMOVES THE NETWORK [EXISTS]

Two WiFi defects behind one operator report — *"forgetting a network or
disconnecting from a network is not working"*. Full evidence:
`.omo/notepads/modem-phase-c-quality/evidence/session-amendment-wifi-forget-disconnect.md`.

**`wifiRescan()` COALESCES, because `wifi.scan` is an RPC and nmcli costs a D-Bus
connection.** Every `nmcli` process opens its own connection to the SYSTEM bus,
and root's `max_connections_per_user` (256) is a DEVICE-WIDE resource. Measured on
a Rock 5B+ (2026-08-19): a frontend render loop drove ~50 `wifi.scan` per second,
250-330 concurrent `nmcli device wifi rescan` processes were live, and `busctl`
itself could not list names — after which EVERY nmcli on the box answered
`Could not create NMClient object: …LimitsExceeded`, taking WiFi
connect/disconnect/forget, the gateway election and the modem profile writes with
it. The client that caused it is fixed in `apps/frontend` (`WifiSelectorDialog`'s
periodic scan, see that repo's Async OS-operation entry), but the guard stays: a
device must not be knockable over by a repeated READ RPC, whoever sends it.
Concurrent callers JOIN the in-flight run (their intent is exactly what it
delivers) rather than yielding, and the shared promise SWALLOWS its rejection —
one failed scan must not raise an unhandled rejection per joiner. Same discipline
as `signalRecheckInFlight` in `modules/streaming/sources.ts`.
`setRescanActionForTest` mirrors `setScanRefreshAction` as the counting seam.

**`WifiInterface.savedAll` exists because Forget removes a NETWORK, not a
profile.** `saved` is `Record<SSID, uuid>`, and NetworkManager holds a profile per
CONNECTION — the same board carried `4G-UFI-611A` AND `ufi-recovery`, both
`802-11-wireless.ssid = 4G-UFI-611A`. So Forget deleted one, the sibling kept the
SSID in the map, and the row still read "Saved": indistinguishable, to the
operator, from a Forget that did nothing. `registerSavedWifiConnection` now also
appends to `savedAll` (`rememberSavedUuid`), and `wifiForget` deletes every uuid
`wifiSiblingConnections(uuid)` resolves.

- **`savedAll` is OFF the wire.** No schema change; `saved` still names ONE uuid,
  which is what the frontend acts on.
- **Only FORGET reads it.** Connect and disconnect mean "act on this connection";
  only Forget means "remove this network".
- **A MAC-bound profile records its sibling on ITS adapter only** — a bound
  profile is not another radio's network to remove.
- **`wifiUpdateSavedConns` clears BOTH maps** before the sweep, or a deleted
  profile lingers as a phantom sibling and Forget issues a delete for a uuid that
  no longer exists.

Coverage: `tests/wifi-rescan-coalescing.test.ts`, `tests/wifi-forget-same-ssid.test.ts`.

## WIFI AP-vs-CLIENT CLASSIFICATION [EXISTS]

A radio in AP/hotspot mode and a radio associated with somebody else's access
point are DIFFERENT operator states, and the Network page must never confuse
them — an access point cannot be bonded and cannot be "connected to". Found live
on a board: a broadcasting `wlan0` rendered as "Connected · CERALIVE_03f6" with
an ON "In Bond" toggle and a "Connect >" button, then as plain "Disconnected"
one poll later.

**One cause, both symptoms: the classification hung off `conn`.**
`wifiUpdateDevices` nulls `conn` unless the SEPARATELY polled ifconfig cache
(`wifi-device-list.ts`) has already seen an address for the radio. That gate is
right for bonding — a client link with no lease is unusable — but it made an
active hotspot indistinguishable from a disconnected station whenever the two
pollers were momentarily out of step. Worse, NetworkManager lists a radio's OWN
access point in its scan results with IN-USE set, so the station branch then
rendered the hotspot's own SSID as a client association.

- **`activeConn` / `activeMode`** (`wifi-interfaces.ts`) carry NM's active
  connection for the radio WITHOUT the IP gate, plus that connection's
  `802-11-wireless.mode`. The mode is resolved once per UUID and cached;
  `unknown` (an nmcli read that failed) is deliberately NOT cached, or a
  transient failure would pin an AP radio to the client UI for the process
  lifetime.
- **`isApMode(iface)`** (`wifi-hotspot-types.ts`) is the classification every
  operator surface uses: `isHotspot()` OR (hotspot-capable AND
  `activeMode === 'ap'`). `isHotspot()` still requires the adopted hotspot
  profile and stays the predicate for anything that dereferences
  `hotspot.conn` (`wifi-hotspot-config.ts`, `wifi-hotspot-activation.ts`,
  `wifi-hotspot-info.ts`) — do NOT swap those to `isApMode`.
- **`isHotspot()` now also accepts `activeConn === hotspot.conn`**, so a
  confirmed hotspot no longer flickers back to station on a lagging IP poll.
- **AP-mode adoption happens in the device loop.** When NM reports the active
  connection as `ap`, `wifiUpdateDevices` calls `handleHotspotConn` immediately
  rather than waiting for `wifiUpdateSavedConns` (which only runs when a NEW
  adapter appears).
- **`getModeForInterface`** (`state/wifi-state.ts`) and `wifiBuildMsg`'s
  `mode` + `hotspot` block both route through `isApMode`, so the cached mode and
  the broadcast mode can never disagree. An AP-mode radio's `available` scan
  list and `saved` map are omitted from the wire — there is no Connect target to
  render.
- The netif hotspot marker (`setNetifHotspot`, which removes the radio from the
  bonded source-IP list) is likewise keyed on `isApMode`, so an AP radio is
  excluded from bonding before its profile is adopted.

Frontend half: `apps/frontend/src/lib/helpers/wifi-mode-outcome.ts`
(`isApRadio`) — `mode` first, `hotspot` presence only as a pre-`mode` fallback.

Coverage: `tests/wifi-ap-mode-classification.test.ts`.

## AP+STA CONCURRENT MODE [PARTIAL — implementation complete; hardware validation pending]

`wifi-ap-sta-capability.ts` derives support from the kernel's own
`valid interface combinations` answer. One complete alternative must permit a
`managed` interface and an `AP` interface together; grouped limits and `total`
are enforced, and every absent/malformed/probe-error path resolves false.

`wifi-concurrent-interface.ts` creates the deterministic `clap-<parent>` cfg80211
`__ap` interface and waits for NetworkManager to observe it. Hotspot profiles on
proven radios bind to that virtual interface, so the physical interface retains
its station connection and bond state. Confirmation, polling, saved-profile
adoption, reconfiguration, and stop track the virtual AP separately. Radios that
do not prove support use the pre-existing exclusive path unchanged.

The optional wire flag is `supports_ap_sta_concurrency`; it is emitted only after
both the `iw phy` parser and runtime virtual-interface creation succeed. Full
contract and the outstanding RTL8852BE/MT7925 board drill:
[`docs/AP-STA-CONCURRENT-MODE.md`](../../docs/AP-STA-CONCURRENT-MODE.md).

Coverage: `tests/wifi-ap-sta-capability.test.ts`,
`tests/wifi-concurrent-interface.test.ts`, `tests/wifi-hotspot.test.ts`.

## HOTSPOT CHANNELS ARE DERIVED FROM THE KERNEL, NEVER FROM A TABLE [EXISTS]

`modules/wifi/regdomain.ts` turns an operator-declared country into the set of
channels the hotspot may actually use. **It contains no country→channel table and
must never gain one.**

The reason is that such a table is wrong the moment it is written: which channels
a country permits depends on the kernel's `wireless-regdb` version, the radio's
own capabilities, and whether the adapter is self-managed (carrying its own
regulatory rules that override the global domain). So the flow is
apply-then-read-back: `iw reg set <CC>` hands the country to the kernel, the
kernel rewrites every wiphy's per-frequency flags, and `iw phy` is parsed to
enumerate what is left. A table would be a second, silently-diverging opinion
about the same question.

**What "AP-usable" excludes, and why none of it is optional:**

| Flag | Why an access point may not use it |
|------|-----------------------------------|
| `disabled` | not permitted at all |
| `no IR` | NO_INITIATING_RADIATION — the radio may listen but not transmit first, which is exactly what starting an AP does |
| `radar detection` | DFS; legal for an AP only with a full radar-detection + channel-availability-check implementation, which CeraLive does not have |
| a BAND the regulatory RULES permit no initiating radiation on | the fact lives in `iw reg get`, NOT in the per-channel flags — see below |
| 6 GHz | NetworkManager's `802-11-wireless.band` has no value for it, and AP operation there additionally requires WPA3-SAE |

`no IR`'s pre-NO_IR spellings (`passive scanning`, `no IBSS`) are treated
identically — an older kernel expresses the same restriction with different words,
and excluding a channel is the conservative direction.

**THE PER-CHANNEL FLAGS ARE NOT THE WHOLE REGULATORY TRUTH — the rule data is the
other half.** Board-proven on a Rock 5B+ (RTL8852BE, 2026-08-22): under the
kernel's world domain (`00`) that adapter's `iw phy` dump lists 5180/5200/5220/5745
with **no `no IR` marker at all**, so a derivation reading only those flags offered
`ch_36` — and the AP then died, identically for WPA2 and WPA3-SAE, while `ch_6`
succeeded for both on the same board and attempt:

```
Config: added 'frequency' value '5180'
wpa_supplicant: wlan0: Failed to start AP functionality
state change: config -> failed (reason 'supplicant-timeout')
```

`iw reg get` is where that fact was: every 5 GHz rule under domain `00` reads
`PASSIVE-SCAN`, which is the same nl80211 flag (`NL80211_RRF_NO_IR`) the
per-channel `no IR` names. `wifi-regulatory-rules.ts` is the pure parser for that
rule data and `buildApInitiationGate` narrows the SOURCE map with it inside
`parseIwPhyChannels` — the structural shape `HOTSPOT_BANDS` already uses to refuse
6 GHz, never a downstream filter on an already-built offering. Four properties are
load-bearing:

- **It is BAND-scoped, and the band is refused only when EVERY rule overlapping it
  forbids initiation** — "PASSIVE-SCAN only". That is what the world domain does to
  5 GHz and deliberately does NOT do to 2.4 GHz, whose `(2402 - 2472 @ 40)` rule
  carries no such flag: channels 1-11 are offered exactly as before, and the
  per-channel flags still exclude 12/13/14. It is NOT a hardcoded "block 5 GHz",
  which would withdraw the band from every properly-configured country.
- **It FAILS OPEN.** An absent, empty or unparseable `iw reg get` derives
  byte-identically to the pre-gate behaviour, and a frequency span no rule mentions
  is permitted — absence of a rule is not evidence of prohibition, and a failed read
  is a statement about the READ. Same rule as `refreshDerivedApChannels`'s
  retain-on-empty and `planHotspotRegdomainChange`'s refusal to clamp on an empty
  derivation.
- **A per-phy section outranks the global one.** A self-managed wiphy carries its
  own domain, so a board whose global scope is still the world domain can have a
  radio that legally initiates on 5 GHz — and only that section says so. This is
  the same per-phy rule `parseIwRegDomains` already applies to `is6GhzLegal`.
- **`parseRegulatoryRuleLine` is the ONE rule-line parser**, shared with
  `wifi-capabilities.ts`'s `is6GhzLegal` derivation, so the ranges the capability
  block reads and the ranges this gate reads can never drift apart.

`probeApChannels` reads `iw reg get` alongside `iw phy` through the same `runIw`
seam and logs one `warn` naming any band the rules withheld — otherwise the 5 GHz
options simply vanish from the operator's dialog with nothing on the device saying
why. Coverage: `tests/wifi-regdomain-channels.test.ts` → "W1 — a PASSIVE-SCAN-only
band is withheld from the AP offering", driven by the board's own
`iw-phy-rock5bplus-rtl8852be.txt` + `iw-reg-get-rock5bplus.txt` fixtures, with a
non-vacuity check that the phy dump really carries no `no IR` on those channels.
Rule-E proof captured in both directions: deleting the gate reddens exactly the
named world-domain test, and replacing it with a hardcoded "block 5 GHz always"
reddens 9 — including the regression lock that a permitting domain still offers
them.

- **Radios are kept APART.** `parseIwPhyChannels` returns a per-wiphy map and
  `deriveApChannels` takes ONE radio (the first, absent a name). A dual-radio
  board's wiphys can differ, so unioning them would offer one radio a channel only
  the other can host — the same class of defect as the retired device-mode union
  (ADR-0008 §10).
- **`ch_<n>` is the channel id** (`wifi-channels.ts`). Shape validation
  (`isWifiChannelName`) answers "could this name a channel"; **legality is
  `isChannelOffered`**, which tests the runtime-derived set. `wifiHotspotConfig`
  uses the latter, so a well-formed-but-underived channel is rejected.
- **An underived channel has no NetworkManager mapping BY CONSTRUCTION.**
  `nmSettingsForChannel` resolves the band/number pair out of the derived list, so
  even if validation were bypassed an illegal channel cannot reach `nmcli`.
- **`refreshHotspotChannels` drops the previous explicit channels first.** Keeping
  them would carry an old domain's now-illegal channels into the new set; the
  adapter's own band capability is recovered from its auto entries, so the fold is
  idempotent.
- **A live AP is RESTARTED, not updated in place** (`planHotspotRegdomainChange` →
  `reconfigureHotspotForRegdomain`). NetworkManager bakes the band/channel into the
  activation. A channel the new domain retired is clamped to `auto` — not to the
  band-matching auto, because a domain change can withdraw the whole band. Two
  refusals are deliberate: an INACTIVE AP is left alone (the next start picks the
  new set up), and an EMPTY derivation never clamps a live AP off the air, because
  a failed `iw phy` probe proves nothing about legality.
- **The image must ship BOTH `wireless-regdb` and `iw`.**
  `checkWirelessRegdbSupport` probes `/lib/firmware/regulatory.db` (modern) and
  `/usr/lib/crda/regulatory.bin` (legacy), fails closed, and warns at boot when
  neither is present — without a database the kernel keeps the world domain and
  `iw reg set` is inert. The `iw` binary gap is separately real: `wireless-tools`
  ships only the legacy WEXT `iwconfig`/`iwlist` binaries, NOT `iw` (see
  `image-building-pipeline/AGENTS.md` → "`iw` in `shared.list`").
- **Board safety.** `buildRegdomainRestoreCommand` constructs a `systemd-run
  --unit=dqw3-net-restore --on-active=10min … iw reg set <pre-state>` timer, armed
  BEFORE any mutation so a drill that loses its operator still returns the radio to
  a known domain. Argv-only (no `sh -c`), and a malformed pre-state THROWS rather
  than arming a timer that would do nothing.

Every effectful call routes through `setRegdomainRunner` (the `set<Name>Runner`
convention shared with `ssh.ts` / `software-updates.ts`), so no test can move the
host's own regulatory domain. Coverage: `tests/wifi-regdomain-channels.test.ts`,
driven by real-shaped `iw phy` transcripts in `tests/fixtures/wifi/` (world / ES /
US / legacy-flag / 6 GHz).

## EVERY WIFI MUTATION SHARES ONE ADAPTER LOCK [EXISTS]

`modules/wifi/wifi-adapter-lock.ts` owns the ONLY per-adapter lock-key
derivation in the codebase, and both layers import it: the oRPC procedures
(`runGuarded` in `rpc/procedures/wifi.procedure.ts`) and the hotspot
start/stop/reconfigure transactions (`wifi-hotspot-activation.ts`,
`wifi-hotspot-config.ts`).

**The two layers used to derive their own, and they disagreed.** The RPC layer
keyed on the adapter's registry MAC; `startHotspotForInterface` /
`stopHotspotForInterface` / `wifiHotspotConfig` /
`reconfigureHotspotForRegdomain` keyed on `wifiInterface.ifname`. Those are two
different strings for one radio, so `withDeviceLock` handed both callers the
lock simultaneously and the guard that exists to serialize an NM activation
against a station mutation serialized nothing. `wifiConnectNewProcedure`
compounded it by taking no lock at all — the one mutating procedure that skipped
`runGuarded` entirely.

- **The key is the PERMANENT hardware address**, i.e. the same value
  `wifiInterfacesByMacAddress` is keyed on (`resolveWifiPermanentMac`), so a lock
  key and a registry lookup can never name different adapters. An ifname cannot
  carry that guarantee: NetworkManager renames adapters (this fleet's
  duplicate-MAC dongles rename against each other on replug), and the AP+STA
  concurrent path activates the hotspot on a SECOND, virtual `clap-<parent>`
  interface belonging to the same radio — an ifname key there leaves the
  parent's station mutations unguarded for the whole activation.
- **It is the BARE normalized MAC, no prefix.** It shares the process-wide
  `withDeviceLock` registry, so prefixing would silently stop matching a key an
  existing caller already holds.
- **An unresolvable adapter runs UNGUARDED, deliberately.** `runGuarded` runs
  `op` when the device id / connection uuid names no known radio: there is no
  adapter to contend for, and refusing would be dishonest in the other
  direction.
- **The station procedures hold the lock across their DISPATCH, not across the
  nmcli work** — `handleWifi` fires connect/disconnect/forget/scan/new with
  `void`. The hotspot transactions DO hold it for their full NM activation,
  which is the ordering that matters: the destructive multi-step operation
  cannot be interleaved with a station mutation. Making the station legs
  awaitable under the lock is a separate change with its own RPC-latency
  consequences, and the `wifi.procedure.ts` header says so rather than claiming
  more than the code delivers.

Coverage: `tests/wifi-adapter-lock.test.ts` — the two layers' derivations
compared for string equality AND both CALL SITES proven to refuse under one
externally-held key, plus the `connectNew`-versus-hotspot-start race asserting
the refused op dispatched ZERO nmcli and the admitted one observed the first
op's terminal state. Rule-E proof captured in both directions: reverting the
activation key to `ifname` reddens the first test, and un-guarding
`wifiConnectNewProcedure` reddens the second.

### …AND A HOTSPOT TOGGLE NEVER CLAIMS MORE THAN NM HAS CONFIRMED [EXISTS]

`withDeviceLock` is **NOT re-entrant**, and sharing ONE key between the RPC layer
and the transactions is exactly what exposed that. The hotspot procedures
dispatched INSIDE `runGuarded`, so the outer lock was still held when the
transaction reached `withDeviceLock` — and a `void` does not help, because an
async body runs SYNCHRONOUSLY up to its first `await` and the busy check is
before any await. On a real device **every** hotspot start/stop/configure refused
ITSELF with `DEVICE_BUSY` while the procedure ignored the result and answered a
fabricated `{ success: true }`. Nothing caught it: no test asserted the
dispatched outcome.

| Procedure | Lock posture |
|---|---|
| station (connect/connectNew/disconnect/forget/scan) | UNCHANGED — `runGuarded` across dispatch only |
| `hotspotStart` / `hotspotStop` | NO `runGuarded`: an `adapterBusy()` admission PROBE (acquire+release), then AWAIT the transaction and return its typed outcome |
| `hotspotConfigure` | NO `runGuarded`: same probe, then a dispatch ack — awaiting it risks 2 × `HOTSPOT_UP_TO` (60 s) against a 30 s RPC timeout |

**The probe is required, not decorative: two id→MAC resolutions exist and they
disagree.** `getMacAddressForWifiInterface` reads `getWifiIdToMacAddress()`;
`wifiAdapterLockKeyForDeviceId` scans the registry by `.id`. A caller that
resolves a lock key but not a MAC would be answered `no-device` where
`DEVICE_BUSY` is owed.

**`modules/wifi/wifi-hotspot-outcome.ts` is the ONE builder of a
`wifi` → `hotspot.start` / `hotspot.stop` frame**, and it BROADCASTS: the path
that most needs a terminal (the bounded NM confirmation) settles from a monitor
event or a backoff poll with no requesting socket in hand. **Exactly ONE
publisher per exit path** — refusals from `wifiHotspotStart`, the already-active
short-circuit from `startHotspotLocked` (nothing was dispatched, so no
confirmation will ever settle), confirmed/never-confirmed from
`registerPendingConfirmation`, every stop outcome from `wifiHotspotStop`, and an
unexpected throw from the `.catch` arms in `handleWifi`. `wifiHotspotStart`
deliberately does NOT publish on success — that would resolve the operator's op
before NetworkManager has answered.

**A state broadcast is not a terminal outcome.** `giveUp()` already called
`broadcastState()`, which says "still a station"; it does not say the START
failed, so the keyed op could only expire on its TTL. Hence `not-confirmed`,
which is deliberately NOT `activation-failed` — NM accepted the activation and
never reported the AP up, which is a different thing to tell someone.

`accepted: true` on the reply means "a terminal frame follows", never "the access
point is up". Wire contract: `hotspotToggleErrorSchema` (six members, none
collapsible) + `hotspotToggleOutputSchema` in `@ceraui/rpc`.

**`runWifiNew`'s `ok:true, uuid:undefined` is AMBIGUOUS, not failed.** It emits
`{new:{error:"ambiguous"}}` and deliberately does NOT run
`wifiDeleteFailedConns()` — the failure path does, because a failure proves the
profile never activated, and this path proves nothing.

Both `publishOutcome` deps are OPTIONAL so the existing suites' exact dep objects
still typecheck; production wires them in the `default*Deps`. Coverage:
`tests/wifi-hotspot-terminal-outcomes.test.ts` (11 tests — every typed refusal,
both accepted-path settlements, both stop outcomes, the RPC caller's typed
reply, and the two station-join frames). Rule-E: all 11 fail on the pre-fix tree.

## WIFI ADAPTER IDENTITY IS THE PERMANENT MAC [EXISTS]

Every adapter-keyed WiFi structure — the `wifiInterfacesByMacAddress` registry,
the `wifiState` cache, the numeric UI id map, the hotspot credential store, and
the `802-11-wireless.mac-address` pinned into a NetworkManager profile — is keyed
on the radio's **permanent hardware address**, resolved by
`modules/wifi/wifi-permanent-mac.ts` (`resolveWifiPermanentMac`).

**`ifconfig`/`GENERAL.HWADDR` report the OPERATIONAL address, and it moves.**
NetworkManager randomizes a WiFi device's MAC while scanning
(`wifi.scan-rand-mac-address`, on by default) and resets it when it activates a
connection. Confirmed on a Rock 5B+, roughly every 7 minutes:
`device (wlan0): set-hw-addr: set MAC address to 26:C3:93:B6:9C:A7 (scanning)`.
Two things broke while the registry keyed on that value:

- the registry re-keyed itself, so the adapter's adopted hotspot profile, saved
  connection map and id were discarded and rebuilt empty; and
- profiles were pinned to a randomized address. **NetworkManager matches
  `802-11-wireless.mac-address` against the PERMANENT address**, so those
  profiles could never activate again — the board's journal recorded
  `audit: op="connection-activate" result="fail" reason="… device MAC address
  does not match the profile"` on every hotspot start.

**Resolution ladder** (`resolveWifiPermanentMac(ifname, currentMac)`):
`/sys/class/net/<ifname>/phy80211/macaddress` (the cfg80211 `wiphy->perm_addr`,
verified byte-equal to NetworkManager's D-Bus `PermHwAddress` on the reference
board) → the last permanent address read for that interface → the current
address. The cached tier is load-bearing: a transient sysfs failure must not
re-key the registry onto a scan-time address for one poll. `busctl` is
deliberately NOT used — it is not in the `helpers/run.ts` ALLOWED set, and a
single sysfs read needs no spawn at all. `setPermanentMacReaderForTest` is the
test seam.

**A monitor event carries an ifname, never a MAC.** `getWifiInterfaceByIfname()`
(`wifi-connections.ts`) is the bridge; do NOT route a device-state event through
`wifiDeviceListGetMacAddress()` — that returns the operational address and will
miss the registry.

## DURABLE PER-ADAPTER HOTSPOT IDENTITY [EXISTS]

A hotspot's SSID and password are generated **once per physical adapter and
reused forever** — across station↔hotspot switches, backend restarts, and
reboots. Before this, every start took the "no hotspot connection yet" branch
and minted a new pair; a test device accumulated six NetworkManager profiles
(`Hotspot`, `Hotspot-1` … `Hotspot-5`) with six different SSIDs and passwords,
none of which the operator's phone had been told about consistently.

**Discovery runs BEFORE generation.** `startHotspotLocked`
(`wifi-hotspot-activation.ts`) resolves the profile to activate in this order:
the in-memory `hotspot.conn` → `findHotspotConnForAdapter()` → generate. The
lookup (`wifi-hotspot-discovery.ts`) is deterministic, never name-guessing: the
persisted UUID first, then the profile whose `802-11-wireless.mac-address` binds
it to this exact permanent address, and only as a last resort a profile matching
the persisted SSID (for profiles written before the MAC binding was
trustworthy).

**The repair must land BEFORE the activation.** `hotspotProfileFields(permMac)`
is re-asserted with `nmConnSetFields` and only then is the profile brought up —
a profile carrying a randomized binding is one NetworkManager will refuse, so
activating first and repairing after (the old order) fails every time. This also
removes the misleading `result="fail"` audit line that used to accompany every
otherwise-successful start.

**`hotspot_credentials.json` is the BACKSTOP, not the source of truth.**
NetworkManager's own `.nmconnection` files remain primary. The store
(`modules/wifi/hotspot-credentials.ts`, atomic JSON per
`docs/CONFIG_PERSISTENCE.md` — **not** SQLite) exists for the one case
NetworkManager cannot cover: a profile deleted out from under CeraUI. The
credentials are then reused to recreate an identical hotspot rather than mint a
new identity. It is written on generation (**before** activation, so a start
that dies mid-flight cannot strand credentials the UI already displayed), on
adoption (`handleHotspotConn`), and on operator rename
(`reconfigureHotspotLocked` — otherwise a later recreate would restore the stale
generated pair). Writes are inert until `initHotspotCredentials()` runs, so a
unit test that never opts in cannot litter the working directory.

**Duplicate consolidation requires POSITIVE ownership evidence, and ABSENCE is
never evidence.** `pruneDuplicateHotspotConns()` runs best-effort after a
successful start (never blocking or failing it) and deletes a profile only when
ALL of the following hold: its uuid is one the credential store positively
claims, no adapter is currently using it, and it is still an AP-mode profile
carrying the nmcli-generated id (`Hotspot`, `Hotspot-N`).

The claim is computed by `collectSupersededHotspotConns()` — the union of every
adapter's current `conn` and its `previousConns` history, MINUS every adapter's
current `conn`. So a profile that is some adapter's live identity is protected
even when that adapter also appears in another's history, and a uuid the store
has never seen is simply unknown and always survives.

The retired rule also deleted a generated-name AP profile "bound to an address
no present adapter has". That reads absence as abandonment, and a temporarily
unplugged (or not-yet-enumerated) radio looks exactly like it — so the cleanup
could destroy the SSID and password an operator's phone already knew, with the
credential backstop above powerless to help because the profile it points at was
the thing deleted. There is now no code path in which a profile is deleted
because something is missing.

**The name pattern is a narrowing filter, never evidence.** An operator who runs
`nmcli device wifi hotspot` themselves gets the same `Hotspot-N` id and can pick
the same `CERALIVE_`-shaped SSID. Neither is ours to delete, and neither appears
in the store.

**This is why the store keeps a history at all.** It holds ONE current `conn` per
adapter, so a profile that CeraUI itself superseded would otherwise carry no
evidence and become permanently undeletable. `previousConns` (`string[]`, oldest
first, capped at `PREVIOUS_CONNS_LIMIT` = 8, drop-oldest) records the retired
uuid whenever `conn` is REPLACED — one known uuid giving way to a different known
one. Every other write leaves it untouched, so the failure direction is
forgetting evidence (the profile becomes unknown, hence undeletable) rather than
inventing it. It is maintained by the store; a value passed to
`rememberHotspotCredentials` is ignored.

**Schema migration is version 1 → 2.** A v1 file (no `previousConns`) loads
unchanged and gains an empty history at load (`migrateEntry`); saves write
`version: 2`. The reader accepts both versions, so a downgrade mid-rollout still
parses.

**Side effect worth knowing:** with the binding correct, `autoconnect=yes` +
`autoconnect-priority=999` finally work, so a hotspot left on now survives a
reboot. `wifiHotspotStop` still sets `autoconnect=no`, so a hotspot turned off
stays off.

Coverage: `tests/wifi-hotspot-identity.test.ts` (permanent-MAC ladder, first-ever
generation from the permanent suffix, restart reuse with zero profile creation,
recreate-after-external-delete, repair-before-activate ordering, multi-adapter
isolation across a restart, store round-trip, deterministic lookup, and the four
prune negatives). Rule E proof captured in both directions: neutering the
discovery-before-generation step reddens 5 tests; swapping the repair/activate
order reddens the ordering test alone.

## MEASURED INTERFACE THROUGHPUT [EXISTS]

`netif` entries carry TWO different throughput quantities, and only one of them
is a rate:

| Field | Meaning |
|-------|---------|
| `tp` | raw TX **byte delta** since the previous poll, over an unstated interval (legacy; kept for wire compat) |
| `tx_bps` / `rx_bps` | measured throughput in **bits per second** (additive-optional) |

`tp` cannot be rendered as a rate — nothing on the wire says how long its window
was — which is why the Network page's Bonded Links card read `0 kbps` and its
`TOTAL BANDWIDTH` never moved. `computeInterfaceRate(current, previous,
elapsedMs)` is the pure derivation: 0 with no baseline, 0 when no time elapsed,
and 0 on a counter reset (interface bounce / 32-bit wrap) so a wrap reads as
idle rather than a multi-gigabit spike. `processIfconfigOutput` takes an
injectable `now` so the window is the ACTUAL elapsed time, not the nominal
`NETIF_POLL_INTERVAL_MS`.

These are kernel counters, so they are meaningful whether or not a stream is
running — that is the point. This does NOT relax the Live-Data Discipline rule
for stream telemetry: the HUD's stream-gated `throughputKbps` is unchanged, and
`linkTelemetry` still clears on stop.

Coverage: `tests/netif-throughput-rate.test.ts`.

## RAW `active_encode` BRIDGE — SESSION vs CONNECTION LIFETIME [EXISTS]

`modules/streaming/active-passthrough.ts` holds its OWN persistent control-socket
connection, separate from the streaming session's, purely to read the raw
`active_encode` fields the published `@ceralive/cerastream` client Zod-strips
(`passthrough`, `frames_emitted`, `pipeline_playing`). Both caches it keeps
describe the SESSION — what the engine is encoding — not that socket.

**Those are different lifetimes, and conflating them made health lie.** The
bridge's `close`/`error` fire on any transient reconnect (engine restart, socket
hiccup, a read that outlived its window) — none of which says anything about
whether video is flowing. Clearing `cachedLiveness` there erased a REAL,
correctly-stalled frame counter, and `collectRealLiveness()` (`health.ts`) read
the resulting `undefined` as the genuine COLD-START case and fell back to
`processAlive` — which only reports that the supervised OS process has not
crashed. Confirmed live during a Wave H HDMI mid-stream unplug drill: health
reported the frozen counter as `degraded` for several seconds, then flipped to
`state: "healthy"`, `frames: {advancing: true, count: null}` the instant the
bridge reconnected — while a local SRT receiver had already errored out
(`Error during demuxing: Input/output error`) and the kernel reported
`power_present: 0`. The wipe also BYPASSED `FRAMES_FRESHNESS_MS`, the mechanism
that exists precisely to age a stale reading into `advancing: false`.

The caches are therefore cleared at SESSION boundaries only, and there are
exactly three:

| Seam | Why it is a boundary |
|------|----------------------|
| `readStreamingFalse(msg)` in `onLine` | an engine-AUTHORED status event saying the session ended — ground truth, clears immediately |
| `startStream()` (beside `clearStreamProcessExit()`) | a new session must not inherit the previous one's counter; the bridge holds its connection across a stop/start, so nothing else retires it |
| `stopActivePassthroughBridge()` | process teardown — nothing left to describe |

A dropped socket is NOT one of them. The retained reading ages out on its own:
`lastStatusAtMs` stops advancing and `health.ts`'s freshness window turns it into
`advancing: false` (degraded) — the honest verdict, and the one the wipe was
preventing from ever running. `cachedPassthrough` follows the same rule for the
same reason (a blip used to drop the "Passthrough active" state mid-session);
it is overlaid onto `active_encode` only when the engine telemetry already
carries one, so a retained value can never outlive a stopped session on the wire.

The cold-start fallback itself is CORRECT and must not be "fixed": on a stream's
very first heartbeat window no frame telemetry exists to judge advancement, so
raw process liveness is the only honest signal available.

Coverage: `tests/liveness-bridge-reconnect.test.ts` (the blip drives the real
`close`/`error` handlers over an injected socket; the engine-authored stop, the
fresh-start reset, and both cold-start cases are the controls).

## SESSION CONTROL CONNECTION — A DROP *IS* A SESSION BOUNDARY [EXISTS]

The exact inverse of the rule above, for a different connection. Read both
together: the same event (a socket closing) carries opposite authority depending
on what the socket is FOR.

`cerastream-backend.ts`'s `this.client` is opened once in `start()` and held for
the session's whole lifetime. It is dialled with the published client's
`autoReconnect` at its default (**false**), and that client — inspected in the
shipped `dist/client.js`, v2026.7.3 — exposes **no** close/error event, **no**
`isConnected()`, and **no** `reconnect()`. Once its Unix socket drops, the
instance is permanently unusable: `rawRequest` short-circuits on `if (!socket)`
and every later call rejects `CerastreamConnectionError("control connection is
not open", code "closed")`. Only a fresh `connect()` produces a usable client.

**Nothing was watching, and three things compounded.** Confirmed live in Wave H:
`cerastream.service` restarted mid-session and CeraUI never noticed for 11+
minutes.

1. `switchInput` (and `switchAudio` / `setBitrate` / `reloadConfig` /
   `reloadAudioDelay` / `listDevicesIfActive`) kept dispatching onto the dead
   client, rejecting identically forever, changing no state.
2. `reconcileRuntimeState()` short-circuits on
   `telemetry !== null && this.client !== undefined` — it treated a **dead client
   as proof of a live session** and re-affirmed `"streaming"` from the last stale
   heartbeat, so even the `engine-reconnect.ts` heal path's
   `reconcileStreamSession()` could not correct it.
3. `is_streaming` therefore stayed true and the lifecycle stayed `streaming`, so
   a fresh `streaming.start` was inadmissible; forced through, an engine with no
   memory of the session answered an RPC error classified `engine_internal`.

`engine-reconnect.ts` does NOT cover this: it SETTLES (`state.stopped = true`)
once the engine is reachable at boot and never re-arms, and it heals the
capability probe — a short-lived connection — not a session's dedicated one.

**The rule.** cerastream is systemd-owned (ADR-0005), so a dropped control
connection means the process CeraUI was driving went away; a restarted engine has
no memory of the session, and the client cannot re-establish one. The socket is
the ONLY handle on the engine-side pipeline, so losing it retires the session.

`noteConnectionLoss(client, error, site)` is the single seam. It acts only on
PROOF — a `CerastreamConnectionError` from the client we are STILL holding, for a
session we still believe is `active`. An engine RPC error, a request timeout, a
rejection from an already-superseded client, and our own `stop()`'s close (which
clears `active` first) are all deliberately NOT proof.

| Concern | Rule |
|---------|------|
| Detection (proactive) | `listDevicesIfActive()` — the device registry re-polls it every couple of seconds for the whole session, so it is the first call to touch a dead socket. **No watchdog timer**, so nothing can mis-fire on a missed heartbeat. |
| Detection (on demand) | `withSessionClient(site, op)` wraps every session-scoped RPC; the caller still receives its ORIGINAL error, this only adds the missing state change. `handleOpFailure` covers the queued ops. |
| Order | The dead client is dropped FIRST (see cause 2 above), with the subscription and telemetry, then `bridge.broadcastStatus()`. |
| `active` | Deliberately LEFT SET, so `stop()` still recognises the session it must tear down — clearing it makes `stop()` return `false` and trips `reportSessionInvariant`. |
| Reaction | `deps.onSessionConnectionLost(site)`. Production wiring raises the EXISTING `engine-crashed` lifecycle indicator (before the stop, since the reporter is gated on `isStreaming`), then retires the session via `stopStreamSession()` — its single owner. Fire-and-forget: it runs inside a rejected RPC's catch and must never replace the caller's error. |

Net effect: the board lands in a real `idle` and the next `streaming.start` dials
a fresh connection and succeeds — no `ceralive.service` restart.

**Scoped OUT, deliberately:** there is no transparent mid-session reconnect that
resumes the running stream. It is not achievable against this engine — a
restarted cerastream has no session to resume — and would need engine-side
session recovery first. The stream ends; the operator restarts it.

Coverage: `tests/engine-session-connection-loss.test.ts` (dead-connection
`switchInput` retires once and only once, the registry poll detects it with no
operator action, a fresh start dials a NEW client and works, reconciliation stops
re-affirming the phantom session, and the orchestrator re-admits a start; the RPC
error and operator-stop negatives are the controls, green on both trees).

## A PERSISTENT NOTIFICATION MUST BE RETRACTABLE [EXISTS]

The third instance of the same latched-stale class as `policy_route_missing` (a
flag raised but never lowered) and `active_encode` (engine truth that outlived its
session). Here the mechanism is blunter: `notificationRemaining()`
(`modules/ui/notification-liveness.ts`) returns `NOTIFICATION_LIVES_FOREVER` for
EVERY persistent notification by deliberate design — `duration` does not apply to
one — so a raise site with no matching retraction is **permanent by
construction**. `duration: 3` on the raise reads like an expiry and is not one.

Two notifications shipped that way, and both were confirmed on a board.

| Notification | Raised by | Why it could never clear |
|---|---|---|
| `hdmi_error` — BOTH "No HDMI signal detected" and the EMI/cable advisory | `modules/system/sensors.ts`, off the RK3588 dmesg lines `hdmirx-controller: Err, timing is invalid` (no-signal) and `hdmirx_wait_lock_and_get_timing signal not lock` / `hdmirx_delayed_work_audio: audio underflow` (advisory) | the kernel logs the failure and prints NOTHING when the link relocks, so the only event the watcher can see is the bad one |
| the `cerastream` channel carrying `capture_video_error` | `cerastream-backend.ts` `handleErrorEvent()` | the engine reports the Tier-2 error and never revokes it; the condition cleared and the engine returned to idle/healthy with the error still on screen |

**The retraction runs on the same evidence the source list already trusts, never
on a timer.** A timeout would hide a genuinely-still-broken condition exactly as
readily as it clears a resolved one, which is a worse bug than the one being
fixed. Both retractions therefore demand a POSITIVE, engine-authored statement
that contradicts the notification's own claim; every other outcome — an
unreachable engine, a fallback v4l2 row, an idle engine — leaves the notification
standing.

**`hdmi_error` retracts on `signal: "present"` for an HDMI-RX capture device**
(`modules/system/hdmi-signal-notification.ts`
`clearHdmiSignalErrorOnRecovery`). That verdict is stamped at `fromEngineDevice`
— the one seam that knows the ENGINE authored the row (see "THREE capture-row
states") — so it is the engine's own `VIDIOC_QUERY_DV_TIMINGS` projection saying
the port carries a picture. A row with `signal` unset reads `unknown` and proves
nothing. Four properties are load-bearing:

- **It hangs off `commitEngineDevices` (`sources.ts`), not off a broadcast.** That
  is the ONE seam every engine-authored device view flows through — the 5 s
  `recheckSourceSignals` tick, the hotplug refresh, the boot seed, the reconnect
  heal — so no path can commit a recovery the notification does not see. It runs
  on EVERY commit, deliberately NOT gated on a changed payload: a transient
  `timing is invalid` line raises the notification while the engine's own view
  never varies, and a change-gated hook would then never fire at all.
- **Scoped to `kind === "hdmi"`.** The kind heuristic tests usb/uvc BEFORE hdmi
  precisely so a "RØDE HDMI to USB-C" dongle is not mislabelled, so a working
  webcam can never retract a claim about the board's HDMI-RX port.
- **Scoped to a KNOWN message, and BOTH of them qualify.** The name `hdmi_error`
  is ONE slot shared by two claims — "No HDMI signal detected" and the
  EMI/cable-quality advisory ("HDMI signal issues detected…") — so
  `HDMI_MSGS_CLEARED_BY_LOCKED_SIGNAL` is the membership table, exactly as
  `ENGINE_ERRORS_CLEARED_BY_HEALTHY_SESSION` is for the engine channel. A blind
  remove-by-name would retract a future third claim this evidence says nothing
  about.

  **The advisory used to be EXEMPT, and that was the bug.** It was read as a claim
  about cable QUALITY, which a relocked link does not falsify. Operators reported
  the consequence — *"an infinite notification for something that is already
  corrected"* — and the board agrees with them: the two kernel lines behind it fire
  during ORDINARY link locking, so a plain unplug/replug raised an advisory with no
  retraction path at all, which then stood for the rest of the session. An
  engine-authored "this port is carrying a picture" falsifies both claims equally,
  so there is no longer any reason to treat them differently for RETRACTION. They
  are still different for RAISING: each keeps its own trigger.
- **Idempotent.** `notificationExists` answers `undefined` once it is gone, so the
  healthy steady state costs one map lookup and broadcasts nothing.

**`capture_video_error` retracts at a healthy SESSION boundary** — a concordant
`state:"streaming" + streaming:true` status frame (the engine is delivering video
right now), or the start of a new session, which must not inherit the previous
one's failure. That second rule is the same session-boundary discipline
`active_encode` follows in `startStream()`. An IDLE engine is deliberately NOT
proof: idle means "not streaming", not "the capture card works".
`ENGINE_ERRORS_CLEARED_BY_HEALTHY_SESSION` is the membership table and holds
`capture_video_error` alone — `capture_audio_error`, `pipeline_stall` and the two
SRT codes stay latched until each has an established recovery signal of its own.
The table is required because `resolved.channel` (`"cerastream"`) is ONE
notification slot shared by every non-srtla engine error, so
`standingEngineError` records which code currently occupies it; a blind
remove-by-name would retract whichever error happened to be standing.

**Both are now `isDismissable: true`, and that is a safety net, not the fix.**
`active_encode`'s precedent argues for leaving a status signal non-dismissable
when its automatic clear is reliable, and the automatic clears above ARE the
primary mechanism. But each depends on the engine being reachable and speaking:
`hdmi_error` needs cerastream to enumerate the HDMI-RX node, and
`capture_video_error` needs a later status frame or a new session. A masked or
crashed engine emits neither, and the pre-existing `isDismissable: false` left the
operator with no escape at all from a notification the device could no longer
retract. The manual affordance costs nothing when the automatic path works and is
the only recourse when it cannot run.

Coverage: `tests/notification-recovery-clearing.test.ts` (the pure verdict, the
persists-while-severed and unreachable-engine controls, the real `remove` frame
pushed to a connected client, the SAME three assertions repeated for the EMI
advisory, the foreign-device negatives, the idle-is-not-proof and shared-slot
negatives, and the repeat-heartbeat idempotence)
plus the frontend half `apps/frontend/src/tests/notification-recovery-ingestion.test.ts`
(the `remove` frame drops the entry from the persistent panel).

### THE PER-MODEM ROAMING ADVISORY — the same rule, applied per ENTITY [EXISTS]

`modules/modems/roaming-advisory.ts` (todo 40) is the first notification on this
device that is keyed **per device instance** rather than to one fixed slot, so it
carries the retraction rule in the form the rule takes when the entity can
multiply and disappear: a MEMBERSHIP TABLE of the currently-standing advisories,
reconciled on every modem broadcast against the roaming set the broadcast itself
carries.

| Property | How it is met |
|---|---|
| Retraction evidence | the modem's OWN next registration state — `status.roaming` reading `false` on a later broadcast. Never a timer. |
| Device-absent retraction | absence from a later broadcast retracts too. A device-absent modem emits no further registration states, so a per-modem evaluator would never see the evidence that falsifies its own claim, and the advisory would stand for the session on hardware no longer in the board — the `policy_route_missing` latch class exactly. |
| Slot key | `stable_key` → the legacy wire id → **suppressed**. `stable_key` is optional by todo 17's contract, so the legacy id is a real fallback, not a defensive one; a modem with NEITHER is suppressed rather than collided, because a notification `name` is the removal identity and a shared slot makes one retraction clear two claims. |
| Dedupe | raise on the ENTRY edge only. Re-broadcasts of an unchanged roaming state — including one where only the device LABEL changed — emit nothing. |
| `isDismissable` | `true`, the same safety net the two above adopted: the automatic retraction is the mechanism, but a wedged poll loop must not trap an operator under a notification the device can no longer retract. |
| Tone | `info`, not `warning`. Which is why `Notification["type"]` now imports the SHARED `NotificationType` instead of re-spelling a narrower union — the wire schema and both render surfaces always accepted `info`; only the backend's local type had drifted. |

**It NEVER gates.** Roaming is a BILLING fact. Refusing to bond a roaming link
would take a working stream off the air over a cost the operator may already have
accepted, and staying silent is how a data bill becomes a surprise — so the
advisory says the true thing and changes nothing. Three tests enforce that rather
than asserting it: a one-hop import gate (the module's only import is
`../ui/notifications.ts`), a comment-stripped grep gate over its executable
source, and a rendered-DOM assertion that a roaming row is byte-identical to a
home-network row once the badge itself is removed.

It reads `status.roaming` (the modem's registration claim) and NEVER
`config.roaming` (the operator's PERMISSION to roam) — a modem allowed to roam
that is sitting on its home network is not roaming, and advising on it would
report a setting back to the person who set it. A row with no `status` block at
all (every `router-ethernet` dongle, by construction) draws no badge.

Hooked at `broadcastModems()` (`modem-status.ts`) — the ONE seam every modem
payload flows through — AFTER the payload is on the wire and inside a `try/catch`:
an informational surface may cost an operator a badge when it fails, never the
modem list. Coverage: `tests/modem-roaming-advisory.test.ts` (28 tests, including
the real-store raise/retract through a connected client),
`apps/frontend/src/main/network/cellular-row.test.ts` and
`CellularSection.test.ts`.

## …AND ITS RAISE MUST BE SCOPED LIKE ITS RETRACTION [EXISTS]

The retraction above is scoped to `kind === "hdmi"`. The RAISE was scoped to
nothing but the board resolving as `rk3588` — not to `config.source`, not to the
active capture source, not to the pipeline, not to `status.active_encode`. The
pair was asymmetric, and the asymmetry is reachable in ordinary use.

Measured on a board (2026-07-30): **a `streaming.start` attempt probes EVERY
capture input**, so it opens `/dev/video0` in passing. On a board whose HDMI-RX
carries no cable — the normal state for an operator streaming a USB camera — that
probe makes the kernel print `hdmirx-controller: Err, timing is invalid`, and the
watcher raised "No HDMI signal detected" at an operator who was using a UVC camera
and had asked nothing about HDMI. The CeraUI journal names the driver of the sweep
exactly: `no capture input reached PLAYING (signal-less: /dev/video0,
/dev/video1)`. The claim is TRUE about the HDMI-RX port; it is simply not addressed
to anyone. And because a persistent notification never expires on a timer, the
`duration: 3` on that raise buys nothing — it stands until something retracts it,
which on a cable-less port is never.

`provesSelectionIsNotHdmi()` is the gate, and it is a **SUPPRESSION-ONLY** test —
the same discipline as the audio meter's foreign-card rule, for the same reason.
It can only ever withhold a raise PROVEN irrelevant:

| Selected source | Raise |
|---|---|
| a capture row whose engine-authored `kind` is not `hdmi` | SUPPRESSED |
| a coarse/virtual/network row that is not the `hdmi` source | SUPPRESSED |
| a capture row of `kind: "hdmi"`, or the coarse `hdmi` source | RAISED |
| nothing selected, or a selection that resolves to no row at all | RAISED |

- **Absence is never evidence.** An unset selection and an unresolvable one both
  leave the raise armed, because neither proves the operator is not watching the
  HDMI port. Do NOT "harden" this into a fail-closed check — that would silently
  drop a genuine no-signal report, which is the exact fault the notification
  exists for.
- **It reads the persisted `kind` when the live row is missing.**
  `last_seen_devices` is consulted as a fallback because the ONE moment this is
  asked — mid stream-start sweep — is precisely when the live row may be
  transiently degraded by the libuvc rebind the same sweep triggers (see A
  DEBOUNCE IS NOT AN ABSENCE GRACE). `kind` is a durable hardware property, so
  the snapshot can answer it; a live row always outranks the snapshot.
- **A renumbered camera is still recognised**, through the `previousIds` aliases
  the successor publishes — otherwise a libuvc camera would lose its own
  selection on exactly the cycle that matters.
- **The EMI/cable advisory does not take this SELECTION gate.** Its two kernel
  lines are emitted only while the receiver is actually locking or clocking a
  link, so they already describe work somebody asked for. Do not extend
  `provesSelectionIsNotHdmi` to it.
- **`hdmiNoSignalRaiseAllowed()` (the production wiring in `sensors.ts`) is
  FAIL-OPEN.** A throw reading config or the sources list is not evidence about
  the operator, so it must never be the reason a real fault goes unreported.

**The advisory DOES take a DEDUP guard, which is a different question.** Its raise
was unconditional — every matching kernel line called `raise()`, and a link that is
merely settling prints them repeatedly, so one replug cycle could re-fire the toast
several times over and could also overwrite a standing "No HDMI signal detected" on
the slot the two share. Both properties are fixed by ONE check: it raises only when
`peek(HDMI_ERROR_NOTIFICATION)` is `undefined`, i.e. only onto a free channel.

Note the deliberate asymmetry with the sibling no-signal raise, which DOES re-raise
over its own standing notification (`!hdmiNotif || hdmiNotif.msg === HDMI_NO_SIGNAL_MSG`).
That one re-asserts a condition the operator is being asked to act on; the advisory
is one-shot guidance about the physical link, and repeating it teaches nothing new.

The dmesg callback was extracted to the exported `handleRk3588HdmiDmesg(data,
deps)` so both raise conditions are drivable without a `dmesg -w` process.
Coverage: `tests/hdmi-raise-scope.test.ts` (the pure verdict table incl. the
coarse/renumber/persisted-fallback arms, the sweep raising nothing, the advisory's
dedup guard — free channel raises, own-advisory and no-signal standing both refuse,
a five-line settling burst costs exactly one raise, and the audio-underflow trigger
under the same guard — and the negative controls: a selected HDMI input with no
cable still raises, the advisory still raises past the selection gate, and the
no-signal raise's own standing-advisory non-overwrite is unchanged).

## AN INFERENCE MAY NOT OUTRANK THE OPERATOR, AND A SHARED NODE PATH NAMES NOBODY [EXISTS]

`reconcileConfiguredSourceIdentity` self-heals a persisted `config.source` across
a re-enumeration, and it is right to. But it is an INFERENCE about hardware
written into the same field an operator writes their INTENT into, and it had no
rule for what happens when the two disagree. Both failure directions were
confirmed on a board (192.168.78.131).

**A stale engine view may not overwrite a newer operator write.** The reconciler
decides against `getSourcesMessage()`, built from the engine-device cache that
`tryRefreshEngineDeviceCache` deliberately RETAINS across a failed fetch. During a
~5 minute cerastream outage every `list-devices` timed out, so the cache was
minutes old — and it still authorized a config MUTATION 7 ms after an operator
`setConfig({source})` saved a different, correct id:

```
20:05:47.125 debug sources: engine device fetch failed; retaining last-known device cache
20:05:47.132 info  sources: configured source re-enumerated under a new node path
                         — migrated by stable identity {"from":"/dev/video0","to":"/dev/video3"}
```

Retain-on-failure is the right contract for a device LIST and the wrong one for a
config write: "this device is no longer live", drawn from a view known not to have
been refreshed, is not a verdict. The fix is a compare-and-set on a monotonic
**selection token** (`sources.ts`, "Selection write token"):

- `noteSourceSelectionWrite()` advances `sourceSelectionToken` at every site that
  persists a STATED selection — `streaming.setConfig`, the `start` path's
  `updateConfig` (`streaming.ts`), and the durable live `switchInput` follow. Miss
  one and the reconciler can still overrule that selection.
- `engineViewSelectionToken` records the token as it stood when the evidence
  behind the current view was **REQUESTED**. It is captured inside
  `probeEngineDevices` BEFORE the round-trip and carried on the probe to
  `commitEngineDevices` — not sampled at commit — so a probe already in flight
  when the operator saved cannot authorize a migration either.
- The reconciler writes only while the two are equal.

The reconciler's OWN write deliberately does not advance the token (it would
refuse itself forever), and a failing probe commits nothing — so the stamp simply
stops advancing and the reconciler stands down until the engine answers again.
That IS the engine-freshness gate this defect needed, with no wall-clock bound to
tune and no permanent suppression: the next answered probe re-authorizes it, and
a migration still true then still fires.

**A node path several devices answer to identifies none of them.**
`findRememberingId` breaks that tie by PREFERENCE — whoever holds the path
outright beats whoever merely retired it — which is correct for choosing a lost
row and wrong for deciding what hardware a saved selection means. The board's own
`last_seen_devices` had FOUR entries answering to `/dev/video3` (the HDMI-RX and
the Osmo both remembering it as a retired alias, plus a pre-`stableId` snapshot
holding it outright), so the preference alone decided which camera the operator
had picked. `resolveSourceIdentity` now resolves through `unambiguousStableId`,
which requires the claimants of a path to fold to exactly ONE identity key.

- **Duplicate SNAPSHOTS are not ambiguity** — they share an identity key, so a
  `config.json` predating the identity fold still migrates and still self-heals.
- **It is suppression-only.** A refusal leaves the literal id standing, which the
  engine then answers about honestly (`resolveSourceRouting` fails closed;
  `resolvePreviewStartFrame` passes it through to the engine's typed
  `source-unavailable`). It never adopts anything new.
- `findRememberingId` is UNCHANGED and still owns `collectLostCandidates` — the
  two rules answer different questions and must not be merged.

Board proof (same board, same drill, before/after the fix): an ambiguous path
(`/dev/video9`, claimed by the HDMI-RX AND the Osmo) was silently re-pointed to
`/dev/video0` and persisted by the pre-fix binary, and left byte-identical by the
fixed one; an UNAMBIGUOUS retired alias (`/dev/video8`, one claimant) still
migrated to its live successor, so genuine renumber is unweakened. An operator
save during a real engine outage then survived 45 s of reconcile ticks AND the
engine's return with `config.json` byte-identical.

Coverage: `tests/source-selection-stale-cache.test.ts` (the F10a repro driving the
REAL `setConfig` procedure against a pre-save engine view, the re-authorization
control, the post-save genuine-renumber control, and the F10b claimant table).

## A LIVE NODE PATH IS NOT PROOF OF THE OPERATOR'S DEVICE [EXISTS]

The rule above refuses to resolve a node path several remembered devices answer
to. It only ever runs when the persisted id is NO LONGER LIVE, because
`resolveSourceIdentity` opened with a short-circuit:

```ts
if (sources.some((s) => s.id === sourceId)) return sourceId;
```

"Still live" and "still the same camera" are different questions, and the kernel
recycles `/dev/videoN`, so they come apart the moment two USB cameras are dropped
and restored in the opposite order. Measured on a Rock 5B+ with a RØDE
HDMI-to-USB-C and a DJI Osmo Pocket 3 (W4A4-F5, 2026-07-31 20:44–20:45Z, on a
binary that already carried the fixes above): the operator selected the RØDE at
`/dev/video2`, both cameras were re-authorized in the opposite order, the RØDE
landed on `/dev/video4` and the **Osmo took `/dev/video2`**. `config` was
untouched — `source: "/dev/video2"`, `pipeline: "usb_mjpeg"` — while
`/dev/video2` was now a `libuvch264` device, and a preview on the operator's own
configured source delivered **69 frames / 2 210 312 bytes with zero errors and
zero typed transitions**. The RØDE at its new node returned 47 frames / 97 741
bytes in the same minute: a 22× payload gap between two live cameras, with the
system routing the operator's selection to the one they did not choose.

Nothing could recover it after the fact. The identity layer worked perfectly —
both `stable_id`s survived and both `last_seen_devices` rows migrated — but
`config.source` persisted a node path with NO identity anchor, and after the fold
that path had several remembered claimants, so `unambiguousStableId` correctly
refused rather than guessed. The evidence has to be captured at SELECTION time.

**`config.source_stable_id` is that anchor** (additive-optional,
`helpers/config-schemas.ts`). It is written by `noteSourceSelectionWrite(sourceId)`
— so every site that advances the F10a token also records the identity, and the
two can never disagree — from `resolveSelectionAnchor(sourceId, sources)`, the
live capture row's `stableId`. A pick that names no single physical device writes
`undefined`, which CLEARS the previous anchor; leaving it would let a retired
camera govern a selection it has nothing to do with.

`resolveSourceIdentityDetailed` then verifies the live row before trusting it, and
reports the one outcome a bare id cannot express:

| Live row at the persisted path | Resolution |
|---|---|
| no anchor / not a capture row / no `stableId` | the id, unchanged (pre-anchor behaviour, byte-identical) |
| `stableId` === the anchor | the id, unchanged |
| a DIFFERENT `stableId`, anchored device live elsewhere | **migrate** to the anchored device's current node |
| a DIFFERENT `stableId`, anchored device gone | `takenOver` → `SOURCE_TAKEN_OVER_ERROR` |

- **It is suppression-only in the same sense #263 is.** Three of the four rows
  above resolve exactly as they did before the field existed, so a legacy config,
  a coarse source, and an engine that cannot vouch for a device's identity are all
  unaffected. Only positive, engine-authored proof of a DIFFERENT device changes
  anything.
- **The anchor OUTRANKS `unambiguousStableId` when the path is dead**, because it
  is the operator's own word rather than a retroactive inference — and it is the
  only thing that still works once a recycled path has several claimants.
- **A freshly stated pick carries no anchor.** `configuredSelectionAnchor(id)`
  answers `undefined` unless `id` IS `config.source`; the operator is choosing
  from the list in front of them, so the row they tapped is what they mean
  whatever it was called before. `streaming.setConfig` therefore passes NO anchor
  and writes a fresh one; only the START path (resolving the PERSISTED selection)
  and the reconciler pass one.
- **`SOURCE_TAKEN_OVER_ERROR` is distinct from `SOURCE_LOST_ERROR`** — the path
  resolves fine, it just no longer names the operator's camera. Keyed operator
  copy: `live.startFailed.source_taken_over` (10 locales).
- **Preview refuses instead of opening the inheritor.** `resolvePreviewInputId`
  answers `null` on a takeover and the proxy replies with the typed
  `{"type":"preview-error","reason":"source-unavailable"}` frame CeraUI already
  bands. The "resolves, never rejects" contract is otherwise unchanged — a true
  unplug still passes through so the ENGINE authors the reason.
- **The periodic signal recheck reconciles too**, and that is load-bearing rather
  than tidy. The hotplug refresh fires on a device-SET change, and on the board it
  fired at 20:49:00.661 with only the INHERITOR enumerated — correctly refusing to
  migrate, since there was nowhere honest to migrate to — while the anchored
  camera re-enumerated seconds later and no further set change ever fired. The
  right camera sat in the very same list for the rest of the session with
  `config.source` still naming the wrong one. `broadcastSourcesIfChanged` is the
  only periodic re-poke, so reconciling there bounds that self-heal to one
  `VIDEO_SIGNAL_RECHECK_INTERVAL_MS`.

Board proof (same board, same crossed-renumber drill, before and after the fix,
2026-07-31 20:44–20:58Z): pre-fix, the operator's selection silently became the
Osmo and previewed 69 frames / 2.21 MB of it. Post-fix, the same drill migrated
`config.source` `/dev/video5` → `/dev/video2` by anchor the moment the RØDE
re-appeared, and a preview on `config.source` returned **48 frames / 99 848
bytes** — the RØDE's signature, within 2% of its pre-fix control. The fixed binary
also corrected, on its first boot, the wrong pairing the pre-fix drill had left on
disk. Genuine same-identity renumbers still migrated throughout.

Coverage: `tests/source-cross-device-renumber.test.ts` (the anchor written through
the REAL `setConfig` procedure and cleared by an unidentified pick, the crossed
renumber routing the anchored camera, the typed takeover, the reconciler's
persisted migration, the periodic-recheck self-heal, both preview arms, and the
four regression controls: a genuine same-identity renumber, an anchorless legacy
config, an anchored path still held by its own device, and a live row with no
`stableId`).

## ANTI-PATTERNS

- Don't insert a dongle union row into the live `netif` map and filter it out of `genSrtlaIpList` later — the whole point is that a gated veth never enters that map, so bonding is safe BY CONSTRUCTION rather than by a filter a refactor can drop. And don't publish the `dongle` marker true-only: the frontend merge preserves an omitted optional field, so a marker raised that way can never be lowered (the `policy_route_missing` latch, exactly).
- Don't classify a USB network interface by its NAME — not `enx*`, not `eth*`, not any prefix. This bench's two HiLink units share one factory MAC, so one is named `enx0c5b8f279a64` and its twin falls back to `eth1`; either prefix rule badges exactly one of a matched pair. `classifyUsbNetDevice` is not given a name at all, and it must stay that way.
- Don't import modem-stack's `device-classifier.ts` across the sibling boundary (Rule D) — `usb-net-classifier.ts` is a re-derived MIRROR with its own bench-captured fixtures. And don't drop the cellular-evidence gate on top of it: modem-stack's `router-mode` verdict means "a tether with no control port", which is equally true of a plain USB-to-Ethernet adapter, so claiming CELLULAR on that alone would put the word on a wired NIC.
- Don't read only the netdev's OWN USB interface — the vendor ids, the AT/QMI ports and the ZeroCD mass-storage companion all live on the PARENT device, and those are exactly the descriptors the classification turns on.
- Don't proxy a dongle's admin UI by DESTINATION ADDRESS — identical units share one factory address, and the bench ZTE answered a request addressed to its twins' gateway, so the address selects nothing. Resolve `wire id -> interface -> that interface's own default route` and bind with `curl --interface`; a hardcoded `192.168.8.1` or a best-guess interface reaches whichever unit the kernel picks.
- Don't assume a dongle is `open` because nothing refused a read — a refusal can also be a read that never happened. `open` needs a document that STATES it (HiLink's `/api/user/state-login`, on a FRESH session); a dialect that cannot say so resolves `locked`. And don't RETAIN a cached open verdict whose read stopped answering: `open` is the only value that widens what a row offers, so this one case is the deliberate opposite of the retain-on-failure rule everywhere else.
- Don't publish `lock_state: "open"` as the ABSENCE of the field — the modem merge preserves an omitted optional field, so a row that went `locked` → `open` could never lower the claim (the `policy_route_missing` latch, exactly). All five values are stated explicitly on every row that has an admin surface; only a device with NO admin-auth surface omits the key.
- Don't fold `protocol-mismatch` into `auth-failed` — the credential was never presented, so reporting a rejection tells an operator their password is wrong when it was not tried. It is `locked` + `lock_detail.sub_reason: "unsupported-profile"`.
- Don't retry a failed `verifyCredentials`, and don't attempt one while the device reports a lockout — every dialect counts a failed login toward a window the operator cannot clear, so a retry spends the attempts that would have let them fix a typo. The lockout check reads only local state and MUST stay ahead of the transport, so a locked-out device costs zero requests.
- Don't store a credential for a device DETECTED as `open`, and don't route the three credential procedures through `modemProcedure` — a router dongle is invisible to ModemManager, and the readiness gate makes the fix unreachable in exactly the state it exists for.
- Don't log the credential procedures' args, and don't "simplify" the per-procedure omission set into a whole-namespace one — the rest of `modems.*` carries APNs, band lists and device ids that are the diagnostics the trace exists to give.
- Don't drop `--compressed` from the admin proxy, and don't forward or set an `Accept-Encoding` header — the dongle serves pre-gzipped assets and ignores `identity`, and a header set here overrides the flag and leaves curl unable to decode the reply. Stripping `content-encoding` is correct ONLY while that flag is present.
- Don't route curl's `--dump-header` to `/dev/stderr` under `Bun.spawn` — against a PIPE it never completes (`exitCode: null`, both streams empty), even though the same argv works under a shell redirect to a file.
- Don't widen the admin-UI URL rewriter. `(` is a delimiter in CSS only (in JS it opens a regex), a path must name a DIRECTORY outside CSS (a regex literal can end in a quote — jQuery's `replace(/'/g, …)` is byte-identical to a quoted path), a bare `"/"` is a separator as often as a link, and an XML/JSON body is data whatever its content-type says. Each of those refusals is a page that rendered blank on the bench before it existed.
- Don't replay a dongle's `X-Frame-Options`, CSP or `Strict-Transport-Security` onto CeraUI's origin, and don't leave `Set-Cookie` on `Path=/` — an HSTS pin locks the operator out of a board that serves plain HTTP, and two twins issue same-named cookies that would overwrite each other.
- Don't mint, template, or concatenate a `lnk_`-prefixed id outside `physical-identity.ts` — a name-shaped identity follows the NAME, and the bench twins swap names on a replug, so the next device in the socket inherits the previous unit's telemetry row. A link whose identity cannot be resolved gets `unmappableBondEntry()`'s explicit `unmappable` state and NO id. Don't "fix" the resulting refusal by giving `buildBindMapDocument` a placeholder `link_id`, by dropping the entry so the bond looks clean, or by widening `unmappableByIface` into a rung that resolves an identity from the derived interface name. `tests/link-id-authority-gate.test.ts` fails the build on the first three.
- Don't derive a second physical identity anywhere — `physical-identity.ts` is the ONE resolver and the ONE `link_id` authority, or the bind map and the telemetry registry attribute an operator's links to different devices. Don't key a classified dongle on its interface name again (that is the defect this closed), don't add an alias table unifying the serial and port rungs (a stale port alias hands the NEXT device the previous unit's identity), and don't re-key the wire's `stable_key` onto the serial rung — todo 17's consumers, the usage-policy store and the projection fixtures all correlate on the ID_PATH-derived value.
- Don't write `BIND_IPS_FILE` outside `publishBondMapping` — the two-file ADR-003 publication order (ips rename → sidecar rename as the COMMIT POINT → SIGHUP), the unique temp siblings, the fsync, and the 0600 sidecar mode are all one contract, and a second writer desynchronizes the `generation` counter the reader orders mappings by. Don't swap the sidecar write to `Bun.write`: it neither fsyncs nor sets a mode, and the reader REFUSES a group- or world-writable sidecar.
- Don't key the SIGHUP on an IP-list diff — a MAPPING-ONLY change (a link moving between interfaces) leaves the IP bytes byte-identical, so only `publication.changed`/`generation` can see it. That is the whole reason the generation increments on every publication.
- Don't collapse the duplicate-IP flag back into one answer. It stays raised and `probeExclusionReason` still refuses the link for a generic SOURCE-IP operation; bond membership is the separate `isBondCandidate` question, and two same-IP lines in `BIND_IPS_FILE` are LEGAL. Don't read the operator's bond choice out of `enabled` for such a link either — the error path forces that bit false, which is why `operatorBondOptOut` exists.
- Don't pass `--bind-map` without the pre-spawn `--capabilities-json` probe, and don't move that probe below `buildSrtlaSendArgs` — an unknown flag makes an OLD `srtla_send` exit with a usage error, i.e. a failed stream instead of a graceful downgrade. Match on NOTHING: any non-zero exit, unparseable output, or timeout is NO SUPPORT.
- Don't invent a second disposition vocabulary, and don't let the UI infer a degradation from an absent field — `bind-map-disposition.ts` emits todo 8's exact `bind_map_status`/`disposition` values for EVERY launch path, including the two the sender cannot report, and sender-reported telemetry replaces the synthesized value. A degraded band that names no collision group, or a second twin dropped in silence, is the defect this boundary exists to remove.
- Don't identify a telemetry row by its `conn_id` — that is a FILE POSITION, so a SIGHUP reload moves it and the row follows the position instead of the modem. Key on todo 10's `link_id` through `link-registry.ts`, and don't resolve a row's interface by looking its source IP up in `netif`: twins share one address, so that answered BOTH rows with ONE interface. Don't let the file-position rung outrank the sender's own `link_id` echo either — the echo names the row the sender actually bound.
- Don't index by file line while the mapping is NOT in force — without one the sender collapses duplicate source IPs, so its ids count unique addresses rather than lines. Gate it on `isBondMappingActive()` (the normalized disposition), never on whether a telemetry field happens to be present.
- Don't treat an ABSENT `bind_map_status` as a retraction — the pinned binding strips those keys, so absence means "this sender build does not report it" and the writer's synthesized verdict must stand. And don't hand the sender's verdict to `noteSenderBindMapReport` on every tick: the boundary notifies on every write, so an unchanged verdict re-broadcasts the operator band once a second.
- Don't publish `status.bond_mapping` present-only-when-degraded — the frontend status merge preserves an omitted field, so a raise-only band can be raised and never lowered (the `policy_route_missing` latch, exactly). It is an explicit value, `null` when no bond is described.
- Don't tell an operator a duplicate-IP pair "can't be used" — since the bind map those links DO bond when a per-interface mapping is in force. What the shared address really costs is every operation that steers by source address, and the `netif_dup_ip` copy now says exactly that. Don't raise it at `"error"` severity either: an excluded twin degrades the bond, it does not break the device, so the band is a WARNING.
- Don't decide the `netif_dup_ip` band inside the `intsChanged` branch, and don't derive its groups from `NETIF_ERR_DUPIPV4` — a bond-mapping transition moves no interface, no address and no flag, so a topology-gated decision can never retract the band (the `policy_route_missing` latch, exactly). `decideDupIpNotice` runs on EVERY pass against `duplicateIpGroups()` recomputed from the live addresses. And don't band a group the mapping already disambiguated: a fully mapped group is SILENT, because the per-interface `error` still rides the `netif` wire and telling an operator a handled condition is a fault is the defect this replaced.
- Don't mint a `link_id` from a counter or from array position — it must be stable across a reload with no persisted state and across a composition change, which is exactly what the `sha256(identityKey)` derivation buys. And don't publish the USB serial itself: the digest is what keeps an identity anchor off the wire.
- Don't filter the descriptor/hwdb model through `isUninformativeIdentity` — that rule judges mmcli's identity answers, where a bare numeral is measured garbage; here the bare numeral is the PRODUCT ID the classifier chose as its honest floor, so filtering it degrades `Qualcomm 9024` to `Qualcomm 05c6:9024`.
- Don't parse a router row's allocation key back into an interface name — once it carries a real `stable_key` that key is an `ID_PATH`, which names a PORT. Read the mapping the last collection recorded.
- Don't assume `duplicate_model` from a model name or a vendor table — it is true only when a second device of that exact `vid_pid` is attached right now, resolved across the whole scan. And don't "unify" `applyRouterCellularProjection` with `applyDongleProjection`: the first must never union a row in, and its `null` retraction keeps the row rather than retiring it.
- Don't commit a USB-net sweep's result without checking the generation it was issued — the netif cadence and a replug-triggered refresh overlap, and last-writer-wins republishes the RETIRED dongle's markers over the live ones. Don't coalesce on the interface set alone either (the `deps` object is half the request), don't widen the fence into a shared lock over unrelated scans, and don't drop the generation bump in `resetUsbNetMarkers()` — a sweep still reading would otherwise repopulate the caches the reset just cleared.
- Don't import the dongle metadata schema from the sibling `image-building-pipeline` checkout — Rule D forbids the path reference, and the contract itself requires each repo to carry its own reader and fixtures. Don't tighten the mirrored `driver` field into the contract's three-value enum either: a reader must ignore what it does not know, and rejecting a fourth USB-ethernet driver would drop a working dongle over a field nothing here reads.
- Don't add `enx*` to the policy-route candidate set — the image dispatcher maps only `enx*0`..`enx*7` by the ifname's LAST character, so ~half of correctly-working adapters would false-flag amber for a documented dispatcher gap.
- Don't statically import `gateways.ts` from `network-interfaces.ts` to call `queueUpdateGw` — that edge cycles, and an eagerly-wired default dials real DNS from a parser-only test. It is installed by `initNetworkInterfaceMonitoring`.
- Don't derive `no_sim` from the absence of a NetworkManager GSM profile — a profile is provisioned only after a SIM has been READ and a connection created for it, so a working card that has not registered yet has none, and the board's Quectel was reported SIM-less while its own SMS inbox and PIN2 unlock were correctly offered. Route it through `sim-presence.ts` `claimsNoSim`. Don't collapse `unknown` into `absent` either (that is what keeps a modem class from silently losing a genuine no-SIM report), don't let an `unknown` poll overwrite a `present` already seen, and don't test a SIM slot for a non-empty string: an EMPTY slot is published as the bare path `/`, so only the object-path SHAPE tells the two apart.
- Don't loosen the `@ceralive/modem-control` pin off an exact version, and don't
  re-add a runtime probe in front of `setUsagePolicy`, the SMS port or the band
  catalog. All three are STATIC imports now: the probes existed only because their
  APIs post-dated the `0.2.0` floor, and a `^`/`~` that resolved a release without
  them must fail at import rather than answer `usage_policy_unsupported` for
  hardware that is fine. Don't make `data_usage_policy.supported`
  present-only-when-true (the `policy_route_missing` latch), and don't fold the
  policy into `data_usage` — no shipped device produces
  that block, so the controls would be unreachable on every board in the field.
  Don't collapse the tri-state input into two states either: `undefined` must leave
  a persisted bound alone, or an APN-only save silently clears the operator's meter.
- Don't add a persistent notification without a retraction path — `duration` does
  NOT expire one (`notificationRemaining()` returns "lives forever" for every
  persistent notification by design), so a raise-only site latches for the whole
  session. And don't "fix" a latched one with a timeout: that hides a
  still-broken condition just as readily as it clears a resolved one. Find the
  authoritative recovery signal (see A PERSISTENT NOTIFICATION MUST BE RETRACTABLE).
- Don't retract a notification whose NAME is shared by more than one claim without
  discriminating WHICH claim is standing — `hdmi_error` carries both the no-signal
  message and the EMI/cable advisory, and the `cerastream` channel carries every
  non-srtla engine error. Key on an explicit membership table
  (`HDMI_MSGS_CLEARED_BY_LOCKED_SIGNAL`) or on the recorded code
  (`standingEngineError`), never on the bare name. Note that membership is a
  question about the EVIDENCE, not about how the claim was raised: a locked HDMI
  signal falsifies BOTH `hdmi_error` messages, so both are in that table. Don't
  re-exempt the advisory — it has no other retraction path, and its kernel lines
  fire during ordinary link locking, which is how it became the operator-reported
  "infinite notification for something that is already corrected".
- Don't move the HDMI recovery hook off `commitEngineDevices` or gate it on a
  changed payload — it must see every engine-authored device view, including the
  ones that are byte-identical to the last.
- Don't key a PER-ENTITY notification on anything an operator's hardware can
  reuse, and don't invent a shared slot for an entity that has no key. The
  roaming advisory's chain is `stable_key` → legacy wire id → SUPPRESS
  (`roaming-advisory.ts`); "fixing" the suppressed case by falling back to the
  ifname or to a constant would make one modem's retraction clear another's
  advisory. And don't evaluate it one modem at a time — absence from the whole
  broadcast is the ONLY retraction evidence a device that was unplugged will
  ever produce.
- Don't let the roaming advisory reach streaming or bonding. It is informational
  by contract (roaming is a billing fact, not a health fact) and three tests —
  an import gate, a source grep gate, and a rendered-row DOM comparison — exist
  to fail the build if it grows a control path.
- Don't raise the `hdmi_error` NO-SIGNAL notification off the kernel line alone —
  a stream-start attempt probes every capture input, so `/dev/video0` gets opened
  on an operator's behalf who never asked about HDMI. Route it through
  `provesSelectionIsNotHdmi()`, and don't turn that suppression-only test into a
  fail-closed one: absence of evidence is not evidence, and refusing to raise on
  an unset/unresolvable selection would drop a genuine no-signal report. The
  EMI/cable advisory keeps its own trigger and does NOT take that selection gate.
- Don't raise the EMI/cable advisory onto an occupied `hdmi_error` channel — its
  kernel lines repeat while a link merely settles, so an unconditional raise
  re-fires a fresh toast per line and can overwrite a standing no-signal claim.
  Raise only when `peek(HDMI_ERROR_NOTIFICATION)` is `undefined`. And don't
  "unify" that with the no-signal guard's `|| msg === HDMI_NO_SIGNAL_MSG` arm:
  the no-signal raise re-asserting itself is deliberate, the advisory doing so is
  the defect.
- Don't answer "is the selected capture device present" with a bare
  `sources.find(...)` on the Auto-audio path — the engine's device view has a
  real, NORMAL hole on every libuvc release (≈400 ms, up to 2 s), and resolving
  it literally reported a bound, streaming microphone as "No audio device". Route
  through `resolveSelectedSourceWithGrace()` (see A DEBOUNCE IS NOT AN ABSENCE
  GRACE). And don't confuse that grace with the existing debounces: those wait
  for quiet before RE-READING, this waits before BELIEVING. Don't re-measure the
  window from the memory's age instead of from the first degraded observation
  (it would be expired in steady state), don't let anything but a genuinely
  healthy observation reset the run, and don't widen it past `physical_group_id`
  absence into re-asserting a remembered `caps`/`signal` — that is the latch
  `withKnownEngineMetadata` already refuses for good reason.
- **Don't `continue` past a live capture device whose pipeline the engine does not offer** — that intersection couples two independently-versioned vocabularies, and when they disagree EVERY camera vanishes at once behind a picker that looks exactly like "no hardware attached" (board-confirmed: a locked 1080p59.94 HDMI input and a USB camera both gone, `test` the only row). Route it through `buildUnofferedCaptureEntry` so it renders disabled-with-a-reason. Don't drop the `basePipelineIds` guard either — a `test`-kind device is already the virtual row and would double — and don't widen the fallback to kinds that bridge to nothing: `mapEngineDeviceKind` collapses an unrecognised kind onto the same `"other"` as the SoC codec/scaler nodes, so widening puts `rockchip-rga` and three `hantro-vpu` blocks in the picker.
- **Don't read `setup.sound_device_dir` as if it were guaranteed to be the kernel's card directory** — it is a static value packaged into a separately-versioned `.deb`, and a value naming any other layout yields ZERO cards, so the picker collapses to its two pseudo-sources and a connected, capture-ready microphone is simply absent with nothing to say why (board-confirmed: `/dev/snd`, which has no `cardN` directory at all). Route the production scan through `resolveConfiguredAlsaCards`, keep the fallback positive-evidence-only (a configured directory that names cards is never second-guessed; a genuinely card-less board still answers empty), and keep the rescue scan unable to throw. Don't reconcile an EXPLICITLY-passed directory either — every sysfs-shaped fixture would then report the HOST's real sound cards.
- Don't decide a sound card's DIRECTION from its card id — `rockchiphdmi0`/`rockchiphdmi1` and `hdmi0`/`hdmi1` are the same two HDMI output blocks under two kernel vocabularies, so a name list alone puts speakers in the microphone picker. Ask `isPlaybackOnlyCard`. And don't "simplify" that to `!hasCapturePcmNode`: a card with NO PCM node has claimed no direction, and it is the signal-less HDMI-RX INPUT — dropping it deletes a row the operator legitimately picked.
- Don't assume a missing HDMI row is a kernel/HDMI-RX fault before checking whether OTHER capture devices vanished too — a receiver fault cannot unlist a USB webcam, and the engine's own `devices` list (`kind: "hdmi"`) plus `v4l2-ctl --query-dv-timings` will both still be correct while the projection is what dropped it.
- Don't add only ONE spelling of an onboard node to `ONBOARD_VIDEO_DISPLAY_RULES` — the v4l2 card type (`stream_hdmirx`) and driver name (`snps_hdmirx`) are different strings for the same block, and which one reaches CeraUI depends on the engine build.
- Don't re-add a coarse USB-capture placeholder row (`usb_mjpeg`, `v4l_mjpeg`, `libuvch264`, `camlink`) — a pipeline is not a device, the row is unactionable in every state, and one dual-format camera answers to two of them. And don't extend `SUPPRESSED_COARSE_PIPELINE_IDS` to `hdmi`/`rtmp`/`srt`/`test`: each names a real always-present board capability, so its coarse row is truthful with nothing plugged in.
- Don't publish a device mode family whose pipeline the engine does not offer — the pick dies at `pipeline_not_in_offered_set` AFTER the operator committed to it. Gate `buildInputModes` on the coarse capability set, and don't union two media types' ladders (ADR-0008 §10).
- **Don't add a field to `captureDeviceSchema` without adding it to `probeEngineDevices`'s whitelist copy too.** That copy (`sources.ts`) is the ONE seam a real `list-devices` payload crosses, and an unlisted field is DROPPED SILENTLY — no error, no warning. `modes[]` was unlisted for a whole wave, so todo 21's per-format families never reached the wire on real hardware: every dual-format camera published `selectedInputMode` with no `inputModes` beside it, the picker had nothing to offer, and the encoder ladder fell back to the device's UNIONED flat list (the exact ADR-0008 §10 defect the scoping exists to prevent). Read the field defensively (`const extra = d as {…}`), like the audio join keys beside it. And cover it with a test that drives the MOCK PROVIDER through the real boot path (`tests/mock-sources-parity.test.ts` `bootLikeMain`) — a test that hands `buildSources` a hand-built device literal bypasses this seam entirely, which is exactly why todo 21's 36-case suite stayed green while the feature was dead on the board.
- Don't add a config field to `configMessageSchema` and wire only the broadcast — `getConfigProcedure` is a SEPARATE hand-maintained field list, and `input_mode` was echoed by `setConfig`/the broadcast but omitted there, so a consumer asking the device what it is configured for was told the source and not the format it will be opened under.
- Don't key `config.input_mode` per device in a map, and don't let it survive a move to different hardware — it is a single field SCOPED to `config.source_stable_id`, cleared when the stable identity changes. A map needs its own retention policy and silently evicts a stated operator intent.
- Don't remember a device as `lost` because it was SEEN — only the device of the LAST-STREAMED configuration is remembered while absent, and `config.last_streamed_source` is that slot. Don't anchor it on `config.source` (a save-only edit moves that freely and must not move the slot), don't move it on `PLAYING` or on `reconcile()`'s adoption of an existing session (only the orchestrator's confirmed `transition("streaming")` is a commitment), and don't static-import `sources.ts` into `stream-session-orchestrator.ts` to wire it — that reorders module initialisation and empties the boot-time device list.
- Don't drop `config.last_streamed_source` from `mergeLastSeenLru`'s retained set — its snapshot IS the lost row, and the two exemptions come apart on exactly the save-only edit this policy exists to tolerate.
- Don't send `input_mode` when the operator never chose one — absent hands the format choice back to the engine's own precedence (H.264 first), which is the unchanged behaviour for every device and every existing caller.
- Don't route a mode pick down the scalar kind's pipeline — the same camera is `libuvch264` in H.264 mode and `usb_mjpeg` in MJPEG mode. Use `pipelineIdForInputMode`.
- Don't fork a mode-aware copy of the device-mode rule — `device-mode-truth.ts` already scopes by "the media type the KIND names", so pointing it at the SELECTED mode is the entire change (`governingKind`). And don't turn the carried-mode drop into a refusal: only an EXPLICIT pick the device does not advertise may be refused.
- Don't handle a `capture_degraded` event — there is no such event. Key on `capture_video_error` + `selected === true`. Don't give the snapshot a clearing path of its own (it inherits `clearRecoveredEngineError`), and don't move its clear BEHIND the standing-error gate: the `cerastream` notification slot is shared, so a later unrelated error would latch a capture claim the boundary disproved.
- Don't hardcode a `cooling_deviceN` or `hwmonN` index to reach the fan — both index spaces are registration-order artefacts and were measured SHIFTING across a reboot on the reference board, so a hardcoded one silently starts reporting an unrelated device. Discover by the exact `type` string `pwm-fan` (see FAN), and don't collapse "no thermal class at all" (provable `absent`) into "the read failed" (`unknown`).
- Don't assume a cooling device has a `device` backlink — on `7.1.5-ceralive-rk3588` the `pwm-fan` cdev has none at all, which made the first shipped collector report `unknown` on a board whose fan was running at `pwm1=120`. The `hwmon<N>/name == "pwmfan"` correlation covers it, and its three gates are not optional: it requires an already-confirmed `pwm-fan` cooling device, it fires ONLY when the backlink is absent (never merely because a `pwm1` read under an existing one failed — that could adopt a different fan on a multi-fan board), and two matching hwmons report `unknown` rather than a guess. Don't widen it into a general "find any fan" scan.
- Don't derive a fan percentage from `cur_state / max_state`, and don't report or infer an RPM anywhere — the levels index a devicetree `cooling-levels` table rather than scaling airflow, and the reference fan is 2-wire with no `fan1_input` at all. `pwm1 / 255` is the ONLY sanctioned duty-cycle source, and the collector deliberately never reads the cooling-level nodes so the division is unreachable.
- Don't import from `@ceralive/srtla` — that package is retired from CeraUI. Use `@ceralive/srtla-send` (the `srtla-send-rs` binding, registry dep). Check `../../../srtla-send-rs/AGENTS.md` before touching call sites.
- Don't blame "the default connection" when the elected default route sits on an interface CeraUI has already excluded — the kernel elects it from whatever DHCP hands it, and a dup-IP dongle's metric-0 lease outranks eth0. Route the decision through `decideConnectivityClaim`, and don't give `suppressed` an escalation branch: a candidate probe steers by SOURCE ADDRESS, which selects a route only where the kernel supports policy routing, so a failed probe there is evidence about steering rather than connectivity (see AN EXCLUDED DEFAULT ROUTE IS NOT A CONNECTIVITY VERDICT).
- Don't probe a duplicate-IP interface by SOURCE ADDRESS, and don't "unify" `probeExclusionReason` with `deviceBoundProbeExclusionReason` — the twins share one address AND one admin gateway, so only `SO_BINDTODEVICE` (`curl --interface`) can name one of them. Don't let a dongle's own `192.168.8.1` answer stand in for a WAN verdict either: reaching the admin API and reaching the Internet are separate assertions, and a SIM-less HiLink passes the first while captive-portalling the second.
- Don't identify an uplink by its GATEWAY address on the default-route path — two twins publish the same `via 192.168.8.1` and differ only in `dev`. `buildRouteAddArgv` replays every token for exactly that reason.
- Don't let the sharing-coexistence diagnostic write anything, gate anything, or reach a verdict stronger than `degraded` — it is read-only by construction, and every check it cannot establish is an EMITTED `unknown` rather than an omitted field (the `policy_route_missing` latch). Don't read an absent `firewall-backend` pin as a mismatch (it is a PRE-PIN image, which is normal) and don't substitute NetworkManager's compiled-in default for it — what that default is depends on the daemon's build and on whether it found an `nft` binary at start-up.
- Don't assume `10.42.0.0/24` for an NM shared prefix — the profile answers WHICH interface is shared and the netif map answers what it actually leased, so an interface with no address yet is INDETERMINATE, never missing NAT. And don't count a masquerade rule without first excluding `inet ceralive_share`: it masquerades the same prefix by design, so ignoring table provenance lets CeraUI's own NAT stand in for the NetworkManager floor it is supposed to be checking.
- Don't judge steering-rule placement against `SOURCE_ROUTE_RULE_PRIORITY` alone — the floor is the higher of that constant and the source rules the device really installed, or a rule that is legal against the constant while sitting ahead of the real source rules reads as healthy. And don't reuse `route-policy.ts`'s readers here: those are scoped to `FWMARK_RULE_PRIORITY`, so they structurally cannot see the drifted rule this diagnostic exists to report.
- Don't report an absent `ceralive_ingest_fw` as `degraded` — the ingest gateway is operator-disable-able and is not on every image, so absence is a statement about the image rather than evidence that steering touched the table.
- Don't fold the diagnostic's `nft list ruleset` READ into the steering layer's `network.nft` spawn-policy entry — it is `network.nftRead`, a bounded PROBE with a different caller and different failure semantics, and merging them would let a future write inherit a read's justification.
- Don't attribute an `ip rule` back to an interface whose address another interface also holds — `derivePolicyRouteMissing` withholds there, and a withheld interface must never be reported as "checked and faulty". Don't re-derive that ambiguity from `NETIF_ERR_DUPIPV4` either: importing it would cycle, and it lags the condition.
- Don't re-add a `dg<N>h` arm to `isBondedModemOrWifiIface` — the netns layer that created those veths is retired (phase-C todo 39), so the only board that can still show one is an old-image board mid-teardown, and flagging its veth amber reports a layer being REMOVED as a routing fault. The retired seam is regression-locked, including a stale-netns fixture whose `dg0h` rule is still present and whose table is deliberately default-less, so a re-added arm goes red rather than quietly flagging.
- Don't add `enabled === false` to `probeExclusionReason` — it is overloaded, and the operator toggling a link out of the BOND is not a statement that it may not be used to check for Internet.
- Don't "restore" `httpGet`'s bound path to `fetch`: Bun's `fetch` has no source-address option, and dropping `localAddress` is exactly what made the per-interface fallback re-test the failing default route forever. And don't retract `no_internet` only after `setDefaultRoute` succeeds — the shipped image provisions per-interface routing tables only for `modem*`/`wlan*`, so a board reaching the Internet through eth0 fails that install and used to keep an offline warning standing over a working link.
- Don't disconnect a modem's NM profile unconditionally at the end of a config save — every gsm value is consumed at bearer-connect time, so a tear-down is the only way to apply a REAL change and pure harm for anything else (board journal: `nmDisconnect err: … is not an active connection` on saves against a modem holding no bearer). Route through `decideModemReactivation`, compare NORMALIZED values (a stale APN behind an enabled automatic-APN switch is not a change), and don't read `unknown` as idle — that silently drops the operator's setting. Don't gate the profile WRITE on the same diff either: todo 50's ranking can re-point a save at a different duplicate.
- Don't write a modem's gsm settings to the SELECTED profile alone — the operator's `gsm.home-only` becomes the bearer's allow-roaming flag at `Simple.Connect`, and the bench board carried eleven same-SIM duplicates still reading `no` under an operator who had roaming OFF, so any activation of one silently registers roaming. Fan the write out through `reconcileDuplicateGsmProfiles`, keep enforcement AHEAD of the demotion and the reconnect, and classify from the PRE-demotion audit so step 2 cannot manufacture step 3's evidence. Don't delete a duplicate on a shared device+SIM alone either — `classifyGsmDuplicate` wants NM not holding it, `autoconnect: no`, AND `timestamp: 0`, and an unreadable timestamp RETAINS.
- Don't rebuild a refreshed modem by spreading the previous one and replacing only `status`/`sim_lock` — `current-modes` rides the SAME `-K` payload, and carrying discovery's answer forward latched the reported radio mode for the process lifetime AND made `applyModemConfig`'s skip guard compare against it, so re-saving the mode the dialog was showing skipped mmcli entirely and still toasted "Saved" (board-measured: wire `5g4g`, radio `allowed: 3g`). Route through `deriveNetworkTypes`/`mergeRefreshedModem`, and keep `undefined` meaning "this READ could not answer" — a payload with no mode fields, or an unparsable `current-modes`, must retain the previous block rather than blank a modem's whole mode list.
- Don't swallow a falsy `setNetworkTypes` result — mmcli answers `false` when it did not confirm and `undefined` when the spawn threw, the configure-echo parrots the REQUEST rather than the device, and the dialog locks its form to that echo. A refused radio-mode write is the wire-stable `write_failed` refusal.
- Don't add HTTP REST endpoints — all device control goes through oRPC over WebSocket.
- Don't take a lock, stamp a pending marker, or bound a discovery window in a `bluetooth.*` handler — all four are applied INSIDE `BluetoothStack`, and a second guard over one radio drifts. Don't read the stack's `bt_unavailable` as the operator's answer either: an operator-disabled device records `bluez_unavailable`, so the preference gate (`bluetooth_disabled`) must be checked first or a flipped switch reads as a broken service.
- Don't pre-refuse a `bluetooth.pair` because no `org.bluez.Agent1` is registered — a host agent or a no-auth peer can still complete one; re-LABEL the BlueZ rejection `pairing_agent_unavailable` instead. And don't build a D-Bus object exporter as a side effect of an RPC change; that is its own reviewed piece of work.
- Don't broadcast `bluetooth` straight off `onChange` — a discovery window makes an edge per advertisement per device. Route it through the debounced, payload-compared `broadcastBluetoothIfChanged`, and don't await `initBluetooth` at boot: it enables systemd units and dials the system bus.
- Don't add a silence-on-disconnect path, a device-leg re-promote RPC, or any other audio-path repair for a Bluetooth microphone — cerastream's `audio_actuator_loop` already fails over to the silence companion, rebuilds the `alsasrc` on a 3 s cadence and re-selects the device leg the moment it is healthy, and a CeraUI-side actuator would race it. CeraUI's reconnect duties are EXACTLY the meter-preference re-assert and the notification transitions (see …AND A MICROPHONE THAT DROPS MID-STREAM IS TOLD, NOT REPAIRED).
- Don't collapse `dropped` into `gone` for a Bluetooth source, and don't raise either without the grace window — BlueZ flips `Connected` for a link that dropped and retires the row for one that is gone, and a radio flaps, so an unguarded raise/clear pair turns one bad minute into a stream of toasts. And never report a device "lost" that this process has not observed CONNECTED: a trusted mic switched off at boot is exactly that case.
- Don't reorder `bluetooth-runtime.ts`'s publish steps — registry projection, then picker re-fold, then presence reconcile. Refreshing first re-derives the picker from the PREVIOUS registry view (at boot, the empty one), so a trusted microphone that just reconnected is missing from the first source list the operator sees.
- Don't dispatch a capability module's mutation without `withCapabilityModuleMutation` — the gate check and the lease are one seam, and a module that takes the lease directly skips the feature gate while a module that checks the gate directly skips the lease. Don't move the gate check after the lease either (a doomed request must not contend for a device), don't give a journaled module a lease-only request shape (the union makes it a compile error, and keeping it that way is the point), and don't turn the unproven-capability arm into a pass — it fails closed on purpose.
- Don't give `config.modem_capabilities` a `RUNTIME_CONFIG_DEFAULTS` entry, or an inner `.default(true)` — absent and `false` must be equally inert, or seven radio-mutating modules become reachable on every shipped device at once.
- Don't route `modems.getCapabilities`/`setCapabilities` through `modemProcedure` — the gates belong to the DEVICE, and the readiness middleware would make the settings surface unreachable while the cellular stack is initializing or with no modem attached, which is exactly when an operator opens it. And don't persist a gate for a module `IMPLEMENTED_MODEM_CAPABILITY_MODULES` omits: its key is read by nothing, so the operator gets a switch that can never act — refuse it.
- Don't fire `noteCapabilityEvidenceChanged()` on every probe read — it is change-gated so a dialog open does not re-broadcast the whole roster. Don't static-import `modem-status.ts` to install its notifier either (that module reaches `capability-gates.ts` through the wire producer, so the edge cycles), and don't drop the inert default: a suite that never installs one must stay byte-identical.
- Don't add a modem-mutating path that does not route through `withModemMutation` / `withJournaledModemMutation` / `beginModemMutation` — the enforcement suite has one test per inventoried entrypoint and a new route with no test is a route with no lease. Don't build a second lease beside `getIsStreaming()` either: that check is false for the whole admission window, which is exactly the window a mutation must not land in.
- Don't guess a mutation key for a device with no resolvable `stable_key` — the identity contract permits its absence, and a guessed key files one device's rollback under another's slot. Refuse with `identity_unresolved`, and don't turn that refusal into a throw at an RPC boundary.
- Don't reorder or shorten the journal's `temp -> fsync(temp) -> rename -> fsync(parent)` sequence, and don't move the parent-directory fsync outside the commit boundary — until that entry is durable a power cut can lose the rename, and a mutation whose armed record can vanish is the exact case the journal exists to prevent.
- Don't make the replay barrier a boolean, and don't refuse an INTERNAL boot origin with it — restoration terminalizes its one-shot marker on an unhandled refusal and autostart records a failed result with no retry, so refusing either destroys the boot intent rather than deferring it. Don't move restoration's await below its marker READ either.
- Don't let anything but VERIFIED-ROLLBACK or FORCE-REBASELINE unblock a failed mutation, and don't archive before the `acknowledged` write commits — that ordering is what makes a crash between the two replayable instead of a lost operator decision.
- Don't make `decommissioned` terminal, and don't let it hold GLOBAL streaming: identity is PORT-based for serial-less devices, so a replacement modem inherits the key and must be caught as `recommission-pending`, while a destroyed modem must never strand the remaining links.
- Don't release the `modem.reconfig` mutation lease when the handler returns — its 30 s confirm/auto-revert watchdog is still live, and that window is precisely when the modem is half-applied.
- Don't acquire the lifecycle interlock ahead of the orchestrator's duplicate-start rejection — a second `streaming.start` would then answer a generic lease-busy refusal instead of its own `START_IN_PROGRESS`, and the duplicate is the one case the operator can act on. Don't move the acquisition into `streaming.procedure.ts` either (four other launch origins bypass it), don't default `admitLifecycle` on inside the orchestrator factory (the lease is process-wide and `bun test` is one process), and don't release by HOLDER instead of by grant token — a stale `finally` would then free whoever holds it now.
- Don't move either cellular guard below `initModemUpdateLoop` in `main.ts`, and don't reorder them relative to each other — the loop's first discovery + `modems` broadcast fire immediately, and `initCellularStack` publishes `{ready:false}` synchronously, so a reordered boot puts the operator's first modem snapshot inside the window where every modem procedure refuses `CELLULAR_STACK_INITIALIZING`. Don't reclassify either as `runCritical` either: the dbus→mmcli fallback lives INSIDE the stack, so reaching the guard means the cellular subsystem is down and the device must still keep its UI.
- Don't rewrite `buildModemsMessage` in terms of the projection, and don't delete it as dead — it is NOT on the wire (`buildModemsWireMessage` is) precisely so it can stay the independent implementation `modem-wire-projection.test.ts` asserts byte-compat against. "De-duplicating" it makes that assertion compare the projector to itself. And don't drop the fail-safe fallback: the additive fields are enrichment, the legacy ones are the operator's whole modem list.
- Don't fabricate a `stable_key` for a modem whose `ID_PATH` did not resolve, and don't clear the id-path cache when a refresh FAILS — absence yields the pre-Phase-B wire (honest), while a cleared cache makes every row look like new hardware to a frontend correlating a USB-mode switch. Don't refresh it on the 30 s status poll either: an `ID_PATH` names where a device is plugged in, so only presence edges can move it.
- Don't build the `ifname → ID_PATH` map from `@ceralive/modem-control`'s `createUsbEnumerator()` — `UsbDeviceSnapshot.ifname` is declared and NEVER populated (that enumerator keeps only `DEVTYPE=usb_device` records, which carry no `INTERFACE`), so the map was empty on every real board and the fail-closed identity contract refused EVERY modem mutation with `identity_unresolved`. Read udev's NET records (`modem-id-path-source.ts`). And don't test it with a hand-built device list carrying an `ifname` — that is exactly the fixture shape that kept this green; drive the parser with verbatim `udevadm info --export-db` output.
- Don't match a USB snapshot on `device.ifname` ANYWHERE — the bullet above is about the wire producer's map, and the SAME dead field was still being matched in `defaultResolveIdentity`, so every capability module (`ussd`, `gps`, `band-lock`) and `modems.getUsbModeOptions` answered `unknown_modem`/`identity_unresolved` on real hardware while `stable_key` was correct on the wire. Derive the key from `modemStableKeyForIfname` and match the snapshot's `physicalUid` through `deriveModemStableKey`. And don't add a THIRD resolver: the capability modules take `resolveModemIdentityAnchor`, which is a reuse of the same fixed source.
- Don't read a USSD status ONCE, immediately after a turn, and treat what it holds as that turn's answer — `--3gpp-ussd-respond` returns in 60 ms without waiting for the network, so for ~570 ms the state reads `idle` (reporting a live dialogue closed) and the RETAINED property still holds the PREVIOUS turn's menu, which then reaches the operator as this turn's reply. Snapshot the property BEFORE dispatching and wait for arrival; a bound that elapses must yield NO reply, never the retained value.
- Don't match a USSD reply on a key called `reply` — mmcli uses that word as a key nowhere. The action line's key is the whole sentence `… new reply from network`, and the `-K` key is `modem.3gpp.ussd.network-request`. Don't route that value through `mmcliParseSep` either: it logs an unsplittable line verbatim, and every value here is subscriber content.
- Don't let `fromDbusView` re-derive a fact `fromMmcliModem` already derives. `"dbus"` is the DEFAULT backend, so an mmcli-only fix ships and reaches NO device — three separate defects took this shape at once: the garbage-identity name fallback (bypassed by a hand-rolled `buildDbusName` that even claimed byte-identical output while implementing a different rule), `registration_rejection`/`packet_service_state` (never folded, leaving the whole `REJECTION_REASON_KEYS` operator-copy surface dead code), and the 3GPP scan results. When you add a fact to a modem row, name which of the TWO adapters you taught.
- Don't hand a child process its own deadline and leave the outer wrapper on a default — the shorter of two contradictory timeouts wins, silently. `mmNetworkScan` passed `--timeout=240` to mmcli while `run()` killed it at its 30 s default, and a board-measured 27.8 s cold scan sat 2.2 s inside that cap, so the scan failed INTERMITTENTLY and read as a hardware flake. The outer budget must be strictly larger.
- Don't dispatch a modem scan without a completion object that owns the mutation lease and publishes a terminal lifecycle marker. `scanModemProcedure` returns once admission is known, but the background completion is observed, releases the lease in `finally`, and broadcasts `network_scan` with the same generation returned as `scanGeneration`. A bare `void` promise recreates silent failures and admits streaming mid-scan. And don't collapse "found nothing" into a failure: an empty completed result is a real answer about coverage.
- Don't clear an in-flight marker on `Modem` through a CAPTURED reference. `mergeRefreshedModem` immutably REPLACES the object each poll (so the T11 diff can see a change by value) and spreads the previous one, so the flag rides forward onto the replacement while a `delete` on the old object mutates something nothing reads. Board-measured: one scan latched `is_scanning` for the process lifetime — every later scan refused `already_scanning` and the row read `connection: "scanning"` forever, since `buildModemStatus` derives that label from the same flag. Clear it through the state map (`clearScanningMarker`).
- Don't drop the `syntheticIds` round-trip through `buildProjectedModemsMessage` — the projector deliberately does not own that state, and without it every poll renumbers the dongles under the operator.
- Don't decide which adapter produces a radio row from `config.modem_backend` — read the backend the stack COMMITTED (`getCellularStack()`), or a `dbus` request that fell back to mmcli advertises a detail block nothing observed.
- Don't publish an MM restart's first resnapshot verbatim — it legitimately answers `modemCount: 0` **18 ms** after the daemon re-acquires its bus name and refills over ~20 s (measured, todo 16 gate 4), so forwarding it blanks the operator's modem list on every restart. Route a new epoch through the cache's `settling` merge, match carried rows on the `ID_PATH` anchor (MM renumbers the WHOLE roster across a restart), and don't shorten `EPOCH_SETTLE_MS` below the measured refill.
- Don't collapse the two observation failure classes into one "unavailable" state — `bus-error` means MM is alive and mmcli is a real second opinion (demote below it), while `source-unavailable` means mmcli talks to the SAME dead daemon (retain the rows, mark them, claim nothing healthy). Falling back on the second is how a device reports a confident empty modem list about hardware nobody could see.
- Don't drive the D-Bus cache from `ObservationList` events — the observer suppresses a list emission when no row FINGERPRINT changed and the fingerprint ignores signal quality, so a signal-only refresh delivers a tree and NO list. Fold the tree `onEpochRefresh` hands over; use the list only for the start commit test and the failure classes.
- Don't add `Modem.Signal.Setup`/`SetupThresholds` to reach for extended signal metrics without treating it as its own reviewed change — it WRITES, `dbus-audit-transport.ts` refuses it by name, and that fail-closed guarantee is the reason it is safe to point the fleet default at the daemon mmcli is driving. `Modem.SignalQuality` already arrives push-driven without it.
- Don't assume `observer.stop()` cleans up after a late-resolving `start()` — it is IDEMPOTENT, and the observer's `start()` has no stopped-check before `#subscribeAll()`, so a start that outlives `withDeadline` re-issues all four match rules and the observer will never retire them again. The backend's own generation (`refuseSubscriptionsOnceAborted`) is what closes that leak; a bare "no cache writes" assertion passes while four rules leak.
- Don't let a provisional udev row be anything but LAST and CONDITIONAL in `collectSources()` — the claimed-key set is what makes precedence structural, so a row consulted before the authoritative sources are collected can displace one. And don't merge FIELDS in either direction: an optimistic row has observed nothing to merge, which is why supersession retires it outright.
- Don't key the provisional merge on todo 10's identity key — the two sides of it sit on DIFFERENT rungs (udev publishes a serial, a D-Bus row publishes only a path), so the keys would never match and the optimistic row would sit beside its own authoritative row. `deriveModemStableKey` is the key both sides always carry, and it is what survives the `9024`⇄`9091` flip.
- Don't hand a raw `Modem.Physdev`/`Modem.Device` sysfs path to anything that compares `stable_key` — it names the same socket as a udev `ID_PATH` in a different vocabulary, so supersession silently never fires (todo 24: two rows per stick, 10/10 cycles, with todo 18's suite green throughout). `deriveModemStableKey` normalizes for you; use `canonicalModemIdPath` where the path is also STORED. And don't paper over the next instance of this with a compare-time fuzzy match or a third key format — normalize at the derivation, to the ID_PATH shape.
- Don't write a supersession fixture with the same key encoding on both sides — that is precisely the gap that let this ship. Pair an `ID_PATH`-keyed provisional row against a SYSFS-path-keyed authoritative one, and assert on the WHOLE payload length: a key-filtered assertion cannot see the duplicate row under the other encoding.
- Don't accept a `usb_interface`, a `bind`/`change`, or an attach with no `ID_PATH` as a provisional row — the first draws one composite stick as several rows, the second describes a device already present, and the third can never be superseded, which is the ghost class this feature must not introduce.
- Don't make the retained modem poll status-only again, and don't gate modem presence on `modem-added`/`modem-removed` — the production `NmcliMonitorManager` structurally cannot emit either (`nmcli monitor` has no view of the ModemManager lifecycle), so those arms are mock-only and presence would once more be established just once, at boot. Board-measured: a Fibocom FM350-GL created 46 minutes after boot was never registered, never got an NM profile, and sat `registered` with a live SIM and no IP while CeraUI kept polling two indices that no longer existed. And don't read an unreadable `mmcli -L` as an empty roster (`?? []`) — at the 30 s cadence that evicts every modem's resolved profile on one transient failure; `undefined` retains, `[]` is authoritative.
- Don't reach for the npm `udev` binding, and don't drop `--udev` from the monitor's argv — the binding is an unmaintained native addon a `bun build --compile` binary cannot load, and the `--kernel` events that precede rule processing carry no `ID_*` properties at all. Don't skip the cache clear on a monitor restart either: the child has no replay, so a detach during the gap leaves a row nothing can retire.
- Don't seed the dev dongle fixtures PAST `dongle-metadata.ts`'s deps seam, and don't freeze their `updated_at_ms` — entering as file CONTENT is what keeps the real schema/staleness/ambiguity rules on the dev path, and a frozen timestamp makes the rows silently vanish after 90 s. Don't give the duplicate-MAC HiLink pair different MACs to "fix" the fixture: that collision is the whole reason identity is `ID_PATH`-keyed.
- Don't write a raw ifname as the mmcli-side shadow `deviceKey` — the observer side is opaque-hashed, so the join fails and every cycle emits a matched `only-in-mmcli` + `only-in-dbus` pair instead of a real divergence. That is the state the retirement runbook calls a gate blocker, and it looks like data rather than a bug.
- Don't give `modem_provisioning` a default, and don't move the provisioning check behind the emulated/streaming ones — default-absent-and-first is what makes a modem re-enumeration unreachable on an unprovisioned device. And don't let `setUsbMode` return `{success:true}` while the transition transaction is unimplemented: past the gates the honest answer is the typed `transition_failed`.
- Don't re-serialise the DNS health check ahead of the caller's query in `dnsCacheResolve`, and don't share one `Resolver` between them — the check only GATES the answer, and a shared c-ares channel's `cancel()` would abort the sibling leg. Both legs sit inside the per-attempt launch deadline (see DNS ON THE STREAM-START CRITICAL PATH).
- Don't use `process.exit` directly — use `invariant` from `helpers/invariant.ts`.
- Don't serve `revisions.cerastream` from a cache, and don't retain the last-known value when the engine is unreachable — the engine is a separate systemd-owned process that can be restarted or upgraded mid-session, so a retained version keeps naming a build that may not be installed. Re-probe (`refreshEngineRevision`) and report `ENGINE_UNREACHABLE_REVISION` honestly.
- Don't read config files with raw `fs` — use `helpers/config-loader.ts`.
- Don't drive the engine directly — route through `getStreamingBackend()`, never
  the `cerastreamBackend` singleton.
- Don't refuse a software update with a bare `return`, and don't re-check the
  update guards at a call site — `startSoftwareUpdate()` owns every refusal and
  always names it (see SOFTWARE-UPDATE START CONTRACT).
- Don't let an update CHECK end without publishing something: route every cycle
  through `runUpdateDiscoveryAndReport()`, and don't derive a check failure from
  apt's stderr (benign warnings) or clear one on a stale-list discovery success —
  that is how "up to date" came to mean "couldn't reach any repo" (see
  SOFTWARE-UPDATE CHECK CONTRACT).
- Don't send the idle-meter preference through the typed `reloadConfig()` — the published client Zod-strips `audio.meter_device`; it goes over `rawRequest` behind `supportsMeterDevicePreference`. And don't send `undefined` for "Auto": absent means *unchanged*, `null` means Auto.
- Don't report a suppressed foreign-card level as `no_device` when CeraUI still lists the selected card AND that card owns a capture PCM (`isMeterPreferenceDevicePresent()`) — that makes a mis-bound meter indistinguishable from an unplugged cable — and don't try to fix a sustained mismatch by re-pushing the same preference value: `set_preferred_device` early-returns on an unchanged value, so the re-assert must pass through `null`.
- Don't equate "the card is in `audioDevices`" with "the card can deliver audio" — a permanently-enumerated input with no capture PCM (idle HDMI-RX) is genuinely `no_device`, not `not_selected_device`. Gate presence on `audioCaptureCardIds`/`hasCapturePcmNode`, and don't "simplify" that by filtering the card out of the picker instead.
- Don't identify the HDMI-RX audio card by ONE card id — the vendor 6.1 BSP calls it `rockchiphdmiin` and mainline/edge 7.1 calls the same physical port `hdmirx`, so a single hardcoded string makes rule 3 miss, fall through in silence, and never bind HDMI audio at all on the other kernel (board-proven: that card captures real, non-silent audio). Add every spelling to `HDMI_CARD_IDS` and to `ONBOARD_AUDIO_DISPLAY_RULES`, keep the first-enumerated-wins ordering, and ask the capture gate about the spelling that MATCHED. Don't "generalise" it into "bind whichever card can capture" either — that answers capability, not identity, and would hand an HDMI source somebody else's microphone. And don't add the second id to `RK3588_AUDIO_SRC_ALIASES`: that table is inverted by `getAudioSrcReverseAliases()`, so two ids under one label break the vendor board's `getAudioSrcId("HDMI")`.
- Don't let Auto rule 3/4 bind their FIXED card on enumeration alone — that is the same "listed ≠ recordable" confusion one layer up, and it made every `asrc: "Auto"` start on the board's HDMI source die `audio-device-unavailable … not_retriable` even with a locked signal. Pass `captureCapableCardIds` and refuse with `no-capture-audio`. Keep the refusal FAIL-OPEN (an absent set binds exactly as before), keep it resolving to the `"No audio"` pseudo-source rather than a `null` asrcKey (a `null` OMITS `asrc` and hands the engine its legacy inference over the port that cannot deliver), and don't extend the gate to rule 5 — its candidates already come from the engine's `list-devices`, which never lists a capture-less card.
- Don't infer "the operator wants no meter" from a `null` meter preference — `null` also covers the pipeline default and an "Auto" that resolves to no single card, each of which legitimately meters whatever the engine picks. Ask `isMeterSilencedByPick()`, key the selection-change detection on the `(silenced, preference)` PAIR, and don't let an engine-sent `unavailable` reason outrank an explicit "No audio".
- Don't short-circuit `AUDIO_SOURCE_AUTO` to a `null` meter preference — "Auto" is a DETERMINISTIC resolution (`resolveAutoAsrc`), not a hand-back, so route it through `resolveEffectiveAudioPick()` and let the meter prefer the same card the start path would use. Getting this wrong is doubly invisible: `null` makes the engine auto-pick AND disarms `isForeignCardLevel`, so the meter draws a different device's real moving bars for a pick whose own start fails. And don't ask `isMeterPreferenceDevicePresent()` about the raw sentinel — `audioDevices["Auto"]` is undefined, so every Auto pick would report `no_device` and a genuine mismatch on a healthy card would lose its `not_selected_device` reason.
- Don't re-push the meter preference only when `asrc` changed — under "Auto" the resolved card is a function of the selected VIDEO source (rule 3) and of the ENGINE's audio list (rule 5), so `input.source` changes and `reresolveAudioForEngineChange` must re-push too. An unchanged pick is deduped by the bridge and costs nothing; a missed changed one is permanent, because `set_preferred_device` early-returns on an unchanged value.
- Don't leave a pick change to be corrected by the next engine frame — the level already broadcast belongs to the previous pick, so `noteMeterSelection()` must retire it immediately (and must stay silent on an unchanged pick, or every re-enumeration blinks the meter).
- Don't let the meter's ONLY recovery path be driven by arriving frames — that gates the retraction on the very signal whose absence IS the failure, and a feed that stops leaves a bare `Meter unavailable` forever. Keep BOTH watchdogs: `noteForeignCardLevel` for frame CONTENT and `armFrameAbsenceWatchdog`/`noteFrameAbsence` for frame ABSENCE. And don't "simplify" the absence one into a poll that compares `now()` against a last-frame stamp: the debounce-on-arrival shape is what makes expiry *proof* of absence and an unarmed watchdog *proof* that no baseline frame has arrived yet — a poll needs a second flag for the first-connect case and gets it wrong. Don't move the re-arm below the silenced/Auto gates either (a silenced feed would stop being watched and never resume), and don't give it its own reassert cadence — it shares `lastReassertAt` so the two triggers can never double up.
- Don't let either audio-meter watchdog re-assert while a stream launch is in flight — a re-assert is an ACQUISITION of the selected card, and the engine's bounded self-release retry cannot beat a peer that is actively taking the device back (the start dies `audio-device-unavailable … not_retriable`). Gate both on `launchInFlight()`, keep the check immediately BEFORE `lastReassertAt` is stamped (or a deferral silently becomes 30 s of suppression), and keep the re-arm above every gate. Don't widen the gate past `starting` either: `streaming`/`idle` are where a genuinely dead feed must still be recovered.
- Don't fold `active_encode` into telemetry preserve-on-omission past the end of a session, and don't let `stop()` rely on a final engine status frame to clear it — a crashed engine sends none, and the stale encode then renders the stopped session under a "Live" badge.
- Don't clear the raw bridge's `cachedLiveness`/`cachedPassthrough` from its own socket `close`/`error` — that is a CONNECTION blip, not a session boundary, and wiping there hands `collectRealLiveness()` an `undefined` it can only read as a cold start, so a dead stream reports `healthy` off raw process liveness. Let `FRAMES_FRESHNESS_MS` age the retained reading out instead.
- Don't apply that same rule to the SESSION-scoped control client — it is the inverse case. Losing `cerastream-backend.ts`'s `this.client` retires the session (the published client cannot reconnect and a restarted engine has no session to resume), so route every session RPC through `withSessionClient` and never swallow a `CerastreamConnectionError` without calling `noteConnectionLoss`. And don't treat `this.client !== undefined` as evidence the engine is reachable — that is exactly how `reconcileRuntimeState()` re-affirmed a phantom "streaming" state off stale telemetry until the backend was restarted.
- Don't apply `STOP_DEADLINE_MS` to a config-change transaction, and don't "simplify" the queued-stop branch in `stop()` into the normal stop path — a 12 s deadline against a 65 s worst-case change reports healthy hardware as `stop_failed`. Size anything bounding a change from `RECONFIGURE_DEADLINE_MS`.
- Don't drop `parkStop()`'s deadline or its `warn`, and don't demote that `warn` to `info` — only a settling transaction can release a parked stop, so without the deadline a broken transaction strands the operator's Stop with no ceiling and no journal line, and the production console transport hides `info` (see "But QUEUED is not UNBOUNDED"). Board-measured pre-fix: 4.4 s of an unanswered Stop with a frozen lifecycle and an empty journal.
- Don't measure a board stop/start cycle with a WebSocket client that stays silent between RPC calls — `pruneStaleClients()` closes any socket with no INBOUND frame for `HEARTBEAT_STALE_THRESHOLD_MS` (15 s, swept every 5 s), and the pending call then resolves as a phantom "the backend hung". Reproduced exactly: 1 apparent hang in 5 cycles with a silent harness, 0 in 10 with the same harness answering `ping` with `pong`, same binary and same trigger. Answer the heartbeat, and assert on `socketClosed` before believing a hang.
- Don't hardcode `65000` (or `60000`) anywhere — the bound is DERIVED in `@ceraui/rpc` `config-change.schema.ts` from cerastream `docs/adr/schema.md` §11's phase table, so a shrunken engine budget fails a test instead of silently invalidating the number. The published bindings deliberately do NOT ship this constant.
- Don't delete `handleEvent`'s `config-change` case as a duplicate of the RPC return path — it is the ONLY thing that settles a transaction whose engine escalates and then exits (the RPC then rejects on a dead socket), and dropping it strands the UI in `applying`.
- Don't send a UI resolution rung on the apply-now path — the engine speaks `WxH` pixels and rejects `'720p'` outright. Route it through `toEngineResolution`, the same map the START path uses, and don't "simplify" the unknown-token branch into dropping the axis.
- Don't collapse every rejected `change-config` dispatch into `rollback_failed{engine_connection_lost}` — a `CerastreamRpcError` means the transaction never began and the stream is untouched (`reverted{change_rejected}`). Keep `rollback_failed` as the DEFAULT for every other rejection, so an unrecognised failure can never claim a possibly-dead stream is fine.
- Don't persist an apply-now candidate before the transaction says `applied`, and don't add a `reverted`-specific write — until then `config.json` still describes the session the engine is actually running.
- Don't reconcile a params-vs-config mismatch without the in-flight marker — that mismatch is normally a legitimate "apply on next start" intent, and reconciling it overwrites the operator's choice on every boot.
- Don't ask the armed-stream marker anything before asking the ENGINE whether it is streaming — a marker survives a backend restart exactly as it survives an engine death, and only the engine can tell the two apart. Adoption short-circuits ahead of every marker gate; invert that order and a backend-only restart launches a SECOND session.
- Don't gate restoration on an engine session id, and don't "upgrade" `diagnostics.engineSessionId` into one — the adoption seam never carries it, `start()` drops the one the engine does return, status events have none, and the engine's ids are process-local counters that collide across restarts (a restarted engine re-issues `cs-1`).
- Don't call `stopStreamSession()` without stating a cause, and don't default it — the engine-loss path and an operator Stop reach the identical function, so an implicit cause either forgets every crash or restarts a stream the operator deliberately ended. `operator` clears the marker; `engine_loss`/`reconfigure` preserve it.
- Don't restore across a `boot_id` mismatch, and don't treat an UNREADABLE boot id as a match — both fail closed on purpose. A device reboot never auto-restarts a stream; that is a separate product decision, not an oversight.
- Don't turn the one-shot into a retry loop. BOTH outcomes write a terminal attempted-state before anything else, and that is the whole guarantee — an attempted marker is never attempted again, in either direction.
- Don't move the planned-shutdown suppression into its own flag file — stamped onto the marker it dies with the thing it suppresses; as a standalone file it needs a clearing rule whose failure mode is restoration silently dead forever.
- Don't drop the write-path `armedStreamMarkerSchema.parse()` as redundant with the read-path one — the snapshot is copied out of the runtime config, which also holds `password_hash`/`ssh_pass`/`remote_key`, so that parse is the credential barrier.
- Don't let a restoration launch read `getConfig()` — pass the marker's snapshot through `startStream`'s `configOverride`, or a deferred (non-`apply_now`) edit gets applied by a restart the operator never asked for.
- Don't give restoration a private commit path around `onStreamCommitted` — routing it through the ordinary idempotent hook is exactly what keeps todo 22's `last_streamed_source` slot from moving.
- Don't add a second deadline racing the launch's own retry machinery for the 30 s restoration bound — it is RECORDED per attempt (`elapsedMs`/`withinBound`), not enforced, so a healthy-but-slow start is never reported as a failure.
- Don't remove either `runInflightConfigChangeReconciliation()` call site (boot in `main.ts`, the heal in `engine-reconnect.ts`) — for a whole wave the crash-window reconciler existed, was correct, and was called by nothing but its own test, so a leaked marker was the observable behaviour while the docs claimed the safety net was armed. And don't hand the judge the ENGINE's own vocabulary: it compares `config.json` values, so a raw `"3840x2160"`/`29.97` reads as "neither params set" — an eternal `wait` that never retires the marker. Route it through `buildEngineEncodeSnapshot`.
- Don't decide "the engine is not streaming" from `is_streaming` on the reconciliation path — that flag is false for an idle engine AND for one reconciliation has not reached yet, so it turns a NON-ANSWER into `retain_previous` and discards a change the operator actually got. Only a lifecycle of `idle` is decisive.
- Don't re-add stderr regex on the cerastream path — engine errors are structured
  codes mapped via `cerastream-error-mapping.ts`.
- Don't wire `@ceralive/cerastream` as a sibling `link:` or vendored `.tgz` — it
  is a public-npm registry dep by design; bump the pinned version in
  `package.json` to track the engine.
- Don't multiplex the control channel onto the BCRPT relay socket — the two channels are independent by design (different token audiences, different endpoints, different authority models).
- Don't add secret-bearing event types to `RELAYABLE_TYPES` — the no-secrets contract test will catch it.
- Don't delete the `devices`/`pipelines` broadcasts or the `capabilities.device_modes` field yet — they're deprecation shims kept for one release (`TD-legacy-source-broadcasts`); route new consumers through `getSources()`/the `sources` broadcast instead.
- Don't resolve the "Auto" audio pick from device NAMES — name similarity is not evidence of shared hardware, and the prefix matcher it replaced served a different device's microphone as the camera's own. Route through `samePhysicalGroup()` on `physical_group_id`, and don't collapse it to `a === b`: an ABSENT group must never match another absent group (ADR-0008 §6). Don't re-add a `usb-alias`/`first-device`-style fallback either — with no same-group card the honest answer is the typed `no-same-device-audio`, and with several it is `ambiguous-same-device-audio` with NO auto-pick.
- Don't assume the audio label/identity maps are fresh because a hotplug ran — the ENGINE's audio list arrives later and separately, so `commitEngineDevices` must keep firing the re-resolve on a changed list. And don't "simplify" that handler into a full `updateAudioDevices()` call: the sysfs scan has not changed, so it would raise a spurious lost verdict and blink the meter.
- Don't re-add an operator audio-device rename/alias surface (RPC, contract entry, or config field) — device naming is code-level only (`ONBOARD_AUDIO_DISPLAY_RULES` + `cleanAudioDeviceName`); the #206 alias layer was removed in #207 by product decision. The same holds for VIDEO (`ONBOARD_VIDEO_DISPLAY_RULES`) — no rename affordance for any device, of any media type.
- Don't re-apply an onboard display-name rule at a render site (a Svelte label, a summary derivation) — it belongs at the device-construction seam (`fromEngineDevice`), which is why the row and the "Configured" label are both fixed by one call.
- Don't re-derive `pipeline`/`selected_video_input` resolution inline in a new procedure — route through `resolveSourceRouting()`/`deriveEngineRouting()` in `modules/streaming/sources.ts`.
- Don't dispatch an `input_id` to the engine from ANY path without resolving it by stable identity first — the preview leg was the one that skipped it, and a renumbered device streamed while refusing to preview. And don't "upgrade" `resolvePreviewStartFrame` to `resolveSourceRouting`: preview must RESOLVE without REJECTING, or a true unplug loses the engine's typed `source-unavailable` reason to a silent drop.
- Don't validate an encode target against a device ladder with a second, local copy of the rule — `@ceraui/rpc` `capabilities/device-mode-truth.ts` is shared with the frontend precisely so the offering and the save path cannot disagree. And don't turn its fail-open guards (no ladder, coarse source, un-normalizable payload) into refusals: blocking a save the hardware can honour is the same dishonesty as allowing one it cannot.
- Don't report a `streaming.setConfig` result without reading `result.success` — a device-truth refusal RESOLVES, it does not throw, so a bare try/catch toasts "Saved" over a config the device rejected.
- Don't add a country→channel table anywhere — the hotspot channel set is DERIVED by applying `iw reg set <CC>` and parsing `iw phy` back out (`regdomain.ts`), because the legal set depends on the kernel's regdb version, the radio, and self-managed adapters. And don't validate a channel with `isWifiChannelName` alone: that is a SHAPE check, and legality is `isChannelOffered` against the runtime-derived set.
- Don't union two wiphys' channel lists, and don't clamp a live AP off the air on an EMPTY derivation — a failed `iw phy` probe proves nothing about legality (see HOTSPOT CHANNELS ARE DERIVED FROM THE KERNEL).
- Don't decide a channel is AP-usable from the per-channel `iw phy` flags alone — board-proven, an RTL8852BE under the world domain lists 5180/5200/5220 with no `no IR` marker while every 5 GHz rule in `iw reg get` reads `PASSIVE-SCAN`, so the offered channel died `Failed to start AP functionality`. Ask the rule data through `buildApInitiationGate`. And don't "simplify" that into a hardcoded 5 GHz block (it withdraws the band from every properly-configured country), don't make it channel-scoped (it would silently retire 2.4 GHz channels the fix does not touch), and don't make it fail CLOSED — an unreadable `iw reg get` is a statement about the read, not a prohibition.
- Don't classify a WiFi radio's AP-vs-client mode from `conn` (or from the presence of a `hotspot` block) — `conn` is IP-gated and lies during a poll skew. Use `isApMode()`; keep `isHotspot()` only where `hotspot.conn` is actually dereferenced.
- Don't spawn `nmcli` from an RPC-reachable path without a bound — every nmcli process takes one of root's 256 system-bus connections, so an unguarded repeat makes EVERY NetworkManager operation on the device fail `Could not create NMClient object`. `wifiRescan()` coalesces; keep it that way, and keep its shared promise from rejecting.
- Don't delete only the `saved[ssid]` uuid in `wifiForget` — a second NM profile for the same SSID keeps the row reading "Saved", which the operator cannot tell from a Forget that did nothing. Go through `wifiSiblingConnections`. And don't put `savedAll` on the wire or read it from connect/disconnect: those act on a CONNECTION, Forget removes a NETWORK.
- Don't hold a per-adapter lock across a call into a module that acquires the SAME key — `withDeviceLock` is not re-entrant and an async body runs synchronously to its first `await`, so `runGuarded(key, () => void wifiHotspotStart(…))` made every hotspot start/stop/configure refuse ITSELF under a fabricated `{success:true}`. The hotspot procedures use an `adapterBusy()` probe and then AWAIT the transaction; don't re-wrap them.
- Don't return `{success:true}` from a hotspot RPC before the transaction has answered, and don't treat `accepted: true` as "the AP is up" — it promises a later terminal frame and nothing else.
- Don't build a `wifi` `hotspot.start`/`hotspot.stop` frame anywhere but `wifi-hotspot-outcome.ts`, and don't add a SECOND publisher to an exit path that already has one — publishing success from `wifiHotspotStart` resolves the operator's op before NetworkManager has answered. A `broadcastState()` is not a terminal outcome, and `not-confirmed` is not `activation-failed`.
- Don't return in silence from a WiFi dispatch that an operator's keyed op is waiting on — a bare `return` leaves it to expire on its TTL. And don't "clean up" `runWifiNew`'s ambiguous path by calling `wifiDeleteFailedConns()` or claiming `generic`: `ok:true` with no uuid proves nothing in either direction.
- Don't derive a per-adapter WiFi lock key anywhere but `modules/wifi/wifi-adapter-lock.ts`, and don't key one on `wifiInterface.ifname` — the RPC layer and the hotspot transactions did exactly that with two different strings for one radio, so `withDeviceLock` handed both callers the lock at once and the guard serialized nothing. Don't add a mutating WiFi procedure that skips `runGuarded` either (that was `wifiConnectNewProcedure`), and don't prefix the key: it shares the process-wide `withDeviceLock` registry, so a prefix silently stops matching a key an existing caller already holds.
- Don't key an adapter on the MAC `ifconfig`/`GENERAL.HWADDR` reports — NetworkManager randomizes it while scanning, and pinning it into `802-11-wireless.mac-address` produces a profile no device can ever activate. Route through `resolveWifiPermanentMac()`, and bridge an ifname-carrying monitor event with `getWifiInterfaceByIfname()`.
- Don't generate a hotspot SSID/password without asking `findHotspotConnForAdapter()` and the credential store first — that ordering IS the fix for the six orphaned `Hotspot-N` profiles. And don't move the `nmConnSetFields` repair after the `nmConnect`: NetworkManager rejects a profile whose pinned MAC does not match the adapter's permanent address, so the activation is what fails.
- Don't delete a hotspot profile because nothing claims the address it is bound to — a temporarily unplugged radio looks identical to an abandoned profile, and the deletion destroys the very credentials the backstop exists to preserve. Deletion needs POSITIVE evidence from the credential store (`collectSupersededHotspotConns`), and the `Hotspot-N` name pattern is a narrowing filter, never evidence: an operator's own `nmcli device wifi hotspot` profile carries the same id. Don't stop maintaining `previousConns` either — it is the ONLY record that a superseded profile was ever ours, and without it a real duplicate becomes permanently undeletable.
- Don't render `netif.tp` as a rate — it is a byte delta over an unstated window. Use `tx_bps`/`rx_bps`.
- Don't let a `list-devices` probe decide device MEMBERSHIP on the hotplug path, and don't drop the generation fence — a probe that answers can still be stale or out of order, and both have already stranded a real device on a board. Membership comes from the registry's observation (`mergeObservedWithProbe`); the probe supplies metadata. The ONE exemption is a kind that `releasesV4l2Node()` — for a libuvc-driven camera the `/dev` scan is not an observation at all (see LIBUVC-HELD DEVICES). Don't widen that exemption to any other kind, and don't "simplify" it into a blanket probe-wins membership rule.
- Don't key a REMEMBERED device (`last_seen_devices`, the session-seen snapshot map) on its node path — a libuvc camera renumbers on every open/close cycle, so that appends a new entry per cycle and renders one camera as N rows with N `lost` candidates. Route through `identityKey()`. And when folding, don't drop the retired paths: `resolveSourceIdentity` resolves a stale `config.source` THROUGH `last_seen_devices`, so a fold that forgets them strands the operator's selection — that is what `previousIds` is for.
- Don't record a device's `stable_id` into `liveStableIds` before the bridge check in `buildSources` — an unbridged device renders no row, so letting it suppress the remembered `lost` row erases the device from the list entirely.
- Don't leave a re-enumerated `config.source`/`config.asrc` unrepaired, and don't repair either by name, slot, or "whichever id resolves" — migration is by STABLE IDENTITY only (`reconcileConfiguredSourceIdentity` / `reconcileConfiguredAudioIdentity`), and the retired id must be published as `previousIds` so consumers can tell MOVED from GONE.
- Don't let that repair write from an engine view older than the operator's own last word, and don't add a `config.source` write site without `noteSourceSelectionWrite()` — the retained-on-failure device cache is minutes old during an outage and will overwrite a just-saved selection (see AN INFERENCE MAY NOT OUTRANK THE OPERATOR). Sample the token BEFORE the probe's round-trip, not at commit, or a probe already in flight still wins; and never advance it from the reconciler's own write, which would make the gate refuse itself forever.
- Don't trust a persisted node path just because it is LIVE — ask WHICH device holds it. `config.source_stable_id` is the anchor, and without the check a crossed drop/replug of two cameras hands the operator's selection to the wrong one while the preview looks perfectly healthy (board-measured: 69 frames / 2.21 MB of a camera nobody chose). Keep the check suppression-only (no anchor, no `stableId`, non-capture row ⇒ unchanged), keep `SOURCE_TAKEN_OVER_ERROR` distinct from `source_lost`, and don't let `streaming.setConfig` apply the OLD anchor to a NEW explicit pick — the row the operator tapped is what they mean.
- Don't write `config.source` without `noteSourceSelectionWrite(sourceId)` — passing the id is what writes the anchor, so a bare call now records intent without recording WHICH hardware it named. And don't skip clearing it: a pick with no stable identity must write `undefined`, or a retired camera keeps governing a selection it has nothing to do with.
- Don't drop `reconcileConfiguredSourceIdentity` from `broadcastSourcesIfChanged` — the hotplug path can only fire on a device-SET change, and the anchored camera returning AFTER its node was taken over is exactly the transition it misses (board-measured: the right camera sat in the same list for the rest of the session with `config.source` naming the wrong one).
- Don't resolve a persisted selection through a node path more than one remembered device answers to — `findRememberingId`'s holder-beats-alias preference picks a camera rather than proving one. Use `unambiguousStableId`, keep the refusal suppression-only (the literal id must still reach the engine), and don't "unify" it with `findRememberingId`, which correctly keeps that preference for `collectLostCandidates`.
- Don't let the v4l2 scan's `deriveKind()` guess overwrite a kind the engine has already reported for that device, and don't clear `lastEngineVideoDevices` when a device leaves the list — a `usb` guess bridges to no pipeline, so the row is dropped and its coarse slot renders "not connected" for a device that is physically present. Don't relax the display-name gate on the restore to an `input_id`-only lookup either: node paths are recycled, and a fabricated identity is worse than a coarse one. And don't widen that restore past IDENTITY (`kind`/`stable_id`) back onto the remembered `caps`/`signal` — re-asserting a past probe's verdict is how a device that loses its signal keeps claiming it has one, forever.
- Don't let the periodic signal recheck start a second probe while its own is still out (`signalRecheckInFlight`) — a fixed-interval loop whose probe outlives its interval supersedes ITSELF on every tick and publishes nothing at all, and a link-losing receiver is exactly what makes an enumeration slow.
- Don't assert a GLOBAL call count on a process-wide seam like `helpers/run.ts` — `bun test` loads every file into ONE process, and background work started by an earlier file keeps issuing OS commands. `wifiUpdateDevices()` is the known offender: while any Wi-Fi adapter reads unavailable it re-arms itself every 3 s for a five-minute budget (`modules/wifi/wifi-interfaces.ts`), firing several `run("nmcli", …)` calls per pass. Filter the spy's calls to the binary under test instead (`logs-injection.test.ts`), which asserts the same property and cannot be flipped by a foreign command.
## START-FAILURE DIAGNOSTICS [EXISTS]

The typed `StartFailure` contract preserves the optional original diagnostic
`message` alongside its stable `class` and `code`. `classifyStartFailure()` keeps
cerastream JSON-RPC messages (including invalid-params `-32602` and internal
`-32603` responses) generic and engine-authored; retry/terminal diagnostics and
notification params carry the field so it reaches `logger.error("stream start
failed", diagnostic)` and, through it, `getLog()` / the LogsDialog download. Do
not replace this with an engine-code-specific or HDMI-specific mapping — the
message is the generic diagnostic surface.

**It reaches the LOG, never the primary toast.** The frontend used to concatenate
`message` onto the localized failure toast; that shipped a raw JSON-RPC/ALSA
string (`invalid params: audio-device-unavailable: ALSA capture device
'hw:CARD=rockchiphdmiin' is busy or unavailable`) verbatim to an operator with no
console, stacked under a second toast telling them to run `journalctl`. Neither is
actionable for the audience CeraLive targets. `LiveView.startFailureMessage()`
therefore renders class + retry-state only, and every operator-facing string
points at Settings → System Logs instead of a shell command or a unit name. The
propagation above is UNCHANGED — do not weaken it to "fix" the toast, and do not
re-add the concatenation. Gate: `apps/frontend/src/tests/operator-copy-no-internals.test.ts`
sweeps all 10 locales for `journalctl` / `systemctl` / `*.service` / `hw:CARD=`.
