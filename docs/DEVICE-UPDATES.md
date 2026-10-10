# Device updates: the update orchestrator [PARTIAL]

This is the engineering reference for how a CeraLive device discovers, downloads,
installs and verifies its own updates. It describes the code on this branch, file
by file, and says plainly where a path is implemented but not released on any
image today.

**Status in one paragraph.** The orchestrator, its D8 stream admission, the
package pipeline, the Updates dialog and its global surfaces are implemented and
run on every device ([EXISTS]). The APT all-package scope, the OS agent, the
lagged slot mirror and the UID-pinned transport are implemented and
fixture-tested, but each is gated on an image capability that no shipped image
declares yet ([PARTIAL]). The one exception to fixture-only evidence is the
bench-enabled APT candidate-origin check and credentials upgrade described
below; it does not qualify a released capable image or the OS/slot paths.

## Where things live

| Concern | Code |
|---|---|
| Phase set, events, D8 types | `apps/backend/src/modules/system/update-orchestrator/types.ts` |
| Pure state transitions | `update-orchestrator/reducer.ts` (`reduceOrchestrator`) |
| D8 stream admission | `update-orchestrator/admission.ts` (`admitStreamStart`, `onStreamStart`) |
| Cadence, backoff, D7/D12 gates | `update-orchestrator/schedule.ts` |
| Effects, scheduler tick, RPC actions | `update-orchestrator/runtime.ts` |
| Persistence and restart resume | `update-orchestrator/persistence.ts`, `update-orchestrator/resume.ts` |
| Signed OS channel agent | `update-orchestrator/os-manifest.ts`, `update-orchestrator/os-agent.ts` |
| Lagged slot mirror | `update-orchestrator/slot-sync-gate.ts`, `slot-sync-state.ts`, `lock.ts`, `slot-sync-cleanup.ts`, `slot-status.ts` |
| Quarantine, stale services | `update-orchestrator/quarantine.ts`, `update-orchestrator/stale-services.ts` |
| Notifications | `update-orchestrator/notifications.ts` (`notifyUpdate`) |
| Stream-start abort effects | `update-orchestrator/stream-abort.ts` |
| Updates dialog read | `update-orchestrator/details.ts` (`readUpdateDetails`) |
| Transport selector and pin | `modules/system/update-transport/` (`core.ts`, `executor.ts`, `pin.ts`, `pin-rules.ts`, `last-selection.ts`) |
| Settings, capabilities, idle | `update-settings.ts`, `update-capabilities.ts`, `idle-detector.ts`, `idle-activity.ts`, `idle-state.ts` |
| APT all-package scope | `modules/system/apt-all-packages.ts`, `update-apt-channel.ts` |
| Wire schemas | `packages/rpc/src/schemas/update-orchestrator.schema.ts`, `update-details.schema.ts`, `update-settings.schema.ts`, `update-capabilities.schema.ts` |
| Frontend | `apps/frontend/src/lib/updates/`, `main/dialogs/UpdatesDialog.svelte`, `main/dialogs/updates/`, `main/layout/UpdateOrchestratorBadge.svelte`, `main/live/UpdateRefusalBand.svelte` |

Boot wiring: `apps/backend/src/main.ts`. Recovery contract:
[UPDATE-RECOVERY.md](./UPDATE-RECOVERY.md).

## Capability gating: legacy images and capable images

What the device may do is decided by the image, not by CeraUI.
`readUpdateCapabilities()` reads `/usr/lib/ceralive/update-capabilities.json`
(`{schema: 1, features, ota_uid, apt_uid}`, strict). The result has two modes:

| File state | `mode` | `features` |
|---|---|---|
| absent, unparseable, or `features` lacks `apt-all-packages` | `legacy` | `[]` |
| `features` includes `apt-all-packages` | `capable` | the file's list, verbatim |

The eight recognised feature tokens are `rauc-verity-streaming`,
`rauc-activate-on-shutdown`, `slot-sync`, `origin-protection`,
`apt-all-packages`, `reprune-hook`, `apt-credentials` and `transport-uidrange`.
Feature requirements:

| Path | Needs |
|---|---|
| Package discovery and install by origin (all packages) | `mode: capable`, i.e. `apt-all-packages` |
| OS checks, OS staging, System image dialog section | `apt-all-packages` and `rauc-verity-streaming` |
| Slot mirror, Slots dialog section | `slot-sync` |
| UID-pinned transfer (`uidFor` in `pin.ts`) | `transport-uidrange`, nonzero and distinct `ota_uid` / `apt_uid` |

A legacy image keeps the exact-name 15-package roster in `package-layer.ts`, its
`dist-upgrade --assume-no` discovery and its app-only install argv, unchanged.
Every image shipping today is a legacy image: the current image carrier declares
`features: []`. The frontend mirrors the split in `updateCapabilityView()`
(`apps/frontend/src/lib/updates/update-view.ts`), which states the limit on a
legacy image instead of hiding sections silently.

In capable mode the candidate version's `apt-cache policy <name>` package-file
line is joined to the complete line in one unscoped `apt-cache policy` reading
per discovery. The unscoped inventory carries Release Origin/Label and the
Debian suite. Unknown or ambiguous joins remain informational, not installable;
the Rock 5B+ capture of both APT forms is the regression fixture.
On 2026-09-27 a Rock 5B+ with bench-enabled capabilities classified and installed
`ceralive-apt-credentials` 1.0.1. A later Rock capture showed apt success but
`committing` stuck for 84+ minutes: the observer rejected systemd's flock-wrapped
`ExecStart`. The identity and retry fixes were then exercised on both benches:
the detached unit completed and the selected packages installed, but the backend
exited on success before the orchestrator's next tick persisted that result.
Both boards resumed to sticky `failed / commit_unit_absent_on_resume`, with
`pending-packages.json` still populated. The completion-order fix below is
source-tested; **its fixed build has not yet been board-proven**. Neither the
earlier installs nor the identity proof qualify a settled update lifecycle.

Runtime check/install, tick and activation admission share only an
in-flight ownership probe, preserving concurrent caller order without caching
a settled permission. Live OS ownership is still re-read after the job-file read
and before startup reconciliation can be queued.

Manual `installUpdatesNow` reports launch refusals using its existing reason
vocabulary (no RPC schema change):

| `startSoftwareUpdate()` refusal | Manual reason |
|---|---|
| `streaming` | `stream_active` |
| `already_updating` | `busy` |
| `check_unavailable` | `not_available` |
| `updates_disabled` | `busy` (updates are disabled, not necessarily another running step) |

For a disabled update, the existing `busy` UI copy, “Another update step is
already running,” is generic and does not literally describe the refusal. A
dedicated disabled-updates reason requires a separate reviewed wire-and-copy
change; this mapping does not add one.

Starting-stream launch limits: root AGENTS.md D8 Known gaps (f).

## Settings

`update-settings.json` (next to `config.json`, CWD-relative, atomic writes) holds
six fields. Absent means defaults; malformed present content is a typed
`UpdateSettingsValidationError`, never partial salvage.

| Field | Default | Meaning |
|---|---|---|
| `packagesAuto` | `true` | the scheduled package pipeline (check through install) |
| `systemAuto` | `true` | the scheduled OS pipeline |
| `schedule` | `{mode: "any-idle", start: "03:00", end: "05:00"}` | any idle moment, or a local HH:mm window |
| `channel` | `stable` | `stable` or `beta`; the bench `drill` channel is not selectable |
| `allowPackagesOverCellular` | `true` | package check and install on a metered-only uplink |
| `allowSystemOverCellular` | `false` | OS **check** on a metered-only uplink (never the download) |

The `system.getUpdateSettings`, `system.setUpdateSettings` and
`system.getUpdateCapabilities` RPCs expose them.

## The state machine

Phase set: `ORCHESTRATOR_PHASES` in `types.ts`. See the root AGENTS.md D8 Known
gaps for overlap with the independent legacy launcher. Transition table from
`reducer.ts`:

| From | Event | To |
|---|---|---|
| `idle` | `PACKAGE_CHECK_STARTED` | `checking` |
| `idle` | `OS_CHECK_STARTED` | `checking` |
| `idle` | `SYNC_ELIGIBILITY_CONFIRMED` | `sync-eligible` |
| `idle` | `CELLULAR_OVERRIDE_GRANTED` | `idle` (records the id) |
| `checking` | `CHECK_SUCCEEDED_NONE` | `idle` |
| `checking` | `CHECK_SUCCEEDED_PACKAGES` | `available` |
| `checking` | `CHECK_SUCCEEDED_OS` | `os-available` |
| `checking` | `CHECK_FAILED` | `idle` (clock backs off) |
| `available` | `AWAIT_IDLE_FOR_INSTALL` | `awaiting-idle` |
| `available` | `PACKAGE_CHECK_STARTED` | `checking` |
| `awaiting-idle` | `INSTALL_UNIT_STARTED` | `downloading` |
| `downloading` | `DOWNLOAD_PROGRESS` | `downloading` |
| `downloading` | `COMMIT_PHASE_ENTERED` | `committing` |
| `downloading` | `DOWNLOAD_FAILED` | `failed` |
| `downloading` | `DOWNLOAD_ABORTED_FOR_STREAM` | `available` |
| `downloading` | `DOWNLOAD_RESUME_UNIT_ABSENT` | `idle` with the package check due now (resume only, when a probe proved the install unit gone) |
| `committing` | `COMMIT_PROGRESS` | `committing` |
| `committing` | `COMMIT_SUCCEEDED` | `restarting-services` |
| `committing` | `COMMIT_FAILED` | `quarantined` |
| `committing` | `COMMIT_RESUME_UNRESOLVED` | `failed` |
| `restarting-services` | `SERVICES_RESTARTED` | `settled` |
| `settled` | `SETTLE_ACKNOWLEDGED` | `idle` |
| `os-available` | `OS_STAGING_STARTED` | `os-staging` (consumes the cellular override; persists the attempt id before RAUC runs) |
| `os-available` | `OS_CHECK_STARTED` | `checking` |
| `os-available` | `CELLULAR_OVERRIDE_GRANTED` | `os-available` (records the id) |
| `os-available` with an OS recovery record | `PACKAGE_CHECK_STARTED` | `checking` (the record rides through the package phases) |
| `os-staging` | `OS_STAGING_PROGRESS` | `os-staging` |
| `os-staging` | `OS_STAGED` | `os-staged` (tokened publication retains the active recovery record until producer settlement; legacy completed-success event clears it) |
| `os-staging` | `OS_STAGING_FAILED`, typed `automatic` | `os-available`, retry scheduled (see below) |
| `os-staging` | `OS_STAGING_FAILED`, typed `operator`, or a third automatic round | `os-available`, operator-only (no automatic stage) |
| `os-staging` | `OS_STAGING_FAILED`, typed `unsafe`, or untyped | `failed` |
| `os-staging` | `OS_STAGING_ABORTED_FOR_STREAM` | `os-available` (no failed round counted) |
| `os-staging` | `OS_STAGE_OFFER_INVALIDATED`, matching active attempt | `idle`, stale offer/policy dropped, fresh OS discovery due |
| `os-staging` with persisted attempt identity | `OS_UNLAUNCHED_STAGE_SETTLED`, exact current-boot/candidate/attempt witness plus fresh readiness | `os-available`, one failed round counted, `rauc_install_failed` / operator-only |
| `os-staged` | `OS_STAGE_SETTLED`, matching active attempt | `os-staged`, recovery record cleared after producer success |
| `os-staged` | `OS_STAGING_FAILED`, matching active attempt and `unsafe` | `failed`, unsafe recovery persisted; receipt retained, no activation or quarantine |
| `os-staged` without a pending active attempt | `OS_ACTIVATION_ARMED` | `os-activation-armed` |
| `os-activation-armed` | `OS_REBOOT_OBSERVED` | `os-verifying` (only once RAUC shows the armed activation ran, or the staged version booted) |
| `os-verifying` | `OS_VERIFIED` | `sync-eligible` (only once `healthy-state.json` carries this boot's id) |
| `os-verifying` | `OS_ROLLBACK_DETECTED` | `quarantined` (a boot on a version other than the staged one) |
| `sync-eligible` | `SYNC_STARTED` | `syncing` |
| `sync-eligible` | `SYNC_SKIPPED` | `idle` |
| `syncing` | `SYNC_SUCCEEDED` | `synced` |
| `syncing` | `SYNC_FAILED` | `failed` |
| `synced` | `SYNC_SETTLED` | `idle` |
| `quarantined` | `RESET` | `idle` |
| `failed` | `RESET` | `idle` |
| `failed` with exact `commit_unit_absent_on_resume` | root-only `HISTORICAL_COMMIT_ADJUDICATED` after durable receipt and plan archive | `idle` |
| `failed` with a settled `unsafe` OS record (`activeAttemptId:null`), reason matching `failureReason` and exactly `rauc_recovery_unproven` or `os_stage_outcome_unknown_after_restart` | `OS_STAGE_RECOVERY_CONFIRMED` from a manual check, after positive OS evidence | `idle`, OS check due now, next round operator-only; notice cleared only on acceptance |
| `failed` with exact `rauc_install_failed` and no recovery record (persisted by an older build) | `OS_STAGE_LEGACY_FAILURE_MIGRATED`, after positive OS evidence | `idle`, OS check due in 15 min |
| `failed` with settled confirmable unsafe OS record and persisted attempt identity | `OS_UNLAUNCHED_STAGE_SETTLED`, exact current-boot/candidate/attempt witness plus fresh readiness | `os-available`, failed-round count unchanged, `rauc_install_failed` / operator-only; matching unresolved notice replaced |

Distinctions in that table carry weight:

- `COMMIT_FAILED` moves tracked `committing` to `quarantined` on a wire failure;
  it does not prove dpkg itself failed. Detached-service cleanup can fail after
  transaction exit 0, and the legacy adoption race under root
  [`AGENTS.md`](../AGENTS.md) D8 Known gaps (d) can misattribute another unit's
  failure. `COMMIT_RESUME_UNRESOLVED` goes to `failed`
  because a restarted backend could not establish what dpkg did, and nothing is
  pinned on a guess.
- Stream-abort semantics are in the D8 section below. Launch limits:
  "D8 stream/update admission:
  what it does NOT cover" under Known gaps in the root [`AGENTS.md`](../AGENTS.md).
- A sync failure is `failed`, never `quarantined`. It means the mirror failed,
  not that the running slot is bad.
- An OS staging failure is terminal only when it is unsafe or untyped. The
  staging adapter throws an `OsStageError` whose reason maps to `automatic`,
  `operator`, `unsafe` or `cancelled`; any other error stays fail-closed as
  `failed`. No staging failure writes quarantine.

### OS staging recovery [PARTIAL, fixture-proven]

`osStageRecovery` (persisted, optional within schema 1) belongs to one exact
candidate: version, serial, channel, board, compatible, bundle URL and digest.
It records the active attempt id, the failed rounds, the next retry time, the
mode (`automatic`, `operator`, `unsafe`) and the machine reason. Future attempts
also retain optional `attemptId` after settlement clears `activeAttemptId`.
This is persistence-only, not an addition to the RPC wire. No boot ID is stored
in the recovery record; the settlement witness must match the current boot.
A present `attemptId` must be a UUID; a malformed one is invalid recovery
metadata and closes admission on load. An accepted witness settlement whose
state write has not durably succeeded keeps admission closed (no new attempt,
no witness retirement) until a later write succeeds.

| Settled round | Result |
|---|---|
| first automatic failure | retry 15 min later |
| second automatic failure | retry 30 min later |
| third automatic failure | operator-only pause; packages continue |
| operator failure | operator-only pause; packages continue |
| unsafe failure, or an attempt found idle after a restart without matching completed unlaunched evidence | `failed`, no automatic retry |
| exact attempt proven unlaunched by completed same-boot witness and fresh readiness | `os-available`, operator-only; previously counted rounds stay unchanged |
| stream cancellation | no round counted |
| success | record cleared |

A positively identified pre-write stale/expired admission drops the offer and
returns to fresh discovery; every other untyped staging error remains terminal.
Terminal settlement withdraws that candidate's stage-policy notice before the
refusal, without clearing other candidates or OS-check notices. Progress callbacks
belong to the active attempt id, so a retained callback cannot advance a later round.
Receipt publication is not producer success. The attempt remains pending in
`os-staged` until the producer resolves; the 60-second tick cannot arm it in that
window, even if a stream starts. A matching late unsafe release failure moves it
to `failed` and replaces any retry notice with unresolved recovery. A late untyped
or non-unsafe error is also unsafe here, never a permission to retry a published
receipt. The receipt and serial watermark are retained for diagnosis, not treated
as activation permission, and no staging failure writes quarantine.
Retry deadlines use wall-clock time: a backward clock jump prolongs the wait;
there is no compensation policy.

- A round counts once, when the attempt that started it settles; a settlement
  for any other attempt id is ignored.
- A newly admitted candidate (different key) starts a fresh budget; an OS check
  that finds no candidate drops the record. A successful check of the same
  candidate keeps it.
- Same-candidate successful refreshes preserve the pending retry deadline;
  idle scheduling also consults persisted `osStageRecovery.nextRetryAt`, so idle
  scheduling re-discovers the candidate when it is due, and a due package check
  leaves `os-available` for the normal package path.
- A due automatic restage first re-admits the signed candidate through a fresh
  OS check, then stages on a later tick, still behind the idle, automation and
  cellular gates.
- Install now on an operator-paused candidate runs one more round.
- An `os-staging` found after a restart is observed, never replayed: while RAUC
  runs it waits, an unreadable probe defers, and once RAUC is idle and the
  guarded adapter proves writer quiescence the attempt
  settles `unsafe` (`os_stage_outcome_unknown_after_restart`) unless the private
  completed unlaunched witness first proves this exact persisted attempt never
  dispatched an install. That narrow event returns directly to operator retry,
  counts only an uncounted staging round, and never grants staged success. Success is never
  inferred from a good slot, a matching version or a receipt.
  The same rule covers `os-staged` with a still-active publication identity:
  release was not recorded complete, so it cannot arm and settles unknown/unsafe
  only after the writer proof. A retained receipt also prevents manual confirmation.
- Present but invalid/inconsistent recovery metadata is never first boot. Shared
  schema validation binds phase, attempt and deadline; startup keeps a terminal
  outcome and any valid legacy failure reason, preserves the original file and
  refuses migration/check/install until maintenance repairs it and restarts the
  backend. Files without these optional fields retain the existing resume rules.
- Generic manual confirmation of `failed` needs positive evidence, all of it: RAUC idle, a writer
  quiescence proof from the RAUC recovery adapter, the booted slot good with
  this boot's healthy record, the one other rootfs inactive and `bad`, no staged
  receipt and no armed activation. The production adapter supplies positive
  guardian/resource proof; an unreadable or uncertain observation stays closed.
  The separate witnessed-unlaunched path permits a good inactive target only
  because exact never-launched provenance is present; it does not weaken this
  bad-target rule. Missing/stale/invalid witnesses and legacy records without
  `attemptId` never auto-clear. See the witness/crash contract in UPDATE-RECOVERY.

Failure clearance and receipt requirements:
[`UPDATE-RECOVERY.md`](UPDATE-RECOVERY.md). Do not erase persisted failure state
to bypass adjudication.

The additive wire field is `status.update_orchestrator`
(`updateOrchestratorWireStateSchema`): `{schema: 1, phase, progress,
failure_reason, cellular_override_id}`. `getOrchestratorWireState()` builds it.
The older `update_state` union keeps its original meaning.

### Persistence and resume

State persists at `/data/ceralive/update-state/agent.json`. Reattach rather than
replay an uncertain transaction: a replay could run dpkg twice. Settlement may
run `apt-get clean`; see [UPDATE-RECOVERY.md](./UPDATE-RECOVERY.md).

**Successful capable-image commits have a persist-before-exit boundary.**
The observed result must be durable before the deliberate backend exit. For a
transaction launched by the orchestrator on a capable image, the completion
callback now dispatches `COMMIT_SUCCEEDED` (entering `committing` first if a
fast unit outran the tick) and synchronously persists `restarting-services`
**before** the exit. The pending package plan remains intact. Resume passes
through `restarting-services` without needing the absent unit. Failure-clearance
and stale-service policy: [UPDATE-RECOVERY.md](./UPDATE-RECOVERY.md).

A persisted `downloading` resumes differently: only a probe that found the
fixed unit name `LoadState=not-found` drops the attempt (to `idle`, check due
now; the next install start normally comes through discovery, and a start
from an `available` wire rewrites the pending plan, while a start after the
wire stopped reading `available` keeps the earlier plan, an inherited
limitation); a skipped or failed
probe keeps `downloading` and re-asks on each tick, fenced so a late answer
never touches a newer attempt.
Detail: [UPDATE-RECOVERY.md](./UPDATE-RECOVERY.md#resuming-an-interrupted-download-exists--fixture-proven).

Inferring success on resume from dpkg or the pending plan would turn an uncertain
mid-commit crash into an unproved success. Preserve the output-drain and exact
unit-identity checks before trusting the exit status.

### Scheduling

The tick runs every 3 s while a phase is active (`downloading`, `committing`,
`restarting-services`, `os-staging`, `syncing`) and every 60 s otherwise.
`schedule.ts` holds the cadence:

| Constant | Value |
|---|---|
| `PACKAGE_CHECK_INTERVAL_MS` / `PACKAGE_CHECK_JITTER_MS` | 6 h, ±30 min |
| `OS_CHECK_INTERVAL_MS` / `OS_CHECK_JITTER_MS` | 12 h, ±60 min |
| `BACKOFF_BASE_MS` | 60 s, doubling per consecutive failure |
| `BACKOFF_BASE_RATE_LIMITED_MS` | 5 min, used when apt's error text names HTTP 429 or 5xx |
| `BACKOFF_MAX_MS` | 24 h ceiling for both curves |

Scheduled-launch limits: root AGENTS.md D8 Known gaps (b), (f), (g).

Idle comes from `getIdleStatus()`: 30 minutes since the latest of stream end,
preview end, start-lease end, last routed remote command and last UI heartbeat,
inside the configured schedule window. An active preview blocks idle. Remote
presence is a five-minute command-recency heuristic
(`hasActiveRemoteSession()`), not hub connectivity, so a connected but quiet
remote operator can be missed.

### Operator actions

| RPC | Runtime function | Behaviour |
|---|---|---|
| `system.checkUpdatesNow` | `checkUpdatesNow()` | Manual discovery; bypasses due time and D7. |
| `system.installUpdatesNow` | `installUpdatesNow()` | Manual install; bypasses idle. Starting-stream limits: root AGENTS.md D8 Known gaps (f). |
| `system.allowCellularOnce` | `allowCellularOnce()` | Records a one-time cellular approval for the named OS candidate. |
| `system.getUpdateDetails` | `readUpdateDetails()` | Dialog snapshot. |

Legacy-launch limits: "D8 stream/update admission: what it does NOT
cover" under Known gaps in the root [`AGENTS.md`](../AGENTS.md).

## D8: stream admission

D8 classifies stream-start admission against the cached update phase in
`admission.ts`. `assertExhaustivePhaseClassification()` runs at module load and
throws if a phase is placed in more than one bucket.

| Phase | Start allowed? | Action on the update |
|---|---|---|
| `committing`, `restarting-services` | **refused** (`update_in_progress`) | none |
| `downloading` | **refused** on a fresh wire reading of `installing` or `success`, or a positive/fail-closed commit-stage probe; otherwise allowed once the stop call returns | best-effort `systemctl stop` of the detached apt unit, never issued on a refusal; a nonzero exit is logged, not proof of cancellation |
| `os-staging` | allowed once termination/restart submission returns, not after daemon recovery | cancel the stable attempt signal and move to `os-available` before termination; queue `systemctl restart --no-block rauc.service`; propagate submission errors, but never wait for the daemon's delayed retirement here. The submission fence and interrupted-stage fence remain independent. New OS work requires positive readiness, and cancellation wins over simultaneous link failure or late producer callbacks. |
| `syncing` | allowed | continue locally |
| every other phase | allowed | none |

A refusal from the cached table carries the orchestrator's phase and progress;
a refusal from the commit-stage probe alone (below) carries the fixed
`committing`, `0`, `0`. In practice `etaSeconds` is always `0`: neither the
package nor the OS progress path computes an ETA.

The live wiring is `admitAndPrepareStreamStart()` in `runtime.ts`, called from
`stream-session-orchestrator.ts` as the last admission gate, after
duplicate-start, the modem-transition lease, the recovery barrier and the
blocking-mutation check. It is last among THIS orchestrator's admission gates;
`streamloop/session.ts` can still refuse the admitted launch via `isUpdating()`
while the unit monitor settles (including `apt-get clean`). That refusal is
retriable `engine_restarting`/`stream_start_suppressed_update`; the next attempt
may succeed after settlement, but a failed stop or untracked pre-unit launch
can exhaust the retry budget (root AGENTS.md D8 Known gaps (g)-(h)).
The cached phase can stay `downloading` while dpkg runs: the tick
re-reads the wire only on its own cadence (after an operator-RPC install the next
tick can be up to 60 s away), and the wire reports `installing` only once a dpkg
`Unpacking` or `Setting up` line has been ingested. On a Rock 5B+ a start 1 ms
after dpkg appeared was admitted and dpkg was killed. So before stopping a
`downloading` unit it asks two questions. The first is a forced-fresh read of
`getPackageInstallWireState()`: `installing`/`success` is evidence dpkg ran, so
it dispatches `COMMIT_PHASE_ENTERED` and refuses. The second is the commit-stage
probe (`update-orchestrator/commit-stage-probe.ts`), which reads the unit's own
processes through its `ControlGroup`, `cgroup.procs` and `/proc/<pid>/comm` +
`cmdline`. The commit stage is running when any process is `dpkg`/`dpkg-*` or an
`apt-get` whose argv contains `--no-download` (the second stage, which starts
before dpkg). The first `apt-get -d … upgrade` stage does not count, so a genuine
download stays abortable. The probe fails closed: a running unit whose process
list cannot be read refuses, and so does a probe that throws. A probe-only refusal
dispatches nothing and the phase stays `downloading`: a running second stage is
not proof that dpkg ran, and a second stage that fails before dpkg must still
end as `DOWNLOAD_FAILED` (`failed`, nothing quarantined), not a quarantining
`COMMIT_FAILED`. The next start probes again.

For an existing unit the orchestrator launched itself and is tracking in `downloading`,
what the stop can still reach depends on the image. A capable image runs the
two-stage unit, where the remaining exposure is the check-then-stop gap: a
second-stage `apt-get` that starts inside it is stopped, normally before it
spawns the unpacking dpkg (not measured). A non-capable image runs the
single-stage `runDetachedAptUpgrade` unit, which has no `--no-download` stage, so
the probe detects only a running `dpkg` and the gap sits right before the dpkg
spawn. The boot-time `ceralive-dpkg-recover.service` (`dpkg --configure -a`)
remains a backstop for interruptions such as power loss, and does not repair a
package left half-installed. For other windows see "D8 stream/update
admission: what it does NOT cover" under Known gaps in the root
[`AGENTS.md`](../AGENTS.md). An admitted start sets `/run/ceralive/streaming`,
which the image's activation script checks before arming an OS slot, and every
stream-end path clears it. The typed failure is documented in
[START-LIFECYCLE.md](./START-LIFECYCLE.md).

## Package pipeline

`startPackageInstall` wraps the existing `startSoftwareUpdate()`. On a legacy
image that is the 15-name roster path. On a capable image it is the all-package
path in `apt-all-packages.ts`:

- discovery simulates `upgrade --with-new-pkgs` without locking, resolves each
  candidate through `apt-cache policy`, and refuses any removal (`Remv`) or held
  first-party package;
- only candidates whose origin is Debian `trixie`, `trixie-updates`,
  `trixie-security` or `apt.ceralive.tv` are actionable;
- the commit is an explicit `apt-get install name=version ...` with
  `--no-download --no-remove`, after a second simulation proves resolution added
  nothing;
- one PID-1-owned transient service runs download and commit inside a single
  `flock -x /run/lock/ceralive-update.lock`.

The package check reads `update_state.available.actionable_count` rather than
the inclusive `package_count`: a successful discovery listing only platform or
kept-back packages returns to `idle`, leaving the OS check eligible on a capable
image. This prevents a *new* sticky failure; an
existing `failed` `agent.json` is not reclassified on restart or the next tick.
The root-only `ceralive-update-recover` tool admits only the exact
`commit_unit_absent_on_resume` reason, not a no-actionable-packages failure;
clearing another reason requires a separately reviewed recovery procedure.

`reconcileAptChannel()` rewrites `/etc/apt/sources.list.d/ceralive.sources`:
stable only, or stable plus beta. Moving from beta back to stable requests no
downgrade.

The package path does **not** use the transport selector or the UID pin below.
It still uses the legacy `apt-reachability.ts` family preflight and gateway
repair described in [HOST-UPLINK-ELECTION.md](./HOST-UPLINK-ELECTION.md).

## OS agent

Active only with `apt-all-packages` and `rauc-verity-streaming`.

- `checkOsChannel()` fetches `channels/<channel>/<board>.json` and its `.sig`
  from `images.ceralive.tv` as the image's `ota_uid`, inside
  `updatePinController.run("os", ...)`.
- `readBoardIdentity()` derives the channel filename from a **closed exact map**
  of physical RAUC compatibles: `ceralive-rock-5b-plus` selects
  `rock-5b-plus`; `ceralive-orangepi5-plus` selects `orange-pi-5-plus`.
  Unknown and near matches refuse before transport selection and fetch. Orange's
  `orangepi5-plus` board ID is not the `orange-pi-5-plus` product slug; Rock's
  two names happen to coincide. This translation is only for the URL and the
  signed `board` comparison, never for the physical compatible comparison.
- `verifySignedOsManifestTrust()` verifies the CMS signature against
  `/etc/rauc/ceralive-keyring.pem`, requires the exact manifest signer CN with
  the codeSigning EKU and without emailProtection, and requires the extracted
  leaf's RFC2253 issuer DN to equal exactly
  `CN=CeraLive RAUC Intermediate CA,O=CeraLive` (production) or
  `CN=CeraLive RAUC Bench Intermediate CA,O=CeraLive` (persistent bench).
  A root-direct or alternate-intermediate signer is refused as
  `signer_issuer_invalid` even if the CMS signature verifies to the keyring.
  Only then does it parse the strict v1 schema and check exact board, compatible
  and channel identity. `validateSignedOsManifest()` remains strict installation
  admission through `admitTrustedOsManifest()`: per-channel serial replay is
  refused before expiry, booted-version, anti-downgrade, quarantine and
  `min_ceraui_version` checks. A signed Orange pointer
  must say `board: orange-pi-5-plus`, `compatible: ceralive-orangepi5-plus`;
  the presently published serial-4 drill pointer says the latter as
  `ceralive-orange-pi-5-plus` and still fails closed. Publisher repair and a
  refreshed signed pointer are separate prerequisites; the old binary on the
  2026.10.6 candidate also needs replacement after boot before another OS check.
- The booted version is read only from `/etc/ceralive/os-release-version`
  (`readBootedOsReleaseVersion()`). Absent or malformed means
  `booted_version_unknown`, never a fallback to the build timestamp or commit.
- `discoverSignedOsManifest()` separates discovery from installation admission.
  After trust, expiry and a known booted version, an exact current version is a
  successful check with no candidate, regardless of the serial watermark or
  installation-only CeraUI floor. A non-current pointer is also no candidate when
  its serial equals the stored serial, its version is positively older than the
  booted release and it is not quarantined. All other pointers pass strict
  admission; a replayed newer target remains refused, including after rollback.
  Neither discovery outcome advances `manifest-serial.<channel>` or stages an
  image. No-candidate success resets check failures, records a fresh success and
  uses the normal 11–13 h cadence without a new notice. Trusted-current discovery
  retracts only `os-check:downgrade_or_same` and `os-check:serial_replayed`
  refusal notices; expired, untrusted and unrelated notices are not cleared.
- `stageOsBundle()` delegates to the guarded OS job below. Every selected pair
  strictly revalidates the signed candidate through its existing OTA UID pin.
  Confirmed RAUC completion and pin teardown precede receipt preparation;
  the final attempt check, synchronous `os-staged.json` and per-channel serial
  writes, and `OS_STAGED` publication have no intervening await. They run under
  the job lock. Activation waits until the producer has completely settled.
- Activation is armed through `ceralive-rauc-arm@arm.service` (next idle
  shutdown). After seven days pending with no live stream, `@now` is used.
- After a reboot (the receipt's boot id no longer matches), a booted CalVer equal
  to the staged version goes straight to verification. Otherwise RAUC is asked
  whether the activation ran at all (`parseStagedActivation()`, the same test
  `ceralive-rauc-activate` applies: the booted slot is still the primary and the
  other slot holds an install newer than its last activation). If it did not,
  the reboot was unclean (crash, watchdog, power loss before the shutdown hook):
  the phase stays `os-activation-armed`, the receipt is rebound to the new boot
  id, and nothing is quarantined or notified. An unreadable or inconclusive RAUC
  status reaches no verdict and is retried on the next tick: the phase stays
  armed, no activation verdict is persisted and the receipt is not rebound
  (when this happens at startup, the ordinary persistence of the resumed state
  still runs once). Inconclusive includes a
  `boot_primary` naming neither rootfs slot (it is read as a slot name, the
  form every capture carries) and an other slot with no usable install stamp
  or an unusable activation stamp; missing metadata is never read as
  activation. A real activation needs positive evidence: the other slot is the
  primary (the bootloader fell back from it), or its activation stamp is at or
  after its install stamp. Only after a real
  activation is the booted CalVer compared. Different records the rollback in
  quarantine and dispatches `OS_ROLLBACK_DETECTED`. Equal proves only that the
  bootloader tried the new slot, so it is not yet a verdict.
- In `os-verifying`, a booted staged version is verified by **this boot's
  healthcheck verdict**: `OS_VERIFIED` (and the `os-activated` notice) needs
  `/data/ceralive/update-state/healthy-state.json` whose `boot_id` equals the
  current `/proc/sys/kernel/random/boot_id`. The on-image healthcheck writes
  that record only after a passing check and `rauc status mark-good`. A record
  from an earlier boot (always present on `/data`, since the stage boot wrote
  one), a missing or garbled record, or an unreadable boot id is no verdict:
  the phase stays `os-verifying`, nothing is notified, and the next tick (every
  60 s) or backend start asks again. The phase is persisted, so it survives
  backend restarts on the same boot and repeat boots of the same failing slot.
  A slot whose healthcheck fails **before** `rauc status mark-good` succeeds is
  booted again until its bootcount runs out; the bootloader then starts the old
  slot, whose CalVer differs, and that boot reaches the rollback path above
  (`quarantine.json` `os[]`, the persistent `os-rollback` notice, sticky
  `quarantined`). The version check comes first, so a rollback never depends on
  the healthy record. Operator-visible consequence: after the reboot into a new
  OS the UI shows the verifying state until that boot's healthcheck passes,
  typically within a couple of minutes, and for as long as the new slot keeps
  failing it before `mark-good`. Replayed from the Orange Pi 5+ drill A2
  (task-45 opi-r5, C1), where the previous rule declared a failed v3 boot
  verified and never recorded the fallback; hermetic only, not yet re-drilled
  on hardware.
- **Boundary: a slot marked good with no readable verdict waits
  indefinitely.** The healthcheck calls `rauc status mark-good` first and only
  then writes its boot marker and `healthy-state.json`. If either write fails,
  the healthcheck fails *after* the slot was marked good, and every successful
  `mark-good` refills that slot's boot attempts, so the bootloader never falls
  back. The booted version equals the staged one, so neither branch above
  fires: the phase stays `os-verifying` with no timeout and no other
  adjudication, on this boot and on every later boot where the record still
  cannot be written. While it waits, scheduled package and OS checks, manual
  checks and installs, and the slot mirror do not run (checks and installs
  need `idle` or an available phase, the tick services only verification, and
  the mirror gate refuses with `os-install-pending`); stream starts stay
  allowed. Nothing clears the update for the product: there is no
  `os-activated` notice and no `os-rollback`. The orchestrator never writes or
  infers the healthy record itself, and RAUC's `good` status is not a
  substitute for it. Operator remedy: find out why the healthcheck cannot
  write its record (the `ceralive-healthcheck.service` journal, `/data` space
  and permissions), fix that, and reboot; the healthcheck runs again on the
  next boot, and a record written for that boot verifies the update. Do not
  mark slots good or bad by hand to get out of this state.
- A backend restart first reconciles any exactly owned OS guardian without
  blocking control-server readiness. It retains the old pin and lock until
  writer quiescence is proved. Reconciliation never replays an install or
  manufactures staging success; an idle daemon alone leaves the interrupted
  outcome `os_stage_outcome_unknown_after_restart`.
- A root-owned `/data/ceralive/update-state/os-channel-override` containing
  exactly `drill` switches the OS channel for bench work. APT always follows
  Settings.

## Transport selection and pinning

Selector and routing reference:
[HOST-UPLINK-ELECTION.md](./HOST-UPLINK-ELECTION.md).

For an OS channel, the plain-HTTP `generate_204` probe still requires exactly
204 with an empty body: redirects or portal content remain `captive-http`.
Only a completed, certificate-verified HTTPS HEAD to the expected
`images.ceralive.tv` channel `.json.sig` object may treat 404/410 as a **healthy
transport with an absent publication**; TLS errors, resets, timeouts and 5xx
remain unhealthy. The subsequent pinned JSON and signature GETs independently
require both objects. A verified 404/410 on either returns a successful OS check
with no candidate (`idle`, no failure notification), not `no-transport`; a
different fetch or signature failure still refuses. This fix is fixture-tested,
**not yet board-proven on the fixed build**.

**Only the OS agent uses this today.** The `apt` job and table exist and are
tested, but no package transaction calls the controller.

Do not remove the prohibit rule or pin global DNS to work around the DNS scope
limit documented in [HOST-UPLINK-ELECTION.md](./HOST-UPLINK-ELECTION.md).

### Bounded OS staging failover [PARTIAL — hermetic proof, hardware drill owed]

The existing pin controller owns the only retry loop: at most **three distinct
interface/address-family pairs** per staging job. A positively failed pair is
held unhealthy for 15 minutes, after safe writer recovery and routing teardown.
Fresh selection can discover a newly restored uplink; it cannot reset the
attempt budget. Moving the pin does not repair an existing TCP connection:
failover starts a new RAUC install after the old writer has retired.

Detection is independent of progress and interface byte counters. Fresh
pinned-path topology is checked every 3 seconds with a 2-second read bound.
Positive interface removal, administrative/carrier down, family-address loss
or missing private-table default route triggers recovery. A TLS-verified HEAD
of the immutable bundle runs as the OTA UID in the selected family every
10 seconds, capped at 5 seconds; two consecutive transport failures trigger
recovery. HTTP 429/5xx means origin unavailability, not a bad uplink. Unknown
reads, unavailable probes, 404/410, flat progress and SIGBUS/EOF alone cannot
manufacture a transport verdict. The install client's overall bound remains
two hours; an unclassified timeout is not automatically a network failure.

Before another install, the previous CLI must have settled, RAUC must be active
with exact `Operation=idle`, the old failed daemon/installer and captured
mount/NBD/dm identities must have retired, and the healthy booted rootfs and
inactive target identities must be unchanged. The job lock must still be held,
no activation marker may be armed, and routing cleanup must have succeeded.
Stream intent is checked again after recovery, reselection and admission awaits.
Recovery polls every second for at most six minutes; expiration retains the
lock and reports `rauc_recovery_unproven`, never permission to force-clean.
Creator PID reuse cannot retire an NBD device the job already owns: while its
connection remains configured, the original tracked identity stays in the proof.
Shared admission observation has a separate 10-second fail-closed deadline,
which neither releases that ownership nor replaces recovery evidence.
This reduces detection delay; it does **not** promise fast retirement of a
kernel-blocked installer. Lock/startup details: [UPDATE-RECOVERY.md](./UPDATE-RECOVERY.md#os-staging-lock-and-startup-reconciliation).

## Cellular policy (D12)

`decideCellularGate()` in `schedule.ts` applies only when every reachable uplink
candidate is metered.

| Kind and stage | Metered-only uplink |
|---|---|
| packages, check or install | allowed when `allowPackagesOverCellular` |
| OS check (small manifest) | allowed when `allowSystemOverCellular` |
| OS install (the bundle) | **always held**, whatever the toggle says |

A held OS install sets a pending approval, raises the `cellular-approval`
notification with the bundle size, and appears in `readUpdateDetails()` as
`pendingCellular`. `system.allowCellularOnce(id)` dispatches
`CELLULAR_OVERRIDE_GRANTED`; the gate then allows exactly that candidate id, and
`OS_STAGING_STARTED` clears the override. The producer captures it before that
transition: one approval buys one bounded staging job, including its internal
pair failover, not a later job. A cheap-check toggle never permits unapproved
cellular bundle failover.

## Lagged slot mirror

Active only with `slot-sync`. The mirror copies a proven running slot into the
other slot. `slotSyncGate()` is the pure pre-dispatch check. It answers
`{allowed: true}` or one of eight reasons, evaluated in this order:

| Reason | Condition |
|---|---|
| `capability-absent` | not `capable`, or `slot-sync` missing |
| `not-yet-booted` | no healthcheck record, or its `boot_id` is not this boot |
| `packages-changed` | the SHA-256 of `/var/lib/dpkg/status` differs from the record |
| `build-changed` | the build id differs from the record |
| `already-synced` | the sync receipt records this dpkg SHA AND names the slot that is not booted now (an OS activation swaps the booted slot without changing dpkg, so the SHA alone can describe the mirror into the slot now running) |
| `slot-identity-unknown` | the sync receipt records this dpkg SHA but its slot identity cannot be resolved (unreadable or bootname-less `/etc/rauc/system.conf`, a booted-slot name it does not map, or a receipt target the map lacks while it does not name the other rootfs slot either), so the tick is skipped and retried rather than suppressing or dispatching the mirror; a warning is logged once per change, not every tick |
| `os-install-pending` | phase is `os-staging`, `os-staged`, `os-activation-armed` or `os-verifying` |
| `already-syncing` | phase is `syncing` |
| `update-busy` | phase is `awaiting-idle`, `downloading`, `committing` or `restarting-services` |

`readSlotSyncEvidence()` reads the image-owned
`/data/ceralive/update-state/healthy-state.json` and `sync-receipt.json`, and
hashes the dpkg status file with `node:crypto`, byte for byte as the image's
`sha256sum` does. The receipt's `target_slot` (a RAUC slot name such as
`rootfs.0`, or a bootname) is compared with this boot's healthy record's booted
`slot` through the `[slot.rootfs.<n>] bootname=` map in `/etc/rauc/system.conf`
(`classifyReceiptTarget()`, `slot-sync-state.ts`), which is static and readable
while RAUC is wedged. It is read as a GLib key file: whitespace around `=`
(`bootname = A`), CRLF line ends and `#`/`;` comment lines are accepted, and
only `[slot.rootfs.<n>]` sections count. The answer is one of three: `other` (the receipt names the
other rootfs slot, so with a matching SHA the gate says `already-synced`),
`not-other` (it names the booted slot, a slot of another class such as
`certs.0`, or a name the map lacks while the map already names the other
rootfs slot, so the mirror is allowed), or `unknown` (no current-boot healthy
record, the booted slot has no mapping, or the target is a name the map lacks
that could be the unmapped other rootfs slot). Completion timestamps are
never used as identity: a clock can step and a time names no slot. With a
matching SHA, `unknown` makes the gate skip this tick (`slot-identity-unknown`)
and retry on the next one: dispatching blind could meet a wedged RAUC whose
exit-75 refusal would leave a sticky failure. The build id is the first `BUILD_ID=` of `/etc/os-release`,
falling back to `/etc/ceralive/image-build-commit`.

Completion is confirmed by `sync-receipt.json` matching the current dpkg SHA
followed by a fresh probe that again reads finished and clean, not by the unit's
exit status alone: systemd unloads the finished oneshot within about a second,
so a successful run usually probes as `inactive-clean` (`pollSlotSync`,
`runtime.ts`). The receipt is consulted for exactly two positively validated
shapes and for no other: `succeeded` (`systemctl show` exit 0, each of the five
properties exactly once, loaded/inactive/dead, `ExecMainCode=1`,
`ExecMainStatus=0`) and `inactive-clean` (the same, with both exit fields empty
or `0`). A read that would otherwise be one of those shapes but fails that
validation is `absent`. An `absent` read, or an `inactive-clean` read without
this run's receipt, may be a `--no-block` job still queued behind
`ceralive-healthcheck.service`, so it fails as `slot-sync-unit-absent` only
after `SLOT_SYNC_QUEUED_START_GRACE_MS` (90 s from entering `syncing`, a
defensive bound: on the shipped image the healthcheck has already finished and
is `RemainAfterExit=yes`, so the real queue lasts milliseconds) and, for
`inactive-clean`, a fresh re-probe and receipt read. An `absent` confirmation
probe taken right after a matching receipt gives no verdict that poll; the
next poll's first probe decides. The receipt alone
is not enough, because the unit writes it before `rauc status mark-good other`:
before `synced` is persisted, RAUC must report exactly one booted and one
inactive rootfs slot, with the receipt's `target_slot` naming the inactive one
and that slot `good`. A `bad` target is an interrupted mark-good and fails as
`slot-sync-incomplete` (unless a re-probe shows the unit running again); an
unreadable or undecidable RAUC answer leaves the phase `syncing` with no
verdict. Because RAUC names this boot's slots, a resumed `syncing` phase whose
healthy record is still the previous boot's is judged by RAUC rather than
failed for lack of an identity.
The parser's `running`, `failed` and `refused` verdicts are kept unchanged; a
failed unit is retained and read from systemd.

Lock, receipt and cleanup ordering:
[UPDATE-RECOVERY.md](./UPDATE-RECOVERY.md).

## Quarantine

`UpdateQuarantine` keeps `/data/ceralive/update-state/quarantine.json` (schema 1,
strict, atomic). Its arrays are exact failed package candidates, OS versions
that failed to activate, and failed commit ids. A failed commit pins each exact
candidate at priority -1 in `/etc/apt/preferences.d/ceralive-quarantine`,
installed through `systemd-run`. A newer candidate lifts the pin. The OS agent
refuses a manifest whose version `isOsVersionQuarantined()` reports. The planned
package set survives a backend restart in `pending-packages.json`. Full schema:
[UPDATE-RECOVERY.md](./UPDATE-RECOVERY.md).

## Stale services after a commit

Protected-unit and restart policy: [UPDATE-RECOVERY.md](./UPDATE-RECOVERY.md).

## Notifications

`notifyUpdate()` sends a persistent, dismissible notification named
`update:<kind>:<id>` with an action that opens the Updates dialog. An existing
name is not re-sent. Keys are translated in all ten catalogs. The three
`os-stage-*` notices carry the version only (the machine reason stays in the
log), use one id per exact candidate, and replace each other: each settled job
raises exactly one, and successful staging or a superseding candidate clears it.

| Kind | Produced by |
|---|---|
| `updates-available` | a package check that found candidates; an OS check that found a manifest |
| `refused` | a failed package check, a failed commit, a failed OS check, an untyped OS stage failure |
| `os-stage-retry` | a typed OS stage failure with an automatic retry scheduled |
| `os-stage-operator` | a typed OS stage failure that needs the operator (operator mode or the third automatic round) |
| `os-stage-unresolved` | an unsafe OS stage failure, including an attempt found idle after a restart |
| `installed` | leaving `restarting-services` |
| `restart-recommended` | a protected unit with stale mappings |
| `cellular-approval` | an OS install held by D12 |
| `os-staged` | a successful OS stage |
| `os-activated` | a forced `@now` activation, and a boot of the staged version whose healthcheck passed (this boot's `healthy-state.json`) |
| `os-rollback` | a booted version that differs from the staged one after the armed activation ran, including the bootloader fallback after the new slot kept failing its healthcheck before `mark-good` |
| `slots-current` | a confirmed slot mirror |
| `download-paused` | **no producer** |
| `credentials-expiring` | **no producer** |
| `transport-unhealthy` | **no producer** |

## Credentials and certificate expiry

There is no expiry countdown. The wire carries no certificate expiry date, and
`credentials-expiring` (90, 30 and 7 days) has no producer.

What does exist is a check for a certificate that has **already** expired or been
refused, inside the APT transport profile. For the `apt.ceralive.tv` host the
executor runs `openssl x509 -checkend 0` on the fleet certificate, then GETs the
mTLS `/__tls-probe` endpoint. An expired certificate, `certVerified` not `true`,
or curl exit 58 (client certificate problem) is recorded as the probe state
`credentials-invalid`. The dialog shows a rejection band only when the last
selection's findings contain that state (`transportCredentialsRejected()` in
`apps/frontend/src/lib/updates/update-bands.ts`).

Because only the OS agent calls the selector today, and it uses the `os` profile,
which never presents the fleet certificate, no production code path currently
produces an APT-profile selection. In practice the band cannot appear on a
device yet. A useful expiry warning needs a producer for the `apt` profile and a
wire field carrying the expiry date.

## Frontend surfaces

- **Updates dialog** (`UpdatesDialog.svelte`): Packages, System image, Slots,
  Automation (auto toggles, schedule window, channel), Over cellular, and Update
  connection. It pulls capabilities, settings and `system.getUpdateDetails` when
  opened (`createUpdateSurface()`).
- **Global badge** (`UpdateOrchestratorBadge.svelte`): shown while
  `isUpdateBusy()` holds, with phase and percent, and opens the dialog.
- **Go Live band** (`UpdateRefusalBand.svelte`): `goLiveUpdateRefusal()` prefers
  the live `update_orchestrator` push and falls back to a typed
  `update_in_progress` start failure. Admission stays on the device.

## Evidence and limits

Backend suites under `apps/backend/src/tests/`: `update-orchestrator-reducer`,
`-admission`, `-schedule`, `-persistence`, `-resume`, `-runtime`, `-lock`,
`update-recovery`, `update-details`, `slot-sync-gate`, `slot-sync-state`,
`slot-sync-runtime`, `apt-all-packages`, `update-settings`,
`update-capabilities`, `update-transport*` (including the two-veth netns pin
test) and `idle-detector`. Frontend: `src/lib/updates/*.test.ts` and the
Playwright spec `tests/e2e/update-system.spec.ts`.

Not proven, and not claimed:

- no board has run the orchestrator's automatic pipeline, an OS stage, a slot
  mirror or a pinned transfer from this branch;
- no image declares `apt-all-packages`, `rauc-verity-streaming`, `slot-sync` or
  `transport-uidrange`, so every capable path is inert in the field;
- no live signed channel manifest, hosted bundle or live `apt.ceralive.tv` mTLS
  verification has been exercised;
- No production caller dispatches `RESET`: `quarantined` and most `failed`
  states remain sticky. The narrow exceptions are root-only
  `commit_unit_absent_on_resume` adjudication through the local recovery CLI
  described above (it preserves a durable receipt and requires a fresh
  discovery) and the two OS staging exits above, which need positive OS
   evidence from the guarded OS writer adapter (not yet board-qualified).
  That CLI exists in source packaging but has not shipped in a released `.deb` or
  image, and its root/systemd/APT board proof remains outstanding. Never delete
  `agent.json` to clear a failure.
