<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## RECEIVER COHERENCE — v2 destination/transport/latency model [EXISTS]

The Live → Receiver/Server dialog is **destination-as-provider, latency-only**.
Full model: [`docs/RECEIVER_MODEL.md`](../RECEIVER_MODEL.md) → "Device UI v2".

- **Destination IS the provider.** `DestinationSection` renders three tiles —
  CeraLive Cloud / BELABOX Cloud / Custom — driven by
  `deriveDestinationChoice(config)` (`receiver-experience.ts`,
  `ReceiverDestinationChoice = 'ceralive' | 'belabox' | 'custom'`,
  `MANAGED_DESTINATION_CHOICES` from `CLOUD_PROVIDERS`). A managed cloud the device
  has no key for shows an add-key prompt (`data-testid="destination-needs-key"`)
  that opens `CloudRemoteDialog` with the `provider` prop preselected. No provider
  dropdown, no manual-endpoint override, no provider-switch stale warning.
- **One transport.** `TransportRow` shows SRTLA active; RIST (`TD-rist-egress`) +
  SRT (`TD-plain-srt-egress`) are calm coming-soon pills. `ProtocolSelector` and
  `TransportBadge` are removed; there is no protocol radiogroup.
- **One knob.** `LatencySection` (replaces `StreamTuningSection`) is a single
  latency slider; window from `deriveLatencyRange(getCapabilities())`. The
  device-side FEC / recovery / presets / cloud-override controls are removed.
- **Schema/handlers kept.** `device.setProfile` + its wiring and the
  `fec_enabled` / `recovery_mode` / `stream_profile` / `profile_decided_by` schema
  fields are intact (the cloud may still push a profile; the device applies latency
  and tolerates the rest). `buildServerSetConfig` is latency-only and clears a stale
  `selected_ingest_endpoint` on every non-slot save (round-3); the backend
  `streaming.setConfig`/`getConfig` persist + echo `selected_ingest_endpoint`.

### Stream Tuning card — SUPERSEDED (historical)

The notes below describe the removed Stream Tuning card (Task 16). The card,
`StreamTuningSection.svelte`, and the device-side tuning derivations are gone; the
`@ceraui/rpc` `stream-profile.schema.ts` exports and the `device.setProfile`
backend path are retained for the cloud control-channel.

The Stream Tuning card was a section inside `ServerDialog.svelte` that exposed per-profile SRT controls gated on receiver capability.

### Schema layer

`packages/rpc/src/schemas/stream-profile.schema.ts` — the single source of truth for all profile-related types:

| Export | Description |
|--------|-------------|
| `streamProfileSchema` | `{presetId, latencyMs, fecEnabled, recoveryMode}` — the wire config |
| `receiverCapsSchema` | `{kind, supportsFec, supportedProfiles, latencyRange, recoveryMode}` |
| `STREAM_PROFILE_PRESETS` | `balanced \| low-latency \| resilient \| classic \| low-latency-fec` |
| `STREAM_PROFILE_IDS` | presets + `'custom'` |
| `STREAM_RECOVERY_MODES` | `reorderfreeze \| srtlapatches \| stock` (internal taxonomy) |
| `streamRecoveryPreferenceSchema` | `standard \| bandwidth-saver` (operator-facing; distinct from internal freeze taxonomy) |
| `DEFAULT_RECOVERY_PREFERENCE` | `'standard'` |
| `RECEIVER_PROFILE_KINDS` | `ceralive \| belabox \| custom \| unknown` |
| `DEFAULT_NON_CERALIVE_PROFILE` | `'classic'` |
| `PRESET_CONFIGS` | `Record<StreamProfilePreset, PresetConfig>` — v1 preset table (latencyMs/fecEnabled/recoveryMode per preset) |

`streaming.schema.ts` carries additive-optional `supported_profiles` / `profile_catalog_version` / `fec_capable` / `latency_range` on `capabilitiesMessageSchema` (consumes cerastream Todo 10 emit; snake_case wire names; backend forwards verbatim).

`streaming.schema.ts` also carries additive-optional `fec_enabled: boolean` + `recovery_mode: streamRecoveryPreferenceSchema` on both `streamingConfigInputSchema` (input) and `configMessageSchema` (echo). These round-trip through `config.json` via `runtimeConfigSchema` + `streaming.procedure.ts`.

### Pure logic (`receiver-experience.ts`)

`apps/frontend/src/lib/streaming/receiver-experience.ts` — pure, rune-free module. New exports added for the Stream Tuning track:

| Export | Description |
|--------|-------------|
| `deriveReceiverProfileKind(provider)` | Maps `config.remote_provider` to `ReceiverProfileKind` (`ceralive \| belabox \| custom \| unknown`). Only a managed CeraLive cloud is the full-controls branch; a custom endpoint is always `'unknown'`. |
| `deriveReceiverCaps(kind, source)` | CeraLive branch trusts the engine snapshot (`supported_profiles`/`fec_capable`/`latency_range`, fallback L1 window `{100,1500,5000}`); every other kind is clamped to the BELABOX-compatible Classic baseline (`{supportsFec:false, ['classic'], {100,1500,2000}, stock}`). |
| `deriveStreamTuningExperience(caps)` | Returns `StreamTuningExperience` — the full gating state for the card (latency range, FEC enabled/disabled-with-reason, recovery mode, preset chips). |
| `getPresetChips(experience)` | Returns `PresetChip[]` in display order `[low-latency, balanced, resilient, low-latency-fec, classic, custom]`. Disabled-with-reason rules: non-CeraLive → all presets carry `presetsDisabledReasonKey`; FEC preset on non-FEC build → `reasonFecUnsupported`; preset not in `availableProfiles` → `REASON_PROFILE_UNSUPPORTED`. |
| `matchActivePreset({latencyMs, fecEnabled, recoveryMode})` | Derives the active `StreamProfileId` from live values — editing any control flips to `'custom'` automatically. |

**CeraUI defines its own `ReceiverProfileKind`** (lowercase `ceralive/belabox/custom/unknown`, aligned with `config.remote_provider` / `RELAY_PROVIDER_KINDS`) — NOT imported from `ceralive-platform`'s `ReceiverKind` (`'CeraLive'` capital). Rule D: repos are self-contained; mirror, don't link.

### UI component

`apps/frontend/src/main/dialogs/server/StreamTuningSection.svelte` — presentational section hosted in `ServerDialog.svelte` after `TransportBadge`. Controls:

- **Latency slider** — continuous range input (step 50, bounds from `experience.latencyRange`); seconds pill ("1.5 s"); labelled "Negotiated" while streaming (reads `config.srt_latency` — the applied/echoed device value).
- **FEC toggle** — bits-ui `Switch` (`<button role=switch>`); disabled-with-reason when `!experience.fecEnabled` (two distinct reasons: `reasonNonCeraLive` for non-CeraLive receivers, `reasonFecUnsupported` for CeraLive receivers on a stock libsrt build).
- **Recovery mode** — `<details>` "Advanced" disclosure (matches `EncoderDialog` precedent) holding a 2-button segmented control (`Standard` / `Bandwidth Saver`). Non-CeraLive receivers show `reasonReceiverManaged`.
- **Preset chips** — chip row from `getPresetChips()`; `selectPreset(id)` calls `onLatencyChange`/`onFecChange`/`onRecoveryChange` (clamped to range); `activeChip = matchActivePreset(...)`. Custom chip is disabled unless it IS the active state.
- **Non-CeraLive badge** — amber status-warning pill + Radio icon (`data-testid="stream-tuning-belabox-badge"`) shown alongside the BELABOX banner when `kind !== 'ceralive'`.

Accessibility: `<section aria-labelledby="stream-tuning-title">`; slider gains `aria-label` + `aria-valuetext` (human seconds); focus-visible rings via `focusRing` const on preset chips + summary + segmented buttons.

The duplicate bottom SRT-latency slider that previously lived in `ServerDialog.svelte` was removed — the card is now the single source of truth for latency.

### Backend wiring

`apps/backend/src/modules/remote-control/set-profile.ts` — `handleSetProfile(payload) -> Promise<SetProfileAck|null>`. Parse → idempotency cache (`Map<commandId, ack>`) → caps-intersect → persist → reconnect-when-streaming → ack. Deps injected (`getCaps`/`readActive`/`persist`/`isStreaming`/`reconnect`) + `configureSetProfile`/`resetSetProfile` test seams.

`apps/backend/src/modules/remote-control/set-profile-wiring.ts` — `wireSetProfile()` binds production deps. Reconnect = `stop → waitUntilIdle(5s bounded poll) → start`; never throws; persist-only fallback on settle timeout.

`apps/backend/src/modules/remote-control/protocol.ts` — `device.setProfile` added to `INTERNAL_COMMANDS` (spread into `COMMAND_REGISTRY` → auto-advertised in `device.hello` `supportedTypes`; opts the device in per the safe-rollout withhold contract).

`apps/backend/src/modules/remote-control/command-router.ts` — `device.setProfile` arm in the INTERNAL-command branch (applies BEFORE the owner gate, like `ingest.slots`). Maps ack → result payload `{ok: status==='applied', applied: ack, error: reason on reject}`.

**Caps intersection (device-side safety net):** `presetId ∉ supported_profiles` (when list present+non-empty, `presetId !== 'custom'`) → REJECT `profile_unsupported`. `fecEnabled && !fec_capable` → REJECT `fec_unsupported`. `latencyMs` clamped to `latency_range[min,max]` → APPLY (reason `latency_clamped`, not a reject). Caps list undefined (no live engine snapshot) → don't gate the preset (can't prove unsupported; trust the platform).

**Reconnect = apply-on-(re)connect.** Persist always; reconnect (`stop → start`) ONLY when `isStreaming()` — latency/profile cannot change live (engine `reload-config` has no latency arm). Idle → persisted config applies on next start.

**Ack transport.** The rich ack `{commandId, status, reason, effectiveActiveProfile, effectiveLatencyMs}` rides the `result` frame's `applied` field (`kind:"result"`, `cid==commandId`). The immediate `delivery.ack` (auto-emitted by the router for every registered command, pre-apply) is the platform's retry-cancel signal.

### WHERE TO LOOK (Stream Tuning)

| Task | Location |
|------|----------|
| Profile + receiver-caps Zod schemas | `packages/rpc/src/schemas/stream-profile.schema.ts` |
| Streaming config schema (fec_enabled, recovery_mode) | `packages/rpc/src/schemas/streaming.schema.ts` |
| Pure receiver-caps + tuning-experience logic | `apps/frontend/src/lib/streaming/receiver-experience.ts` |
| Stream Tuning card component | `apps/frontend/src/main/dialogs/server/StreamTuningSection.svelte` |
| `device.setProfile` handler | `apps/backend/src/modules/remote-control/set-profile.ts` |
| `device.setProfile` production wiring | `apps/backend/src/modules/remote-control/set-profile-wiring.ts` |
| `device.setProfile` in INTERNAL_COMMANDS | `apps/backend/src/modules/remote-control/protocol.ts` |
| `device.setProfile` command-router arm | `apps/backend/src/modules/remote-control/command-router.ts` |
| Runtime config schema (stream_profile, fec_enabled, recovery_mode) | `apps/backend/src/helpers/config-schemas.ts` |
| Tests (handler + routing) | `apps/backend/src/tests/control-set-profile.test.ts` |
| Tests (receiver-experience + StreamTuningSection) | `apps/frontend/src/lib/streaming/receiver-experience.test.ts` + `apps/frontend/src/tests/StreamTuningSection.test.ts` |
| E2E tests | `apps/frontend/tests/e2e/stream-tuning.spec.ts` + `tests/e2e/visual/stream-tuning.visual.spec.ts` |

