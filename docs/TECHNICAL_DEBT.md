# CeraUI Technical-Debt Register

**Status:** `[EXISTS]`

This register is the single, machine-checkable ledger of technical debt that the
CeraUI source-experience overhaul **introduces or touches**. It extends the proven
deferred-work ledger pattern from
[`image-building-pipeline/v2/docs/DEFERRED.md`](../../image-building-pipeline/v2/docs/DEFERRED.md)
(what / why / where / unblock) and is validated in CI by
[`scripts/check-tech-debt.mjs`](../scripts/check-tech-debt.mjs).

It is **not** a historical audit. Pre-existing `[PARTIAL]` claims elsewhere in the
tree are governed by the status-label convention in the root
[`docs/CONVENTIONS.md`](../../docs/CONVENTIONS.md) — this register covers only debt
that THIS overhaul is responsible for, so an item belongs here exactly when the
overhaul ships a debt marker (`data-debt-id`, `coming-soon`, or an in-source
`[PARTIAL]`) that points at it.

The register currently has **no entries**. Entries are added by the overhaul tasks
that introduce debt (e.g. tasks that ship a `coming-soon` UI affordance or a
`data-debt-id`-tagged element). Adding a marker without a matching `open` entry
here fails CI; resolving the debt means removing the marker(s) and flipping the
entry to `resolved`.

---

## Entry Format (machine-checkable — CI enforces it)

Every entry is a fenced code block tagged **`debt`**. The validator parses every
` ```debt ` block in this file and rejects any block that is missing a field, has
an unknown field, or carries an out-of-contract value. Each block has exactly these
nine fields, one `key: value` per line, in any order:

| Field | Required value |
|-------|----------------|
| `id` | Unique register id: either the numeric form `TD-NNN` (e.g. `TD-001`) or a descriptive slug `TD-<slug>` (lowercase alphanumeric words joined by hyphens, e.g. `TD-live-audio-switch`). No duplicates. |
| `title` | One-line human summary (non-empty). |
| `track` | Owning workstream: `1` (CeraUI overhaul) or `2` (cerastream engine). |
| `status` | `open` or `resolved`. |
| `exit_criteria` | An **executable** command in backticks (e.g. `` `bun run --filter frontend test -- foo.test.ts` ``) **or** a capability/PR reference (`capability:<flag>`, `PR #<n>`). Never prose. |
| `owner` | GitHub handle or name of the accountable owner (non-empty). |
| `registered_at` | ISO date `YYYY-MM-DD` the debt was registered. |
| `resolved_at` | ISO date `YYYY-MM-DD` when resolved, or `null` while `open`. A `resolved` entry MUST carry a real date; an `open` entry MUST be `null`. |
| `unblock` | What must happen to clear it — the same "unblock condition" prose the DEFERRED.md ledger uses (non-empty). |

Markers that bind source code to an entry:

- `data-debt-id="TD-NNN"` — an attribute on a UI element (or a `// data-debt-id="TD-NNN"`
  source comment) MUST reference an `open` entry id. An orphan id fails CI.
- `coming-soon` / `[PARTIAL]` (in source under `apps/*/src` or `packages/*/src`) MUST
  appear on a line that also carries a `data-debt-id="TD-NNN"` pointing at an `open`
  entry. A bare marker with no register link fails CI.

The scan covers **shipped source only**. `*.test.*` / `*.spec.*` files are excluded:
their assertion strings and selectors legitimately name markers (`coming-soon`,
`data-debt-id`) without being shippable debt. A reusable affordance component (e.g.
`ComingSoon.svelte`) may render `data-debt-id` dynamically for the DOM/tests; the
static binding the gate verifies then lives in a literal `data-debt-id="TD-…"`
comment co-located with each call site.

### Template

A real entry is a fenced block opened with three backticks immediately followed by
`debt`, the nine `key: value` lines, then a closing three-backtick fence. Written
out (with the fence markers shown as `[```debt]` / `[```]` so this sample is **not**
itself parsed as a live entry — a genuine entry uses literal backtick fences):

```text
[```debt]
id: TD-001
title: Live-audio source switch UI is gated but the engine control path is stubbed
track: 1
status: open
exit_criteria: `bun run --filter backend test -- audio-live-switch.test.ts`
owner: andrescera
registered_at: 2026-06-17
resolved_at: null
unblock: cerastream advertises audio_live_switch=true and the backend wires the live switch RPC; remove the coming-soon marker and flip this entry to resolved.
[```]
```

The only literal ` ```debt ` fences in this file are live register entries; the
register is "empty" precisely when there are none.

---

## Open Debt

```debt
id: TD-modem-phase-c-spa-size
title: Modem Phase-C operator surfaces increased the aggregate SPA and precache footprint
track: 1
status: open
exit_criteria: `bun run build:frontend && bun scripts/ci/bundle-report.mjs`
owner: ceraui-team
registered_at: 2026-08-20
resolved_at: null
unblock: The complete modem Phase-C control surface and shared wire schemas measured 982,392 B total SPA gzip and 1,123,271 B service-worker precache gzip at commit e5849653, versus the retained pre-feature baselines of 762,410 B and 903,286 B. Reduce this footprint in a dedicated bundle effort without removing capability-truth controls or weakening offline availability; keep the entry open until both accepted aggregate baselines can be lowered. The initial-route and largest-chunk baselines remain unchanged.
```

The Phase-C exception is limited to the two aggregate measurements. The initial-route
and largest-chunk ceilings remain on their pre-feature baselines, and every run reports
the displaced aggregate measurements so the accepted growth remains visible.

The 982,392 B total-SPA figure above is no longer the live constant — it was displaced on
2026-09-01 by `TD-spa-i18n-catalog-size` below and is now reported as a retained
measurement. This entry stays open regardless: the precache baseline it accepted is still
live, and the reduction it asks for has not happened.

```debt
id: TD-spa-i18n-catalog-size
title: Every operator-facing message key costs ~500 B gzip of aggregate SPA across 10 locales
track: 1
status: open
exit_criteria: `bun run build:frontend && bun scripts/ci/bundle-report.mjs`
owner: ceraui-team
registered_at: 2026-09-01
resolved_at: null
unblock: The total SPA JS+CSS gzip baseline moved from the accepted Phase-C 982,392 B to 1,103,680 B (+12.3%) on 2026-09-01. Growth merged between 2026-08-20 and that date had already taken the aggregate to 1,099,280 B — 99.9% of the Phase-C 12% budget — and the capture-truth branch's eight new operator-facing message keys added 4,400 B, of which 4,009 B (91%) is Paraglide's per-message x 10-locale expansion in the lazily-imported notifications (+2,299 B) and live (+1,710 B) namespace chunks; only 259 B is code. Reduce the per-key aggregate cost in a dedicated bundle effort — evaluate Paraglide outputStructure "locale-modules" so a session loads one locale instead of ten, per-locale precache scoping, and a narrower shipped locale set — without deleting operator copy or dropping a language; keep the entry open until the aggregate baseline can be lowered. The initial-route, largest-chunk, and precache baselines are unchanged by this step.
```

This is the same root cause as `TD-federation-i18n-catalog-size` on a different surface:
the SPA splits the catalog into lazy namespace chunks where the federation bundle cannot,
so the SPA pays the ten-locale tax per namespace rather than all at once. It is recorded
separately because the remedies and the exit measurements differ.

Two guardrails came with the re-derivation rather than after it. The aggregate total is
now bounded by a 16 KiB **absolute** ceiling as well as the 12% ratio, so re-deriving the
baseline released ~16 KiB rather than the ~118 KiB a ratio alone would have handed back;
and both displaced measurements (762,410 B pre-Phase-C, 982,392 B Phase-C) are re-stated
on every run. Service-worker precache was **not** re-derived at that step — it still passed
on the Phase-C baseline, at 1,244,557 B against a 1,258,063 B budget, i.e. roughly 13 KiB
from its own ceiling. The next surface of this size breaches precache too.

**2026-09-04 — that prediction came true, and precache was re-derived.** The PiP/PbP
composition surface (`CompositionCard.svelte`) added twenty operator-facing keys × 10
locales: 6,688 B aggregate, 6,759 B precache. The tree was already at 99.5% of the
aggregate ceiling and 99.8% of the precache one, so the breach was not this feature being
large — trimming its prose first recovered 941 B and could not close a 3,820 B precache
gap. Both baselines moved (1,103,680 → 1,121,005 B total; 1,123,271 → 1,261,883 B
precache), both displaced measurements are preserved and re-stated on every run, and
**precache gained the same 16 KiB absolute ceiling the total already had** — without it,
re-deriving under the 1.12 ratio alone would have released ~135 KiB of unearned headroom,
20× the growth that forced the step. The initial-route and single-chunk ceilings are
untouched. This entry stays open: the reduction it asks for still has not happened, and
the aggregate is now ~32 message keys from its next ceiling on both metrics.

```debt
id: TD-federation-i18n-catalog-size
title: Federation toast-host shared chunk carries an oversized static Paraglide catalog
track: 1
status: open
exit_criteria: `bun run build:federation && bun scripts/ci/bundle-report.mjs`
owner: ceraui-team
registered_at: 2026-08-15
resolved_at: null
unblock: The federation toast-host.js shared chunk measured 613,463 B gzip on 2026-08-15, versus the prior 245,936 B budget, because a hosted federation bundle is one signed manifest-pinned module graph and must carry the Paraglide catalog statically rather than lazy-loading the SPA's locale chunks. Revisit this debt in a dedicated architecture effort by evaluating (1) Paraglide outputStructure: "locale-modules", (2) dynamic federation chunks with manifest/signing/CSP support, and (3) a smaller federation-specific catalog surface; keep this entry open until one remedy is implemented and the live budget can be reduced.
```

The federation budget exception is intentionally limited to `toast-host.js`; every
other federation budget remains at its passing value. The measured size is accepted
as a documented, open debt rather than silently treated as resolved.

```debt
id: TD-pip
title: Picture-in-picture / source compositing
track: 2
status: resolved
exit_criteria: capability:composition
owner: ceraui-team
registered_at: 2026-06-17
resolved_at: 2026-09-04
unblock: cerastream advertises the `composition` feature token and exposes the two-leg rgacompositor session mode; replace the Live "coming soon" affordance with the real control and flip this entry to resolved.
```

Resolved. cerastream's RK3588 two-leg session mode ships the `composition` token
in `get-capabilities.features` — filtered out unless the board's `rgacompositor`
clears a NULL→READY backend trial, so the token means a two-leg session can
actually be built. `CompositionCard.svelte` is the real control (secondary-input
picker, six layout presets, alpha), mounted by `IdleCockpit.svelte` ONLY while
that token is present; the `coming-soon` affordance and its `data-debt-id` marker
are removed from the Roadmap disclosure.

The exit criterion moved from `capability:pip_supported` to
`capability:composition` because the engine never shipped the former: the
capability payload's `pip_supported` boolean is a legacy field no cerastream
release sets, and the feature is negotiated through the `features` token array
instead.

```debt
id: TD-live-audio-codec
title: Live audio codec change
track: 2
status: open
exit_criteria: capability:audio_codec_switch
owner: ceraui-team
registered_at: 2026-06-17
resolved_at: null
unblock: cerastream advertises audio_codec_switch=true and the backend wires a mid-stream acodec reload; replace the Audio dialog "coming soon" affordance (data-debt-id="TD-live-audio-codec") with an enabled control and flip this entry to resolved.
```

The audio codec cannot be switched mid-stream: applying a new `acodec` requires a
stream restart. While streaming, the Audio dialog renders the codec control disabled
with a "coming soon" affordance (`data-debt-id="TD-live-audio-codec"`) instead of an
enabled select. Pre-start codec selection is unaffected.

```debt
id: TD-mode-fallback
title: Mode-level automatic source fallback
track: 2
status: open
exit_criteria: capability:mode_fallback
owner: ceraui-team
registered_at: 2026-06-17
resolved_at: null
unblock: cerastream advertises mode_fallback=true and exposes an auto-fallback source policy; replace the Live "coming soon" affordance (data-debt-id="TD-mode-fallback"), now rendered inside the IdleCockpit Roadmap disclosure (apps/frontend/src/main/live/IdleCockpit.svelte, moved there by Task 12), with the real fallback control and flip this entry to resolved.
```

When the active source drops, the engine does not yet auto-fall-back to a backup
input — recovery is operator-driven via the unified source list
(`SourceSection.svelte`). The Live destination surfaces a calm "coming soon"
affordance (`data-debt-id="TD-mode-fallback"`) inside the collapsed Roadmap
`<details>` disclosure at the bottom of the idle Live cockpit (`IdleCockpit.svelte`,
Task 12) until the engine advertises `mode_fallback`.

```debt
id: TD-plain-srt-egress
title: Plain-SRT (non-SRTLA) receiver egress
track: 2
status: open
exit_criteria: capability:srt
owner: ceraui-team
registered_at: 2026-06-19
resolved_at: null
unblock: Three layers must land together before plain-SRT egress is live. (1) cerastream must advertise a "srt" transport in its get-capabilities response, which CeraUI surfaces in capabilities.transports and uses to promote "srt" from CAPABILITY_GATED_RELAY_PROTOCOLS to an active protocol. (2) The srt TransportAdapter in transport/registry.ts must replace the current createPlaceholderAdapter("srt", ...) with a real implementation whose resolveEndpoint delivers a remote SRT caller target directly to the engine — bypassing srtla_send entirely. (3) startStream (streamloop/start-stream.ts) unconditionally spawns srtla_send and connects the engine to 127.0.0.1:9000; a protocol branch is needed so plain-SRT skips the srtla_send spawn and passes the remote target straight to the engine IPC. This branch is a PREREQUISITE refactor shared by both RIST and SRT, because session.ts and autostart.ts carry no protocol parameter today. When all three layers are in place, remove the ServerDialog reserved-SRT affordance and flip this entry to resolved.
```

---

```debt
id: TD-rist-egress
title: RIST receiver egress
track: 2
status: open
exit_criteria: capability:rist
owner: ceraui-team
registered_at: 2026-06-30
resolved_at: null
unblock: RIST egress is resolver-only today — the shared startStream protocol branch (RECEIVER_MODEL §3 Layer 3) does not yet pass a remote RIST target to the engine, so RIST is not a selectable egress transport. The receiver dialog surfaces RIST as a calm coming-soon affordance (data-debt-id="TD-rist-egress") in TransportRow. When cerastream advertises a usable "rist" egress transport AND the startStream protocol branch routes a RIST target to the engine, replace the coming-soon affordance with a real selectable transport and flip this entry to resolved.
```

```debt
id: TD-embedded-audio
title: Embedded network-ingest audio routing
track: 2
status: open
exit_criteria: capability:network_embedded_audio
owner: ceraui-team
registered_at: 2026-07-03
resolved_at: null
unblock: A network-ingest (rtmp/srt) publish carries its own muxed audio, but the engine can only route that embedded audio when it advertises the network_embedded_audio capability (cerastream Task 21). Until an engine advertising it is deployed, the Live audio picker keeps the legacy selectable-ALSA path for rtmp/srt pipelines and surfaces a calm coming-soon affordance (data-debt-id="TD-embedded-audio") in TWO places (both post-Task-12/15): conditionally inside the IdleCockpit Roadmap disclosure (apps/frontend/src/main/live/IdleCockpit.svelte) and next to the read-only active-audio-source label in AudioDialog.svelte. When the deployed engine advertises network_embedded_audio=true, the backend skips asrcProbe + omits audio.device and the frontend renders the read-only "Embedded audio" state; remove both coming-soon affordances and flip this entry to resolved.
```

```debt
id: TD-live-audio-follow
title: Live device-keyed audio follow on a mid-stream input switch
track: 2
status: open
exit_criteria: `capability: audio switch accepts list-devices audio input ids`
owner: ceraui-team
registered_at: 2026-07-04
resolved_at: null
unblock: cerastream's switch-audio drives ONLY the two pre-built audio-switch graph legs "a"/"b" (drive_audio_switch, engine.rs:2550 + AUDIO_LEG_A/B engine.rs:2695/2742) — it cannot accept an arbitrary list-devices audio input_id, so a live device-keyed audio follow is NOT implementable against the current engine. A live video switchInput therefore RE-RESOLVES the Auto audio target and applies it AT THE NEXT START (T5's launch-time resolution), broadcasting pending_audio_follow_asrc + a calm "audio follows on restart" hint (i18n live.inputPicker.audioFollowsOnRestart) rather than dispatching a mid-stream switchAudio. When cerastream's switch-audio accepts list-devices audio input ids (device-id-keyed legs), the backend switchInput follow path (apps/backend/src/rpc/procedures/streaming.procedure.ts applySwitchInputFollow) can dispatch a real live audio switch instead of setPendingAudioFollowAsrc, and this entry flips to resolved.
```

This entry carries no source `data-debt-id` marker — the deferred follow is a
backend-only engine limitation surfaced via a calm restart hint (a toast on the
switchInput RPC result + the existing `audio-follow-pending` line), never a
fake-interactive disabled control, so there is no live UI affordance to bind a
marker to. The register entry is the durable record of the deferred-apply
decision instead.

```debt
id: TD-gateway-b2-fleet-window
title: Dual-topology SRT gateway probe (B2 fleet-transition tolerance)
track: 1
status: open
exit_criteria: `bun run --filter backend test -- network-ingest.test.ts`
owner: ceraui-team
registered_at: 2026-07-03
resolved_at: null
unblock: The B2 gateway consolidation (image-building-pipeline: MediaMTX terminates RTMP :1935 + SRT :4001; srt-live-transmit removed) transitions the fleet across two SRT topologies. resolveSrtTopology (apps/backend/src/modules/network/network-ingest.ts) therefore tolerates BOTH the OLD standalone ceralive-srt-gateway.service and the NEW MediaMTX-terminated SRT (parsed from /etc/mediamtx.yml). Once every fleet device has run the B2 image for the full 6-month support window (no device still on the srt-live-transmit topology), remove the OLD-topology branch (srtUnitActive) from resolveSrtTopology plus its network-ingest.test.ts cases, then flip this entry to resolved. This is a backend-only probe simplification and carries no source data-debt-id marker.
```

```debt
id: TD-legacy-source-broadcasts
title: Legacy pipelines/devices/device_modes broadcasts kept as deprecation shims behind the unified sources broadcast
track: 1
status: open
exit_criteria: `bun run --filter backend test -- sources.test.ts`
owner: ceraui-team
registered_at: 2026-07-04
resolved_at: null
unblock: remove only after the FULL migrate-then-wait-then-delete sequence below completes — it is NOT a straight one-release timer. The device-first source model (experience-simplification Tasks 1-16) folds pipelines/devices/device_modes into ONE unified sources broadcast (modules/streaming/sources.ts, getSourcesMessage/buildSources), but the three legacy producers are deliberately left running byte-for-byte unchanged as a rollback safety net: the `devices` broadcast (modules/streaming/devices.ts `deps.broadcast("devices", …)` + its post-login dispatch in rpc/adapter.ts), the `pipelines` broadcast (rpc/procedures/streaming.procedure.ts `broadcastMsg("pipelines", …)`), and the `device_modes` field folded onto the `capabilities` broadcast (modules/streaming/capabilities.ts). CORRECTED 2026-07-06 — this entry previously made a FALSE blanket claim that every frontend consumer had already migrated onto `getSources()`; in truth `EncoderDialog.svelte` (`getPipelines`+`getDevices`), `AudioDialog.svelte` (`getPipelines`), `LiveView.svelte` (`getPipelines`), and `StreamingStateManager.svelte.ts` (`getPipelines`) all still consume the legacy getters directly today — only `SourceSection`/`StreamSetupChain` read `getSources()` exclusively. The REAL exit condition: (1) migrate `EncoderDialog`/`AudioDialog`/`LiveView`/`StreamingStateManager` off `getPipelines`/`getDevices` onto `getSources`-derived data, (2) ship one full release on that migrated state as the sole consumer path with no rollback needed, (3) THEN delete the three legacy producers/fields (and the now-unused `getPipelines`/`devices`/`device_modes` schema surface, if nothing else depends on it), then flip this entry to resolved. STEP 1 DONE 2026-08-15 (ts7-node26-i18n-quality todo 27): all four consumers now read `getSources()` through `apps/frontend/src/lib/streaming/sources-view-model.ts`, which projects the unified `StreamSource[]` back into the legacy `Pipelines` registry and the probed-caps/UVC-H.265 device views the Encoder dialog renders. `grep -rn "getPipelines()\|getDevices()" apps/frontend/src` now returns ZERO call sites outside `subscriptions.svelte.ts` itself (the remaining hits are the `lib/rpc/client.ts` procedure type, the `lib/rpc/index.ts` barrel re-export, and three documentation comments in `NetworkIngestSection.svelte`/`networkIngestRows.ts`/`audioGate.ts`). The three legacy PRODUCERS were deliberately left running unchanged — this entry stays OPEN on step 2. NEXT GATE: after the next release tag lands, verify it contains the migration commit (`git tag --contains <sha>` non-empty) and that no rollback was needed, then execute step 3.
```

This entry carries no source `data-debt-id` marker — the shim is a backend
broadcast-retention decision, not a UI affordance. It is registered here purely
so the "kept for one release, then delete" decision has a durable, dated record
future agents can find instead of re-litigating whether the legacy broadcasts are
safe to remove.

```debt
id: TD-unmounted-source-shims
title: StreamSettingsCard/OnboardingChecklist/ServerReadiness/NetworkIngestSection/GoLiveCard kept as unmounted Live-cockpit migration shims
track: 1
status: open
exit_criteria: `bun run --filter frontend check`
owner: ceraui-team
registered_at: 2026-07-04
resolved_at: null
unblock: remove after one release with the sources broadcast. GoLiveCard + IdleCockpit (experience-simplification Tasks 10-12) absorbed every responsibility four of these components used to own in LiveView — the onboarding/empty-state guidance, the destination readiness hint, the migrated config rows, and the LAN network-ingest picker are all now rendered by GoLiveCard/IdleCockpit/SourceSection. The live-experience-refinement track (Task T9) then merged GoLiveCard's own gates+rows into StreamSetupChain.svelte (one "Stream setup" card of four always-visible rows, no collapse), so GoLiveCard.svelte itself is now ALSO an unmounted shim — kept-not-deleted as a one-release rollback safety net (only StreamSettingsCard's `ConfigRow` type is still imported, now by StreamSetupChain/IdleCockpit; GoLiveCard.svelte re-exports nothing anyone mounts). Once one full release has shipped on the device-first Live cockpit with StreamSetupChain and no rollback, delete apps/frontend/src/main/live/StreamSettingsCard.svelte, main/live/OnboardingChecklist.svelte, main/live/ServerReadiness.svelte, main/live/GoLiveCard.svelte, and lib/components/custom/NetworkIngestSection.svelte (plus their test files and the now-orphaned `onboarding.svelte.ts` store), re-point the `ConfigRow` type onto StreamSetupChain directly, then flip this entry to resolved. GATE CHECK 2026-07-06 (todo 13, ceraui-refinement-pass): HELD — deletion deferred. StreamSetupChain.svelte was introduced by commit d2f4b2db (2026-07-05, `feat(live): device-first live-experience refinement`); `git tag --contains d2f4b2db` is EMPTY and the two newest releases v2026.6.2 (2026-06-18) + v2026.6.1 (2026-06-17) both predate it, so NO shipped release contains the device-first StreamSetupChain cockpit yet. The "one release with the sources broadcast" precondition is unmet — zero files deleted this pass. Re-run the gate (`git tag --contains d2f4b2db`) after the next release tag lands; delete + resolve only once a tag contains it.
```

This entry also carries no source `data-debt-id` marker — the five files are
inert (never imported by anything the router mounts, `StreamSettingsCard`'s type
export excepted), so there is no live UI affordance to bind a marker to. The
register entry is the durable record of the "kept but dead" decision instead.

```debt
id: TD-ler-engine-pin
title: CeraUI @ceralive/cerastream pin not yet bumped to a release carrying alsa_card_id + input_codec
track: 2
status: open
exit_criteria: `pin @ceralive/cerastream >= the cerastream release carrying alsa_card_id + input_codec`
owner: ceraui-team
registered_at: 2026-07-05
resolved_at: null
unblock: The live-experience-refinement plan's additive `alsa_card_id` and `input_codec` fields remain unreleased. CeraUI now pins public-npm `@ceralive/cerastream` 2026.7.1 for the test-pattern audio contract, but that release's 0.4.0 binding surface still omits both fields. The permanent fallback remains intentional: audio naming falls back to `/proc/asound/cards`, and the incoming-codec chip stays absent when `active_encode.input_codec` is undefined. To clear, wait for a CalVer release that publishes both fields, bump the registry pin, run `bun install` and the bindings-skew test, retain the fallback paths for older engines, then resolve this entry. Never work around the release dependency with `link:`, `file:`, or a vendored tarball.
```

This entry carries no source `data-debt-id` marker — the deferral is a backend
dependency-pin decision (an external cerastream-release dependency), not a UI
affordance, so there is no live element to bind a marker to. The register entry
is the durable, dated record of the deferred pin bump instead.

```debt
id: TD-test-pattern-audio-override
title: CeraUI-side old-engine override forces test-pattern audio selectable until the fleet minimum engine advertises supports_audio
track: 2
status: open
exit_criteria: capability:supports_audio
owner: ceraui-team
registered_at: 2026-07-07
resolved_at: null
unblock: The cerastream test pattern gained a real muted audiotestsrc tone leg AND a truthful supports_audio=true capability in the 2026.7.1 release (coherence-contract-pass todo 4), so a device on that engine or newer derives the test source's selectable audio purely from the engine's advertised supports_audio. A device still on an OLDER engine reports supports_audio=false for the test source, so deriveAudioKind (apps/backend/src/modules/streaming/sources.ts) keeps the CeraUI-side TEST_PATTERN_AUDIO_OVERRIDE=true fallback: for the virtual test-pattern id ONLY it returns "selectable" on `supportsAudio || TEST_PATTERN_AUDIO_OVERRIDE`. This override is scoped to the single test id — a coarse/other source without supports_audio still stays "none" (no blanket override). To clear: once every fleet device runs a cerastream engine that advertises supports_audio for the test source (fleet minimum >= 2026.7.1 for the full 6-month support window), delete the TEST_PATTERN_AUDIO_OVERRIDE constant AND the `id === VIRTUAL_SOURCE_ID` branch in deriveAudioKind that reads it (the engine's own supports_audio then drives the virtual source like every other), update sources.test.ts, then flip this entry to resolved. This entry carries no source data-debt-id marker — the override is a backend audio-provenance derivation, not a UI affordance.
```

This entry carries no source `data-debt-id` marker — the override is a backend
audio-provenance derivation in `deriveAudioKind`, not a UI affordance, so there is
no live element to bind a marker to. The register entry is the durable, dated
record of the old-engine fallback and its delete-on-fleet-minimum exit condition.

> **Cross-repo follow-up (not CeraUI debt): RTMP-ingest unification.** The B2 SRT
> ingest is now a loopback `srtsrc`-caller pull; RTMP ingest deliberately STAYS on
> the existing `rtmpsrc` loopback in this plan. A possible future unification
> (MediaMTX remuxes RTMP→TS so cerastream pulls a single SRT code path, trading
> enhanced-RTMP codec coverage for one ingest path) is documented — not
> implemented — in the cerastream repo at `docs/notes/rtmp-srt-pull.md`. It is a
> cerastream (track-2) follow-up with no CeraUI marker, so it is recorded here as a
> cross-reference only, NOT a `debt` register entry.

```debt
id: TD-active-profile-ui-fanout
title: device.activeProfile status-relay frame fans out to UI clients with no subscriptions consumer case
track: 1
status: resolved
exit_criteria: `grep -q "device.activeProfile" apps/frontend/src/lib/rpc/subscriptions.svelte.ts`
owner: ceraui-team
registered_at: 2026-07-06
resolved_at: 2026-07-06
unblock: Surfaced by the live-correctness-pass Todo #18 contract-parity audit (`scripts/audit-contract-parity.mjs`). The active-profile reporter (modules/remote-control/active-profile-reporter.ts, wired by active-profile-wiring.ts) emits the ACTIVE_PROFILE_STATUS frame ("device.activeProfile", protocol.ts) via broadcastMsg. That is the correct transport for the device→platform status relay (status-relay.ts RELAYABLE_TYPES), but broadcastMsg also fans every frame out to the authenticated UI WebSocket clients, where subscriptions.svelte.ts has no matching `case` and falls through to `default: console.warn("Unhandled message type:", ...)`. The frame is harmless to the UI (it drives nothing there) but produces a dev-console warning on every profile change and is a producer-without-consumer wire mismatch. To clear: EITHER add a no-op `case "device.activeProfile": break;` (with an explanatory comment) to subscriptions.svelte.ts so the UI explicitly ignores the relay frame, OR scope the reporter's emit so the device.activeProfile frame is relayed to the platform hub only and never reaches the UI broadcast fan-out; then flip this entry to resolved. This entry carries no source `data-debt-id` marker — it is a backend broadcast-fan-out decision, not a UI affordance.
```

This entry, like the other broadcast-retention entries above, carries no source
`data-debt-id` marker — the finding is a backend broadcast-fan-out observation
surfaced by the contract-parity audit, not a UI affordance to bind a marker to.
The audit script (`scripts/audit-contract-parity.mjs`) classifies
`device.activeProfile` as a documented relay/transport-exempt broadcast so it does
not fail the parity gate; this register entry is the durable record that the
device-side fan-out is a known, benign mismatch pending an explicit no-op consumer.

```debt
id: TD-bt-le-audio
title: Bluetooth LE Audio (BAP/LC3) — HFP/mSBC is the shipped floor, and it is labelled as such
track: 1
status: open
exit_criteria: capability:bluetooth_le_audio
owner: ceraui-team
registered_at: 2026-08-22
resolved_at: null
unblock: The dynamic-wifi-bt-foundation effort ships BR/EDR HFP/mSBC as the Bluetooth-microphone floor and puts LE Audio (BAP/LC3) out of v1 scope by explicit Must-NOT-Have. This entry is the durable record of that deferral, not a marker binding — see the note below. Three layers must land together before LE Audio is real, and none of them exists today. (1) A DEVICE-IMAGE layer: BlueZ must be built with LE Audio support and the image must carry a transport that can actually carry an LC3 stream, which the shipped BlueALSA-based audio path cannot — the PipeWire seam this effort deliberately left unwired (Must-NOT-Have "No PipeWire in v1") is the likely home for it. (2) A DETECTION layer: bluetoothDeviceSchema's `transport` field is POSITIVE-EVIDENCE-ONLY, and `le`/`dual` exist precisely so a future read that can prove them has somewhere to say so — today nothing on a registry row proves LE, so every device reads `bredr` or `unknown`, and `scoCapable` describes the BR/EDR SCO leg alone. A capability probe that can positively identify a BAP-capable device is owed before any surface may claim one. (3) A SURFACE layer: `BLUETOOTH_CAPABILITY_FEATURES` (packages/rpc/src/schemas/bluetooth.schema.ts) would gain a fifth feature resolved through the SAME five-state support-claim ladder the other four use, so an LE Audio control could only ever render at `capable`/`certified`. Until all three land, the honest rendering is the CURRENT one: no LE Audio control, no ComingSoon pill, and no mention of LC3 anywhere in the Bluetooth surface — a roadmap pill for a capability whose detection layer does not exist would be a promise the device cannot qualify. To clear, land the three layers, then flip this entry to resolved.
```

This entry carries no source `data-debt-id` marker, deliberately and by the same
reasoning as `TD-live-audio-follow` and the three router-dongle write entries
above: there is no UI affordance to bind one to, and building a `ComingSoon` pill
ahead of the detection layer would misrepresent unbuilt capability as a roadmap
promise on a card that currently cannot tell an LE-capable device from a BR/EDR
one. The rendered-DOM gate depends on that: `tests/e2e/truthfulness.spec.ts`
asserts the Wi-Fi and Bluetooth surfaces carry ZERO `data-debt-id` nodes as a
POSITIVE claim, so a marker arriving here must be a deliberate, visible decision
that updates both this entry and that expectation.

```debt
id: TD-hilink-write-actions
title: Huawei HiLink (E3372) write-capable dongle actions — reconnect, net-mode/band lock, reboot, APN profiles, PIN/PUK, manual PLMN, antenna settings
track: 1
status: open
exit_criteria: capability:router_admin_hilink_write_actions
owner: ceraui-team
registered_at: 2026-08-18
resolved_at: null
unblock: The current router_admin surface (apps/backend/src/modules/network/router-cellular-admin.ts, router-capabilities.ts, router-details.ts) is deliberately READ-ONLY for HiLink devices — a `112008` net-mode refusal is a CAPABILITY READING, never a control (see AGENTS.md "…AND THE HiLINK CAPABILITY IS DISCOVERED BEFORE ANYTHING IS OFFERED"). This session's librarian research against the mature reverse-engineered client `Salamek/huawei-lte-api` surfaced SEVEN write-capable HiLink endpoints that were investigated but NOT built, each a straightforward extension of the existing capability-discovery-then-gate pattern (Stage B, router-cellular-control.ts) once a product decision picks it up: (1) `net/reconnect` — a guarded reconnect-without-reboot recovery action, lower blast radius than a full `device/control` reboot; worth building first as a "less scary" recovery affordance behind a confirmation dialog. (2) `net/net-mode` + `net/net-mode-list` — 2G/3G/4G mode lock + LTE band-lock; this is the SAME capability-module concept CeraUI already ships for other vendors (packages/rpc/src/schemas/capability-modules.schema.ts band-lock ladder), so a HiLink implementation is a natural additional capability module rather than a new pattern. (3) `device/control` reboot — remote "reset a stuck dongle" action; needs explicit confirmation UX because it causes a temporary link loss identical to a physical unplug. (4) `dialup/profiles` + `dialup/auto-apn` — full APN profile management; HIGH RISK because a bad write can break the current link and profile fields carry operator credentials. (5) `sms/*` send/delete/read-status mutations — this is the dongle's OWN separate SMS surface, distinct from CeraUI's existing ModemManager-based read-only SMS for PCIe/M.2 modems (apps/backend/src/modules/modems/sms-port.ts); a HiLink implementation would be a second, parallel SMS transport, not an extension of the MM one. (6) `pin/*` — PIN/PUK verify/change/enable-disable via the dongle's own HiLink API; CeraUI already has SIM PIN/PUK handling for MM-managed modems (apps/backend/src/modules/modems/sim-autounlock.ts + the SIM unlock UI flow) — a HiLink implementation is a SEPARATE surface for router-mode ethernet dongles, not a route through the existing one. (7) `net/register` manual operator/PLMN selection — an advanced carrier-recovery control for a stuck registration. (8) `device/antenna_settings` — firmware/model-specific and its exact value semantics are unconfirmed against a real E3372 unit; do not build this one without a fresh live probe. To clear: a product decision to build any of these (most likely `net/reconnect` first, as the lowest-blast-radius win), landing behind the SAME capability-discovery-then-gate pattern router_admin already uses, wired through router-cellular-control.ts and surfaced in RouterDongleDialog.svelte with an explicit confirmation UX for any action that can interrupt the link (reconnect, reboot, net-mode change, PIN operations). Split multi-action work into per-action register entries at implementation time if convenient; this entry covers the whole not-yet-built HiLink write surface as researched.
```

This entry carries no source `data-debt-id` marker — none of these actions have any
UI affordance yet (no `ComingSoon` pill, no disabled button) because building the
UI ahead of the feature would misrepresent unbuilt backend capability as a roadmap
promise. The register entry is the durable record of what this session's research
found and deliberately did not build, so a future implementer starts from the
`Salamek/huawei-lte-api` precedent instead of re-discovering the HiLink write
surface from scratch.

```debt
id: TD-zte-mf79u-write-actions
title: ZTE MF79U write-capable dongle actions — router-native SMS surface (unconfirmed value) and CONNECT/DISCONNECT_NETWORK (proven firmware-rejected on tested hardware)
track: 1
status: open
exit_criteria: capability:router_admin_zte_write_actions
owner: ceraui-team
registered_at: 2026-08-18
resolved_at: null
unblock: Two DIFFERENT classes of not-built ZTE MF79U capability, and they must not be conflated. CLASS A — genuinely undecided: an SMS list surface (`sms_data_total` + pagination goform calls, researched against `teixeluis/zte-lte-modem` and `fengjiaqi927/ZTE-MF79U-shell-scripts`) would be a second, SEPARATE router-dongle SMS surface distinct from CeraUI's ModemManager-based one (apps/backend/src/modules/modems/sms-port.ts) — same relationship to the MM surface as HiLink's `sms/*` in TD-hilink-write-actions. It is UNCONFIRMED whether this is worth building at all given CeraUI's existing SMS story; the exit condition is a product decision, not an engineering blocker. Network-mode/band-lock write is ALSO not confirmed available on MF79U firmware at all — it may exist only on other ZTE product lines, and no write attempt should be built against this device without first confirming the goform endpoint exists on THIS firmware. CLASS B — actively disproven, not just undone: `CONNECT_NETWORK` / `DISCONNECT_NETWORK` writes were bench-tested by CeraUI itself against the exact firmware this project ships against (`BD_XCBZHKMF79UV1.0.0B03`) and REJECTED by the device — see apps/backend/src/modules/network/router-cellular-admin.ts lines 64-83 for that finding, which is why router_admin stayed read-only for this vendor. This is not a "hasn't been built yet" gap, it is a "built the write path, the firmware refused it" result. A future implementer must NOT assume CONNECT_NETWORK/DISCONNECT_NETWORK works on any MF79U unit without a FRESH per-firmware round-trip proof against that specific unit's firmware string — a firmware update from ZTE could change this in either direction, so the existing bench result does not generalize past the exact string it was measured against. To clear: (Class A) a product decision on router-native SMS scope, or a confirmed live goform probe proving net-mode/band-lock exists on a specific MF79U firmware before any write code is written. (Class B) stays open as a documented negative result unless a future firmware version is bench-tested and proven to accept the write — at which point this entry should be split so the Class B finding is not silently reopened alongside a Class A decision.
```

This entry carries no source `data-debt-id` marker for the same reason as
`TD-hilink-write-actions` — no UI affordance exists to point at. The Class B
half is the more important record: it stops a future agent from re-attempting
`CONNECT_NETWORK`/`DISCONNECT_NETWORK` on the strength of the ZTE reference
clients' documentation, which describes the wire protocol but not this vendor's
firmware-level refusal.

```debt
id: TD-ufi-himiapi-write-actions
title: Qualcomm-chipset generic "4G UFI" (himiapi) write actions — fundamentally unconfirmed, needs live command-ID probing before any implementation
track: 1
status: open
exit_criteria: capability:router_admin_ufi_write_actions
owner: ceraui-team
registered_at: 2026-08-18
resolved_at: null
unblock: This entry is the WEAKEST-evidence class of the three dongle-vendor writes researched this session, and it must read that way. The `himiapi` (`/goform`+`funcNo`-style) family this project's UFI devices actually speak has NO mature reverse-engineered client comparable to `Salamek/huawei-lte-api` or the ZTE shell scripts. The closest researched precedent, `danyaPostfactum/MifiService`, uses `/ajax` + `funcNo` — a DIFFERENT API family belonging to related-but-not-identical Android UFI firmware, not the specific `himiapi` dialect this project's devices expose (see the read-only-field research this session, which already documents this same distinction for the fields it DID add). Every one of network-mode writes, data counters beyond what the parallel read-only-fields task added, Wi-Fi client listing, reboot/reset, and SMS is UNCONFIRMED for the actual `himiapi` dialect — none of the `/ajax` precedent's `funcNo` command IDs should be assumed to transfer, because a mismatched funcNo against the wrong dialect can silently no-op, silently apply the wrong setting, or (worst case) trigger an unintended action on hardware with no dry-run mode. This whole API family is poorly documented and firmware-inconsistent across white-label units — two units sold under the same "4G UFI" branding are not guaranteed to speak the same dialect. To clear: before building ANY write path here, a fresh live command-ID probe must be run against the SPECIFIC device model/firmware this project ships (the same board-bench-and-record method that produced the read-only `router_admin.details`/`router_admin.capabilities` blocks and the ZTE bench-rejection finding in TD-zte-mf79u-write-actions), confirming both the funcNo values AND that the write is accepted before any UI or backend code is written. Do NOT adopt the `/ajax` precedent's funcNo table as a starting point for implementation — it is documented here as a negative example (a different API family), not a template.
```

This entry carries no source `data-debt-id` marker for the same reason as the two
above. It is the most cautionary of the three: unlike HiLink (a mature client
exists) and ZTE (CeraUI has its own bench-proven negative result), the UFI
`himiapi` write surface has no trustworthy reference at all, so the register entry
exists to stop a future agent from copying the `/ajax` `funcNo` table onto the
wrong device.

## Resolved Debt

```debt
id: TD-encoder-load-telemetry
title: Per-core VEPU580 encoder-load collector
track: 1
status: resolved
exit_criteria: `bun run --filter backend test -- encoder-load.test.ts`
owner: ceraui-team
registered_at: 2026-08-05
resolved_at: 2026-08-05
unblock: A REAL per-core encoder-load signal exists on the hardware — this debt was that CeraUI had no backend collector reading it, NOT that the signal was missing. Resolved by apps/backend/src/modules/system/encoder-load.ts, which PROBES both kernel realities at runtime (never inferring from uname or a board id) and publishes its own `encoder-load` broadcast: the vendor 6.1 BSP path arms /proc/mpp_service/load_interval once, idempotently, then parses real per-core percentages out of /proc/mpp_service/load; the mainline edge-7.1 path reads the encoder cores' clk_enable_count under /sys/kernel/debug and reports a busy/idle bit ONLY. Neither path can synthesise a percentage from an enable count — that absence is pinned by a test. Neither interface readable degrades to the honest unavailable floor. The EncoderCoreLanes.svelte coming-soon affordance and its data-debt-id marker are removed; the genuine-unavailable case now renders a calm hardware statement instead of a roadmap pill.
```

Resolved 2026-08-05. The collector is `isRealDevice()`-gated, so a dev host still
publishes nothing and the dev-only `?health-mock=` fixture remains the single
mocking mechanism for this signal. Board-verified live on the mainline
edge-7.1 kernel (`7.1.5-ceralive-rk3588`): no `/proc/mpp_service` directory at
all, `clk_rkvenc{0,1}_core/clk_enable_count` readable, and the count observed
going positive while the encoder was engaged. See
`apps/frontend/src/lib/streaming/encoder-load.ts` for the three-state contract and
the live measurement table behind it.

```debt
id: TD-live-audio-switch
title: Live audio source switch
track: 2
status: resolved
exit_criteria: `isAudioLiveSwitchEnabled(caps) === true`
owner: ceraui-team
registered_at: 2026-06-17
resolved_at: 2026-06-17
unblock: cerastream switch-audio IPC (Track 2 Task 18)
```

Resolved in Task 25. `isAudioLiveSwitchEnabled(caps)` now returns `true` when the
engine advertises `audio_live_switch`. The live picker's audio entries render with
an enabled Switch button; the `coming-soon` affordance and `data-debt-id` marker
are removed from `InputPicker.svelte`.

```debt
id: TD-live-audio-delay
title: Live audio delay change
track: 2
status: resolved
exit_criteria: capability:audio_live_switch
owner: ceraui-team
registered_at: 2026-06-17
resolved_at: 2026-06-17
unblock: cerastream advertises audio_live_switch=true and reload-config accepts audio.delay_ms mid-stream; replace the Audio dialog "coming soon" affordance (data-debt-id="TD-live-audio-delay") with an enabled control and flip this entry to resolved.
```

Resolved in Task 19 (cerastream `reload-config.audio.delay_ms`). The Audio dialog
delay slider is now enabled while streaming; the `coming-soon` affordance and
`data-debt-id` marker are removed from `AudioDialog.svelte`.

---

```debt
id: TD-modem-usage-policy-write
title: Modem data-usage policy (cycle day + advisory limit) is read-only — no write path exists
track: 2
status: resolved
exit_criteria: capability:modem_usage_policy_setter
owner: ceraui-team
registered_at: 2026-08-16
resolved_at: 2026-08-16
unblock: RESOLVED. `@ceralive/modem-control` gained `setUsagePolicy` (a versioned, 0600, fail-soft local policy store — ModemManager itself has no data-usage API, verified against a live MM 1.24.2 whose only threshold surface is `Signal.SetupThresholds` over RSSI). `modems.configure` now carries tri-state `data_usage_cycle_day` / `data_usage_threshold_bytes` with an applied echo, the wire carries `modem.data_usage_policy` (including an explicit `supported` capability, so a device pinned to a package without the setter renders the controls disabled-with-reason rather than accepting a write it would drop), and `ModemConfigDialog`'s usage card offers a real cycle-day picker and threshold input. The original blocker read: `@ceralive/modem-control@0.2.0` publishes no usage-policy setter — only `DesiredUsage`, a transient `UsageObservation.usage`, a planner receipt, and a sampler-counter store — so `modemConfigInputSchema` deliberately declares no `data_usage_cycle_day` / `data_usage_threshold_bytes` fields (see the note in `packages/rpc/src/schemas/modems.schema.ts`). The READ side already reports both values, so `ModemConfigDialog`'s usage card DISPLAYS them and offers no control: an input the device accepts and silently drops would show the operator's setting reverting with no explanation. Three layers must land together. (1) `modem-stack`'s `control/` package must export a usage-policy setter and be republished. (2) CeraUI must bump its `@ceralive/modem-control` pin and add the two additive input fields plus their applied echo to `modems.configure`. (3) `ModemConfigDialog`'s usage card replaces the `coming-soon` affordance with a real cycle-day picker and threshold input under the standard applied-echo field lock. When all three are in place, remove the `data-debt-id="TD-modem-usage-policy-write"` marker from `ModemConfigDialog.svelte` and flip this entry to resolved.
```

The usage card now carries both halves: the COUNTERS (`modem-usage-cycle-day` /
`modem-usage-threshold`) render when the device reports them, and the POLICY
controls (`modem-usage-policy`) render whenever the device publishes a policy
block — which is every row, since a setting is knowable before a byte is counted.

---

## Related Documents

| Document | Scope |
|----------|-------|
| [`scripts/check-tech-debt.mjs`](../scripts/check-tech-debt.mjs) | The CI validator that enforces this register |
| [`docs/CONVENTIONS.md`](CONVENTIONS.md) | CeraUI doc + debt-register convention |
| [root `docs/CONVENTIONS.md`](../../docs/CONVENTIONS.md) | `[EXISTS]` / `[PARTIAL]` / `[GREENFIELD]` status labels |
| [`image-building-pipeline/v2/docs/DEFERRED.md`](../../image-building-pipeline/v2/docs/DEFERRED.md) | The deferred-work ledger pattern this register extends |
