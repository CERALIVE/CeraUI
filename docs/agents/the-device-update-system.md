<!-- Relocated from AGENTS.md when merging main into update-system-overhaul -->

## THE DEVICE UPDATE SYSTEM [EXISTS; capable-image paths PARTIAL]

The update orchestrator, `apps/backend/src/modules/system/update-orchestrator/`,
tracks package discovery/install, OS staging/activation and slot mirroring for
its own path, alongside legacy package-update RPCs and a periodic loop; D8
supplies stream-start admission against its tracked phase. The implementation reference is
[`docs/DEVICE-UPDATES.md`](../DEVICE-UPDATES.md); the backend's load-bearing
rules are in [`apps/backend/AGENTS.md`](../../apps/backend/AGENTS.md) → THE UPDATE
ORCHESTRATOR. The feature notes, stated at the level a CeraUI change needs:

- **[EXISTS] Orchestrator.** `reduceOrchestrator` and `runtime.ts`; state and
  persistence reference: [`docs/DEVICE-UPDATES.md`](../DEVICE-UPDATES.md).
- **[EXISTS] D8 admission.** Detailed table:
  [`docs/DEVICE-UPDATES.md`](../DEVICE-UPDATES.md#d8-stream-admission).
  See "D8 stream/update admission: what it does NOT cover" under Known gaps below.
- **[EXISTS] Schedule and idle.** 6 h package / 12 h OS checks with jitter and a
  24 h-capped backoff, gated by `packagesAuto` / `systemAuto`. Scheduled installs
  wait for idle (`getIdleStatus()`: 30 minutes without stream, preview, start
  lease, remote command or UI heartbeat, inside the configured window). Remote
  presence is a five-minute command-recency heuristic, not true presence.
- **[EXISTS] Settings, capabilities and RPCs.** `system.getUpdateSettings`,
  `setUpdateSettings`, `getUpdateCapabilities`, `checkUpdatesNow`,
  `installUpdatesNow`, `allowCellularOnce`, `getUpdateDetails`. Launch limits:
  D8 Known gaps (f) below.
- **[EXISTS] Updates dialog and global surfaces.** Settings → Software Updates
  shows Packages, System image, Slots, Automation, Over cellular and Update
  connection, gated by `updateCapabilityView()`; a legacy image states the limit
  instead of hiding it. `UpdateOrchestratorBadge` shows a busy update app-wide;
  `live/UpdateRefusalBand` warns before Go Live (live push first, typed refusal
  as fallback).
- **[EXISTS] Recovery.** Quarantine of exact failed candidates
  (`quarantine.json`), idle-only restart of stale services with a protected-unit
  list, and keyed update notifications. Contract:
  [`docs/UPDATE-RECOVERY.md`](../UPDATE-RECOVERY.md).
- **[PARTIAL] APT all-package scope.** Origin-filtered, exact `name=version`
  installs under one flock. Active only on an image declaring `apt-all-packages`;
  every shipping image is legacy (`features: []`) and keeps the exact-name
  15-package roster. The repaired package-policy join and flock-wrapped systemd
  identity were exercised on bench-enabled Rock 5B+ and Orange Pi 5+ boards;
  packages installed, but both installs ended in sticky
  `failed / commit_unit_absent_on_resume`. The legacy completion exit ran before
  the orchestrator persisted `COMMIT_SUCCEEDED`. On this branch a capable,
  orchestrator-owned completion now persists `restarting-services` before exit;
  the fixed build has **not** been re-proven on a board. See
  [`docs/DEVICE-UPDATES.md`](../DEVICE-UPDATES.md) for the ordering and the
  unchanged fail-closed resume rule.
- **[PARTIAL] Signed OS agent.** CMS-verified channel manifests, RAUC staging,
  authenticated discovery distinct from strict installation admission: an
  unexpired current pointer (at any serial watermark), or a non-quarantined
  consumed pointer positively older than booted at exactly the stored serial,
  succeeds with no candidate and normal check cadence. Discovery never advances
  the serial watermark; newer replayed targets still refuse. Trusted-current
  discovery clears only obsolete equality/replay OS-check refusal notices.
  Staging revalidates through strict admission. These discovery regressions are
  hermetically tested, not hardware-qualified. The agent also handles
  deferred activation, post-boot verification by that boot's healthcheck
  verdict (a new slot failing before `mark-good` stays `os-verifying` until the
  bootloader falls back, which is then quarantined as a rollback; a slot marked
  good whose healthy record cannot be written waits in `os-verifying`
  indefinitely, blocking checks, installs and the mirror but not streams). Needs `apt-all-packages` +
  `rauc-verity-streaming` and the release-only `/etc/ceralive/os-release-version`
  stamp. The leaf's RFC2253 issuer is pinned to the production RAUC intermediate
  (`CN=CeraLive RAUC Intermediate CA,O=CeraLive`) or the persistent bench RAUC
  intermediate (`CN=CeraLive RAUC Bench Intermediate CA,O=CeraLive`); root-direct
  and other intermediate signatures are refused after CMS verification.
  Channel lookup maps only exact physical RAUC compatibles:
  `ceralive-rock-5b-plus` → `rock-5b-plus`, `ceralive-orangepi5-plus` →
  `orange-pi-5-plus`. The signed pointer still has to state that product board
  and the unmodified physical compatible exactly; the bundle is installed only
  after RAUC validates its own compatible. The Orange Pi drill pointer still
  needs the separate image-publisher repair and a newly installed CeraUI binary
  before OS staging can resume; this source fix is not board validation.
- **[PARTIAL] Lagged slot mirror.** `slotSyncGate()` with eight typed refusals,
  then the image's `ceralive-slot-sync.service`. Needs `slot-sync`.
- **[PARTIAL] Update transport.** `selectUpdateTransport()` plus
  `updatePinController` (UID-scoped route, 15-minute failover hold). Used only by
  the OS agent; package transactions still use the apt reachability preflight.
  DNS is not pinned. A verified-TLS 404/410 on the expected OS channel signature
  proves the uplink while the pinned manifest fetch reports no publication; it
  cannot become a captive-portal or `no-transport` verdict. The corrected build
  is not yet board-proven. See [`docs/DEVICE-UPDATES.md`](../DEVICE-UPDATES.md).

OS staging now detects pinned-path loss independently of RAUC progress and
refreshes transport selection only after positive writer recovery and pin
teardown, within one three-pair budget. A PID-1 guardian retains the shared
flock through CLI failure, recovery and backend death. Receipt/serial writes
and `OS_STAGED` publication share a synchronous attempt fence under that lock;
startup reconciliation keeps uncertain ownership closed without delaying the
control server. These are hermetic implementation claims, not a device drill.
Publication retains the active attempt until producer release settles; a matching
unsafe release failure remains terminal even after `OS_STAGED`, with the receipt
retained and activation refused. Invalid present recovery metadata preserves the
original file and a terminal startup outcome, never first-boot idle. Manual unsafe
confirmation requires a settled attempt, matching failure reason, one of the two
typed unsafe OS outcomes and positive proof; rejection retains the unresolved notice.
RAUC's bootloader-selected `boot_primary` is retained separately from slot state:
unknown, ambiguous, target-selected or changed activation identity refuses admission,
recovery and final settlement. An inactive slot alone is not a writable target.
Admission rechecks the live producer after reading job files; queued startup
reconciliation cannot adopt that exact attempt while its producer is running.
Preparation-only and acknowledged-release orphans settle only under a separate
short-lived reconciliation flock with fresh writer/resource/activation proof.
Live guardians keep ownership; unknown or foreign state keeps admission closed.
Absent orphan units are recognized by the exact parsed `LoadState=not-found`
property, not by whole-output equality. A previously owned NBD device retains
its tracked identity while configured, even if its creator PID is reused.
Shared admission observation refuses after 10 seconds; that deadline neither
releases a writer nor proves retirement. Late observations cannot change the
expired caller's verdict or clear a replacement probe.
See [bounded failover](../DEVICE-UPDATES.md#bounded-os-staging-failover-partial--hermetic-proof-hardware-drill-owed)
and [lock recovery](../UPDATE-RECOVERY.md#os-staging-lock-and-startup-reconciliation).

A private durable unlaunched-settlement witness now has a state-side consumer.
Future attempts retain optional persistence-only `osStageRecovery.attemptId`;
startup, ticks and manual admission require its exact candidate/attempt plus a
current-boot witness and fresh readiness. Interrupted attempts count once;
already-counted unsafe records keep their count and become operator-only.
Legacy D8 records without that identity remain unsafe. Guard/state integration
is implemented and fixture-tested; board qualification is owed. Settlement and
new-attempt admission share the control lease, compare authoritative recovery
identity and retain admission closure until settlement is durably persisted.
Runtime control-lease acquisition is unconditional: device detection and
development/mock environment settings cannot select a held no-op. Hermetic
tests inject `acquireTestOsStageControl` through the existing dependency port.
Startup is single-flight and hydrates missing recovery notices without replay
remove/show churn; see
[witness settlement](../UPDATE-RECOVERY.md#unlaunched-settlement-witness-partial).

Known gaps, recorded rather than smoothed over:

- **Nothing dispatches `RESET`.** A root-only packaged maintenance tool can
  adjudicate only `failed`/`commit_unit_absent_on_resume` on the current slot,
  after an inactive/effectively masked backend and durable plan-bearing receipt.
  A failed OS stage is not sticky by default: typed `automatic`/`operator`
  failures return to `os-available` under a bounded retry budget, and an
  `unsafe` one (or an older build's exact `rauc_install_failed`) leaves
  `failed` only on positive OS evidence that the RAUC recovery adapter must
  supply through the guarded job's positive quiescence proof. Every other sticky failure still has no product clearance path. The
  tool's root/systemd/APT end-to-end board proof is owed; see
  `docs/UPDATE-RECOVERY.md`.
- **D8 stream/update admission: what it does NOT cover.** This is the one
  canonical statement of D8's limits; the other D8 descriptions point here. D8's
  guarantee (`admitAndPrepareStreamStart`,
  `update-orchestrator/runtime.ts` l.486-522) covers a package unit the
  orchestrator launched itself, whose systemd unit already exists, without the
  deferral in (b), and is tracking in `downloading`. Before the package-unit
  stop it does a forced-fresh wire read and the commit-stage probe; on a wire
  `installing`/`success` or a positive probe it refuses with
  `update_in_progress` and stops nothing (the probe fails closed, e.g. on an
  unreadable process list for a running unit, or a throw). The remaining
  exposure of that unit is the check-then-stop gap (capable image,
  two-stage unit) or the gap before the dpkg spawn (non-capable image,
  single-stage unit). The cases below are outside that guarantee; they are
  launch/admission integration gaps, not fixed by the probe.
  (a) The Packages section still calls `system.startUpdate` /
  `system.checkForUpdates`, which dispatch nothing to the orchestrator. The
  stop is issued only from the orchestrator's `downloading` phase
  (`runtime.ts` l.495-511), so in any other phase D8 does not stop such a
  unit, and admission does not consult it. `isUpdating()`
  (`streamloop/session.ts` l.80, retriable `engine_restarting` /
  `stream_start_suppressed_update`) refuses a start only once the launch has
  set `softUpdateStatus` (`software-updates.ts` l.1201). (b) Launch
  deferral: while `apt-get update` or discovery runs, `startSoftwareUpdate()`
  arms a 3 s timer and returns `{started:true}` without setting
  `softUpdateStatus` (`software-updates.ts` l.1275-1296), so the RPC answers
  `success:true`, `isUpdating()` is false and no unit exists for D8 to find;
  neither refuses a start on the pending launch's account. The orchestrator's
  own launch uses the same function and dispatches `INSTALL_UNIT_STARTED` on
  that answer (`runtime.ts` l.648-653); a start admitted then issues the stop
  for a unit that does not exist yet and moves the phase to `available`
  (`reducer.ts` l.250-251). D8's abort does not cancel the timer (its only
  `clearTimeout` is the test reset, `software-updates.ts` l.261). When it
  fires, the re-entered `startSoftwareUpdate()`'s one stream check is
  `getIsStreaming()` (l.1263, and `doSoftwareUpdate()` again at l.1505 before
  awaited preparation), which is true only once a stream is live, so the
  timer can launch an install while a stream is still starting, and the
  orchestrator does not track that install (except through the adoption in
  (d)). (c) If a stream is live or updates are disabled when
  `doSoftwareUpdate()` runs, its silent early return at `software-updates.ts`
  l.1505 leaves `softUpdateStatus` set, so `isUpdating()` stays true and
  later stream starts are refused by `session.ts` l.80 until the backend
  restarts. (d) Adoption race: `startSoftwareUpdate()` has no
  orchestrator-phase guard, and the orchestrator learns that its own install
  ended without success only at its next tick (only a successful
  capable-image commit has a callback, `onCommitSucceeded`). That tick can be
  up to `IDLE_TICK_MS` (60 s, `runtime.ts` l.257) after a
  `system.installUpdatesNow` launch, because `installUpdatesNow()` does not
  reschedule it. A legacy
  launch landing in that window is adopted as the orchestrator's
  `downloading` unit (`pollPackageInstallProgress`, `runtime.ts` l.660-711),
  and a stream start can then stop it, guarded only by the forced-fresh read
  and the probe, with the same exposure as above. The same race in
  `committing` (the orchestrator's own install failed before its next tick
  saw it): the legacy launch clears `lastUpdateFailure`
  (`software-updates.ts` l.1270), so the tick keeps `committing` while the
  wire reads `downloading` (or `checking`/`available` while the legacy launch
  is still deferred; `runtime.ts` l.661-671), starts stay refused as
  `update_in_progress`, and the tick then treats the legacy unit's outcome as
  its own commit: `COMMIT_SUCCEEDED`, or `COMMIT_FAILED`, which records its
  own pending plan as quarantined with the legacy reason (`runtime.ts`
  l.684-708). (e) The stage count follows
  the image, not the RPC: `doSoftwareUpdate()` runs `capable ?
  runDetachedAptAll : runDetachedAptUpgrade` (`software-updates.ts` l.1508,
  l.1620-1631) for every caller. (f) Launch into a starting stream: the explicit
  stream checks in `installUpdatesNow()`, `maybeStartPackageInstall()` and
  `startSoftwareUpdate()` are live-only (`runtime.ts` l.423, l.628;
  `software-updates.ts` l.1263). Scheduled launches also await `isIdle`, which
  treats a held start lease as activity (`runtime.ts` l.629-632;
  `idle-activity.ts` l.33-36). Their remaining window is after that idle reading
  and before launch; `installUpdatesNow` bypasses the idle await. The live flag
  stays false
  until the stream is live (`streaming.ts` l.88-102;
  `stream-session-orchestrator.ts` l.558), whereas D8 runs only at
  start admission. An install launched after admission but before live is not
  stopped by D8; if the stream is live when `doSoftwareUpdate()` runs, (c)
  applies. (g) Pre-unit window: even a non-deferred orchestrator launch enters
  `downloading` before its `apt-get update` callback and preparation finish;
  the unit is created only later by `runDetachedApt*` (`software-updates.ts`
  l.1151-1153, l.1504-1633). A start can then probe an absent unit and issue
  a stop that does not cancel the callback. The phase moves to `available`,
  while the callback may create an untracked unit. (h) Admitted does not imply
  launched: after D8 stops a unit, `streamloop/session.ts` can still refuse
  `stream_start_suppressed_update` while `isUpdating()` stays true until the
  unit's monitor settles (including `apt-get clean`). This timing is inferred
  from the code, not separately tested. A failed stop or (g) can exhaust the
  bounded start retries. The same ordering reaches OS staging: `admittedStart()`
  runs D8 before `request.launch` (`stream-session-orchestrator.ts` l.465-491),
  and launch-time `params`/`spawn-sender` validation errors only then classify
  as `start_invalid` (`start-failure-taxonomy.ts` l.261-267), so in `os-staging`
  D8 REQUESTS the SIGTERM and restart of `rauc.service`
  (`killAndRestartRaucForStream`, `update-orchestrator/stream-abort.ts` l.42-61,
  which propagates submission errors; called from `admitAndPrepareStreamStart` in
  `update-orchestrator/runtime.ts`) before launch validation runs, and an active
  OS stage CAN therefore be interrupted by a start that can never stream (for
  example no SRTLA address) and then fails `start_invalid`. Suggested fix direction, NOT implemented: cancel
  pending launches when D8 aborts, fence the pre-unit callback/preparation,
  gate launches on a starting stream rather than only a live one, clear
  `softUpdateStatus` on the (c) early return, and reconcile D8 with the later
  `isUpdating()` guard.
- **A manual OS install outlives the RPC that started it (separate from the D8
  list above).** For an OS candidate, `installUpdatesNow()`
  (`update-orchestrator/runtime.ts` l.413-426) awaits `maybeStartOsStage(true)`,
  which awaits the whole `rauc install` through `deps.stageOs` /
  `stageOsBundle()` (`runtime.ts` l.963-967, `os-agent.ts` l.359) before
  `system.installUpdatesNow` (`rpc/procedures/system.procedure.ts` l.260-270)
  answers. The frontend has no per-procedure override for it
  (`PROCEDURE_TIMEOUT_MS`, `apps/frontend/src/lib/rpc/client.ts` l.560-562), so
  the 30 s default of `RPCClient.call` (l.463) rejects with `Request timeout`
  (l.472-475); `osCommand` turns that rejection into a failed operation and
  `undefined` (`rpc/async-operation.svelte.ts` l.593-606), and the update
  surface records the Install action as refused (`update-surface.svelte.ts` l.146), while the stage keeps running server-side
  and succeeds. On the Rock bench the uninterrupted adaptive stage of the
  1.4 GB bundle took 101 s. The awaiting semantics are pinned by `os-agent-runtime.test.ts`:
  "manual install bypasses idle, stages once and arms without immediate
  activation" (expects `os-staged` when the call returns) and "a stage failure
  never becomes staged or armed" (expects `{started:false}` for a failed stage),
  plus the two interrupted-stage tests that `await install`. Proposed remedy,
  an owner decision and NOT implemented: answer `{started:true}` as soon as
  `OS_STAGING_STARTED` is dispatched and run the stage in the background, as
  the package path already does, reporting its outcome through the phase and
  the `os-staged` / `refused` notifications.
- **Historical pre-fix receipt: a stream start during `os-staging` could be refused while RAUC could not be
  restarted (observed once, Rock bench, task-45d D1).** D8 moves the phase to
  `os-available`, then `killAndRestartRaucForStream()`
  (`update-orchestrator/stream-abort.ts` l.42-61) SIGTERMs `rauc.service` and
  awaits `systemctl restart rauc.service` under `SYSTEMD_COMMAND_TIMEOUT_MS`
  (10 s, l.21). On the Rock the kill landed while RAUC's installer thread was
  reading the bundle through `nbd0`; `rauc-nbd` died and that thread stayed in
  uninterruptible sleep until the kernel's NBD dead-connection timeout, so the
  restart outlived the 10 s limit and `spawnWithTimeout` threw
  `SpawnTimeoutError` ("Spawn timed out: systemctl restart rauc.service",
  `helpers/spawn-policy.ts` l.1048-1054). The throw leaves
  `admitAndPrepareStreamStart()` (`update-orchestrator/runtime.ts` l.534-545,
  abort fence released in its `finally`) and `admittedStart()`
  (`streaming/stream-session-orchestrator.ts` l.459-475, before any launch),
  and the RPC adapter answers it as `INTERNAL_ERROR` (`rpc/adapter.ts`
  l.168-176). The operator sees the stream start refused with an internal
  error, and RAUC (status, staging, slot reads) was unusable for 5 min 14 s
  until the NBD timeout reaped the old process; a retry once `rauc.service` is
  active again succeeds. The phase and failure reason were correct
  (`os-available`, no failure), and the target slot was left `bad`/pending with
  no leftover NBD, dm or mount state. n=1: an earlier kill at 46 % restarted
  promptly. The current source queues restart with `--no-block` and propagates
  only submission errors at D8; it no longer waits for daemon recovery there.
  New OS work requires the interrupted job to settle and positive writer
  readiness, not a queue acknowledgement or `active` alone. This fix has not
  been re-drilled on hardware; it does not change the later launch-validation
  limits described in (h).
- **G1: a restart of the healthcheck kills a running slot mirror (observed
  once, Orange Pi 5+ bench, 2026-09-30).** `ceralive-slot-sync.service` has
  `Requires=`/`After=ceralive-healthcheck.service` (image-building-pipeline
  `mkosi/runtime/ceralive-slot-sync.service` l.10-11 at `36d8131`), so a stop
  or restart of the healthcheck propagates to a RUNNING mirror. The healthcheck
  itself only `Wants=ceralive.service` (`ceralive-healthcheck.service` l.13,
  since image `808446d`); what restarts it is the hostname reconcile, whose
  identity-consumer restart names both `ceralive.service` and
  `ceralive-healthcheck.service` (`mkosi/customize/postinst.d/hostname.sh`
  l.71-77, l.378-379). On the bench an Avahi `published=ceralive-2` conflict
  made `ceralive-hostname-reconcile` restart them shortly after boot, about
  20 s into the rsync: the mirror got SIGTERM, exited 143 and left the target slot
  `bad`, then systemd re-ran the unit, which completed. The orchestrator stayed
  clean only by timing: the old backend was stopping and never read the killed
  run's `failed` record. Had the new backend polled before the re-run, the
  documented rules would have read `failed` with exit 143 (`lock.ts` l.69-70
  and l.86-90; `processExitCode`, `software-update-service-state.ts` l.59-62)
  and persisted `failed / slot-sync failed (exit 143)`
  (`failSlotSyncFromUnit`, `update-orchestrator/runtime.ts` l.950-970), which
  is sticky. A plain stop of the healthcheck mid-mirror would leave the other
  slot `bad` with no re-run. Remedies, an OWNER DECISION and NOT implemented:
  in the image, order the mirror after the healthcheck with `Wants=` or
  ordering only instead of `Requires=` (or drop the healthcheck from the
  reconcile's restart list); in CeraUI, treat exit 143 as an interrupted run
  and probe again, with a bound, before persisting a verdict.
- **No certificate-expiry countdown.** The wire carries no expiry date,
  `credentials-expiring` has no producer, and the credentials band keys on an
  `apt`-profile transport finding that no production path produces yet.
- **Board evidence is narrow.** The capable APT candidate/installation above was
  verified on a bench-enabled board, not a released capable image. OS staging,
  slot mirroring and UID-pinned transport are still not qualified by that run.

