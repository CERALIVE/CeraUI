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
| Engine seam + registry (cerastream-only) | `modules/streaming/streaming-engine.ts` (`getStreamingBackend`) |
| Capability contract service (engine emits, CeraUI consumes; cache + fallback ladder; `transports` + `getSupportedTransports()`) | `modules/streaming/capabilities.ts` (`getCapabilities`) |
| Transport resolver + protocol registry (srtla/rist active, srt reserved; RIST capability-gated via `ristAvailable`) | `modules/streaming/transport/` (`resolveStreamEndpoint`, `registry.ts`, `rist-adapter.ts`) |
| Pipeline registry (derived from the capability contract; `initPipelines` is async) | `modules/streaming/pipelines.ts` |
| Engine connection resilience (bounded boot retry → periodic recheck; heals `engine-unavailable` and re-broadcasts caps/pipelines/sources) | `modules/streaming/engine-reconnect.ts` (`initEngineConnection`) |
| Cerastream engine backend (structured IPC, `@ceralive/cerastream`) | `modules/streaming/cerastream-backend.ts` |
| Structured engine error → notification (Task-7 table swap, no regex); `mapCerastreamError()` maps a `RuntimeErrorEvent` to a Tier-2 code string (T16) | `modules/streaming/cerastream-error-mapping.ts` |
| srtla binding calls (flux — check `../../../srtla/AGENTS.md` first) | `modules/streaming/srtla.ts` |
| srtla per-link telemetry → `status.linkTelemetry` (incl. the MEASURED `bitrate_bps` per link + the summed `measured_bps` — the only honest live bitrate; `engine_bitrate.applied_kbps` is a setpoint) | `modules/streaming/link-telemetry.ts` (`buildLinkTelemetry`) |
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
| Regulatory domain + kernel-derived hotspot channels (`iw reg set` / `iw phy` parser, regdb precheck, armed restore timer) | `modules/wifi/regdomain.ts` (`applyRegulatoryDomain`, `deriveApChannels`, `checkWirelessRegdbSupport`, `buildRegdomainRestoreCommand`) |
| Persisted country → apply → re-derive → hotspot restart | `modules/wifi/wifi-country.ts` (`setWifiCountry`, `reconcileHotspotChannels`) |
| Policy-route self-check for bonded wifi/modem interfaces (`policy_route_missing`) | `modules/network/policy-route-check.ts` |
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
moved. `AudioLevelMeter` needed no change — it already indexes
`$LL.live.preview.audioUnavailableReason[reason]()`.

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
- Frontend dependency `bits-ui` is at v2.18.1 (frontend concern only; backend has no direct bits-ui dep).
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

## BROADCAST EVENTS

The backend pushes typed events to all connected clients via `rpc/events.ts`. Each event type carries a monotonic `seq` counter (`Map<string, number>`) that resets to 0 on server restart.

| Event type | Interval | Source |
|------------|----------|--------|
| `netif` | 5 s | `modules/network/network-interfaces.ts` |
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
| 6 GHz | NetworkManager's `802-11-wireless.band` has no value for it, and AP operation there additionally requires WPA3-SAE |

`no IR`'s pre-NO_IR spellings (`passive scanning`, `no IBSS`) are treated
identically — an older kernel expresses the same restriction with different words,
and excluding a channel is the conservative direction.

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
- Don't add HTTP REST endpoints — all device control goes through oRPC over WebSocket.
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
- Don't classify a WiFi radio's AP-vs-client mode from `conn` (or from the presence of a `hotspot` block) — `conn` is IP-gated and lies during a poll skew. Use `isApMode()`; keep `isHotspot()` only where `hotspot.conn` is actually dereferenced.
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
