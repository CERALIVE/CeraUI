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
| `exit_criteria` | An **executable** command in backticks (e.g. `` `pnpm --filter frontend run test -- foo.test.ts` ``) **or** a capability/PR reference (`capability:<flag>`, `PR #<n>`). Never prose. |
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
exit_criteria: `pnpm --filter backend run test -- audio-live-switch.test.ts`
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
unblock: cerastream advertises pip_supported=true and exposes a compositing/PiP control path; replace the Live "coming soon" affordance (data-debt-id="TD-pip") with the real overlay control and flip this entry to resolved.
```

Compositing a second source as a picture-in-picture overlay is not yet possible:
the engine drives a single active input. The Live destination surfaces a calm
"coming soon" affordance (`data-debt-id="TD-pip"`) next to the input picker — purely
informational, never an actionable control — until the engine advertises
`pip_supported`.

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
unblock: cerastream advertises mode_fallback=true and exposes an auto-fallback source policy; replace the Live "coming soon" affordance (data-debt-id="TD-mode-fallback") with the real fallback control and flip this entry to resolved.
```

When the active source drops, the engine does not yet auto-fall-back to a backup
input — recovery is operator-driven via the input picker. The Live destination
surfaces a calm "coming soon" affordance (`data-debt-id="TD-mode-fallback"`) until
the engine advertises `mode_fallback`.

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
