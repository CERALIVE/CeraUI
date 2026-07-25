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
| Policy-route self-check for bonded wifi/modem interfaces (`policy_route_missing`) | `modules/network/policy-route-check.ts` |
| **Unified device-first `sources` builder + engine-device cache + `config.source` routing seam** | `modules/streaming/sources.ts` (`buildSources`, `getSourcesMessage`, `deriveEngineRouting`, `resolveSourceRouting`) |
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

Coverage: `tests/audio-meter-bridge.test.ts` (push on connect, `null` for Auto, re-push
on change, nothing sent to a pre-0.9.0 engine, a refused reload leaves levels flowing,
no-op while down, plus the schema gate) and `tests/audio-sources.test.ts`
(`resolveMeterPreference` — alias, no-alias, every `null` case, selector passthrough).

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
merge path and the #214 probe-failure path, is restored from it — kind, caps,
`stable_id` and display name together, exactly as a live probe entry would win.
It is **guarded by display name, not `input_id` alone**: the kernel recycles node
paths, and inheriting an identity is worse than showing a coarse one. Both lists
read the name from the same kernel string (byte-identical on the bug hardware),
so an equal name is real evidence of the same device and an unequal one leaves
the observation untouched. `resetEngineDeviceCache()` clears the map.

The specific USB-as-HDMI mislabel this seam was originally warned about still
cannot recur (`deriveKind` tests usb/uvc BEFORE hdmi), and a device seen for the
FIRST time while cerastream is unreachable still has no memory to draw on — it
keeps the coarse fallback, which is the accepted degradation.
Coverage: `tests/devices.test.ts` (`fires onDevicesChanged on a hotplug set
change…` + `hands onDevicesChanged the list this scan observed…`) and
`tests/lost-device-retention.test.ts` (`refreshSourcesForHotplug — a failing
engine probe never masks a removal` + `refreshSourcesForHotplug — a stale
successful probe never masks the observed set`, which covers the replug-vs-empty-
probe case, the removal-vs-pre-removal-probe case, metadata preference, the audio
cache, and both out-of-order fences).

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

## ANTI-PATTERNS

- Don't import from `@ceralive/srtla` — that package is retired from CeraUI. Use `@ceralive/srtla-send` (the `srtla-send-rs` binding, registry dep). Check `../../../srtla-send-rs/AGENTS.md` before touching call sites.
- Don't add HTTP REST endpoints — all device control goes through oRPC over WebSocket.
- Don't use `process.exit` directly — use `invariant` from `helpers/invariant.ts`.
- Don't read config files with raw `fs` — use `helpers/config-loader.ts`.
- Don't drive the engine directly — route through `getStreamingBackend()`, never
  the `cerastreamBackend` singleton.
- Don't refuse a software update with a bare `return`, and don't re-check the
  update guards at a call site — `startSoftwareUpdate()` owns every refusal and
  always names it (see SOFTWARE-UPDATE START CONTRACT).
- Don't send the idle-meter preference through the typed `reloadConfig()` — the published client Zod-strips `audio.meter_device`; it goes over `rawRequest` behind `supportsMeterDevicePreference`. And don't send `undefined` for "Auto": absent means *unchanged*, `null` means Auto.
- Don't re-add stderr regex on the cerastream path — engine errors are structured
  codes mapped via `cerastream-error-mapping.ts`.
- Don't wire `@ceralive/cerastream` as a sibling `link:` or vendored `.tgz` — it
  is a public-npm registry dep by design; bump the pinned version in
  `package.json` to track the engine.
- Don't multiplex the control channel onto the BCRPT relay socket — the two channels are independent by design (different token audiences, different endpoints, different authority models).
- Don't add secret-bearing event types to `RELAYABLE_TYPES` — the no-secrets contract test will catch it.
- Don't delete the `devices`/`pipelines` broadcasts or the `capabilities.device_modes` field yet — they're deprecation shims kept for one release (`TD-legacy-source-broadcasts`); route new consumers through `getSources()`/the `sources` broadcast instead.
- Don't re-add an operator audio-device rename/alias surface (RPC, contract entry, or config field) — device naming is code-level only (`ONBOARD_AUDIO_DISPLAY_RULES` + `cleanAudioDeviceName`); the #206 alias layer was removed in #207 by product decision. The same holds for VIDEO (`ONBOARD_VIDEO_DISPLAY_RULES`) — no rename affordance for any device, of any media type.
- Don't re-apply an onboard display-name rule at a render site (a Svelte label, a summary derivation) — it belongs at the device-construction seam (`fromEngineDevice`), which is why the row and the "Configured" label are both fixed by one call.
- Don't re-derive `pipeline`/`selected_video_input` resolution inline in a new procedure — route through `resolveSourceRouting()`/`deriveEngineRouting()` in `modules/streaming/sources.ts`.
- Don't let a `list-devices` probe decide device MEMBERSHIP on the hotplug path, and don't drop the generation fence — a probe that answers can still be stale or out of order, and both have already stranded a real device on a board. Membership comes from the registry's observation (`mergeObservedWithProbe`); the probe supplies metadata.
- Don't let the v4l2 scan's `deriveKind()` guess overwrite a kind the engine has already reported for that device, and don't clear `lastEngineVideoDevices` when a device leaves the list — a `usb` guess bridges to no pipeline, so the row is dropped and its coarse slot renders "not connected" for a device that is physically present. Don't relax the display-name gate on the restore to an `input_id`-only lookup either: node paths are recycled, and a fabricated identity is worse than a coarse one.
