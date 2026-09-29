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

The orchestrator starts at boot through `startUpdateOrchestrator()`, wired in
`main.ts` as `guardNonCritical("update-orchestrator", ...)` before the standalone
`recoverSoftwareUpdateIfRunning()` probe and then the
`periodicCheckForSoftwareUpdates()` loop. Orchestrator resume reattaches a
persisted `committing` unit first; standalone recovery afterwards also covers
any detached unit that resume did not reattach, including one the orchestrator
tracks as `downloading`.
The legacy periodic loop still runs beside it; both land their discovery
through the same `runUpdateDiscoveryAndReport()` seam.

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
`capable` is never read as permission by itself. Each path checks its own token:

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
per discovery. Only the unscoped inventory carries Release Origin/Label and the
Debian suite. Unknown or ambiguous joins remain informational, not installable;
the Rock 5B+ capture of both APT forms is the regression fixture. This repairs
the former fixture-only origin parser, which looked for inventory annotations
under each package-specific candidate and rejected every real candidate.
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

`setup.json`'s explicit `"apt_update_enabled": false` still vetoes every APT
transaction on both kinds of image. The orchestrator does not bypass it: a
refused `startSoftwareUpdate()` leaves the phase in `awaiting-idle`, retried on
the next tick.

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

The launcher rechecks streaming after pending-plan persistence; a stream that
starts during that await therefore returns `stream_active`, not generic `busy`.
Scheduled refusals remain in `awaiting-idle` for the next tick.

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

The orchestrator is one flat phase (`ORCHESTRATOR_PHASES` in `types.ts`), 18
values in this order: `idle`, `checking`, `available`, `downloading`,
`awaiting-idle`, `committing`, `restarting-services`, `settled`,
`os-available`, `os-staging`, `os-staged`, `os-activation-armed`,
`os-verifying`, `sync-eligible`, `syncing`, `synced`, `quarantined`, `failed`.

One phase is enough because the single update lock allows only one disruptive
operation at a time. The trade-off: a package update and an OS update are never
both tracked as available at once. Packages go first, and the OS check waits
while a package phase is active.

`reduceOrchestrator` is pure and total. A (phase, event) pair it does not list
returns the same state object unchanged. This is the complete transition table,
transcribed from `reducer.ts`:

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
| `committing` | `COMMIT_PROGRESS` | `committing` |
| `committing` | `COMMIT_SUCCEEDED` | `restarting-services` |
| `committing` | `COMMIT_FAILED` | `quarantined` |
| `committing` | `COMMIT_RESUME_UNRESOLVED` | `failed` |
| `restarting-services` | `SERVICES_RESTARTED` | `settled` |
| `settled` | `SETTLE_ACKNOWLEDGED` | `idle` |
| `os-available` | `OS_STAGING_STARTED` | `os-staging` (consumes the cellular override) |
| `os-available` | `OS_CHECK_STARTED` | `checking` |
| `os-available` | `CELLULAR_OVERRIDE_GRANTED` | `os-available` (records the id) |
| `os-staging` | `OS_STAGING_PROGRESS` | `os-staging` |
| `os-staging` | `OS_STAGED` | `os-staged` |
| `os-staging` | `OS_STAGING_FAILED` | `failed` |
| `os-staging` | `OS_STAGING_ABORTED_FOR_STREAM` | `os-available` |
| `os-staged` | `OS_ACTIVATION_ARMED` | `os-activation-armed` |
| `os-activation-armed` | `OS_REBOOT_OBSERVED` | `os-verifying` |
| `os-verifying` | `OS_VERIFIED` | `sync-eligible` |
| `os-verifying` | `OS_ROLLBACK_DETECTED` | `quarantined` |
| `sync-eligible` | `SYNC_STARTED` | `syncing` |
| `sync-eligible` | `SYNC_SKIPPED` | `idle` |
| `syncing` | `SYNC_SUCCEEDED` | `synced` |
| `syncing` | `SYNC_FAILED` | `failed` |
| `synced` | `SYNC_SETTLED` | `idle` |
| `quarantined` | `RESET` | `idle` |
| `failed` | `RESET` | `idle` |
| `failed` with exact `commit_unit_absent_on_resume` | root-only `HISTORICAL_COMMIT_ADJUDICATED` after durable receipt and plan archive | `idle` |

Three distinctions in that table carry weight:

- `COMMIT_FAILED` goes to `quarantined` because dpkg ran and failed, so there is
  a confirmed-bad candidate to pin. `COMMIT_RESUME_UNRESOLVED` goes to `failed`
  because a restarted backend could not establish what dpkg did, and nothing is
  pinned on a guess.
- `DOWNLOAD_ABORTED_FOR_STREAM` and `OS_STAGING_ABORTED_FOR_STREAM` are not
  failures. A stream started, the transfer was cancelled with nothing installed,
  and the candidate is offered again.
- A sync failure is `failed`, never `quarantined`. It means the mirror failed,
  not that the running slot is bad.

**No production caller dispatches `RESET`.** The reducer accepts it, but no
RPC, tick branch or resume path sends it. Once the phase reaches `quarantined`
or `failed` the tick does nothing, `system.checkUpdatesNow` answers `busy`,
`system.installUpdatesNow` answers `not_available`, and the phase survives a
backend restart because `agent.json` persists it. Other sticky failures have no
product clearance path. The one narrow exception is the root-only, inactive/
effectively-masked-service cross-slot unresolved commit adjudication; it never
dispatches `RESET` and requires byte-bound evidence, a durable receipt and plan
retirement before its own transition. See [`UPDATE-RECOVERY.md`](UPDATE-RECOVERY.md).
Streaming is not affected (D8 allows every start in both phases).

The additive wire field is `status.update_orchestrator`
(`updateOrchestratorWireStateSchema`): `{schema: 1, phase, progress,
failure_reason, cellular_override_id}`. `getOrchestratorWireState()` builds it,
and every real transition pushes it through `broadcastMsg("status", ...)`. The
older `update_state` union keeps its original meaning.

### Persistence and resume

Every transition that changes state is written atomically to
`/data/ceralive/update-state/agent.json`. On boot, `resumeOrchestratorState()`
treats `committing` as the one safety-critical case: dpkg must never run twice.
It never spawns apt. It calls the existing read-only
`recoverSoftwareUpdateIfRunning()` and reads `getUpdateState()`, then maps the
answer: still running keeps `committing` with progress, `success` dispatches
`COMMIT_SUCCEEDED`, `failed` dispatches `COMMIT_FAILED`, and an absent or
inconclusive unit dispatches `COMMIT_RESUME_UNRESOLVED`. Every other phase
resumes unchanged; the next tick re-observes it. A resumed commit that lands in
`quarantined` also records the pending package failure.

**Successful capable-image commits have a persist-before-exit boundary.**
`software-updates.ts`'s `finish()` settles the detached unit's exit and post-clean
before its legacy deliberate exit. The orchestrator's normal 3 s tick cannot
be expected to run between that settle and the exit: it previously left
`agent.json` at `committing` while the observer removed the already-finished
unit. On restart, `resumeCommitting()` correctly refused to guess success from
an absent unit and persisted `failed / commit_unit_absent_on_resume`. For a
transaction launched by the orchestrator on a capable image, the completion
callback now dispatches `COMMIT_SUCCEEDED` (entering `committing` first if a
fast unit outran the tick) and synchronously persists `restarting-services`
**before** the exit. The pending package plan remains intact. Resume passes
through `restarting-services` without needing the absent unit, and the idle-gated
stale-service reconciliation clears the plan only after it finishes; a stale
`ceralive.service` can restart itself there when no transaction is running.
This does not force a reboot. Legacy images and direct legacy RPC launches retain
their previous restart/reboot behaviour. A genuinely interrupted commit with no
retained unit or outcome still fails closed with `commit_unit_absent_on_resume`;
there is no dpkg-state inference or automatic RESET.

We rejected waiting solely for the next tick: the exit wins deterministically.
Suppressing the exit on capable images would leave a newly installed CeraUI binary
running stale until the 30-minute idle gate, with a version-skew window.
Inferring success on resume from dpkg or the pending plan would turn an uncertain
mid-commit crash into an unproved success. Only the observed zero exit after a
complete output drain and service cleanup may author the transition.

The observer checks the retained systemd unit's identity on every poll before
trusting its terminal exit status. On the Rock 5B+, `systemctl show` omits unset
`ExecStartPre` and `ExecStartPost` even when requested; omitted and explicitly
empty both mean no hook, while any populated hook still rejects a foreign unit.
The earlier empty-only check never saw `active/exited` after a real transaction:
it retried every 250 ms and held `committing` at 100% until a backend restart.
The correction is in the identity reader, not in the detached apt launcher.

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

A scheduled check starts only from `idle`, only when due, and only when the D7
toggle (`packagesAuto` or `systemAuto`) is on. In `available` the tick moves to
`awaiting-idle` only when `packagesAuto` is on. In `awaiting-idle` the combined
download and commit unit starts only when no stream is live and the device is
idle.

Idle comes from `getIdleStatus()`: 30 minutes since the latest of stream end,
preview end, start-lease end, last routed remote command and last UI heartbeat,
inside the configured schedule window. An active preview blocks idle. Remote
presence is a five-minute command-recency heuristic
(`hasActiveRemoteSession()`), not hub connectivity, so a connected but quiet
remote operator can be missed.

### Operator actions

| RPC | Runtime function | Behaviour |
|---|---|---|
| `system.checkUpdatesNow` | `checkUpdatesNow()` | Bypasses the due time and D7. Allowed from `idle`, `available` and `os-available`, otherwise `busy`. Runs a package check, then an OS check on a capable image. |
| `system.installUpdatesNow` | `installUpdatesNow()` | From `available` **or `awaiting-idle`**, starts the pending package unit immediately without waiting for the 30-minute idle gate; OS `os-available` staging also bypasses idle. Never bypasses stream admission: `stream_active` refuses even a pending package intent without starting a unit. An already-starting or running package unit remains `busy`; `committing`/`restarting-services` cannot start another. `booted_version_unknown` and `not_available` retain their distinct refusals. |
| `system.allowCellularOnce` | `allowCellularOnce()` | Records a one-time cellular approval for the named OS candidate. |
| `system.getUpdateDetails` | `readUpdateDetails()` | Pure read for the dialog: slots, booted/staged/candidate OS version, check clocks, pending cellular approval, last transport selection. Every block is independently nullable. |

**Two launch paths exist, and only one goes through the orchestrator.** The
dialog's System section calls `system.checkUpdatesNow` and
`system.installUpdatesNow`. Its Packages section, preserved unchanged from before
the orchestrator, still calls the older `system.checkForUpdates` and
`system.startUpdate`, which run `triggerManualUpdateCheck()` and
`startSoftwareUpdate()` directly. A transaction started that way never moves the
orchestrator's phase, so the D8 table below does not see it. A stream start
during it is still refused, by the pre-existing `isUpdating()` guard in
`streamloop/session.ts`, but as the retriable `engine_restarting` class with code
`stream_start_suppressed_update`, not as `update_in_progress`.

## D8: stream admission

A stream start and an update are mutually admitted through one table in
`admission.ts`. `assertExhaustivePhaseClassification()` runs at module load and
throws if a phase is placed in more than one bucket.

| Phase | Start allowed? | Action on the update |
|---|---|---|
| `committing`, `restarting-services` | **refused** (`update_in_progress`) | none |
| `downloading` | allowed | abort over network: stop the detached apt unit |
| `os-staging` | allowed | abort over network: kill and restart `rauc.service` |
| `syncing` | allowed | continue locally |
| every other phase | allowed | none |

The refusal carries the orchestrator's phase and progress. In practice
`etaSeconds` is always `0`: neither the package nor the OS progress path
computes an ETA.

The live wiring is `admitAndPrepareStreamStart()` in `runtime.ts`, called from
`stream-session-orchestrator.ts` as the last admission gate, after
duplicate-start, the modem-transition lease, the recovery barrier and the
blocking-mutation check. It is last because it is the only gate with a side
effect. Before stopping a `downloading` unit it takes a forced-fresh read of
`getPackageInstallWireState()`. If dpkg has already started, it dispatches
`COMMIT_PHASE_ENTERED` and refuses instead of killing anything. The small
remaining window is covered by the image's boot-time
`ceralive-dpkg-recover.service`. An admitted start sets `/run/ceralive/streaming`,
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
image. It never launches the legacy installer just to discover it has nothing
actionable. A direct legacy `system.startUpdate` with no actionable names still
reports its existing refusal. This fix prevents a *new* sticky failure; an
existing `failed` `agent.json` is not reclassified on restart or the next tick.
The root-only `ceralive-update-recover` tool admits only the exact
`commit_unit_absent_on_resume` reason, not a no-actionable-packages failure;
clearing another reason requires a separately reviewed recovery procedure.

Because download and commit share one unit, `awaiting-idle` gates the start of
the whole unit. The orchestrator then infers `downloading` versus `committing`
from the unit's progress counters (unpacking or setting-up counts above zero
mean dpkg is running). Progress percent is the sum of the download, unpack and
setup counters over three times the package total.

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
- `validateSignedOsManifest()` verifies the CMS signature against
  `/etc/rauc/ceralive-keyring.pem`, requires the exact manifest signer CN with
  the codeSigning EKU and without emailProtection, then checks the strict v1
  fields: board, compatible string, per-channel serial, expiry, CalVer
  anti-downgrade, quarantine and `min_ceraui_version`. A signed Orange pointer
  must say `board: orange-pi-5-plus`, `compatible: ceralive-orangepi5-plus`;
  the presently published serial-4 drill pointer says the latter as
  `ceralive-orange-pi-5-plus` and still fails closed. Publisher repair and a
  refreshed signed pointer are separate prerequisites; the old binary on the
  2026.10.6 candidate also needs replacement after boot before another OS check.
- The booted version is read only from `/etc/ceralive/os-release-version`
  (`readBootedOsReleaseVersion()`). Absent or malformed means
  `booted_version_unknown`, never a fallback to the build timestamp or commit.
  That stamp exists only on a release-cut image, so every board running today
  refuses OS staging.
- `stageOsBundle()` runs `rauc install` under the same pin until RAUC finishes,
  writes `os-staged.json`, then the per-channel `manifest-serial.<channel>` file.
- Activation is armed through `ceralive-rauc-arm@arm.service` (next idle
  shutdown). After seven days pending with no live stream, `@now` is used.
- After a reboot (the receipt's boot id no longer matches), the booted CalVer is
  compared to the staged version: equal dispatches `OS_VERIFIED`, different
  records the rollback in quarantine and dispatches `OS_ROLLBACK_DETECTED`.
- If the backend restarts during staging and RAUC reports idle with no receipt,
  the tick fails closed with `os_stage_outcome_unknown_after_restart`.
- A root-owned `/data/ceralive/update-state/os-channel-override` containing
  exactly `drill` switches the OS channel for bench work. APT always follows
  Settings.

## Transport selection and pinning

`selectUpdateTransport()` (`update-transport/executor.ts`) probes every uplink
and address family for an `apt` or `os` profile and ranks them in `core.ts`
(`rankTransports`): all required hosts must pass, non-metered before metered,
then Ethernet, Wi-Fi, dongle, cellular, then latency. The selection is recorded
by `recordTransportSelection()` for the dialog's Connection section and is never
read back as a routing input.

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

`updatePinController.run(job, selection, step)` (`pin.ts`, `pin-rules.ts`) runs
one awaited step under a private policy rule for the job's UID:

- priority 120 (`UPDATE_TRANSPORT_RULE_PRIORITY`), table 100000 for `apt` and
  100001 for `os` (`UPDATE_TRANSPORT_TABLE_BASE`), disjoint from uplink
  steering's 30000 to 95535;
- the chosen family looks up the private table, the other family gets a
  `prohibit` rule, and an `unreachable` floor stops fallthrough to the main
  table if the selected route disappears;
- rules and tables are removed in `finally` on every exit;
- a transfer error holds that exact interface and family for 15 minutes
  (`UPDATE_TRANSPORT_HOLD_MS`), with at most three candidates per step;
- `sweepUpdateRules()` runs once at boot through `updatePinController.sweep()`;
  until it succeeds every pinned step is refused (`sweep-required`).

**Only the OS agent uses this today.** The `apt` job and table exist and are
tested, but no package transaction calls the controller.

**DNS is not pinned.** The selector checks each uplink's own resolvers with
`resolvectl -i`, but the `uidrange` rule governs the job's sockets, not
systemd-resolved's separate process. If a device uses a direct upstream resolver
that is reachable only over the prohibited family (instead of the local
`127.0.0.53` stub), the job's own DNS lookups fail. That is classified
`dns-failed` and fails over to the next pair. It is an expected scope limit, not
a reason to drop the prohibit rule or to pin global DNS configuration. The same
wording, with the netns evidence, is in
[HOST-UPLINK-ELECTION.md](./HOST-UPLINK-ELECTION.md).

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
`OS_STAGING_STARTED` clears the override. One approval buys one attempt.

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
| `already-synced` | the sync receipt already records this dpkg SHA |
| `os-install-pending` | phase is `os-staging`, `os-staged`, `os-activation-armed` or `os-verifying` |
| `already-syncing` | phase is `syncing` |
| `update-busy` | phase is `awaiting-idle`, `downloading`, `committing` or `restarting-services` |

`readSlotSyncEvidence()` reads the image-owned
`/data/ceralive/update-state/healthy-state.json` and `sync-receipt.json`, and
hashes the dpkg status file with `node:crypto`, byte for byte as the image's
`sha256sum` does. The build id is the first `BUILD_ID=` of `/etc/os-release`,
falling back to `/etc/ceralive/image-build-commit`.

At boot and on every idle tick, a passing gate dispatches
`SYNC_ELIGIBILITY_CONFIRMED`. `OS_VERIFIED` reaches `sync-eligible` directly.
The gate is rechecked before `startSlotSync()` starts
`ceralive-slot-sync.service`. A package commit becomes mirrorable only after it
survives a reboot and the image healthcheck, because only then does a matching
boot-health record exist. The unit itself re-validates `dpkg --audit`, the
partlabel guard, RAUC idle and hawkBit under its own nonblocking locks and
reports a refusal as exit 75 (`SLOT_SYNC_REFUSE_EXIT_CODE`).

Success is confirmed only once the receipt carries the current dpkg SHA. Then
four independent best-effort cleanups run (apt archive clean, RAUC download
leftovers, superseded quarantine pins, both-slot status refresh), followed by the
`slots-current` notification. A failed cleanup is logged and cannot reverse the
result. The both-slot reading reaches the UI only through
`system.getUpdateDetails`; `device-stats.raucSlot` is unchanged.

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

In `restarting-services`, `reconcileStaleUnits()` finds processes still mapping
deleted files under `/usr/` or `/lib/`, maps each to its systemd service through
its cgroup, and restarts eligible units only when idle. `mayRestartUnit()` never
restarts `systemd*`, `dbus`, `NetworkManager*`, `ModemManager*`,
`wpa_supplicant*`, `rauc*`, `pipewire*` or `wireplumber*`; those raise a
`restart-recommended` notification instead. `ceralive.service` is deferred only
while the update unit is still downloading or installing.

## Notifications

`notifyUpdate()` sends a persistent, dismissible notification named
`update:<kind>:<id>` with an action that opens the Updates dialog. An existing
name is not re-sent. Keys are translated in all ten catalogs.

| Kind | Produced by |
|---|---|
| `updates-available` | a package check that found candidates; an OS check that found a manifest |
| `refused` | a failed package check, a failed commit, a failed OS check, a failed OS stage |
| `installed` | leaving `restarting-services` |
| `restart-recommended` | a protected unit with stale mappings |
| `cellular-approval` | an OS install held by D12 |
| `os-staged` | a successful OS stage |
| `os-activated` | a forced `@now` activation, and a verified boot |
| `os-rollback` | a booted version that differs from the staged one |
| `slots-current` | a confirmed slot mirror |
| `download-paused` | **no producer** |
| `credentials-expiring` | **no producer** |
| `transport-unhealthy` | **no producer** |

The last three are defined in the vocabulary and translated, and nothing sends
them.

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
  opened (`createUpdateSurface()`). Every write is pessimistic: a control moves
  only to the `setUpdateSettings` echo. `validateSchedule()` refuses a window
  whose times disagree with the explicit past-midnight checkbox.
- **Global badge** (`UpdateOrchestratorBadge.svelte`): shown while
  `isUpdateBusy()` holds, with phase and percent, and opens the dialog.
- **Go Live band** (`UpdateRefusalBand.svelte`): `goLiveUpdateRefusal()` prefers
  the live `update_orchestrator` push and falls back to a typed
  `update_in_progress` start failure. The band never disables Start; admission
  stays on the device.

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
  states remain sticky. The sole narrow exception is root-only
  `commit_unit_absent_on_resume` adjudication through the local recovery CLI
  described above; it preserves a durable receipt and requires a fresh discovery.
  That CLI exists in source packaging but has not shipped in a released `.deb` or
  image, and its root/systemd/APT board proof remains outstanding. Never delete
  `agent.json` to clear a failure.
