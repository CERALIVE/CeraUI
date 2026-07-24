# CeraUI Lifecycle Indicator Inventory

**Document status:** internal engineering reference. Pure documentation — no code
changed to produce this register (device-stability-wrapup Todo 21). It commits the
full 31-row indicator gap matrix that guided Todos 19-20, records what each row's
current on-device/on-dashboard indicator actually is, and registers the remaining
gaps as recommendations — not commitments.

This document is the durable successor to the ephemeral audit report that
originally produced the 31-row list; the canonical row list now lives in
`.omo/plans/device-stability-wrapup.md` (Todo 21) and is mirrored verbatim in
`.omo/evidence/device-stability-wrapup/task-21-rows.txt`.

## Purpose

For every lifecycle transition a CeraLive device can go through — a source
appearing/disappearing, a stream starting/failing/stopping, a bonded link
dropping, the engine crashing, the backend restarting, an update running, a
preview failing, storage/thermal pressure, or an operator opening two tabs — this
doc answers three questions:

1. **What tells the operator today?** (file:line citation to the actual indicator,
   or "nothing" if none exists)
2. **Is that indicator EXISTING (pre-dates this effort), FIXED (landed by Todo 19
   or 20 of `device-stability-wrapup`), or RECOMMENDED (a real gap, not yet built)?**
3. **For a RECOMMENDED row, what would the backend actually have to emit/track to
   close it?** (the "backend-event cost" — an estimate, not a commitment)

## Legend

| Tag | Meaning |
|-----|---------|
| `EXISTS` | An indicator for this transition is live today (may pre-date this effort or Todos 19-20). |
| `FIXED` | Todo 19 or Todo 20 of `device-stability-wrapup` added or hardened this indicator. PR number cited inline. |
| `RECOMMENDED` | No dedicated indicator exists for this transition today. A required backend-event cost is given — this is a recommendation for future work, **not a commitment**. |

Each row below carries exactly one `Status: <tag>` line.

---

## 1. Source lifecycle

### `usb-source-connect-idle`
**Current indicator:** `apps/backend/src/modules/streaming/devices.ts:363-380` detects
a changed device set and calls `onDevicesChanged()`, rebroadcasting the unified
`sources` list; `apps/frontend/src/lib/components/custom/SourceSection.svelte:192-200`
re-renders the newly-appeared row. There is no dedicated "device connected" toast —
the row simply appears, which is the correct calm behavior while idle (nothing was
broken, nothing needs an alert).
**Status: EXISTS**

### `usb-source-disconnect-idle`
**Current indicator:** the same `devices.ts:363-380` rebroadcast;
`SourceSection.svelte:236-252` marks the vanished capture row lost/disabled in
place. No dedicated idle-disconnect banner or toast exists — while idle (no active
stream), the passive row-graying is sufficient: nothing is actively broken, so a
persistent alert would be noise. Contrast with `usb-source-disconnect-streaming`
below, where the same disappearance IS alert-worthy because a stream is actually
consuming the source.
**Status: EXISTS**

### `usb-source-disconnect-streaming`
**Current indicator:** `apps/backend/src/modules/streaming/devices.ts:381-389` hooks
the hotplug rebroadcast + applied-source id, calling into
`apps/backend/src/modules/streaming/lifecycle-indicators.ts:196-210`
(`reportActiveVideoSource`), which raises a persistent, dedupe-by-name notification
on the ok→bad edge while `isStreaming()`. Frontend:
`apps/frontend/src/main/live/LiveCockpit.svelte:132-174` renders the
`active-source-lost-banner` (salvage-derived markup) + a toast; a recovery
(bad→ok) clears the notification and fires a single transient "recovered" toast.
**Status: FIXED** (CERALIVE/CeraUI PR #180, `cf70527e`) — live-drilled via
RØDE USB-unbind mid-stream: toast + banner + recovered toast all PASS
(`task-20-device-stability-wrapup.md` Drill 2+3).

---

## 2. Stream start/stop lifecycle

### `stream-start`
**Current indicator:** `apps/frontend/src/main/live/StreamSetupChain.svelte:172-180`
gates the Start control on `deriveGoLiveReadiness()`;
`apps/backend/src/rpc/procedures/streaming.procedure.ts:122-168` validates the
config and routes `streaming.start`. Successful start flips the optimistic
streaming-edge state machine (`streaming-optimism.svelte.ts`), switching
`LiveView` from `IdleCockpit` to `LiveCockpit` without a flicker.
**Status: EXISTS**

### `stream-start-failure`
**Current indicator:** `apps/backend/src/rpc/procedures/streaming.procedure.ts:170-219,258-269`
returns structured pipeline/audio/engine start errors to the caller;
`apps/backend/src/modules/streaming/streaming.ts:99-121` sends a `start_error`
notification and clears streaming state so the UI never gets stuck showing "Live"
for a stream that never actually started.
**Status: EXISTS**

### `stream-stop`
**Current indicator:** `apps/backend/src/modules/streaming/streamloop/session.ts:133-157`
stops the engine first, then all spawned processes, in order;
`apps/frontend/src/main/live/LiveCockpit.svelte:220-229` owns the live Stop
control and the transition back to `IdleCockpit`.
**Status: EXISTS**

### `stream-stop-hang`
**Current indicator:** `apps/backend/src/modules/streaming/streamloop/process-runner.ts:149-192`
polls for process termination and escalates any straggler to `SIGKILL` after the
shutdown-timeout window — so the backend itself never hangs forever. There is no
frontend-visible indicator, however: if Stop is slow, the operator sees no
distinguishing state between "still tearing down" and "stuck" — the UI just
waits.
**Status: RECOMMENDED**
**Required backend-event cost:** the `process-runner.ts` escalation path (the
branch that fires when the graceful-shutdown poll window elapses and a
`SIGKILL` is issued) would need to emit a distinct notification/status field
(e.g. `stream.stopEscalated`) instead of resolving silently once the kill
succeeds. The frontend would consume it as a "Stopping is taking longer than
expected…" band on `LiveCockpit.svelte`'s Stop control, so a genuinely slow
teardown reads differently from an instant one.

---

## 3. Mid-stream engine health

### `midstream-engine-process-error`
**Current indicator:** `apps/backend/src/modules/streaming/cerastream-backend.ts:643-714`
maps runtime engine error events (reported over the control socket, distinct from
a full process crash) to notifications; `apps/backend/src/modules/streaming/health.ts:76-121`
folds process/frame liveness into the `dead`/`degraded` health states so the HUD
reflects it even if no explicit error event arrives.
**Status: EXISTS**

### `one-link-drops`
**Current indicator:** `apps/backend/src/modules/streaming/health.ts:93-98,110-116`
derives the degraded-health reason and reports the distinct "N of M links down"
partial-drop message (as opposed to the all-down case, see below);
`apps/frontend/src/main/network/BondedLinksSection.svelte:49-56,75-81` dims the
stale individual link card. The truthfulness of the underlying `bond.linkCount`/
`activeLinks` numbers this reason derives from was hardened by Todo 19 (below).
**Status: EXISTS** — underlying link-truthfulness data hardened by
**Todo 19** (CeraUI PR #179, `60b8595c`): `bond.linkCount`/`activeLinks` now come
from the srtla stats file's per-link entries (fresh-within-threshold = active)
instead of any synthetic value.

### `all-links-down`
**Current indicator:** `apps/backend/src/modules/streaming/health.ts:87-91,281-288`
detects zero-of-N active links while streaming;
`apps/backend/src/modules/streaming/lifecycle-indicators.ts:225-237`
(`reportAllLinksDown`) raises the dedicated persistent notification, and
`deriveReason` returns a message **distinct** from the partial-drop case ("All N
links down — no data can be sent"); `apps/frontend/src/main/live/LiveCockpit.svelte:150-207`
renders the `all-links-down-banner` from telemetry.
**Status: FIXED** (CERALIVE/CeraUI PR #180, `cf70527e`) — **logic is
implemented and covered by unit (`reportAllLinksDown`, distinct HUD reason) and
render (`all-links-down-banner`) tests, but the LIVE drill was DEFERRED**: the
Rock 5B+ board's only network interface (besides `lo`) is `eth0`, which also
carries the SSH session, and the srtla source-ips set was empty — the true
all-links-down state was therefore unreachable without cutting the SSH
connection, and there were no non-SSH links to drop instead. Per the plan's
PREFLIGHT deferral rule, no interface was disconnected
(`task-20-device-stability-wrapup.md` Drill 4). **This is a genuine
code-exists/tested-but-not-live-drilled distinction, not a fabricated pass** — a
future live drill needs a second bonded uplink (WiFi/modem) that is not the SSH
path.

### `link-recovers`
**Current indicator:** the `all-links-down` recovery edge (all links back up)
clears the lifecycle indicator and fires the paired "links recovered" toast
(`lifecycle-indicators.ts:225-237` recovery branch). An **individual** link
recovering — while others stay up, i.e. the partial-drop case reversing — has no
dedicated toast; `BondedLinksSection.svelte:75-81` only removes the stale-card
styling silently.
**Status: RECOMMENDED**
**Required backend-event cost:** a per-link (not just aggregate all-links)
transition tracker inside `lifecycle-indicators.ts`, keyed by interface/`conn_id`,
mirroring the existing all-links-down/recovered emit-on-transition pattern but at
per-link granularity — emitting a transient "Link `<name>` recovered" toast on
that one link's down→up edge. This is the **per-link recovery toast
granularity** follow-up (see Named Follow-ups below).

### `engine-unavailable`
**Current indicator:** `apps/backend/src/modules/streaming/capabilities.ts:392-400`
exposes an `engineUnavailable` flag consumed pre-stream by
`apps/frontend/src/lib/streaming/go-live-readiness.ts:279-295` (blocks Start
readiness) and rendered by `apps/frontend/src/main/live/CapabilityTierBanner.svelte:38-66`.
**Status: FIXED** (CeraUI PR #179, `60b8595c`) — this capability-level gate
pre-dates Todo 19, but the mid-stream/HUD-facing truthfulness of "is the engine
actually alive" was the bug Todo 19 fixed: before the fix, `health.ts`'s
real-device path equated process-liveness with frame-advancement, so an idle
device could render as "dead" and a genuinely-dead engine mid-stream could still
show `healthy`. After the fix, `process.alive`/`frames.advancing` are real
(`null` while idle = honestly unknown, never faked); proven live on the board
across idle/streaming/kill-srtla states (`task-19-device-stability-wrapup.md`
STATE 1-3).

### `engine-recovered`
**Current indicator:** `apps/backend/src/modules/streaming/engine-reconnect.ts:231-353`
runs the pre-existing retry/recovery/rebroadcast/watchdog loop that resolves
`engineUnavailable` back to available once the control socket reconnects.
**Status: FIXED** (CeraUI PR #179, `60b8595c`) — same truthfulness fix as
`engine-unavailable`: the HUD's healthy/dead verdict now reflects the real
`process.alive`/`frames.advancing` signals on recovery, not a liveness-as-frames
approximation. The **mid-stream toast** for this specific edge is a separate,
newer indicator — see `engine-crash-during-streaming` below.

### `engine-crash-during-streaming`
**Current indicator:** `apps/backend/src/modules/streaming/active-passthrough.ts:203-225,234-253`
treats the persistent control-socket close/reconnect as the real-time mid-stream
engine-drop detector (the bridge holds the one live engine connection) and
reconnects with bounded backoff;
`apps/backend/src/modules/streaming/engine-reconnect.ts:72-80,141-150,204-335`
(`runAttempt`) also reports the engine-reachability edge;
`apps/backend/src/modules/streaming/lifecycle-indicators.ts:240-251`
(`reportEngineState`) raises the persistent "stopped unexpectedly" error toast on
the down edge and a transient "recovered" success toast on the up edge, both
gated on `isStreaming()`.
**Status: FIXED** (CERALIVE/CeraUI PR #180, `cf70527e`) — live-drilled via
`systemctl stop/start cerastream` mid-stream: **PASS**, toast + recovered toast
both fired (`task-20-device-stability-wrapup.md` Drill 1).

---

## 4. Backend / connection lifecycle

### `ws-backend-disconnect`
**Current indicator:** `apps/frontend/src/lib/stores/connection-ux.svelte.ts:21-27,224-227`
consumes client-level connection-state changes;
`apps/frontend/src/main/DisconnectedBanner.svelte:18-31,64-73` renders the
reconnecting banner while the WebSocket to the CeraUI backend itself is down
(distinct from an engine-reachability edge — this is the browser↔backend
socket).
**Status: EXISTS**

### `backend-restart-dashboard-open`
**Current indicator:** for a **user-initiated** reboot/restart (Settings →
Reboot), `apps/backend/src/rpc/events.ts:108-135` (`simulateDevReboot`, dev-only
double) and the real-device `system.reboot` RPC handler close authenticated
sockets after the reply flushes; `connection-ux.svelte.ts:107-120` preserves a
"rebooting" flag across the disconnect and `DisconnectedBanner.svelte:34-45`
renders that specific state. This covers the **explicit, operator-triggered**
case only. There is no signal that distinguishes a **surprise** backend-service
restart — a crash-restart, an OTA-triggered restart, or any unexpected `systemctl
restart ceralive` that happens while the dashboard is open without the user
having clicked Reboot — from a plain transient network blip; both currently
render as the same generic "Reconnecting…" state from `ws-backend-disconnect`
above.
**Status: RECOMMENDED**
**Required backend-event cost:** an explicit process/boot generation marker
(e.g. a monotonic `serverInstanceId` or process-start `bootId`, sent on the first
frame after every connect) so the frontend can diff "same instance, network
blip" from "different instance, the backend process itself restarted" and render
a specific "The device restarted — reconnecting" state, distinct from both the
generic disconnect banner and the existing user-initiated-reboot banner. This is
the **backend-restart signal** follow-up (see Named Follow-ups below).

### `update-in-progress`
**Current indicator:** `apps/frontend/src/main/dialogs/UpdatesDialog.svelte:40-71,133-147`
tracks update progress and disables a duplicate concurrent start;
`apps/frontend/src/lib/components/updating-overlay.svelte:23-84,92-130` renders
the downloading/unpacking/setting-up phases and the completion state.
**Status: EXISTS** — the in-progress rendering itself is solid, and the related
gap the Todo-1 salvage branch flagged is now **CONSUMED** (device-quality-wave2).
The "failed update shown as Successfully Updated" bug is FIXED:
`updating-overlay.svelte` now splits the single `isComplete` into truthful
`failureReason`/`isFailure`/`isSuccess` derivations — a string `result` (the apt
failure message) renders a `failed` phase (`XCircle` + error toast carrying the
real apt reason), never the green checkmark (CeraUI PR `fix/updating-overlay-false-success`,
merged `e8704449`; covered by `updating-overlay.test.ts`). Todo 24
(update-notification unification, PR #184) additionally shipped the truthful
`UpdatesDialog` `failed(reason)` band + retry off the unified update state
machine. The overlay auto-clears when the update loop clears `status.updating`,
so the salvage branch's separate "dismiss escape hatch" is subsumed. See
**update rollback lifecycle** in Named Follow-ups below (now resolved) and the
Todo-37 triage section.

---

## 5. Preview lifecycle

### `preview-unavailable-predial`
**Current indicator:** `apps/frontend/src/lib/components/preview/preview-availability.ts:20-43,77-115`
defines and derives the full pre-dial taxonomy — `engineStarting`,
`engineOffline`, `previewUnavailable`, `noVideo`, `tokenRejected`, `mintFailed`,
`interrupted`, `backpressure` — so the operator gets a distinct, never-endless
"Connecting…" state per failure mode before the preview WS even connects.
**Status: EXISTS**

### `preview-socket-drops`
**Current indicator:** `apps/frontend/src/lib/components/preview/PreviewCanvas.svelte:434-480`
maps WS close codes to the appropriate availability band and schedules bounded
reconnect attempts.
**Status: EXISTS**

### `preview-open-no-video`
**Current indicator:** `apps/frontend/src/lib/components/preview/PreviewCanvas.svelte:391-422`
arms a media watchdog and surfaces the `noVideo` band if no frames arrive within
its window; `preview-availability.ts:49-55` defines the band.
**Status: EXISTS**

### `preview-decoder-failure`
**Current indicator:** `apps/frontend/src/lib/components/preview/PreviewCanvas.svelte:191-214`
handles WebCodecs decoder errors by setting preview status to `error`;
`PreviewCanvas.svelte:217-239,241-251` covers the MSE setup/append-failure path
with the same error state.
**Status: EXISTS**

---

## 6. Audio lifecycle

### `audio-device-vanishes-idle`
**Current indicator:** `apps/backend/src/modules/streaming/audio.ts:60-67`
(`isSelectedAudioLost`) detects the selected device's absence from the current
audio-source list and rebroadcasts, regardless of streaming state; while idle
this surfaces as a passive list update (the device drops out of the picker) with
no proactive toast — the same calm-by-design reasoning as
`usb-source-disconnect-idle` above: nothing is actively broken while idle.
**Status: EXISTS**

### `audio-device-vanishes-streaming`
**Current indicator:** `apps/backend/src/modules/streaming/audio.ts:276-285`
(`reportActiveAudioSource`) reports the loss gated on `isStreaming()`;
`apps/backend/src/modules/streaming/lifecycle-indicators.ts:213-222` evaluates
the indicator; `apps/frontend/src/main/live/LiveCockpit.svelte:159-190` renders
the `active-audio-lost-banner` + toast, with copy naming the Todo-17
**silence**-failover behavior (never a test tone).
**Status: FIXED** (CERALIVE/CeraUI PR #180, `cf70527e`) — live-drilled via
RØDE USB-unbind mid-stream: toast + banner + recovered toast all PASS
(same drill as `usb-source-disconnect-streaming`,
`task-20-device-stability-wrapup.md` Drill 2+3).

---

## 7. Device health

### `disk-low-full`
**Current indicator:** `apps/backend/src/modules/system/device-stats.ts:19-34,83-89`
publishes the `disk` signal (used/total bytes + media type) on the 5-signal
`device-stats` broadcast; `apps/frontend/src/lib/components/custom/LowDiskBanner.svelte:1-8,25-34`
renders a general low-disk warning below a configured threshold.
**Status: EXISTS** — the general system-level warning exists, but it is not
specifically surfaced on the Live/stream-start path — an operator about to go
live with a nearly-full disk gets the same Settings-area banner as any other
time, not a stream-facing warning tied to the actual risk (recording/buffer
failure during the stream). See **disk-full stream-facing warning** in Named
Follow-ups below.

### `thermal-warning`
**Current indicator:** `apps/backend/src/modules/system/sensors.ts:59-68,92-97`
reads the SoC temperature; `apps/frontend/src/main/HudBar.svelte:134-145,372-384`
displays the raw °C figure with staleness handling. There is no threshold
classification anywhere in this path — the HUD shows a number, never a
"warning"/"critical" state.
**Status: RECOMMENDED**
**Required backend-event cost:** a threshold classifier layered on the existing
`socTemp` device-stats signal — e.g. an additive `thermal: { level: "normal" |
"warning" | "critical" }` field (computed in `sensors.ts` from board-specific
thresholds, riding the existing `device-stats` broadcast — no new endpoint), plus
a frontend warning band/toast in `HudBar.svelte` when the level crosses
`warning`/`critical`. This is the **thermal threshold indicator** follow-up (see
Named Follow-ups below).

### `engine-schema-skew`
**Current indicator:** `apps/backend/src/modules/streaming/capabilities.ts:361-375,392-400`
compares the engine's reported `schema_version` against the binding's expected
version, logs a warning, and sets a `schemaVersionMismatch` flag;
`apps/frontend/src/lib/streaming/go-live-readiness.ts:270-295` surfaces it as an
advisory (non-blocking) readiness warning.
**Status: EXISTS**

### `multiple-browser-tabs`
**Current indicator:** none found. Two tabs open against the same device today
each independently connect, authenticate, and drive RPCs with no awareness of
each other — no leader-election, no "also open elsewhere" notice, no
conflicting-mutation guard beyond the existing per-resource `osCommand`
key-based race guard (which only protects specific network mutations, not
general dashboard state).
**Status: RECOMMENDED**
**Required backend-event cost:** simplest form is entirely frontend — a
`BroadcastChannel`/`localStorage` lock that detects a second same-origin tab and
shows an informational "Also open in another tab" band (no backend change). A
server-aware version would have the backend track concurrent authenticated-client
count (`getAuthenticatedClients()` in `apps/backend/src/rpc/events.ts` already
enumerates them) and broadcast a `multipleClients: boolean` flag so both tabs
know about each other. This is the **multi-tab coordination** follow-up (see
Named Follow-ups below).

---

## 8. Pre-start readiness (source/audio present but not yet confirmed live)

### `source-unplugged-before-start`
**Current indicator:** `apps/frontend/src/lib/components/custom/SourceSection.svelte:236-252`
marks a lost capture row disabled with a reason;
`apps/frontend/src/lib/streaming/go-live-readiness.ts:306-318` folds the source
gate into Start readiness; `apps/frontend/src/main/live/StreamSetupChain.svelte:152-169`
feeds that gate to the Start control's disabled-with-reason state.
**Status: EXISTS**

### `source-unplugged-midstream`
**Current indicator:** identical code path to `usb-source-disconnect-streaming`
above — `devices.ts:381-389` → `lifecycle-indicators.ts:196-210` →
`LiveCockpit.svelte:132-174`. These are the same canonical row under two names in
the source audit; documented here for completeness against the plan's exact
31-ID list.
**Status: FIXED** (CERALIVE/CeraUI PR #180, `cf70527e`) — see
`usb-source-disconnect-streaming` for the full drill evidence.

### `audio-unplugged-before-start`
**Current indicator:** `apps/backend/src/modules/streaming/audio.ts:269-291`
refreshes and rebroadcasts the available audio-source list, and
`apps/frontend/src/lib/components/custom/SourceSection.svelte:202-209` reflects
the current audio surface — but unlike the video-source case above, there is no
equivalent gate in `go-live-readiness.ts`: a previously-selected audio device
that has vanished does not block or warn on Start, it simply falls through to
whatever the backend resolves at start time.
**Status: RECOMMENDED**
**Required backend-event cost:** extend `deriveGoLiveReadiness()`
(`apps/frontend/src/lib/streaming/go-live-readiness.ts`) with a parallel
audio-availability check mirroring the existing video-source gate — when
`config.asrc` names a device absent from the current audio-source list, surface
a disabled-with-reason Start state (or at minimum a non-blocking warning)
instead of silently proceeding with a since-vanished audio device.

### `audio-unplugged-midstream`
**Current indicator:** identical code path to `audio-device-vanishes-streaming`
above — `audio.ts:276-285` → `lifecycle-indicators.ts:213-222` →
`LiveCockpit.svelte:159-190`. Same canonical row under two names in the source
audit; documented here for completeness against the plan's exact 31-ID list.
**Status: FIXED** (CERALIVE/CeraUI PR #180, `cf70527e`) — see
`audio-device-vanishes-streaming` for the full drill evidence.

---

## Status summary

| Status | Count | Rows |
|--------|-------|------|
| `EXISTS` | 17 | usb-source-connect-idle, usb-source-disconnect-idle, stream-start, stream-start-failure, stream-stop, midstream-engine-process-error, one-link-drops, ws-backend-disconnect, update-in-progress, preview-unavailable-predial, preview-socket-drops, preview-open-no-video, preview-decoder-failure, audio-device-vanishes-idle, disk-low-full, engine-schema-skew, source-unplugged-before-start |
| `FIXED` | 8 | usb-source-disconnect-streaming, all-links-down, engine-unavailable, engine-recovered, engine-crash-during-streaming, audio-device-vanishes-streaming, source-unplugged-midstream, audio-unplugged-midstream |
| `RECOMMENDED` | 6 | stream-stop-hang, link-recovers, backend-restart-dashboard-open, thermal-warning, multiple-browser-tabs, audio-unplugged-before-start |

31 rows total. `RECOMMENDED` rows are recommendations for future work, not
commitments — see `docs/CONVENTIONS.md` status-label rules for the same
discipline applied to feature claims generally.

---

## Named Follow-ups (registered, not committed)

These are the specific named follow-ups called out by `device-stability-wrapup`
Todos 19-21. Registering them here does **not** schedule or commit to the work —
it makes them discoverable for whoever plans the next indicator wave.

1. **Sender-side SRT reconnect-state contract (Todo 19b).** `srtla-send-rs`'s
   ADR-001 stats file (`src/telemetry_file.rs`) carries no per-link
   reconnect/connected flag, so CeraUI's `srt.reconnecting` field cannot be
   truthfully `true`/`false` on real hardware today — by the honesty contract
   Todo 19 established, the **live value is always `null`** (unknown), and the
   tri-state derivation exists specifically so a future producer contract can
   light up real values with **zero consumer-side change**
   (`task-19-device-stability-wrapup.md` §Todo-21 follow-up). This is the
   sender-side half of what would make `one-link-drops`/`engine-unavailable`'s
   SRT-reconnect dimension fully truthful, rather than honestly-unknown.
   **Triage verdict (Todo 37 · Audit b): `backlog`.** Re-verified at execution:
   `srtla-send-rs/src/telemetry_file.rs`'s emitted `ConnRecord` has exactly
   seven fields (`conn_id`, `rtt_ms`, `nak_count`, `weight_percent`, `window`,
   `in_flight`, `bitrate_bps`) — no `connected`/`reconnecting` field; the
   internal `LinkStats.connected` is used only to compute `weight_percent` and is
   never serialized. The consumer IS wired: `streaming.schema.ts:856`
   (`reconnecting: z.boolean().nullable()`), `deriveStreamHealth` (tri-state), and
   `HudBar.svelte:496` all read it. Cost to wire: a cross-repo ADR-001 telemetry
   schema v2 — sender producer field + unfreezing the `@ceralive/srtla` Zod
   reader + C-reference parity + a binding republish; the CeraUI consumer lights
   up with zero change once the producer lands (≈4–5 coordinated PRs across two
   sibling repos). Not a CeraUI-only change → not implement-now.
2. **Thermal threshold indicator.** See `thermal-warning` above.
3. **Disk-full stream-facing warning.** See `disk-low-full` above.
4. **Backend-restart signal.** See `backend-restart-dashboard-open` above.
5. **Multi-tab coordination.** See `multiple-browser-tabs` above.
6. **Per-link recovery toast granularity.** See `link-recovers` above.
7. **Update rollback lifecycle.** ~~See `update-in-progress` above — the
   unconsumed Todo-1 salvage branch.~~ **RESOLVED (Todo 37 triage: `done-in-this-plan`).**
   The core "failed update shown as Successfully Updated" bug is FIXED on `main`:
   `updating-overlay.svelte` now renders a truthful `failed` phase for a string
   (apt-error) `result` instead of the green success toast (CeraUI PR
   `fix/updating-overlay-false-success`, merged `e8704449`; covered by
   `updating-overlay.test.ts` red→green). Todo 24 (PR #184) additionally shipped
   the `UpdatesDialog` `failed(reason)` band + retry off the unified update state
   machine. The overlay auto-clears when the update loop clears `status.updating`
   and the dialog retry covers re-attempt, so the salvage branch's separate
   "dismiss escape hatch" is subsumed. Cross-verified against Todo 24's evidence
   (`task-24-device-quality-wave2.md` §8, which flagged the overlay `isComplete`
   bug as still-open at Todo 24 time — that residual is what the
   `fix/updating-overlay-false-success` PR then closed).

---

## Triage — device-quality-wave2 Todo 37

This section is the authoritative disposition of the 6 `RECOMMENDED` rows and 7
Named Follow-ups above, plus two targeted audits, recorded by
`device-quality-wave2` Todo 37 (2026-07-24). Each `done-in-this-plan` claim was
cross-verified against the cited todo's actual evidence — not the doc's prior
assumption. `backlog` verdicts carry a one-line cost. No item qualified as a
genuinely-small (≤1 focused PR) `implement-now`: every `RECOMMENDED` row is, by
construction, a registered *backend-event-cost* follow-up, so all were
`backlog`ed rather than scope-exploded. Full evidence:
`.omo/evidence/device-quality-wave2/task-37-device-quality-wave2.md`.

### 6 RECOMMENDED lifecycle rows

| Row | Verdict | Cost / resolving todo |
|-----|---------|-----------------------|
| `stream-stop-hang` | `backlog` | New backend `stream.stopEscalated` status field emitted from the `process-runner.ts` SIGKILL-escalation branch + a `LiveCockpit` "stopping is taking longer…" band + i18n(10) + tests. The backend never hangs forever (SIGKILL already bounds teardown), so the gap is cosmetic distinctness only — deferred. ~1 cross-layer PR. |
| `link-recovers` | `backlog` | = Named Follow-up #6. Per-link (`conn_id`-keyed) down→up transition tracker in `lifecycle-indicators.ts` mirroring the all-links-down emit pattern + toast copy(10) + tests. Aggregate all-links recovery already toasts; per-link is a granularity nicety. ~1 backend PR. |
| `backend-restart-dashboard-open` | `backlog` | = Named Follow-up #4. Monotonic `serverInstanceId`/`bootId` on the first frame after connect + `connection-ux` diff + a distinct `DisconnectedBanner` state + i18n + tests. Cross-layer. |
| `thermal-warning` | `backlog` | = Named Follow-up #2. Board-specific threshold classifier in `sensors.ts` + additive `thermal.level` riding the device-stats broadcast + `HudBar` band + i18n + tests. Needs per-board calibration data. |
| `multiple-browser-tabs` | `backlog` | = Named Follow-up #5. Even the cheapest frontend-only form (`BroadcastChannel` + "also open elsewhere" band) is a new store + banner + i18n(10) + tests. The existing per-resource `osCommand` race guard already blocks the dangerous concurrent-mutation case. |
| `audio-unplugged-before-start` | `backlog` | Extending `deriveGoLiveReadiness()` needs a 5th gate (or a new warn dimension) + plumbing the `audio_sources` list into the pure input + call-site wiring + tests, and would contradict the deliberate "audio is NOT a readiness row" decision (live-correctness-pass Todo #11). Runtime silence-failover (Todo 17) also means blocking Start on a since-vanished audio device may be undesirable — a product decision, not a mechanical mirror of the video gate. Deferred. |

### 7 Named Follow-ups

| # | Follow-up | Verdict | Cost / resolving todo |
|---|-----------|---------|-----------------------|
| 1 | Sender-side SRT reconnect-state contract (Todo 19b) | `backlog` | = **Audit (b)**. `srtla-send-rs/src/telemetry_file.rs` emits no `connected`/`reconnecting` field; CeraUI already consumes `srt.reconnecting` tri-state so the live value is honestly `null`. Cost: cross-repo ADR-001 telemetry schema v2 (sender producer + `@ceralive/srtla` Zod-reader unfreeze + C-reference parity + binding republish); consumer lights up with zero change. ≈4–5 PRs across two sibling repos. |
| 2 | Thermal threshold indicator | `backlog` | = `thermal-warning` row (dedup). |
| 3 | Disk-full stream-facing warning | `backlog` | General low-disk banner already EXISTS (`LowDiskBanner` + `isDiskLow` off the existing device-stats `disk` signal — no new collector); the gap is a stream-start-path-specific warning. Reuses the existing signal but still needs a Live-path surface + a streaming-specific threshold design + tests. Deferred. |
| 4 | Backend-restart signal | `backlog` | = `backend-restart-dashboard-open` row (dedup). |
| 5 | Multi-tab coordination | `backlog` | = `multiple-browser-tabs` row (dedup). |
| 6 | Per-link recovery toast granularity | `backlog` | = `link-recovers` row (dedup). |
| 7 | Update rollback lifecycle | `done-in-this-plan` | Todo 24 (PR #184, `UpdatesDialog` `failed(reason)` band + retry) **and** CeraUI PR `fix/updating-overlay-false-success` (`e8704449`, the overlay false-success fix). Cross-verified: Todo 24's evidence §8 flagged the overlay `isComplete` bug as still-open at Todo 24 time; the `fix/updating-overlay-false-success` PR then closed it (verified in current `updating-overlay.svelte` on `main`). |

### Two audits

**(a) Program-path WebCodecs Annex-B — verdict: `done-in-this-plan` (Todo 14
cerastream-half); CeraUI consumer already correct.**
CeraUI's WebCodecs decoder (`PreviewCanvas.svelte:238-248`) constructs the
`VideoDecoder` with `{ codec }` and sets `config.description` (the avcC box) ONLY
when the engine sends one; with no `description` the decoder runs in **Annex-B**
(byte-stream) mode, and `decodeAccessUnit` (`:293-304`) feeds raw H.264 access
units with **no length-prefix parse** — i.e. it expects Annex-B, never AVCC. The
engine's spliced *program-path* preview leg formerly emitted `avc`
(AVCC/`codec_data`) where byte-stream is required (the mp4mux/MSE muxer AND the
WebCodecs tier both need byte-stream); Todo 14 cerastream-half fixed it by adding
a `video/x-h264,stream-format=byte-stream,alignment=au` `preview_annexb`
capsfilter to `splice_preview` (`leg.rs`), so the engine now emits Annex-B —
matching the CeraUI decoder. No CeraUI change is needed. The engine fix lives in
the `cerastream` repo (protected sibling — read-only for this triage); its
presence in a shipped engine `.deb` is a cerastream-release/device-image tracking
item, not a CeraUI change.

**(b) Sender `srt.reconnecting` field — verdict: `backlog` (= Named Follow-up
#1); CeraUI consumer already wired.**
`srtla-send-rs/src/telemetry_file.rs`'s emitted `ConnRecord` has exactly seven
fields (`conn_id`, `rtt_ms`, `nak_count`, `weight_percent`, `window`,
`in_flight`, `bitrate_bps`) — **no** `connected`/`reconnecting`. The internal
`LinkStats.connected` drives `weight_percent` only and is never serialized. CeraUI
DOES consume `srt.reconnecting` — schema `streaming.schema.ts:856`
(`z.boolean().nullable()`), `deriveStreamHealth` (tri-state: `null`=unknown,
`false`=ok, `true`=bad), `HudBar.svelte:496` — so on real hardware the value is
honestly `null`. Wiring it is a cross-repo ADR-001 telemetry schema-v2 change (see
Follow-up #1 cost); the consumer needs zero change once the producer lands.

## Cross-references

- `.omo/plans/device-stability-wrapup.md` — Todo 21 (this doc's origin), Todos
  19-20 (the fixes cited above).
- `.omo/evidence/device-stability-wrapup/task-19-device-stability-wrapup.md` —
  full health-truthfulness evidence (PR #179).
- `.omo/evidence/device-stability-wrapup/task-20-device-stability-wrapup.md` —
  full four-indicator implementation + live-drill evidence (PR #180).
- `.omo/evidence/device-stability-wrapup/task-21-rows.txt` — the durable,
  verbatim 31-row-ID oracle this document's coverage is checked against.
- `.omo/plans/device-quality-wave2.md` — Todo 37 (this doc's Triage section),
  Todos 24/28/29 (the fixes cross-verified above).
- `.omo/evidence/device-quality-wave2/task-37-device-quality-wave2.md` — the
  13-row triage table + two audit verdicts (WebCodecs Annex-B, sender
  `srt.reconnecting`) recorded by Todo 37.
- [`AGENTS.md`](../AGENTS.md) → WHERE TO LOOK — cross-link entry for this
  document.
