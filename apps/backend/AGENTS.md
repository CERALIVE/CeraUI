# CeraUI Backend — Agent Knowledge Base

Parent: [`../../AGENTS.md`](../../AGENTS.md)

## OVERVIEW

Bun/TypeScript HTTP + WebSocket server. Serves the frontend static bundle, exposes all device control via oRPC over WebSocket, drives the `cerastream` engine over structured IPC (`@ceralive/cerastream` public-npm registry dep) and `srtla-send-rs` via the `@ceralive/srtla-send` npm package.

## STRUCTURE

`src/main.ts` — entry. `src/modules/` — domain logic (no RPC awareness): `streaming/` (cerastream + srtla consumers), `modems/` (mmcli), `network/`, `wifi/`, `system/`, `ui/` (HTTP + WS servers, auth), `ingest/`, `remote/`, `config.ts`, `setup.ts`. `src/rpc/` — oRPC layer: `router.ts`, `procedures/<domain>.procedure.ts`, `middleware/`, `events.ts`. `src/helpers/` — pure utils. `src/mocks/` — MOCK_SCENARIO providers. `src/tests/` — bun:test.

## WHERE TO LOOK

| Task | Location |
|------|----------|
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
| srtla per-link telemetry → `status.linkTelemetry` | `modules/streaming/link-telemetry.ts` |
| Stream lifecycle (spawn supervision, start/stop, autostart, exec paths) | `modules/streaming/streamloop/` (barrel: `modules/streaming/streamloop.ts`) |
| Authoritative stream-session lifecycle (UI/autostart/remote arbitration, cancellation generations, boot adoption) | `modules/streaming/stream-session-orchestrator.ts` |
| Transactional launch cleanup + phase/stop deadlines | `modules/streaming/launch-transaction.ts`, `start-lifecycle-timing.ts`, `streamloop/start-stream.ts`; contract in `../../docs/START-LIFECYCLE.md` |
| Bounded start retry + suppression + diagnostics | `modules/streaming/stream-start-retry.ts`, `stream-start-retry-reporting.ts` |
| Pre-engine gate deadline deferral (`pendingGateRemainingMs` ← `asrcProbeRemainingMs`) | `modules/streaming/stream-start-retry.ts` + `modules/streaming/audio.ts`; contract in `../../AGENTS.md` → STREAMING BACKEND QUALITY |
| Raw `active_encode` bridge (passthrough + frame-liveness the typed client strips) | `modules/streaming/active-passthrough.ts`; cache-lifetime contract below → RAW `active_encode` BRIDGE |
| Engine restarted mid-session (session control connection dropped → retire the session so the next start works) | `modules/streaming/cerastream-backend.ts` (`noteConnectionLoss`, `withSessionClient`, `onSessionConnectionLost`); contract below → SESSION CONTROL CONNECTION |
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
| Retracting the `hdmi_error` "No HDMI signal detected" notification once the link relocks | `modules/system/hdmi-signal-notification.ts` (`clearHdmiSignalErrorOnRecovery`, hooked into `sources.ts` `commitEngineDevices`); contract below → A PERSISTENT NOTIFICATION MUST BE RETRACTABLE |
| Retracting the `cerastream` `capture_video_error` notification at a healthy session boundary | `modules/streaming/cerastream-backend.ts` (`standingEngineError`, `clearRecoveredEngineError`, `ENGINE_ERRORS_CLEARED_BY_HEALTHY_SESSION`) |
| **Device-truth save guard + persisted-mode clamp (ADR-0008 §10)** | `modules/streaming/device-mode-guard.ts` (`verifySaveDeviceMode`, `clampPersistedDeviceMode`) + `modules/streaming/persisted-mode-clamp.ts` (`reconcilePersistedDeviceMode`); the RULE itself is `@ceraui/rpc` `capabilities/device-mode-truth.ts`, shared with the frontend |
| **Unified device-first `sources` builder + engine-device cache + `config.source` routing seam** | `modules/streaming/sources.ts` (`buildSources`, `getSourcesMessage`, `deriveEngineRouting`, `resolveSourceRouting`) |
| **Which capture kinds release their kernel v4l2 node while the engine holds them (libuvc)** | `modules/streaming/held-devices.ts` (`releasesV4l2Node`) — CeraUI-side mirror of cerastream `engine::held_devices` |
| **`config.source` legacy coercion (pipeline/selected_video_input → source, idempotent)** | `helpers/config-schemas.ts` (`coerceLegacySource`) |
| **Audio-naming resolution (4-tier: static onboard rule → engine join → ALSA longname → generic alias) + name cleaning + tier-3 diagnostic** | `modules/streaming/audio-naming.ts` |
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

## "AUTO" AUDIO — THE SAME-DEVICE JOIN [EXISTS]

`resolveAutoAsrc` rule 5(i) (`modules/streaming/auto-audio.ts`) picks the audio card
belonging to the SAME chassis as the selected USB/UVC camera, by matching names with
a `MIN_COMMON_PREFIX` (4-character) shared-prefix floor.

**It must compare EVERY engine-given name, not `display_name` alone.** cerastream
sets an audio entry's `display_name` to the ALSA longname verbatim, and the kernel
puts the manufacturer on the front of that string. The DJI Osmo Pocket 3 is the
worked example: audio `"DJI DJIPocket3 at usb-fc880000.usb-1, high speed"` vs video
`"DJIPocket3: OsmoPocket3"` share only `"DJI"` — 3 characters, ONE short of the
floor. The join missed, rule 5(ii) fired, and "Auto" served the generic `usbaudio`
card, i.e. a **different physical device's microphone** (a still-enumerated RØDE
whose video interface had already died). `engineAudioJoinNames()` therefore also
offers `product_name` and `alsa_card_id` (both `"DJIPocket3"`, both already on the
wire), which carry no manufacturer prefix and align from the first character.

**The BEST match wins, not the first.** Several cards can clear a 4-character floor
(`DJIPro` vs `DJIPocket3`), and taking whichever the engine happened to list first is
exactly the coin-flip this rule exists to remove.

Do NOT add the asrc key or any CeraUI-side alias to the candidate list — those are
our own strings, not names the hardware chose, and would join a card to a device it
shares nothing with. Coverage: `tests/auto-audio.test.ts`.

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
`ONBOARD_VIDEO_DISPLAY_RULES` maps `rkhdmirx` / `rockchiphdmirx` /
`rockchiphdmirxcontroller` → `HDMI Input` — deliberately the SAME name the audio
ladder gives `rockchip,hdmiin`, because the two are the video and audio halves of
ONE physical port. Like the audio rule it is code-level only: no UI, no RPC, no
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
  yourself". `null` covers `AUDIO_SOURCE_AUTO`, both pipeline pseudo-sources
  (`"No audio"` / `"Pipeline default"`), an unset `asrc`, and anything that resolves to
  no card. It reuses the SAME `audioDevices` map + alias reverse-lookup + `hw:CARD=`
  wrapping that `resolveAudioMode` uses for `start`, so the meter and the program leg
  can never disagree about which card a pick names. It is deliberately NOT
  `resolveAudioMode`: this is the IDLE meter, which has no notion of network-embedded
  program audio and must keep following the card the picker is showing.
- **The `audio-meter-bridge` delivers it**, because it already holds the ONE long-lived
  IDLE connection to the engine (`cerastream-backend.ts`'s client only exists while
  streaming). `pushPreference()` sends `reload-config` with
  `{ audio: { meter_device } }`.
- **`syncAudioMeterPreference()`** re-pushes on change. Three call sites: the bridge's
  own `runAttempt` (every fresh connect — the engine holds NO preference across a
  restart), `streaming.setConfig` when `input.asrc` changed, and `updateAudioDevices`
  (a re-enumeration can change which card an UNCHANGED pick resolves to).

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
false unless BOTH sides name a card: an `Auto` pick (`null`) hands selection to the
engine by design, and an engine that reports no identity cannot be shown to mismatch.
An engine-sent `unavailable` passes through with its OWN reason. Do NOT "simplify" this
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

**"No audio" is NOT "Auto", and only the picker value can tell them apart.**
`resolveMeterPreference` answers `null` for both, and `null` on the wire means
"engine, choose for yourself" — so the one pick that means *meter nothing* made the
engine auto-pick a card AND left `isForeignCardLevel` unarmed (it returns `false` for
a `null` preference by design). The meter therefore rendered another card's real,
moving audio under an "Audio source: No audio" label. Found live in Wave H QA; it read
as a transient "few seconds of green bars" only because PR #232's frozen-content
watchdog happened to age the bars out once that card's content stopped changing.
`isMeterSilencedByPick(asrc)` (`audio.ts`, true for `NO_AUDIO_ID` alone) is the
distinction, and `projectLevel` applies it BEFORE every other branch — including the
engine's own `unavailable` reason, because the operator's explicit silence outranks
whatever gap the engine is reporting. It reuses the existing `mode_none` reason
(`resolveAudioMode("No audio")` is literally `{mode:"none"}`), so no schema or locale
change was needed. `DEFAULT_AUDIO_ID` and `AUDIO_SOURCE_AUTO` are deliberately NOT
silenced — both hand sourcing to the engine, so whatever it picks IS the operator's
meter.

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
run reset) and `tests/audio-sources.test.ts` (`resolveMeterPreference` — alias,
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
- Build: `bun build --compile --minify --bytecode --target=bun-linux-{arm64|amd64}` — single binary, no runtime on device.
- Tests: `bun test` (not vitest). Files in `src/tests/`.
- Config files (`config.json`, `setup.json`, `auth_tokens.json`) read/written from working dir — path-sensitive in production.
- `MOCK_SCENARIO` env activates mock providers. Scenarios: `single-modem`, `streaming-active`, `multi-modem-wifi` (default dev), `modem-pin-locked` (2 modems, modem 0 SIM PIN-locked, fixture PIN `0000` — the `unlockSim`/`unlockSimPuk` RPCs route to the mock SIM state machine). Three additional scenario-seeded capability scenarios: `caps-full`, `engine-starting`, `engine-unavailable` (T5).
- Frontend dependency `bits-ui` is at v2.18.1 (frontend concern only; backend has no direct bits-ui dep).
- Use `shouldUseMocks()` — never raw `isDevelopment()` — to gate mock-hardware paths. `shouldUseMocks()` requires both `isDevelopment()` AND `mockState.initialized`.
- **Frontend store-ownership mirror [EXISTS]:** the frontend's legacy `websocket-store.svelte.ts` wrapper is deleted; `rpc/procedures/auth.procedure.ts` (`auth.login`/`auth.setPassword`/`auth.logout`) is now called exclusively through the frontend's `lib/stores/auth-status.svelte.ts` (`authenticate`/`createPassword`), and every other push event is consumed exclusively through `lib/rpc/subscriptions.svelte.ts`'s single `rpcClient.onMessage` handler. Don't casually rename/reshape these procedure signatures or add a second push-consumption path on the frontend side — see `apps/frontend/AGENTS.md` → CONVENTIONS (store ownership).

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

## BROADCAST EVENTS

The backend pushes typed events to all connected clients via `rpc/events.ts`. Each event type carries a monotonic `seq` counter (`Map<string, number>`) that resets to 0 on server restart.

| Event type | Interval | Source |
|------------|----------|--------|
| `netif` | 5 s | `modules/network/network-interfaces.ts` |
| `sensors` | 1 s | `modules/system/sensors.ts` |
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
    stale: boolean;
  }>;
} | null
```

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

**Duplicate consolidation is deliberately narrow.**
`pruneDuplicateHotspotConns()` runs best-effort after a successful start (never
blocking or failing it) and only deletes a profile that is AP mode, carries the
nmcli-generated id (`Hotspot`, `Hotspot-N`), is used by no adapter, is claimed by
no other adapter's persisted identity, and is bound either to THIS adapter or to
an address no present adapter has. A profile bound to another present radio is
always kept, so a multi-radio device cannot lose its second hotspot to the
first's cleanup.

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
| `hdmi_error` / "No HDMI signal detected" | `modules/system/sensors.ts`, off the RK3588 dmesg line `hdmirx-controller: Err, timing is invalid` | the kernel logs the failure and prints NOTHING when the link relocks, so the only event the watcher can see is the bad one |
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
- **Scoped to the EXACT message.** The name `hdmi_error` is SHARED with the
  EMI/cable-quality advisory ("HDMI signal issues detected…"), which describes a
  different condition a relocked link does not falsify — the raise site already
  keys on the same string to avoid overwriting it. Retracting by name alone would
  silently drop it.
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
pushed to a connected client, the EMI-advisory and foreign-device negatives, the
idle-is-not-proof and shared-slot negatives, and the repeat-heartbeat idempotence)
plus the frontend half `apps/frontend/src/tests/notification-recovery-ingestion.test.ts`
(the `remove` frame drops the entry from the persistent panel).

## ANTI-PATTERNS

- Don't add a persistent notification without a retraction path — `duration` does
  NOT expire one (`notificationRemaining()` returns "lives forever" for every
  persistent notification by design), so a raise-only site latches for the whole
  session. And don't "fix" a latched one with a timeout: that hides a
  still-broken condition just as readily as it clears a resolved one. Find the
  authoritative recovery signal (see A PERSISTENT NOTIFICATION MUST BE RETRACTABLE).
- Don't retract a notification whose NAME is shared by more than one claim without
  discriminating WHICH claim is standing — `hdmi_error` carries both the no-signal
  and the EMI/cable advisory, and the `cerastream` channel carries every non-srtla
  engine error. Key on the message (`HDMI_NO_SIGNAL_MSG`) or on the recorded code
  (`standingEngineError`), never on the bare name.
- Don't move the HDMI recovery hook off `commitEngineDevices` or gate it on a
  changed payload — it must see every engine-authored device view, including the
  ones that are byte-identical to the last.
- Don't import from `@ceralive/srtla` — that package is retired from CeraUI. Use `@ceralive/srtla-send` (the `srtla-send-rs` binding, registry dep). Check `../../../srtla-send-rs/AGENTS.md` before touching call sites.
- Don't add HTTP REST endpoints — all device control goes through oRPC over WebSocket.
- Don't re-serialise the DNS health check ahead of the caller's query in `dnsCacheResolve`, and don't share one `Resolver` between them — the check only GATES the answer, and a shared c-ares channel's `cancel()` would abort the sibling leg. Both legs sit inside the per-attempt launch deadline (see DNS ON THE STREAM-START CRITICAL PATH).
- Don't use `process.exit` directly — use `invariant` from `helpers/invariant.ts`.
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
- Don't infer "the operator wants no meter" from a `null` meter preference — `null` is ALSO "Auto", which legitimately meters whatever the engine picks. Ask `isMeterSilencedByPick()`, key the selection-change detection on the `(silenced, preference)` PAIR, and don't let an engine-sent `unavailable` reason outrank an explicit "No audio".
- Don't leave a pick change to be corrected by the next engine frame — the level already broadcast belongs to the previous pick, so `noteMeterSelection()` must retire it immediately (and must stay silent on an unchanged pick, or every re-enumeration blinks the meter).
- Don't fold `active_encode` into telemetry preserve-on-omission past the end of a session, and don't let `stop()` rely on a final engine status frame to clear it — a crashed engine sends none, and the stale encode then renders the stopped session under a "Live" badge.
- Don't clear the raw bridge's `cachedLiveness`/`cachedPassthrough` from its own socket `close`/`error` — that is a CONNECTION blip, not a session boundary, and wiping there hands `collectRealLiveness()` an `undefined` it can only read as a cold start, so a dead stream reports `healthy` off raw process liveness. Let `FRAMES_FRESHNESS_MS` age the retained reading out instead.
- Don't apply that same rule to the SESSION-scoped control client — it is the inverse case. Losing `cerastream-backend.ts`'s `this.client` retires the session (the published client cannot reconnect and a restarted engine has no session to resume), so route every session RPC through `withSessionClient` and never swallow a `CerastreamConnectionError` without calling `noteConnectionLoss`. And don't treat `this.client !== undefined` as evidence the engine is reachable — that is exactly how `reconcileRuntimeState()` re-affirmed a phantom "streaming" state off stale telemetry until the backend was restarted.
- Don't re-add stderr regex on the cerastream path — engine errors are structured
  codes mapped via `cerastream-error-mapping.ts`.
- Don't wire `@ceralive/cerastream` as a sibling `link:` or vendored `.tgz` — it
  is a public-npm registry dep by design; bump the pinned version in
  `package.json` to track the engine.
- Don't multiplex the control channel onto the BCRPT relay socket — the two channels are independent by design (different token audiences, different endpoints, different authority models).
- Don't add secret-bearing event types to `RELAYABLE_TYPES` — the no-secrets contract test will catch it.
- Don't delete the `devices`/`pipelines` broadcasts or the `capabilities.device_modes` field yet — they're deprecation shims kept for one release (`TD-legacy-source-broadcasts`); route new consumers through `getSources()`/the `sources` broadcast instead.
- Don't resolve the rule-5(i) same-device join from `display_name` alone — it is the ALSA longname, and the manufacturer prefix the kernel puts on it can push the shared prefix under the 4-character floor for a device whose `product_name`/`alsa_card_id` match perfectly. Route through `engineAudioJoinNames()`, and don't feed it CeraUI-side strings.
- Don't assume the audio label/identity maps are fresh because a hotplug ran — the ENGINE's audio list arrives later and separately, so `commitEngineDevices` must keep firing the re-resolve on a changed list. And don't "simplify" that handler into a full `updateAudioDevices()` call: the sysfs scan has not changed, so it would raise a spurious lost verdict and blink the meter.
- Don't re-add an operator audio-device rename/alias surface (RPC, contract entry, or config field) — device naming is code-level only (`ONBOARD_AUDIO_DISPLAY_RULES` + `cleanAudioDeviceName`); the #206 alias layer was removed in #207 by product decision. The same holds for VIDEO (`ONBOARD_VIDEO_DISPLAY_RULES`) — no rename affordance for any device, of any media type.
- Don't re-apply an onboard display-name rule at a render site (a Svelte label, a summary derivation) — it belongs at the device-construction seam (`fromEngineDevice`), which is why the row and the "Configured" label are both fixed by one call.
- Don't re-derive `pipeline`/`selected_video_input` resolution inline in a new procedure — route through `resolveSourceRouting()`/`deriveEngineRouting()` in `modules/streaming/sources.ts`.
- Don't validate an encode target against a device ladder with a second, local copy of the rule — `@ceraui/rpc` `capabilities/device-mode-truth.ts` is shared with the frontend precisely so the offering and the save path cannot disagree. And don't turn its fail-open guards (no ladder, coarse source, un-normalizable payload) into refusals: blocking a save the hardware can honour is the same dishonesty as allowing one it cannot.
- Don't report a `streaming.setConfig` result without reading `result.success` — a device-truth refusal RESOLVES, it does not throw, so a bare try/catch toasts "Saved" over a config the device rejected.
- Don't add a country→channel table anywhere — the hotspot channel set is DERIVED by applying `iw reg set <CC>` and parsing `iw phy` back out (`regdomain.ts`), because the legal set depends on the kernel's regdb version, the radio, and self-managed adapters. And don't validate a channel with `isWifiChannelName` alone: that is a SHAPE check, and legality is `isChannelOffered` against the runtime-derived set.
- Don't union two wiphys' channel lists, and don't clamp a live AP off the air on an EMPTY derivation — a failed `iw phy` probe proves nothing about legality (see HOTSPOT CHANNELS ARE DERIVED FROM THE KERNEL).
- Don't classify a WiFi radio's AP-vs-client mode from `conn` (or from the presence of a `hotspot` block) — `conn` is IP-gated and lies during a poll skew. Use `isApMode()`; keep `isHotspot()` only where `hotspot.conn` is actually dereferenced.
- Don't key an adapter on the MAC `ifconfig`/`GENERAL.HWADDR` reports — NetworkManager randomizes it while scanning, and pinning it into `802-11-wireless.mac-address` produces a profile no device can ever activate. Route through `resolveWifiPermanentMac()`, and bridge an ifname-carrying monitor event with `getWifiInterfaceByIfname()`.
- Don't generate a hotspot SSID/password without asking `findHotspotConnForAdapter()` and the credential store first — that ordering IS the fix for the six orphaned `Hotspot-N` profiles. And don't move the `nmConnSetFields` repair after the `nmConnect`: NetworkManager rejects a profile whose pinned MAC does not match the adapter's permanent address, so the activation is what fails.
- Don't render `netif.tp` as a rate — it is a byte delta over an unstated window. Use `tx_bps`/`rx_bps`.
- Don't let a `list-devices` probe decide device MEMBERSHIP on the hotplug path, and don't drop the generation fence — a probe that answers can still be stale or out of order, and both have already stranded a real device on a board. Membership comes from the registry's observation (`mergeObservedWithProbe`); the probe supplies metadata. The ONE exemption is a kind that `releasesV4l2Node()` — for a libuvc-driven camera the `/dev` scan is not an observation at all (see LIBUVC-HELD DEVICES). Don't widen that exemption to any other kind, and don't "simplify" it into a blanket probe-wins membership rule.
- Don't key a REMEMBERED device (`last_seen_devices`, the session-seen snapshot map) on its node path — a libuvc camera renumbers on every open/close cycle, so that appends a new entry per cycle and renders one camera as N rows with N `lost` candidates. Route through `identityKey()`. And when folding, don't drop the retired paths: `resolveSourceIdentity` resolves a stale `config.source` THROUGH `last_seen_devices`, so a fold that forgets them strands the operator's selection — that is what `previousIds` is for.
- Don't record a device's `stable_id` into `liveStableIds` before the bridge check in `buildSources` — an unbridged device renders no row, so letting it suppress the remembered `lost` row erases the device from the list entirely.
- Don't leave a re-enumerated `config.source`/`config.asrc` unrepaired, and don't repair either by name, slot, or "whichever id resolves" — migration is by STABLE IDENTITY only (`reconcileConfiguredSourceIdentity` / `reconcileConfiguredAudioIdentity`), and the retired id must be published as `previousIds` so consumers can tell MOVED from GONE.
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
