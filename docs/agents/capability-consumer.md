<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## CAPABILITY CONSUMER [EXISTS]

CeraUI is the strict consumer of the `get-capabilities` IPC contract emitted by
`cerastream`. The backend calls `get-capabilities` (a post-hello JSON-RPC method on
the UDS control plane) and forwards the tiered response to the frontend. The frontend
renders only the intersected offered set:

```
platform caps ∩ capture-source caps ∩ current-mode → offered set
```

Options outside the offered set are shown **disabled with a reason tooltip** — never
hidden, so operators can see what the hardware doesn't support and why.

**The encoder universe is engine-owned [EXISTS].** The published
`@ceralive/cerastream@2026.9.11` binding carries `get-capabilities.encoders[]` with
one entry per codec (`codec`, maximum resolution/framerate, accepted pixel formats,
and `gates."4k60"`). `@ceraui/rpc` imports the producer schemas and types directly;
it does not redeclare `PlatformCaps`, `VideoSourceCap`, or `EncoderCapability`.
The backend forwards the parsed ladder, and `EncoderDialog` derives codec
availability from it. `PLATFORM_CAPS_BY_HARDWARE` remains only for a legacy or
absent `encoders` snapshot and is pinned to the engine platform golden by a test.
`producer-wire-type-shadow.test.ts` rejects any reintroduced local declaration.

**`pipeline-sources.ts` per-board tables deleted [EXISTS].** The static per-board
capability tables that previously lived in `pipeline-sources.ts` are removed. All
capability data is now derived from the `get-capabilities` response at runtime. Do not
re-add static board tables; the contract is the single source of truth.

**Capability-first live experience [EXISTS].** The capability-first-live-experience
track deepened the contract to Tier-2 per-device modes and dropped the preset shortcut:

- The `capabilities` broadcast now carries per-device `device_modes` (folded from the
  engine `list-devices` `caps[]` in `capabilities.ts`, keyed by `input_id`, framerates
  normalized to rungs and bitrate normalized to kbps at ONE seam) plus
  `network_embedded_audio`. The offered set is now `platform ∩ active-source ∩ Tier-2
  device modes`; with `device_modes` absent it degrades to the coarse offering
  (old-engine fallback), never a fully-disabled axis set.
- The `status` broadcast carries a typed `audio_sources` list (`deriveAudioSources`)
  beside the legacy `asrcs` — pseudo-sources (`No audio`/`Pipeline default`) carry a
  `labelKey`; device entries stay untranslated. `config.asrc` wire value is unchanged.
- The mode-preset catalog is fully removed (`CANONICAL_PRESETS`/`modePresets.ts`/the
  `data-testid="mode-presets"` grid/`live.presets.*` keys are gone). `EncoderDialog` is
  now capability-first with independent, disabled-with-reason axes; `SourceSection`
  surfaces rtmp/srt LAN ingest as first-class source rows (`source-network-ingest-*`,
  with `NetworkIngestSection` the detailed QR/instructions card), and an rtmp/srt
  pipeline's embedded audio (`network_embedded_audio` + pipeline `audio_kind:
  'embedded'`) renders the read-only "Embedded audio" state, else a `TD-embedded-audio`
  coming-soon pill.
- The rendered-DOM truth of all of the above is locked by the capability-truthfulness
  e2e gate (`apps/frontend/tests/e2e/truthfulness.spec.ts`) — extend it, don't fork it.

**Source-experience overhaul [EXISTS].** The Live destination's source-selection,
encoder-configuration, and server-destination surfaces were overhauled as part of the
ceraui-source-experience / ceraui-receiver-experience tracks (Tasks 1–16). New
components and modules shipped:

- `apps/frontend/src/lib/components/custom/SourceSection.svelte` — live input picker
  section; renders the active source, a live-switch affordance, and the PiP/fallback
  coming-soon pills.
- `apps/frontend/src/lib/components/custom/ComingSoon.svelte` — calm roadmap pill +
  tooltip; takes a `debtId` prop and renders `data-debt-id` into the DOM. Every
  instance MUST point at an `open` entry in `docs/TECHNICAL_DEBT.md`.
- `apps/frontend/src/lib/components/custom/InfoPopover.svelte` — lightweight info
  popover (question-mark trigger + tooltip body); used by SourceSection and
  CapabilityTierBanner.
- `apps/frontend/src/lib/streaming/sourceSummary.ts` — derives a human-readable
  source summary string from the active config for the HUD and Live header.
- `apps/frontend/src/lib/streaming/liveAudioSwitch.ts` — live audio switch gate;
  `isAudioLiveSwitchEnabled(caps)` is the single source of truth for the
  `TD-live-audio-switch` capability check.
- `apps/frontend/src/lib/rpc/streaming-optimism.svelte.ts` — optimistic streaming
  state machine; bridges the gap between `startStream` RPC dispatch and the first
  `is_streaming=true` push so the UI never flickers back to idle mid-start.
- `apps/frontend/src/lib/streaming/receiver-experience.ts` — pure, rune-free module
  for the receiver-experience track. Exports: `Destination`, `deriveDestination`,
  `resolveReceiverKind`, `kindBadgeLabelKey`, `buildServerSetConfig`,
  `ServerReadiness`, `deriveServerReadiness`, `buildServerSummary`. The single source
  of truth for destination derivation, kind-badge i18n keys, and the field set sent
  to `streaming.setConfig` on save.
- `apps/frontend/src/main/dialogs/server/DestinationSection.svelte` — destination
  radiogroup (managed vs custom); provider-aware label from `config.remote_provider`.
- `apps/frontend/src/main/dialogs/server/CustomEndpointForm.svelte` — custom/manual
  endpoint fields driven by `receiverKindManifest(kind)` (addr, port, optional stream
  ID, optional secret for SRTLA/SRT custom).
- `apps/frontend/src/main/dialogs/server/TransportBadge.svelte` — transport summary
  chip + Advanced disclosure for protocol selection; reads `getCapabilities()` itself.
- `apps/frontend/src/main/live/ServerReadiness.svelte` — SRTLA bonded/single-link
  readiness hint in the Live destination; driven by `deriveServerReadiness`.
- `apps/frontend/src/main/live/LiveHeader.svelte` — Live header chip showing the
  active destination + kind badge; opens `ServerDialog` on tap.

**Source-priority reorder UI removed (live-correctness-pass Todo #10).** The
pre-start source-preference reorder affordance is GONE from the frontend:
`lib/streaming/source-preference.ts`, `SourcePreference.svelte`, and their tests
are deleted (every remaining importer was itself one of the deleted files). The
backend `source_preference` config field is KEPT for wire compat (still
persisted/echoed by `streaming.procedure.ts`) — an old client can still write it;
nothing in CeraUI writes or reads it anymore. `SourceSection.svelte`'s unified
`<ul>` renders sources in broadcast order — no rank sort, no drag handles.

**Track-1 tech-debt register [EXISTS].** Items from this overhaul are tracked in
`docs/TECHNICAL_DEBT.md` and enforced by `scripts/check-tech-debt.mjs`. Three remain
open; two are resolved (Task 26):

| ID | Feature | Status | Exit condition |
|----|---------|--------|----------------|
| `TD-live-audio-switch` | Live audio source switch | resolved 2026-06-17 | `capability:audio_live_switch` |
| `TD-live-audio-delay` | Live audio delay change | resolved 2026-06-17 | `capability:audio_live_switch` |
| `TD-live-audio-codec` | Live audio codec change | open | `capability:audio_codec_switch` |
| `TD-pip` | Picture-in-picture / compositing | open | `capability:pip_supported` |
| `TD-mode-fallback` | Mode-level automatic source fallback | open | `capability:mode_fallback` |
| `TD-plain-srt-egress` | Plain-SRT (non-SRTLA) receiver egress | open | `capability:srt` |

Open items are `track: 2` (cerastream engine dependency) and carry `coming-soon`
affordances in the Live destination. The CI gate (`check:tech-debt`) fails if any
source `data-debt-id` is orphaned or any entry is malformed.

**Relay transports + RIST protocol [EXISTS].** The capability contract carries a
`transports` list (the relay transports the engine can honor; always includes
`srtla`). The capability service derives it (`getSupportedTransports()` is the sync
backend gate source) and broadcasts the snapshot in the `capabilities` event. The
transport resolver promotes `rist` from a reserved placeholder to an active protocol
(`apps/backend/src/modules/streaming/transport/rist-adapter.ts`, RIST simple-profile:
even data port) gated on `ristAvailable` in `resolveStreamEndpoint`; `srt` stays
reserved. The shared selectability rule lives in `@ceraui/rpc/schemas`
(`relayProtocolAvailability`). `ServerDialog` renders the SRTLA/SRT/RIST selector
via `ProtocolSelector.svelte` (always-visible radiogroup, **above** the endpoint
section — protocol-first reorder, T21-T23): RIST is shown **disabled with a reason**
until the engine advertises the `rist` transport, SRT is always reserved
(`data-debt-id="TD-plain-srt-egress"`, calmed styling, CI-enforced) — never hidden.
`TransportBadge` is now a read-only summary chip that reflects the active protocol;
it is no longer the protocol entry point and no longer hosts an Advanced disclosure.

**Protocol-first receiver-experience overhaul [EXISTS].** `ServerDialog` was
rewritten as a destination-first container (ceraui-receiver-experience track, Tasks
1–14) and subsequently updated to a protocol-first layout (T21-T23): the protocol
selector is now promoted above the endpoint fields, making transport choice the
second decision after destination. Key concepts:

- **Receiver-kind model** (`packages/rpc/src/schemas/relay.schema.ts`): every stream
  destination is one of `srtla_relay`, `srtla_custom`, `rist_relay`, `rist_custom`,
  or `srt_custom`. `deriveReceiverKind` derives the kind from the current config;
  `receiverKindManifest(kind)` describes which fields are required and whether the
  kind is bonded or single-link. See [`docs/RECEIVER_MODEL.md`](../RECEIVER_MODEL.md)
  for the full model and the Scope-B plain-SRT contract.
- **Transport × destination model**: the two axes are independent. Destination
  (`managed` relay vs `custom` endpoint) is chosen first; transport (SRTLA / RIST /
  SRT) is chosen second via the always-visible `ProtocolSelector` rendered ABOVE the
  endpoint fields (protocol-first reorder, T21-T23) — no longer inside `TransportBadge`,
  which is now a read-only summary chip. A managed relay may advertise
  multiple protocols via `server.protocols`; the dialog seeds the best available
  default when the selected server's protocol set excludes the current draft.
- **`relay.validate` mock seam (T4)**: `apps/backend/src/rpc/procedures/relay.procedure.ts`
  exposes a `relay.validate` procedure that runs ordered stages (`input` → `protocol`
  → `endpoint` → `dns` → `probe`). The `dns` and `probe` stages are stubbed by the
  mock seam (`shouldUseMocks()` gate) so integration tests can exercise the full
  validation pipeline without real DNS or UDP reachability. See
  `apps/backend/src/mocks/providers/relay.ts` for the mock provider.

**New `server/` sub-components [EXISTS]:**

- `apps/frontend/src/main/dialogs/server/DestinationSection.svelte` — presentational
  radiogroup (managed vs custom); provider-aware label driven by `config.remote_provider`
  (set in `CloudRemoteDialog`); D6-gated (managed disabled when no relay servers are
  configured or while streaming).
- `apps/frontend/src/main/dialogs/server/ProtocolSelector.svelte` — always-visible
  radiogroup for protocol selection (SRTLA / RIST / SRT); rendered **above** the
  endpoint section in `ServerDialog.svelte` (protocol-first reorder, T21-T23). Reads
  `getCapabilities()` itself. RIST is disabled-with-reason until the engine advertises
  the `rist` transport; SRT carries `data-debt-id="TD-plain-srt-egress"` (calmed
  styling, CI-enforced via `check:tech-debt`) and is never hidden.
- `apps/frontend/src/main/dialogs/server/CustomEndpointForm.svelte` — field set for
  custom/manual endpoints; fields driven by `receiverKindManifest(kind)` (addr, port,
  optional stream ID, optional secret for SRTLA/SRT custom).
- `apps/frontend/src/main/dialogs/server/TransportBadge.svelte` — read-only summary
  chip showing the active receiver kind via `kindBadgeLabelKey` (from
  `lib/streaming/receiver-experience.ts`) and a bonding readiness line for SRTLA.
  Demoted to a summary chip in T21-T23: it is no longer the protocol entry point and
  no longer hosts an Advanced disclosure for protocol selection.

**Scope decisions (record for future agents):**

- **HUD bar does NOT surface the server target.** The persistent `HudBar.svelte` shows
  bitrate, per-link signals, and SoC telemetry only. The Live header chip
  (`main/live/LiveHeader.svelte`) and the Live destination summary row own the
  server-target display. Adding server-target to the HUD is explicitly out of scope
  and would duplicate the Live header.
- **Provider-switch stale-`relay_server` (surfaced, T18).** `DestinationSection`
  labels the managed option using `config.remote_provider` (set by `CloudRemoteDialog`).
  If the operator switches provider in `CloudRemoteDialog` without clearing the server
  selection in `ServerDialog`, the persisted `relay_server` may reference a server from
  the previous provider's relay list. The dialogs DELIBERATELY do not auto-clear
  `relay_server` (no silent mutation of the operator's config) — instead the staleness
  is now made VISIBLE on both surfaces (T18): `CloudRemoteDialog` shows a
  `relay-provider-stale-warning` band when the chosen provider no longer owns the saved
  server, and `ServerDialog` shows a `relay-stale-warning` band in the managed branch.
  The staleness rule is the pure `isRelayServerStaleForProvider(relay_server, entries,
  provider)` in `receiver-experience.ts` (a saved id absent from the catalog, or tagged
  to a different managed cloud, is stale; empty/untagged-legacy never is). Both call
  sites MUST guard on a loaded catalog (`getRelays() !== undefined`) so a still-loading
  relay list never false-warns. A related T18 warning, `relay-override-warning`
  (`overrideClearsManagedBinding`), fires before save when a manual-endpoint override
  on a bound managed server would drop the `relay_server` binding.
- **Device ↔ cloud-OBS association is read-only (T17).** A platform-managed ingest
  slot may carry an `obsInstanceId` + `instanceLabel` naming the cloud OBS instance it
  feeds. `obsInstanceAssociation(account)` (`receiver-experience.ts`) surfaces a calm
  read-only line — under each slot in `ServerIngestSlots.svelte`
  (`data-testid="obs-instance-association"`) and appended to the Live server summary by
  `buildServerSummary` — copy `settings.feedsCloudObsInstance` (10 locales). It renders
  only when BOTH `obsInstanceId` is non-null AND `instanceLabel` is non-empty; an
  unbound slot shows nothing. The device only OBSERVES the binding the platform pushes —
  there is **NO device-side OBS control** (no start/stop, no scene switch). On the cloud
  side each endpoint also carries a `sourceKind` (a device feed = `DEVICE`); CeraUI
  neither sets nor reads it. Full model: [`docs/RECEIVER_MODEL.md`](../RECEIVER_MODEL.md) §6.

**Plain-SRT / RIST roadmap.** Plain-SRT egress requires three layers to land together
(capability advertisement, real `srtAdapter`, and a `startStream` protocol branch).
Full spec: [`docs/RECEIVER_MODEL.md`](../RECEIVER_MODEL.md) §3. Tracked as
`TD-plain-srt-egress` in [`docs/TECHNICAL_DEBT.md`](../TECHNICAL_DEBT.md).

**Tier-4 add-on compat [PARTIAL].** Add-on compatibility is resolved entirely inside
CeraUI and is NOT part of the `get-capabilities` response. Three enforcement layers:

- `compatibleHardware` field in `AddonDescriptorSchema` gates which boards may enable
  an add-on (server-side enforcement in `apps/backend/src/modules/addons/manager.ts`
  — not UI-only).
- `deps[]` / `conflicts[]` in `AddonDescriptorSchema` are enforced at enable time
  (previously declared but unenforced).
- In-UI docs: incompatible add-ons show a reason tooltip explaining the hardware or
  dependency constraint.

**Recent enhancements [PARTIAL]:**

- **SIM PUK recovery** — UI flow for entering the PUK code when a SIM is PUK-locked.
- **SIM PIN auto-unlock** — `maybeAutoUnlockSimPins()` submits the opt-in PIN (stored
  in the chmod-600 tmpfs file `/run/ceralive/sim-pin.secret`, never in `config.json`)
  at most once per locked modem on boot, then clears the PIN and stops on any failure.
  See `apps/backend/src/modules/modems/sim-autounlock.ts`.
- **Ingest sparklines** — fixed ~60-sample in-memory ring buffer per link; no
  persistence. Rendered in the HUD bar as a compact bitrate history.
- **Session summary** — post-stream summary panel showing duration, average bitrate,
  and per-link stats for the completed session.
- **EncoderDialog modal preview (#72)** — live encoder settings preview rendered inside
  the EncoderDialog modal before the user applies changes.

