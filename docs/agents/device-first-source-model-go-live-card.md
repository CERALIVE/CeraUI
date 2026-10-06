<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## DEVICE-FIRST SOURCE MODEL + GO LIVE CARD [EXISTS]

The Live destination was rebuilt (experience-simplification plan, Tasks 1-20)
around ONE device-first source list and ONE adaptive Go-Live surface, replacing a
scattered pipeline picker + device list + onboarding checklist + server-readiness
card + stream-settings card.

### `config.source` + the unified `sources` broadcast

`apps/backend/src/modules/streaming/sources.ts` is the single builder. It folds
the coarse pipeline registry, the engine's `list-devices` result, and the
network-ingest gateway status into ONE ordered `StreamSource[]` list
(`getSourcesMessage()` = `{hardware, sources}`, broadcast as `sources` — rides the
existing bus, no new endpoint). Every row is one of four `origin` variants
(`capture`/`coarse`/`virtual`/`network`), each carrying its own `modes`
(per-device Tier-2 caps when known), `audioKind`, and availability —
`packages/rpc/src/schemas/sources.schema.ts` is the schema source of truth
(`StreamSource`, `sourcesMessageSchema`).

- **`config.source`** persists the operator's pick as a single id (an `input_id`
  for capture, a pipeline id for coarse/virtual, `rtmp`/`srt` for network).
  Legacy configs (no `source` field) are coerced once at load
  (`coerceLegacySource`, `apps/backend/src/helpers/config-schemas.ts`) from
  whatever combination of `selected_video_input`/`pipeline` they already have —
  idempotent, never throws, logs once.
- **`deriveEngineRouting(sourceId, sources)`** (`sources.ts`) resolves a source id
  to the wire pair the engine needs: `{pipeline, selected_video_input}`. A
  capture id routes to its bridged pipeline + its own `input_id`;
  coarse/virtual/network route to their pipeline id with `selected_video_input`
  explicitly `undefined` (clearing a stale capture selection — the engine's
  existing `config.selected_video_input ?? getActiveInput()` fallback fills it).
  `resolveSourceRouting()` wraps this with the `unknown_source` rejection and is
  the seam both `streaming.setConfig` and `streaming.start` call BEFORE any
  config mutation or engine dispatch — `cerastream-backend.ts` is untouched by
  this entire model (verified by a `git diff`-based regression test).
- **Shim policy**: the legacy `pipelines`/`devices` broadcasts and the coarse
  `capabilities.device_modes` field are kept running unmodified as a rollback
  safety net. `EncoderDialog.svelte`, `AudioDialog.svelte`, `LiveView.svelte`,
  and `StreamingStateManager.svelte.ts` have migrated off the legacy getters and
  now use `getSources()`-derived data. The legacy getter definitions and
  compatibility/comment references remain, but there are no direct consumer
  call sites in these four files. The producers stay in place for the rollback
  net; the real exit condition is ship one release with no rollback needed,
  THEN delete the producers. Tracked as
  `TD-legacy-source-broadcasts` in `docs/TECHNICAL_DEBT.md`; do not delete the
  producers until that entry's exit condition is met.

### StreamSetupChain / IdleCockpit / LiveCockpit

`apps/frontend/src/main/live/` now holds the Live destination's cockpit split.
**`GoLiveCard.svelte` no longer mounts anywhere** — a subsequent
live-experience-refinement pass merged its gates + config rows into
`StreamSetupChain.svelte`, which is the component actually rendered today (see
`docs/TECHNICAL_DEBT.md` → `TD-unmounted-source-shims` for the up-to-date shim
list, which already reflects this):

- **`StreamSetupChain.svelte`** — ONE "Stream setup" card of THREE
  always-visible rows in signal order (Encoder → Destination → Network) — no
  collapse state, no thin ready-bar; every row is rendered at all times. It is a
  presentation-only remap of the pure `deriveGoLiveReadiness()`
  (`apps/frontend/src/lib/streaming/go-live-readiness.ts`, four gates:
  source/network/destination/engine) — the verdict is consumed byte-unchanged and
  never re-derived here. Each row fuses a readiness-state dot with the migrated
  config-row summary/edit affordance (same testids/lock semantics as the retired
  `StreamSettingsCard`); the Destination row also carries the traffic-light chip
  (fed by the destination-validation store, below) and the Encoder row a
  bitrate-ceiling chip. Audio is deliberately NOT a row (live-correctness-pass
  Todo #11 — see "LIVE-CORRECTNESS-PASS FIXES" below); the ENGINE gate is also not
  a row (owned by the `CapabilityTierBanner` + the Start button's disabled
  reason). It detects a sole-camera device with no `config.source` set and folds
  the implicit id into the Start payload WITHOUT writing config — the row only
  shows a "Change" affordance. It owns NO RPC and writes NO config itself; every
  action is a callback prop from `LiveView`.
- **`IdleCockpit.svelte`** — pre-stream wrapper, source-first order:
  `SourceSection` → `StreamSetupChain` (readiness rows + Start, mounted exactly
  once) → a collapsed Preview `<details>` disclosure → a collapsed Roadmap
  `<details>` disclosure (the relocated `TD-pip`/`TD-mode-fallback`/
  `TD-embedded-audio` "coming soon" pills). Pure prop pass-through — no `$state`,
  no RPC.
- **`LiveCockpit.svelte`** — streaming wrapper: telemetry strip → bitrate
  adjuster (the sole bitrate-hot-adjust owner while live) → `IngestStats` → Stop.
- **`LiveView.svelte`** switches between the two on the OPTIMISTIC streaming edge
  (`isStreaming || streamingOptimismState === 'starting'`) — never on the raw
  `is_streaming` flag alone, so Start never flickers back to idle mid-launch.
- **`SourceSection.svelte`** (`lib/components/custom/`) renders the single
  `getSources()` list as one `<ul>` (every origin as a row; broadcast order — the
  Todo #10 reorder UI is removed, see below) filtered to `visibleSources` (an
  operator-disabled network row hides UNLESS it is the currently-selected
  source). It owns the `config.source` write itself
  (`rpc.streaming.setConfig({source})`) and is the sole audio-configuration
  surface (Todo #11) — it is no longer a purely presentational component.

### Deprecation shims kept-but-unmounted (registered, not deleted)

`StreamSettingsCard.svelte`, `OnboardingChecklist.svelte`, `ServerReadiness.svelte`
(all `main/live/`), `GoLiveCard.svelte` (`main/live/`), and
`NetworkIngestSection.svelte` (`lib/components/custom/`) are no longer mounted
anywhere — `StreamSetupChain`/`IdleCockpit`/`SourceSection` absorbed every
responsibility they used to own in `LiveView`. The files are kept (not deleted) as
a one-release rollback safety net; only `StreamSettingsCard`'s `ConfigRow` type is
still imported (now by `StreamSetupChain`/`IdleCockpit`). Tracked as
`TD-unmounted-source-shims` in `docs/TECHNICAL_DEBT.md` — do not delete these
files until that entry's exit condition is met, and do not re-mount them either.

### Engine-truth-clears-on-stop contract

`getStatus()?.active_encode` obeys the same never-stale-past-stop rule as the
link telemetry below. It is stronger than a cosmetic staleness issue:
`deriveActiveSummary` reads `live = Boolean(activeEncode)` and then prefers
`activeEncode.active_input` over the fresh `config.source`, so a retained object
claims the device is LIVE on a device that has stopped — observed on a board as
a stopped session still labelled `"● Live RØDE HDMI to USB-C … H.265"` after the
operator had already picked a different source. Guaranteed on both ends:
`cerastream-backend.ts` drops `active_encode` from telemetry when the engine
reports it is not streaming AND on `stop()` (a crashed engine sends no final idle
frame), and every status nudge now carries the field explicitly rather than only
when it exists; `subscriptions.svelte.ts` additionally clears it on the
`wasStreaming && !isStreamingState` edge, because the status merge preserves an
omitted field — the same raise-but-never-retract latch that bit
`policy_route_missing`.

### Telemetry-clears-on-stop contract

`getLinkTelemetry()` is guaranteed `null` (never a stale object) on the
streaming→stopped transition edge — belt-and-braces on both ends: the backend's
5 s heartbeat emits exactly one `{linkTelemetry: null}` frame after
`stopLinkTelemetry()` clears the source state (dedupe cache is deliberately NOT
reset in the stop path, so the null frame broadcasts once, not forever), and the
frontend additionally clears `linkTelemetryState` on the `wasStreaming &&
!isStreamingState` edge as a second guarantee even if a stop frame omits the
field. The tri-state distinction is load-bearing: `undefined` = pre-first-status
(skeleton), `null` = delivered-empty/stopped (dashes), object = live values. HUD
bitrate (`bitrateKbps: isStreaming ? config?.max_br ?? null : null`) and
per-interface throughput (`buildLinks(..., isStreaming)`) follow the same
never-stale-past-stop rule.

### HUD 4-fact scope

The persistent HUD strip (`HudBar.svelte`) surfaces exactly FOUR facts at a
glance: the lifecycle/state badge (live/idle/offline), the health verdict dot,
the bitrate, and ONE temperature chip. Voltage/current, per-link RTT/NAK/weight,
and the bond constellation live ONLY in the expanded Sheet — adding a fifth
compact-strip fact is a deliberate UX regression, not a tweak.

### BondedLinks-owns-telemetry rule

`apps/frontend/src/main/network/BondedLinksSection.svelte` is the documented SOLE
owner of live per-link telemetry (RTT/NAK/weight) on the Network destination. The
per-interface WiFi/Cellular/Ethernet section rows do NOT render their own
signal-%/speed-Badge telemetry clusters — that would duplicate numbers already
shown once, correctly, in `BondedLinksSection`. Do not re-add per-link numbers to
the per-interface sections.

