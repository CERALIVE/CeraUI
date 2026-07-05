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
id: TD-pip
title: Picture-in-picture / source compositing
track: 2
status: open
exit_criteria: capability:pip_supported
owner: ceraui-team
registered_at: 2026-06-17
resolved_at: null
unblock: cerastream advertises pip_supported=true and exposes a compositing/PiP control path; replace the Live "coming soon" affordance (data-debt-id="TD-pip"), now rendered inside the IdleCockpit Roadmap disclosure (apps/frontend/src/main/live/IdleCockpit.svelte, moved there by Task 12), with the real overlay control and flip this entry to resolved.
```

Compositing a second source as a picture-in-picture overlay is not yet possible:
the engine drives a single active input. The Live destination surfaces a calm
"coming soon" affordance (`data-debt-id="TD-pip"`) inside the collapsed Roadmap
`<details>` disclosure at the bottom of the idle Live cockpit
(`IdleCockpit.svelte`, Task 12 — it lived beside the input picker before the
cockpit split) — purely informational, never an actionable control — until the
engine advertises `pip_supported`.

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
unblock: remove after one release with the sources broadcast as the sole consumer path. The device-first source model (experience-simplification Tasks 1-16) folds pipelines/devices/device_modes into ONE unified sources broadcast (modules/streaming/sources.ts, getSourcesMessage/buildSources), but the three legacy producers are deliberately left running byte-for-byte unchanged for one release as a rollback safety net: the `devices` broadcast (modules/streaming/devices.ts `deps.broadcast("devices", …)` + its post-login dispatch in rpc/adapter.ts), the `pipelines` broadcast (rpc/procedures/streaming.procedure.ts `broadcastMsg("pipelines", …)`), and the `device_modes` field folded onto the `capabilities` broadcast (modules/streaming/capabilities.ts). No shipped frontend surface reads any of the three anymore — SourceSection/EncoderDialog/GoLiveCard all read `getSources()` exclusively (Tasks 13-16). Once one full release has shipped with `sources` as the sole consumer path and no rollback has been needed, delete the three legacy producers/fields (and the now-unused `getPipelines`/`devices`/`device_modes` schema surface, if nothing else depends on it), then flip this entry to resolved.
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
unblock: remove after one release with the sources broadcast. GoLiveCard + IdleCockpit (experience-simplification Tasks 10-12) absorbed every responsibility four of these components used to own in LiveView — the onboarding/empty-state guidance, the destination readiness hint, the migrated config rows, and the LAN network-ingest picker are all now rendered by GoLiveCard/IdleCockpit/SourceSection. The live-experience-refinement track (Task T9) then merged GoLiveCard's own gates+rows into StreamSetupChain.svelte (one "Stream setup" card of four always-visible rows, no collapse), so GoLiveCard.svelte itself is now ALSO an unmounted shim — kept-not-deleted as a one-release rollback safety net (only StreamSettingsCard's `ConfigRow` type is still imported, now by StreamSetupChain/IdleCockpit; GoLiveCard.svelte re-exports nothing anyone mounts). Once one full release has shipped on the device-first Live cockpit with StreamSetupChain and no rollback, delete apps/frontend/src/main/live/StreamSettingsCard.svelte, main/live/OnboardingChecklist.svelte, main/live/ServerReadiness.svelte, main/live/GoLiveCard.svelte, and lib/components/custom/NetworkIngestSection.svelte (plus their test files and the now-orphaned `onboarding.svelte.ts` store), re-point the `ConfigRow` type onto StreamSetupChain directly, then flip this entry to resolved.
```

This entry also carries no source `data-debt-id` marker — the five files are
inert (never imported by anything the router mounts, `StreamSettingsCard`'s type
export excepted), so there is no live UI affordance to bind a marker to. The
register entry is the durable record of the "kept but dead" decision instead.

> **Cross-repo follow-up (not CeraUI debt): RTMP-ingest unification.** The B2 SRT
> ingest is now a loopback `srtsrc`-caller pull; RTMP ingest deliberately STAYS on
> the existing `rtmpsrc` loopback in this plan. A possible future unification
> (MediaMTX remuxes RTMP→TS so cerastream pulls a single SRT code path, trading
> enhanced-RTMP codec coverage for one ingest path) is documented — not
> implemented — in the cerastream repo at `docs/notes/rtmp-srt-pull.md`. It is a
> cerastream (track-2) follow-up with no CeraUI marker, so it is recorded here as a
> cross-reference only, NOT a `debt` register entry.

## Resolved Debt

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

## Related Documents

| Document | Scope |
|----------|-------|
| [`scripts/check-tech-debt.mjs`](../scripts/check-tech-debt.mjs) | The CI validator that enforces this register |
| [`docs/CONVENTIONS.md`](CONVENTIONS.md) | CeraUI doc + debt-register convention |
| [root `docs/CONVENTIONS.md`](../../docs/CONVENTIONS.md) | `[EXISTS]` / `[PARTIAL]` / `[GREENFIELD]` status labels |
| [`image-building-pipeline/v2/docs/DEFERRED.md`](../../image-building-pipeline/v2/docs/DEFERRED.md) | The deferred-work ledger pattern this register extends |
