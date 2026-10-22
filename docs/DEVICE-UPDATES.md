# Device updates: the update orchestrator [PARTIAL]

## Pending disruptive effects [PARTIAL — host proof, board drill owed]

Accepted device power/reset and timed OS activation hold an in-process reservation
from the final synchronous gate through pending shutdown, even after the submission
command exits zero. The shared stream-start admission returns its existing typed
`update_in_progress` refusal, and package/OS stage/arm submission remains blocked.
Only positive submission failure releases shutdown exclusion; no countdown or timer
does. SSH and eligible stale-service restarts hold until blocking command completion
or positive systemd settlement after an uncertain client outcome. A queued job,
transitional lifecycle or unreadable systemd keeps exclusion and re-polls with
capped, shutdown-cancellable backoff. Timed arm terminal success keeps shutdown
exclusion; terminal failure releases. See the [state table and owner API](START-LIFECYCLE.md#reservation-state-table-and-owner-seam).
An explicit retry of the SAME power action is allowed only after every current
stream/update fence passes again; failed retry cannot clear an earlier shutdown.
Legacy completion reboot is deferred rather than discarded while refused, without
an unsolicited operator-refusal notification. Console/physical power is the last resort.
Historical boot degradation is retained for diagnosis, not treated as current work
after validated startup and current authority/durability settle. Unknown stays refused.

This is not a durable shutdown lease. Backend restart clears process-local state;
the board drill must prove that a queued installed shutdown still excludes new starts,
restoration/autostart and update work across that restart. Also exercise accepted
reboot followed by Go Live, remote confirm versus Go Live in both orders, and timed
activation from arming through reboot, a stale restart longer than its 10 s client
bound and resolver settlement, and exit-zero-without-shutdown followed by explicit
retry. No hardware qualification is claimed here.

Add-on helper mutations additionally require their checked request-owned process
group to retire, then descriptor-unit jobs to settle, even after exit 0 or 1. A
zero-spawn refusal is the only immediate helper clearance. The launcher, strict
ESRCH predicate, zombie over-hold, session-escape and delegated-manager limits are
documented in [the add-on contract](agents/add-on-subsystem.md). Restart clears
local evidence, not external completion; `KillMode=mixed` still cleans the service
cgroup. No service supersede/clear primitive exists. D257's pre-submission CONTROL
refusal still needs the existing same-action reboot or restart escape. These are
host-tested boundaries, not qualification of either board.

This is the engineering reference for how a CeraLive device discovers, downloads,
installs and verifies its own updates. It describes the code on this branch, file
by file, and says plainly where a path is implemented but not released on any
image today.

**Status in one paragraph.** The orchestrator, its D8 stream admission, the
package pipeline, the Updates dialog and its global surfaces are implemented in
this candidate and apply to legacy and capable images when installed; fleet
rollout is not established ([PARTIAL]). The APT all-package scope, the OS agent, the
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
| genuinely absent, or valid declaration without `apt-all-packages` | `legacy` | `[]` |
| valid declaration with `apt-all-packages` | `capable` | the file's list, verbatim |
| present unreadable, ambiguous or invalid declaration | no mode granted; typed `discovery_failed` | no capability reply |

UNKNOWN is an internal typed read refusal, not a third wire mode. It blocks
legacy refresh/discovery as well as manual/scheduled package installation, and
withdraws cached actionable entries rather than installing through a guessed
regime. Bytes are retained; a valid later read recovers. Package completion also
requires present whole-string bounded exit properties and a coherent owned unit;
missing/malformed evidence stays under observation without success or cleanup.
Host evidence and limits: [update recovery](./UPDATE-RECOVERY.md#capability-regime-and-terminal-package-evidence).

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
The unchanged 2026-10-22 Orange Pi nginx capture additionally reproduces ordinary
security upgrades with apt temporary-break lists such as ` [nginx:arm64 ]`.
Discovery and pinned preflight now accept that producer grammar, empty lists and
repeated reverse-dependency notes while keeping annotations out of installation
authority. Genuine malformed rows, broken configure output, duplicate installs
and all removal/purge plans still refuse. Journal warnings include the closed
reason, stage/substep and at most 300 characters of redacted parser/command detail;
this context stays log-only. Legacy package-list headings also normalize CRLF.
The pinned install recheck ignores apt-get's Suggested/Recommended and additional/
NEW package-list prose without treating its names as install targets. Discovery
and detached argv checking share code-unit package order (not locale collation),
and APT command children use the C locale with `LANGUAGE` unset. Pinned parse
warnings use their own `pinned-recheck` step, so discovery dedupe cannot hide
them; failed hold-list commands are staged as simulation failures.
These are host parser/formatter proofs, not a successful update on the fixed board
build. Source grammar and coverage: the backend
[discovery contract](../apps/backend/docs/agents/software-update-check-contract.md).
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
vocabulary (no new refusal reasons):

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

The legacy Packages section renders a `streaming` start refusal or failed
reason with `general.updateReasonStreamingUnconfirmed` ("A stream is running
or its state is unconfirmed. Press Stop to confirm..."), because the device
refuses while liveness is UNKNOWN as well as while it is live. That sentence is
an additive key: `general.updateReasonStreaming` is in the immutable rendered
oracle and keeps its frozen text (FIX-16-F4, PRE4-C C4-3). The docs.ceralive.tv
update page (English and es-419) still owes this sentence; it is not published.

The frontend's Stop confirmation cannot come from an earlier status request
whose reply merely arrived after the press. Pulled lifecycle evidence requires
dispatch after the current claim/STREAM-FACT observation and receipt over the
current link. Only `is_streaming`, `stream_lifecycle` and unclassified field
names advance that atomic horizon; unrelated telemetry/Wi-Fi/modem/SSH pushes
do not. Successful snapshots merge unrelated fields independently, withholding
only fields superseded by an overlapping newer push/read, not the whole payload.
Stream-superseded facts never settle an action. Receipt, device computation and
ingestion are different events. Superseded reads
permit at most one fresh read, never automatic Stop on unknown. A settled
watchdog cannot act on a later stream session. Restoration still triggers fresh
details/settings/capabilities reads after both hydrate paths settle. This is a
host-proven frontend evidence rule, not backend install permission or browser/
board qualification; see [START-LIFECYCLE](START-LIFECYCLE.md).

A current Start watchdog whose bounded evidence is exhausted now retains an
attempt-generation-owned UNKNOWN record and renders the existing unconfirmed
band's operator Stop. It survives navigation and reconnect and clears only on
later admissible live/idle evidence or that Stop owner's acknowledgement. It
never grants backend update permission or automatically stops media. Other
fields are unrelated to **stream settlement**, not every decision: `updating`
still gates reboot/power and `network_ingest` still gates Start configuration.
Browser scheduling and integrated backend/engine incidence of the full
lost-confirmation transcript remain UNKNOWN. This recovery wording likewise
still owes coordinated English/es-419 user-doc publication.

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
| `os-verifying` | `OS_ROLLBACK_DETECTED` | `idle`, failure cleared (only after recording the staged version in OS quarantine and publishing `os-rollback`) |
| `sync-eligible` | `SYNC_STARTED` | `syncing` |
| `sync-eligible` | `SYNC_SKIPPED` | `idle` |
| `syncing` | `SYNC_SUCCEEDED` | `synced` |
| `syncing` | `SYNC_FAILED` | `failed` |
| `synced` | `SYNC_SETTLED` | `idle` |
| `quarantined` | `RESET` | `idle` |
| `quarantined` with exact `os_version_mismatch` | `OS_ROLLBACK_RECORDED`, matching staged receipt version in `quarantine.json` `os[]` | `idle`, failure cleared; startup/tick migration only, protection retained |
| `failed` | `RESET` | `idle` |
| `failed` with exact `commit_unit_absent_on_resume` | root-only `HISTORICAL_COMMIT_ADJUDICATED` after durable receipt and plan archive | `idle` |
| `failed` with exact `commit_unit_absent_on_resume` and recorded attempt boot/slot | `COMMIT_RESUME_SETTLED_CONSISTENT`, fresh absence/process/lock/dpkg and reboot-or-fallback proof | `idle`, old pending plan cleared, package check due immediately, recovered notice |
| `failed` with a recorded slot-sync failure | `SYNC_FAILURE_SUPERSEDED`, later matching receipt, clean unit and both rootfs slots good | `idle`, recovered notice, no mirror/cleanup replay |
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

An absent commit unit has a separate, narrower consistency path at startup and
on the periodic tick. New attempts retain optional persisted boot/slot provenance.
Only a different current boot or running slot, a positively absent fixed unit,
no APT/dpkg process, exclusive recovery-held OFD locks on the four standard
dpkg/frontend/APT lists/archive paths, a zero-exit `dpkg --audit` with trimmed-empty
stdout and exactly empty stderr, and an empty dpkg updates directory permit idle
with fresh package discovery due. The locks are nonblocking, acquired before the
first state/evidence read and held through durable/wire/notice publication, so
ordinary external fcntl writers cannot enter between proof and publication. Any
refusal defers recovery; finally closes and reaps the pipe-owned inline Perl
holder, including on errors. Direct fcntl acquisition admits only little-endian
Linux x86_64/aarch64 LP64; unsupported platforms refuse. The read-only state and
consistency collection share a 30-second budget; late results never authorize
recovery. Cleanup/publication retain their lease through completion or refusal,
without a timer unlocking underneath them. Backend death closes its pipe.
Holder loss during the final awaited plan cleanup also refuses publication,
even if cleanup completed. Writers bypassing these fixed-inode
locks remain outside the contract. The
old pending plan is strictly read and cleared, not replayed; no package success
or bad candidate is inferred. Same-boot/same-slot or missing/read-failed proof
stays failed. Shipped files without provenance still load but remain operator-only
through the local receipt tool. A recorded sync failure likewise clears only
after a later matching successful mirror: clean unit probes around the receipt,
current digest/build/version/slot identity and both slots good. A genuine current
failure stays visible. These paths hold CONTROL and the shared update lock and
persist keyed recovered-notice intent before publishing idle. See the complete
[proof and crash limits](UPDATE-RECOVERY.md#interrupted-package-and-mirror-failure-recovery-partial--host-proven-board-re-drill-owed).

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

Present unreadable or ambiguous stored idle evidence is not quiet activity:
`getIdleStatus()` returns the existing `activity-unknown` blocker, and a package
attempt stays `awaiting-idle` without submitting an install. Genuine absence
keeps the conservative boot-time baseline. Read errors do not cache defaults or
repair the file; after storage repair the next evaluation retries it. Metadata
link support and host-proof limits are in
[`UPDATE-RECOVERY.md`](UPDATE-RECOVERY.md#metadata-and-idle-boundaries).

### Operator actions

| RPC | Runtime function | Behaviour |
|---|---|---|
| `system.checkUpdatesNow` | `checkUpdatesNow()` | Manual discovery; bypasses due time and D7. |
| `system.installUpdatesNow` | `installUpdatesNow(input?)` | Manual install; bypasses idle. Optional `{scope: "packages"}` restricts admission to package-owned phases. Starting-stream limits: root AGENTS.md D8 Known gaps (f). |
| `system.allowCellularOnce` | `allowCellularOnce()` | Records a one-time cellular approval for the named OS candidate. |
| `system.getUpdateDetails` | `readUpdateDetails()` | Dialog snapshot. |

**Package-labelled manual install [EXISTS; host-tested, board qualification owed].**
The optional input is a strict object with only `scope?: "packages"`. Absent input
and `{}` preserve the existing Install now behavior, including OS staging in
`os-available`; cellular approval still calls that unscoped path. A scoped request
accepts only `available` or `awaiting-idle`, rechecking authoritative phase,
streaming and pending durability after awaited preparation. It cannot stage an
OS image or change automation settings. It uses the existing package launcher,
metered gate, exact actionable pending plan, single-flight ownership and installed
notice. Other phases refuse with the existing manual reasons (`not_available`
without a package offer, `busy` for the existing package-pipeline exclusions;
the existing boot-version diagnostic is retained). The scoped preparation fence
also checks after capability, plan and settings reads, before further preparation
or dispatch; a refused owned plan is cleared before the request settles.

The Packages **Update** button selects this scope only after the image reports
`mode: "capable"` with `apt-all-packages` and the observed orchestrator phase is
`available` or `awaiting-idle`. It reuses the Install action's busy state, phase
settlement and localized refusal bands; a refusal never retries through legacy.
**Legacy-routing residual:** in every other phase the Packages button still uses
`system.startUpdate`, without informing the orchestrator. This includes an OS
offer (`os-available`), `idle` after the Packages section's own legacy check,
`failed`, `quarantined`, `synced`, `os-staged` and `os-activation-armed`. The same
legacy route applies before capabilities have been read successfully (including
a failed read), on legacy/incapable images, or without an orchestrator snapshot.
Package discovery still uses `system.checkForUpdates`, which dispatches nothing
to the orchestrator. The separate D8 launch, deferral, pre-unit and adoption
limitations remain unchanged.

**Mixed-version window:** an older backend that already has the orchestrator
ignores the unknown input and executes `installUpdatesNow()` unscoped, equivalent
to **Install now**, rather than selecting the legacy RPC. A stale newer cached
tab against that backend can therefore stage an OS image if the backend reaches
`os-available` during the RPC window; existing OS admission fences still apply.
Reload the page so the device serves its matching frontend, then use the normal
OS-offer controls. Matching frontend/backend versions do not have this scope-skew
window.

**Install when idle [EXISTS; host-tested]:** if a scoped call first dispatches
`AWAIT_IDLE_FOR_INSTALL` and then refuses while still in `awaiting-idle` (for
example a stream becomes live, capabilities become unreadable, or the cellular
gate refuses), that phase remains. A refused owned plan is empty and the launch
latch is released, but the scheduler retries packages at the next eligible idle,
non-streaming window even with `packagesAuto=false`; normal capability, admission
and cellular gates still apply. This is intended install-when-idle behavior, not
an OS-stage request or an automation-setting change. Operator note: retry Update
when not streaming or let the scheduled package install run. No cancellation
control for `awaiting-idle` is claimed. Each step has its own host test
(`update-orchestrator-runtime-install-pending.test.ts`: a refused scheduled launch
stays pending for the next tick; `update-orchestrator-package-scope.test.ts`: a
scoped metered refusal keeps `packagesAuto=false`). No single committed test runs
the whole chain from scoped refusal to the idle-tick package install.

Regression coverage: `update-orchestrator-package-scope-sweep.test.ts` combines
macrotask and microtask phase/stream flips, including bare recovery-helper awaits,
with an unscoped OS-stage control and runtime absent-input/`{}` equivalence.
These are host fixture proofs, not installed-board qualification.

After a stream abort, `os-available` can precede retirement of the cancelled
producer. Install now reports existing typed `busy` while that producer, RAUC
restart submission, a stream/lifecycle holder, shutdown or pending settlement
withholds a new attempt; it does not misreport an absent offer. Once those
fences settle, Install can stage the retained candidate without a new Check.
The same busy classification is rechecked after awaited preparation, including
settlement that became pending during capability loading. Only `osStageBlocked()`
is mapped this way; no offer, absent capability and other readiness refusals still
answer `not_available`.
The host regression holds producer recovery across two presses, then releases it;
which exact fence withheld the historical Rock presses remains unobserved.
Readiness, CONTROL, cellular-policy and authoritative-state refusals retain
their existing behavior; this correction does not bypass or reclassify them.

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
| `os-staging` | allowed once termination/restart submission returns, not after daemon recovery | cancel the stable attempt signal and move to `os-available` before termination; queue `systemctl restart --no-block rauc.service`; propagate submission errors, but never await daemon recovery or the detached escalation below. The submission fence and interrupted-stage fence remain independent. New OS work requires positive readiness, and cancellation wins over simultaneous link failure or late producer callbacks. |
| `syncing` | allowed | continue locally |
| every other phase | allowed | none |

RAUC cancellation keeps the awaited SIGTERM → nonblocking restart submission
unchanged. A detached escalation first reads `ActiveState`, `MainPID` and
`InvocationID` at T+1 s after the TERM reply. Only a `deactivating` unit with a
valid process/invocation identity gets a second read at T+3 s from that same
origin. Only the same PID **and** invocation still `deactivating` permits the
packaged `ceralive-nbd-release` helper to issue NBD_CLEAR_SOCK on attached NBD
devices. A third read at T+8 s permits
`systemctl kill --signal=SIGKILL --kill-whom=all rauc.service` only for that same
still-stopping identity. Helper failure warns without cancelling that final
look. An observed active or replacement daemon is left alone. Repeated
cancellations replace the pending escalation after the latest TERM reply and
fence already-running reads; a later TERM spawn failure preserves the earlier
armed lifetime. Timers are unreferenced; every new
command uses the existing ten-second command timeout, and detached failures
warn without changing the caller's result. The added awaited Go Live delay is
**zero**. T+8 is the observation deadline, not a guarantee of resource cleanup
by that instant: scheduling, command execution and kernel retirement can take
longer. SIGKILL did not shorten the measured kernel-NBD wedge: recovery took
about 300–315 s until the kernel timeout. A manual NBD_CLEAR_SOCK restored active
RAUC and nbd0 size zero within 12 s in two of two stuck Rock cases; this is not
qualification of the packaged automatic path. The timeline, identity fences and
failure handling are host-tested. Automatic residue-free recovery and subsequent
Install still require the board drill described in
[update recovery](./UPDATE-RECOVERY.md#detached-rauc-termination-escalation-partial).

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
[`AGENTS.md`](../AGENTS.md). An admitted, uncancelled start sets
`/run/ceralive/streaming`, which the image's activation script checks before
arming an OS slot. Each Stop caller reports intent before joining/parking cleanup.
Operator intent requests marker disarm and revokes pending commitment/delayed
arming (machine intent retains restoration). Successful marker removal prevents
fresh-factory restoration; marker I/O/corruption is separate recovery debt. Cancellation
waits for parked Stop rather than racing the engine mutex, and
restoration re-reads intent after runtime observation. This does not remove the
physical-liveness guard: parked, rejected, timed-out and unknown stops retain it.
The internal operator-intent token fences restoration preparation and Start's
pre-generation waits and commitment/hooks; it is never idle/admission evidence.
Composition seeds lifecycle from the owner before hydration without a broadcast
or engine-query wait: retained protection is reconciling, unprotected boot idle.
Legacy live/health/HUD flags are not positive idle authority.
Profile reconnect retains operator cancellation across its machine Stop await
and refuses replacement Start when that flight was superseded.
Confirmed idle/cleanup clears it; reconciliation to streaming sets it and
reconciliation to idle clears it. The host regressions do not qualify image
activation or either board. The typed failure is documented in
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
existing `failed` `agent.json` is not generically reclassified on restart or the next tick.
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

### Outcome evidence [EXISTS; host-tested, board qualification owed]

APT exit zero proves installation, not a completed service restart. Durable
restart permission is separate and may be withheld while the old backend
continues running. The dialog and overlay say installed; restart is not
confirmed. Existing status/details expose no update-specific restart-completed
or backend-start witness, so reconnect/new-boot observations alone cannot
justify that claim. The frontend evidence machine's contract applies to this
distinction too; no new restart wire field is introduced.

Completing `armOs(true)` requests activation, and emits an informational
`os-activation-requested` notice asking for a restart to apply it. It never
emits **now active** on that same boot. Only the existing verified path can emit
`os-activated`: the strictly read running OS version equals the staged target,
and the healthy-state verdict names the current boot. Submission cannot stand
in for either observation. The activation/reboot/health policy is unchanged.

The transport summary is process-local, timestamped evidence. Missing history
means not known, never no previous download. Selection is historical, not live
use. Probe unavailability is not failed reachability; `Not reachable` requires
a positive failed probe. Unknown cost stays null in the shared summary schema
and displays **Cost unknown**. This is the narrow nullable-metering correction
required for honest connection copy; booleans remain accepted, persisted formats
are unchanged, and conservative transport admission is unchanged.

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
   (`quarantine.json` `os[]`, the persistent `os-rollback` notice, then
   `idle` with no workflow failure). The version stays refused, but Check and
   normal lagged-mirror scheduling are available again. Startup and tick also
   clear the older `quarantined / os_version_mismatch` state only after the
   staged receipt's version is found in OS quarantine; missing, invalid or
   unrelated protection never grants clearance. Package quarantine is unchanged.
   Startup also restores the same version-keyed rollback notice from valid OS
   quarantine, independent of the workflow phase or a retained receipt. It stays
   visible until dismissed; the existing durable semantic dismissal store remembers
   the exact version across restarts, exempt from ordinary notice eviction.
   Corrupt/absent quarantine cannot invent a notice. Notice rehydration and dismissal
   are host-tested, not board-qualified by the earlier rollback drill; see
   [recorded rollback recovery](UPDATE-RECOVERY.md#recorded-os-rollback-recovery-partial--host-proven-bench-re-drill-owed).
   A later Check against the same consumed pointer still refuses serial replay.
   If its authenticated exact version is already OS-quarantined, only the redundant
   OS-check replay warning is cleared/suppressed (debug log instead). Check failure,
   backoff and strict staging admission remain unchanged; non-quarantined replay
   and every other refusal still warn normally. This quiet-warning repair is
   host-tested and has not been deployed or re-drilled on either board.
   The version check comes first, so a rollback never depends on
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
  Settings. Only genuine override absence uses Settings' OS channel; invalid or
  unreadable presence refuses selection instead of silently changing channels.
  Present unreadable authority or invalid bytes, type, owner or mode refuse with
  the existing typed `discovery_failed` reason. EIO/EACCES, oversize,
  invalid UTF-8, duplicate-key JSON or any content other than the exact scalar
  cannot authorize a different channel. Discovery proposes no candidate or
  transport and rewrites nothing. A later valid read recovers without a latch.

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

**Package transactions use the `apt` job on an image declaring
`transport-uidrange`** (with `apt-all-packages`, on a real device). The refresh,
the discovery simulations and the install's pinned simulation each run under the
selected pair's rule for `apt_uid`, the sandbox user apt's fetch methods run as.
The refresh and a new archive pre-fetch (`apt-get -d -y upgrade --with-new-pkgs`,
the detached unit's own first stage) fail over to the next clear pair when apt
reports a fetch failure or the bounded runner times out; local apt failures do not
fail over. The pre-fetch is awaited under the pin, but cache/list drift before
the detached unit can still cause an **unpinned** download in its unchanged first
stage. Complete D13 coverage is not claimed for that interval. A
stream start in `downloading` latches cancellation from admission and aborts the
in-flight pre-fetch; teardown failure retains journaled ownership rather than
admitting another APT job. See [APT ownership and residuals](APT-TRANSPORT-OWNERSHIP.md).
Successful teardown removes its rule. No healthy pair folds into the existing `repos_unreachable` /
`captive_portal` / `discovery_failed` refusals. Images without
`transport-uidrange` keep the unbound reachability preflight unchanged. This is
fixture-tested, **not board-proven**.

Orchestrator package checks (manual and scheduled) now run a complete refresh →
discovery cycle, just as the legacy Check does. This starts a new check-failure
lifetime: after a captive portal clears, a healthy selected path and successful
real refresh can return `idle` or `available` without restarting the backend.
Deliberately disabled APT (`apt_update_enabled:false`) skips the orchestrator's
package cycle without a refusal notice or failure backoff; OS discovery remains
independent. An unexpected refresh exception logs and settles `discovery_failed`
instead of leaving Check and the tick chain pending. A failed refresh ends that
cycle before discovery can publish a new stale-list offer. Its failure survives
in the port result and `lastCheckFailure`; an already-published offer can still
outrank it on the package wire under the existing precedence rule. Captive
probe and APT stderr classifications, pin failover and the 15-minute failed-pair
hold are unchanged. This recovery correction is host-regression-tested, not yet
board-re-drilled.

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

`decideCellularGate()` in `schedule.ts` applies unless at least one connected
uplink is positively known to be unmetered (NetworkManager `GENERAL.METERED` of
`no`/`guess-no`, with no ModemManager or router marker). Unknown cost is never
treated as unmetered: a failed or malformed `nmcli` inventory, an empty one, or a
link reporting `unknown` metering all count as metered-only. Unknown cost stays
internal (`metered: null` on the transport candidate); the stored and wire
transport summaries still carry a boolean and report it as metered, so the OS
stage pin requires candidate approval for it exactly as for a metered link.

| Kind and stage | Metered-only uplink |
|---|---|
| packages, check or install | allowed when `allowPackagesOverCellular` |
| OS check (small manifest) | allowed when `allowSystemOverCellular` |
| OS install (the bundle) | **always held**, whatever the toggle says |

The package install gate is evaluated again immediately before the install unit
is launched, not only at check time: an offer discovered over Ethernet does not
install over a metered-only uplink while `allowPackagesOverCellular` is off. The
refusal uses the existing vocabulary (manual install answers `busy`), clears the
pending quarantine record and launches nothing; the phase stays `awaiting-idle`
and the next tick re-evaluates.

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
`{allowed: true}` or one of nine reasons, evaluated in this order:

| Reason | Condition |
|---|---|
| `capability-absent` | not `capable`, or `slot-sync` missing |
| `not-yet-booted` | no healthcheck record, or its `boot_id` is not this boot |
| `packages-changed` | the SHA-256 of `/var/lib/dpkg/status` differs from the record |
| `build-changed` | the build id differs from the record |
| `os-install-pending` | phase is `os-staging`, `os-staged`, `os-activation-armed` or `os-verifying` |
| `already-syncing` | phase is `syncing` |
| `update-busy` | phase is `awaiting-idle`, `downloading`, `committing` or `restarting-services` |
| `already-synced` | the sync receipt records this dpkg SHA, names the current inactive rootfs slot, AND the bounded RAUC observation reports that target `good`, with the healthy booted slot's identity confirmed |
| `slot-identity-unknown` | the matching receipt's slot identity cannot be resolved, or RAUC is unreadable/undecidable or disagrees with the current healthy booted-slot identity; skip and retry, with one warning per change rather than per tick |

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
other rootfs slot, so a matching SHA requires target-health observation),
`not-other` (it names the booted slot, a slot of another class such as
`certs.0`, or a name the map lacks while the map already names the other
rootfs slot, so the mirror is allowed), or `unknown` (no current-boot healthy
record, the booted slot has no mapping, or the target is a name the map lacks
that could be the unmapped other rootfs slot). Completion timestamps are
never used as identity: a clock can step and a time names no slot. With a
matching SHA, `unknown` makes the gate skip this tick (`slot-identity-unknown`)
and retry on the next one: dispatching blind could meet a wedged RAUC whose
exit-75 refusal would leave a sticky failure. The build id is the unique `BUILD_ID=` of `/etc/os-release`,
falling back to `/etc/ceralive/image-build-commit` only when that unique value is
empty or absent. Repeated build keys, `[system]` sections or rootfs slot sections
refuse rather than selecting the first identity.

A receipt proves a **past mirror**, not that its target still contains that
copy. A failed OS install can overwrite the inactive slot and leave it `bad`
after bootloader fallback, without changing the running slot's dpkg SHA. In
`idle` the gate dispatches the existing mirror path in this case, even with a
matching receipt. A matching receipt into a positively `good` inactive slot
still suppresses dispatch. Pending OS phases and an already running mirror
remain refusals; no receipt is deleted or edited to force recovery.

For this matching-receipt check, `SlotSyncTargetCache` reuses `deps.readRootSlots`
with a 60,000 ms refresh bound, shared by eligibility and start preflights.
Successes and unknown/read-failure results are cached equally. Startup begins
uncached; a changed boot/target identity or adoption of any phase other than
`idle`/`sync-eligible` invalidates it, including OS writes and rollback recovery.
Ordinary idle scheduling is every 60,000 ms, active scheduling every 3,000 ms;
unchanged idle evidence costs at most one extra RAUC status call per minute,
with the existing 10,000 ms command timeout. A clock step backward expires the
cache. State-generation changes during observation refuse that result. This is
a cheap decision, not a lock or a replacement for the unit's safety checks.
Recovery dispatch and its bounds are host-tested; the exact-head fallback and
automatic restoration drill on hardware remains owed. A failed mirror retains
the existing failure policy, rather than starting again on every idle tick.

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
| `refused` | a failed package check, a failed commit, a failed OS check (except an exact quarantined replay; an unreadable quarantine probe retains the ordinary replay warning), an untyped OS stage failure |
| `os-stage-retry` | a typed OS stage failure with an automatic retry scheduled |
| `os-stage-operator` | a typed OS stage failure that needs the operator (operator mode or the third automatic round) |
| `os-stage-unresolved` | an unsafe OS stage failure, including an attempt found idle after a restart |
| `installed` | leaving `restarting-services` |
| `restart-recommended` | a protected unit with stale mappings |
| `cellular-approval` | an OS install held by D12 |
| `os-staged` | a successful OS stage |
| `os-activated` | a forced `@now` activation, and a boot of the staged version whose healthcheck passed (this boot's `healthy-state.json`) |
| `os-rollback` | a booted version that differs from the staged one after the armed activation ran, including the bootloader fallback after the new slot kept failing its healthcheck before `mark-good`; startup also restores undismissed recorded OS quarantine history, independently of agent validity |
| `slots-current` | a confirmed slot mirror |
| `download-paused` | a D8 admission that actually returns an in-flight package download or OS staging attempt to its offer state; detached intent persistence precedes publication |
| `credentials-expiring` | independent cached public APT certificate observer, at 90/30/7-day thresholds |
| `credentials-expired` | the same observer when the public certificate expiry is reached |
| `transport-unhealthy` | **no producer** |

The credential and download-hold observers coexist independently: both are
scheduled before tick early returns, with no new await on stream admission.
Their notification names and dismissal keys use distinct kind prefixes even
when opaque suffixes match. Each producer retains its own journal and durable
acknowledgement policy; neither journal is update-admission authority. The
combined host regression `update-notices-combined-runtime.test.ts` exercises
simultaneously held/failing observers, unchanged reducer/effect ordering,
separate dismissals and both notice families' keys across all ten catalogs.
This is host isolation evidence, not a shared-event-loop latency guarantee.

### Download hold notice [EXISTS; host-tested, board qualification owed]

`notifications.updatePausedForStream` says the update was **put on hold for a
stream-start attempt** and will be offered again when the device is idle. It
does not say that a stream started, all network activity stopped, RAUC recovered,
or a suspended process will continue byte-for-byte. This is cancellation and
later retry through the ordinary automation, idle/schedule, cellular and readiness
rules; Install now retains its normal admission checks.

The two producers are the package and OS interruption branches in `runtime.ts`,
not the pure reducer or generic stop helper. Package capture precedes the commit
probe/stop awaits, but emission requires the successful existing abort transition:
a rejected stop, stale-wire commit/success or unknown/throwing commit probe emits
nothing. OS capture precedes signal abort and the existing transition before
TERM/restart; enqueueing happens in the original submission `finally`, so even
slow submission cannot start notice I/O before admission settles. A failed restart
submission still propagates its original error and may produce the truthful hold:
the semantic transition already happened. Nonzero best-effort stop/TERM replies
also permit this hold wording, never a physical-stop claim. Already-live holds,
idle/syncing admission and unrelated producer cancellations produce no event.
A later engine launch refusal does not erase a real earlier interruption.

Package launch acceptance creates a process-local opaque attempt UUID; restarted
downloads lazily acquire one before the first admission await. OS uses its existing
`activeAttemptId`. IDs are `packages:<opaque>` / `os:<opaque>`, inside
`update:download-paused:<id>`. Concurrent callers and repeat observations share one
logical notice; a new attempt gets a new identity. No package UUID or notice field
is added to `agent.json`, the persisted RPC schema or reducer state.

`download-paused-ledger.ts` owns schema-1
`/data/ceralive/update-state/download-paused-notices.json`: opaque ID, local
candidate hash and `active` / `acknowledged` / `withdrawn`. It uses the shared
bounded, anchored/no-follow, nonblocking strict JSON reader, a sibling atomic
write with file fsync, rename and parent-directory fsync. Only genuine absence
is empty; unknown/corrupt/unreadable data is preserved and defers publication,
with bounded in-memory facts retried by the observer after repair. The worker
commits intent before publishing; after a readable baseline, each interruption
gets at most one intent write attempt. Write failure logs a closed reason and
still publishes a best-effort in-memory notice, without per-tick write retries.
Unknown reads retain the bounded fact for repair without writing.
Startup independently rehydrates active
intents even when agent authority is invalid. Ticks retry independently of update
automation or recovery gates. Producer-owned acknowledgement runs before normal
dismissal/removal and survives ordinary 256-key dismissal eviction; failed
acknowledgement leaves the notice visible. Resume withdraws only the matching
candidate. Accepted package replacement also retires the last interrupted package
transaction from this single pipeline across restart, not an unrelated OS notice;
OS discovery retires the exact superseded recovery candidate. Retirement carries
the successor attempt as a cutoff: storage repair cannot let an old withdrawal
erase a newer interruption of the same candidate.

The notice is informational. Restart-safe dedup, rehydration and acknowledgement
are guaranteed for every intent that reached the ledger. If the backend dies in
the window after the transition and before the ledger commit, that one notice is
lost; the update itself is already safely back in the offer state and is
re-offered by the normal rules. This is an accepted, documented best-effort window
(`V-DLP-PRECOMMIT-LOSS`), **not exactly-once delivery**.

All notice I/O/publication starts on a detached zero-delay **macrotask**, never a
microtask or an awaited admission continuation. The queue and retained facts are
capped at 128, one worker flight runs at a time, and each queued action starts on
its own macrotask turn. An interruption fact causes at most one intent write;
duplicate delivery of an existing intent never rewrites it. Acknowledgement and
withdrawal are independent obligations, not additional intent writes.
The strict ledger retains up to 4096 records. At capacity, only `withdrawn`
records are compacted, in the same atomic write that adds the new intent.
Active notices and acknowledgements are never silently evicted. If no room can
be made, one closed-reason `ledger-full` diagnostic drops that pending fact and
publishes its in-memory notice best effort, without per-tick interruption retries.
Ordinary hydration still reads once per observer tick. Neither capacity exhaustion
nor write failure refuses a stream or overwrites protected history.
The worker's one-second observation deadline fences later publication; it cannot
preempt synchronous filesystem calls or cancel an already-submitted asynchronous
port. A held port retains that single flight rather than overlapping writes.
These are scheduling/isolation bounds, not a disk or stream-launch latency SLA.
On the build host's `/mnt/development` filesystem, 100 one-intent atomic ledger
writes measured p50 **17.39 ms**, p95 **18.33 ms**, max **20.77 ms**; the existing
synchronous agent persist in `dispatch` measured p50 **17.42 ms**, p95 **17.81 ms**,
max **26.11 ms** in the same run. The worker can still occupy the shared event loop
after admission returns. These host samples are not board or power-loss proof.

**Accepted tombstone residual (RR-1).** A duplicate informational notice requires
two overlapping admissions (Start → Stop during D8 → Start), one stop of the same
unit hanging within its 10-second timeout despite the other caller's stop having
returned, and an operator relaunch plus a third Go Live before that hung stop
returns. The first admission interrupts a download; the relaunch withdraws that
hold; the third Go Live interrupts the new attempt. With the ledger at exactly
4096 lifetime records, this last interruption compacts away the first hold's
withdrawn tombstone. The older admission then resumes in the already-available
phase: its transition is a no-op, but it can reannounce the original hold because
the tombstone is gone. All those timing and capacity conditions are needed for
this sequence. The repeated notice is truthful because the update really is held
at that moment, and the next accepted relaunch retires it.

## Credentials and certificate expiry

The independent credential observer [EXISTS; host-tested, installed-board proof
owed] reads the active public APT client certificate, never its private key.
Selection reuses add-on TLS policy: a complete packaged pair under
`/usr/share/ceralive/apt-credentials` takes priority over `/etc/apt/certs`. Key
existence is checked without opening it, using the same symlink-following
`Bun.file().exists()` policy as the TLS consumer. A dangling package entry can
therefore select the complete legacy pair in both readers. A selected public
certificate still uses strict no-follow reads. Malformed selected package credentials
never fall back to a different legacy pair.

PEM and DER parsing uses Bun's `node:crypto` X509Certificate. Reads are bounded,
no-follow/nonblocking regular-file reads with trusted ancestry and ownership.
The package's public UTC `not-after` metadata must match the parsed certificate
expiry. A coherent recheck rejects replacement races. Missing, unreadable,
oversized, unsafe, malformed or mismatched evidence is **unavailable**, never
healthy or expired by default. Exceptions, certificate content/identity, paths
and local digests never enter the notice or RPC payload.

Warnings cross at `0 < expiresAt - now <= N * 86400000` milliseconds for
N=90/30/7, with a separate expired variant when `expiresAt <= now`. Late first
boot/offline/clock-forward observation durably records every newly crossed fact,
supersedes weaker thresholds and surfaces only the most urgent current one.
Copy says **within** the threshold, not an exact countdown; expired has no days.
The current intent is the most urgent of eligible thresholds union already
pending/active thresholds in the current generation. A backward clock step never
retires an undismissed notice; only escalation to a more urgent recorded threshold
or rotation does. Same-ID rehydration is continuity, not rearming an acknowledged
threshold. An unreadable replacement is not renewal evidence and does not
retire established warnings as if a new coherent generation had been observed.

`credential-notices.json` under the existing update-state directory writes schema-2
intents, stable random generation IDs and per-threshold pending/active/
acknowledged/superseded lifecycle. Intent persistence and file+directory fsync
precede publication. Startup reconstructs undismissed notices with the same ID;
dismissal commits to this dedicated journal before removing the notice, not to
the ordinary 256-entry LRU. Later thresholds remain eligible after earlier
dismissals. Rotation retires older active notices and retains history across A/B
rollback. At 1,024 generations or a 1-MiB read limit, history is preserved and
new generation observation defers; acknowledgements are never evicted to make
room. Corrupt/unknown journals defer rather than reset. Durable logical identity
is not exactly-once physical frame/toast delivery across a crash.
Strict schema-1 history remains readable with a conservative clock floor derived
from recorded threshold crossings; its exact historical observation time cannot
be recovered. The next semantic write upgrades it; future schemas still defer.
Schema-1-only older binaries refuse schema 2 without clearing it.

Startup forces a read; tick schedules an exception-isolated, single-flight
observer **before** recovery/live/automation early returns without awaiting it.
Observation is throttled to once per minute and public reads cached for fifteen
minutes (forced refresh bypasses cache; a backward clock step refreshes too).
No observer work joins stream admission or starts renewal/network operations.
`system.getUpdateDetails.credentials` projects the same cached observation as
`{ expiresAt: epochMilliseconds | null, state: valid | expiring | expired |
unavailable }`. Absence denotes an older backend; GET never emits notices.
Journal/read failure is unavailable and logs a bounded closed reason once per
fault-state change. No new high-frequency status field is added. Details is also
unavailable while now is earlier than the latest recorded observation checkpoint
or this process's observation high-water mark. Checkpoints are persisted with
semantic ledger changes, not unchanged minute observations; the latter neither
rewrite the ledger nor resync its parent. Load acknowledges the parent once per
ledger instance and retries after failed writes/syncs.

Reading certificate dates proves **nothing** about private-key matching, chain
trust, revocation, server acceptance or renewal completion. Notices and dates are
computed from the device clock: without synchronization, they may appear early
or late, including at boot before chrony convergence when RTC time was not retained.
A retained notice is not proof the edge rejected the certificate, and a clock
floor does not prove time synchronization. Changing local time cannot extend
edge acceptance. Before expiry keep the device online and install available
updates (Settings → Software Updates). After expiry check there for a system
update; if unavailable, reflash or contact CeraLive support. A suitable newer
system release is not guaranteed, and there is no operator renewal action.
Device clocks and installed permissions remain
both-board proof obligations. See the backend
[journal contract](../apps/backend/docs/CREDENTIAL-NOTICES.md).

The Updates dialog renders the optional block as the update-credentials row
described under Frontend surfaces; an absent block renders nothing. See the
[shared RPC contract](../packages/rpc/docs/update-credentials.md).

**Known limits.** A wrong-forward clock step from an out-of-model time source
can leave a persisted bogus clock floor. After the clock is corrected, details
stays `unavailable` until real time passes that mark, and a false `expired` notice
can remain. Dismissing it prevents the later true 30-day, 7-day and expired notices
from reappearing for that certificate generation; the separate transport rejection
band remains the evidence. Never step a production device's clock forward while
its real ledger is in place. For owner-approved recovery, stop the backend, back
up `/data/ceralive/update-state/credential-notices.json`, then delete that file
(which re-initialises the history), or wait for real time to pass the bogus mark.

If the process dies before rename, an orphan `.credential-notices-*.tmp` can
remain. With the backend stopped, remove it with
`rm /data/ceralive/update-state/.credential-notices-*.tmp`.

Rolling back to an older certificate after rotation does not re-show that
certificate's superseded 30-day warning; its 7-day and expired notices still arrive.
Durability evidence is fresh-process reload after injected faults, not power-loss
qualification.

What does exist is a check for a certificate that has **already** expired or been
refused, inside the APT transport profile. For the `apt.ceralive.tv` host the
executor runs `openssl x509 -checkend 0` on the fleet certificate, then GETs the
mTLS `/__tls-probe` endpoint. An expired certificate, `certVerified` not `true`,
or curl exit 58 (client certificate problem) is recorded as the probe state
`credentials-invalid`. The dialog shows a rejection band only when the last
selection's findings contain that state (`transportCredentialsRejected()` in
`apps/frontend/src/lib/updates/update-bands.ts`).

Package transactions on an image declaring `transport-uidrange` now produce
APT-profile selections, so the separate rejection band can appear on such a
device when the fleet certificate is refused (not yet board-proven). That probe
and the public-date observer are distinct evidence; a known date is not a
successful transport probe.

## Frontend surfaces

- **Updates dialog** (`UpdatesDialog.svelte`): Packages, System image, Slots,
  Automation (auto toggles, schedule window, channel), Over cellular, and Update
  connection. It pulls capabilities, settings and `system.getUpdateDetails` when
  opened (`createUpdateSurface()`). One latest-read counter owns the details and
  a save echo outranks an older settings read; closing the dialog fences every
  late write. Every conclusion is drawn from device evidence, never from a
  reply's absence or a clock. "Not started" only for the pre-effect
  `UPDATE_ORCHESTRATOR_INITIALIZING` envelope, a request never sent while
  disconnected, or a `{ success: false }` reply that no start evidence
  preceded: the OS install answers `not_available` from the END phase of a
  stage it may have run, after publishing that start, so a negative reply after
  the start was seen is settled by the phase instead. A lost reply, or an
  `INTERNAL_ERROR`/`VALIDATION_ERROR` raised while handling the request, reads
  "Outcome not confirmed" until a changed phase or a details read made after
  the request settles it; a session restored after a dropped link re-reads the
  details, the settings and the image capabilities even when the phase is
  unchanged (a failed capability read is unknown, never legacy). Each action keeps
  its own band, a declined duplicate click touches nothing, and an action stays
  busy until its whole chain of requests settles. The scoped Packages Update uses
  the Install action and phase evidence. The retained legacy Packages Update is
  the same machine's fourth action, settled by a legacy `update_state` change;
  "accepted, no progress" needs an accepted reply and never claims nothing was
  installed, and "System is up to date" needs a stamped, completed discovery. A
  settings save owns its controls until its requests settle, is built from a
  settings read made after the click, and a lost reply reads "Change not
  confirmed", never "not saved". Unread details and an unestablished running
  version render as unknown; "No newer system image" needs a check the dialog
  saw complete with nothing offered on the link it reads over (the candidate is
  memory-only, so a backend restart cannot be told from "nothing found"), plus
  a succeeded latest attempt and a phase that could show a held offer; the
  sentence belongs to the link that witnessed it, and leaves the screen when
  that link drops. A frame that moves the phase and restores the session
  re-reads the settings and capabilities as well. A row whose probes reached a server but got a
  certificate, signature, TLS or portal answer is "Not usable for updates",
  not "Not reachable"; a pending cellular approval names a metered or
  unknown-cost link, never "only cellular". The install overlay reports
  success only from the device's result, never from full progress counters,
  and a terminal result (success or failure) releases the takeover at once:
  Layout announces the outcome once per outcome (keyed on the `updating` field
  the store preserves, so a repeated outcome beside a changed sibling field
  stays quiet) and the page's controls are back without a reload. Contract and exhaustive proofs:
  `apps/frontend/docs/agents/an-update-action-outcome-is-decided-by-evidence.md`.
- **Update credentials row** (`UpdateCredentialsRow.svelte`, rules in
  `src/lib/updates/credential-expiry.ts`): leads the Update connection section
  when `system.getUpdateDetails` carries the optional `credentials` block, and
  renders nothing when it is absent (an older backend). It shows the device's
  verdict as a worded badge (Valid, Expiring soon, Expired, Unknown, each with
  a shield glyph) and the certificate's expiry as a localized date and time.
  For `expiring` only, it adds "in about N days": the floor of whole days left
  on the **browser's** clock, recounted by one timer at each day boundary
  (timed from the same clock reading as the count) while the row is open, "in
  less than a day" under one day, and no phrase once that clock has passed the
  date, so it never shows a negative count. The day count is an
  `Intl` unit phrase, because a new catalog plural message would need the
  frozen i18n oracle re-frozen. `unavailable`, an unrecognised verdict, or
  `valid` without a usable date reads as Unknown with "The expiry date could
  not be read."; `expiring`/`expired` without a date keep their badge. The
  badge is always the device's own verdict, judged on the device's clock; with
  an unsynchronised device or browser clock the date and the verdict can
  disagree (for example Valid beside a date this browser has already passed),
  and the row shows both rather than overriding the device. The date
  proves nothing about mTLS acceptance; a rejection remains the
  `transportCredentialsRejected()` band. Browser-tested against injected
  details, not against a device's real certificate.
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

- earlier branch builds were exercised on the benches and exposed the recorded
  failures; those runs do not qualify the corrected exact head, and integrated
  both-board re-drills remain owed;
- no RELEASED image declares `apt-all-packages`, `rauc-verity-streaming`, `slot-sync` or
  `transport-uidrange`, so every capable path is inert in the field;
- historical bench runs do not qualify signed-manifest, hosted-bundle or APT
  mTLS behavior on this corrected exact head; the applicable exact-head
  re-drills remain owed;
- `apt.ceralive.tv` mTLS enforcement itself is an infrastructure fact, not a
  CeraUI proof: the 2026-09-26 post-enforcement matrix (todo 50) recorded 403
  without and 200 with the fleet certificate on `dists/*/InRelease`. It says
  nothing about this head's update agent;
- No production caller dispatches `RESET`: package `quarantined` and most `failed`
  states remain sticky. Recorded OS rollback instead returns to idle, including
  the narrowly evidenced historical-state migration above. An interrupted package
  commit with recorded boot/slot provenance, and a recorded slot-sync failure
  superseded by a later proven mirror, now return to idle by themselves under the
  proof rules in the transition table above; anything those rules cannot prove
  stays failed. Other exceptions are root-only
  `commit_unit_absent_on_resume` adjudication through the local recovery CLI
  described above (it preserves a durable receipt and requires a fresh
  discovery) and the two OS staging exits above, which need positive OS
   evidence from the guarded OS writer adapter (not yet board-qualified).
  That CLI exists in source packaging but has not shipped in a released `.deb` or
  image, and its root/systemd/APT board proof remains outstanding. Never delete
  `agent.json` to clear a failure.
