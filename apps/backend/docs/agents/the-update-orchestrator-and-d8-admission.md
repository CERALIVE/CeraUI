<!-- Relocated from apps/backend/AGENTS.md when merging main into update-system-overhaul -->

## THE UPDATE ORCHESTRATOR AND D8 ADMISSION [EXISTS]

In production, `helpers/backend-singleton.ts` enforces a fixed lifetime kernel flock before
`main.ts` binds the control server or starts the orchestrator. Port fallback
cannot create a second state writer. Contention and uncertain acquisition are
fatal; only a proven EACCES/EROFS/ENOENT lock-directory creation failure warns
and permits startup without exclusivity.
Source-development boot skips enforcement only for exact `NODE_ENV === "development"`.
The device unit sets production; production compilation inlines the direct NODE_ENV read.
Production lock/proof primitives are unchanged; mock/device/flag overrides cannot bypass them.
The supervised observer helper exits on backend-pipe EOF; loss of the helper
terminates the backend. Both acquisition censuses refuse only another holder
with kernel status real AND effective uid equal to `process.getuid()` FIRST,
then the exact full `singletonArgv(paths)` vector, then `/proc/<pid>/exe`
matching current `/usr/bin/flock` by device/inode OR the exact kernel link target
`/usr/bin/flock (deleted)` after package replacement,
and `singletonLockIdentity(pid)` proving a PID-owned granted kernel FLOCK on a
held regular-file fd. Proc-directory ownership is not credentials, including for
non-dumpable tasks. Saved/fs UIDs are parsed but not gated (no setuid wrapper).
Failed uid/argv qualifiers are not inspected further; an unknown executable
with exact argv, same uid and a granted lock refuses as `unproven`, never absence.
Nongranted executable lookalikes are ignored only after their fd proof;
lookalikes and nongranted contenders do not refuse the winner. ENOENT/ESRCH races
are ignored; other read failures fail closed, including unreadable fd proof
after qualification. Status EACCES with unreadable (EACCES) or nonmatching argv
is non-qualifying; readable exact argv instead refuses as `unproven`. Other
non-vanished status errors and malformed credentials fail closed. These are
separate proc reads, with no pidfd/start-time fence against PID reuse/TOCTOU.
This census is independent of the current lock pathname,
so an unlinked/replaced holder still counts, including a deleted-flock wrapper.
The granted helper fd identity is
re-validated against the path every ~2 s
(`backend-singleton-monitor.ts`, injectable clock); a replaced path exits the
old backend nonzero. The 2 s cadence is not a strict termination bound; scheduling
and filesystem reads can delay it. Root tampering with `/run/lock` beyond that
detection is
out of the threat model. The OS-stage control lease remains defence in depth.
The launched OS-stage owner (`os-stage-job.ts`) re-asserts private-directory
provenance (`os-stage-launched-provenance.ts` over `os-stage-private-owner.ts`,
identity captured at acquire/adopt) before its success callback, release marker,
guardian retirement and directory removal; drift fails closed.
Host child-process proof does not qualify systemd restart or power-loss ordering
on a board; see `docs/UPDATE-RECOVERY.md`.

The real-helper second Rock fixture (`src/tests/fixtures/real-device/README.md`)
replays individual flock/bash/sleep process and fd receipts, whole lock tables,
the exact combined systemd observation and live ACK-pending into the production
guard parsers. Its kernel adapter inventories only captured unit members, not
the whole system. Pre-ready/stat-child and different-device/same-inode attempts
missed; positive live-install NBD/dm/mount and pin teardown remain unverified.
Do not replace those gaps with fabricated positive fixtures.

`modules/system/update-orchestrator/` tracks the new update path, alongside
the still-running legacy update RPCs and periodic loop. Reference:
[`docs/DEVICE-UPDATES.md`](../../../../docs/DEVICE-UPDATES.md).

Capable-image qualification limits are recorded in `docs/DEVICE-UPDATES.md`.

The runtime refuses Check, Install and synchronous cellular-grant mutations
until validated startup completes. Persisted `checking` alone is normalized to
idle with both discovery clocks due, without altering prior success/failure
counts or recovery records; all transaction/terminal phases retain their owners.
The complete restart census is `docs/UPDATE-STARTUP-PHASES.md`.
Physical reconciliation completion is retained
in `boot-guard.ts` and awaited by the single orchestrator flight without delaying
the control server or unrelated boot surfaces. The noncritical route-sweep guard
retains its completion synchronously, preserving main's fire-and-forget call.
Main launches one detached `update-bootstrap.ts` chain: startup adjudication,
standalone software-update recovery, then periodic checks. A transient burst
failure marks boot degraded but parks the latter two steps until later startup
succeeds. Terminal safety refusal or invalid metadata skips these bootstrap steps,
logs one error and flags `update-orchestrator-maintenance` on `/api/health`;
untracked unit results remain unobserved there. Stream-stop and coordinator-success
callers can still start legacy periodic discovery, and legacy Check/Install RPCs
remain callable. This is not a global admission fence; preserve evidence and repair
the unsafe/invalid baseline locally before restarting. The wider legacy-maintenance
gate is an OWNER DECISION in `docs/UPDATE-RECOVERY.md`.
Legacy boot cleanup must never be the first reader of an unadjudicated plan/unit.
Startup failures retry six times
with 250/500/1000/2000/4000 ms waits, then transient failures continue as one
startup attempt every 30 seconds on a single unreferenced timer, with readiness
closed until success. Operator calls never rearm startup. Authoritative safety
refusals without an I/O cause (except lock contention) and invalid-present metadata
never enter a clearing retry path. Pending/invalid startup answers the distinct
retryable `UPDATE_ORCHESTRATOR_INITIALIZING` RPC error; no OS-stage reason is
added. Status and stream admission remain live. There is no pause/confirmation
RPC; manual Check owns confirmation. Existing test dependency injection denotes
an initialized fixture runtime; production starts closed and has no selector.

Startup tail persistence and generic confirmation/interrupted/legacy settlement
now hold CONTROL and recheck complete authoritative recovery identity. Nested
guard proof borrows that lease; a missing/mismatched/inconclusive witness cannot
authorize a stale tail write, and committed settlement is not duplicated.
Interrupted-stage settlement, generic confirmation and legacy migration retain
their baseline and exact intended snapshot on a failed write. Initial attempt
publication lives inside the attempt cleanup scope: failure before `stageOs`
restores memory and re-persists the pre-state under CONTROL, with the same exact
replay latch if rollback storage also fails, now backed by durable private
`os-attempt-intent.json` authority before agent publication. Its strict full
manifest/baseline/staging record advances `publishing` → `launching` under CONTROL
immediately before producer creation. Startup/tick/admission restores only exact
publishing authority plus positive no-job/no-guardian/no-witness and physical
quiescence proof; it counts no failed round and raises no unsafe notice. Launching
staging records and missing intents retain existing unsafe restart policy. An
already-durable exact rollback can replay cleanup only. Invalid or mismatched
publishing authority stays preserved and closed. A valid launching intent with
an absent/superseding attempt record has no restore authority: CONTROL-protected
job/witness/guardian absence plus fresh disk/intent identity retires and logs it
without changing agent state. Same-attempt active launching remains pending.
Manual admission runs this cleanup before new publication, without a tick.
The producer token clears even when intent
retirement fails; a superseded producer cannot retire a replacement's intent.
Retirement exceptions are logged and contained by a separate single-flight
cleanup-pending latch; they cannot override the stage result or escape its tick.
Admission stays closed while cleanup retries under CONTROL, rechecking disk
identity and parent fsync even after a successful unlink. Snapshot replay remains
independently pending and cannot be cleared by intent cleanup.
Contained retirement I/O retains its cause at startup's tail, so the existing
bounded startup cadence can heal after repair. A cause-free ownership refusal
still schedules no retry; cleanup acknowledgement cannot independently reopen
startup. Combined host regression: `update-orchestrator-combined-cleanup-cadence.test.ts`.
Publishing authority itself participates in pending admission, including an
unacknowledged first intent rename and a deferred finally. Grants refuse
retryably; manual/tick work resolves or closes before mutation. D8 joins the
single publishing recovery flight before its phase decision, without acquiring
CONTROL; identical startup re-adoption is accepted by whole-snapshot equality,
never by weakened disk or physical proof. Unproven publishing without a matching
launched job keeps D8 retryably closed; genuine producers retain cancellation.
Intent ownership/format/read failures, invalid or unreadable job evidence, and
guardian-observation errors at this D8 boundary all retain the existing
`UPDATE_ORCHESTRATOR_INITIALIZING` refusal, including the adapter's retryable
flag. Failed reads never authorize absence or RAUC cancellation. A repaired
retry re-enters recovery; no error latch permanently wedges stream admission.
Host coverage: `os-attempt-intent-stream-evidence.test.ts` and
`os-attempt-intent-stream-producer.test.ts`, through real session admission and
the real loopback WebSocket adapter, with byte preservation and producer controls.
All retirement sites arm the cleanup latch, including publication rollback and
startup/tick restore/stale/settled recovery. Unlink-success/fsync-failure requires
an absent-file parent synchronization on the next pass. The complete writer
census and host-proof limits are in `docs/UPDATE-RECOVERY.md`.
A scheduling tick
replays that snapshot under CONTROL, accepting only the exact baseline or intent
on disk, never redispatching or recounting a failed round. Manual mutations
receive the retryable pending refusal until replay succeeds. Authority refusals
without an I/O cause are not startup-retried into accepting replacement state.
Admission and discovery/staging recheck pending durability after awaited probes,
so a Check admitted before the latch appeared cannot strand its replay shape.
Intent durability and the crash-point recovery table are in
`docs/UPDATE-RECOVERY.md` → Durable OS attempt intent; host proof is not board
power-loss qualification.

The private `os-stage-unlaunched-witness.ts` primitive provides strict, bounded,
uid-owned mode-0600 durable settlement evidence for the guard/state integration.
It parses the job's manifest JSON and derives the canonical recovery candidate
key; publication requires physical cleanup, not release intent. The primitive
is consumed by the fenced `os-unlaunched-adapter.ts` at startup, scheduling ticks
and manual admission. Optional persistence-only `osStageRecovery.attemptId` is
set before staging effects and survives failed-round settlement; no record boot
ID or new RPC field is added. The witness must match that ID, its derived
candidate key and the current boot. Missing legacy identity, including the real
D8 record, never qualifies. Interrupted staging counts one round; an already-
counted unsafe failure changes disposition without counting twice. Persistence
precedes matching-notice replacement and witness consumption. A surviving witness
after persistence replays cleanup only; a failed write is re-persisted before
cleanup. A persistence-pending latch closes admission even when later evidence
is inconclusive; only successful settlement persistence clears it. State-file
rename is parent-directory-fsynced before witness consumption. Settlement holds
the control lease through witness/evidence reads, authoritative disk identity
recheck, dispatch/persist and consume; drift refuses the startup tail too.
Every new stage admission takes that lease before retiring any leftover witness synchronously
before starting (the new identity can never match it, and a leftover file would
make the guard refuse the next witness write). The generic bad-target confirmation rule is unchanged.
The runner borrows that same lease and never reacquires it. Runtime acquisition
uses a real control lease regardless of device detection or environment settings;
held test leases live only in `src/tests/helpers/os-stage-test-control.ts` and
must be injected through the runtime/runner dependency ports.
Accepted transitions replace only the matching notice; cleanup replay leaves it untouched, and
single-flight startup hydrates a missing notice from persisted policy. Present
attempt IDs are validated UUIDs; legacy absence remains valid and unsafe.
Guard/state integration is implemented and fixture-tested; board qualification
is owed. See `docs/UPDATE-RECOVERY.md`.

- Keep decision inputs injectable so reducer/admission tests do not need OS mocks.
- The transition table lives in `docs/DEVICE-UPDATES.md`; legacy overlap is in
  the root D8 Known gaps.
- **`quarantined` ≠ `failed`, and both are sticky by default.** `COMMIT_FAILED`
  moves tracked `committing` to `quarantined` on a wire failure; it does not
  prove dpkg itself failed. Detached-service cleanup can fail after transaction
  exit 0, and the legacy adoption race under root [`AGENTS.md`](../../../../AGENTS.md)
  D8 Known gaps (d) can misattribute another unit's failure.
  Unresolved outcomes are not evidence of a bad version to quarantine. Recovery
  for `failed` with exact `commit_unit_absent_on_resume` is documented at
  `docs/UPDATE-RECOVERY.md`:
  `/usr/sbin/ceralive-update-recover` is a separately packaged root-only local
  executable, with no RPC/remote/sudoers entry. It requires the backend inactive
  and effectively masked. Actual root/systemd/APT board proof is still owed.
- **A failed OS stage is policy, not a sticky `failed`.** Only a typed
  `OsStageError` (`os-stage-error.ts`) is a recovery decision; the runtime's
  stage `catch` maps it, and anything untyped stays fail-closed. The persisted
  `osStageRecovery` (`@ceraui/rpc` `osStageRecoverySchema`, never a local twin)
  is keyed to one exact signed candidate, carries the attempt id persisted
  before RAUC runs, and counts a round once per settled attempt
  (`os-stage-retry.ts`). Three automatic rounds (15 min, 30 min, then
  operator-only). A staging preflight also fences the captured recovery record
  at its synchronous dispatch boundary: a concurrent manual settlement cannot
  be bypassed by an earlier automatic tick. Packages continue while the OS stage
  waits, no staging error
  writes quarantine, and an interrupted `os-staging` is observed, never
  replayed. Restart settlement captures generation and attempt identity before
  probing; a D8 abort or replacement makes the old probe a no-op. Leaving
  `failed` needs positive OS evidence
  (`osStageFailureSettledSafely`) including the RAUC adapter's
  `proveOsWriterQuiescent`, supplied by the guarded job adapter and fail-closed
  on unreadable ownership or retirement. Restart settlement needs this proof,
  not RAUC `Operation=idle` alone; its identity fence follows both awaits.
  Same-candidate discovery preserves the retry deadline, and idle scheduling
  consults it independently of the discovery clock (failed discovery retains
  its own backoff). Legacy migration persists `osStageDiscoveryRetryAt` until
  discovery binds that delay to its first exact candidate; Check now does not
  authorize an early stage, whereas an explicit Install bypasses the delay.
  Before-write offer invalidation is narrower than staging recovery: exact
  `OsAgentError` reasons `manifest_changed_before_stage`, `expired`,
  `serial_replayed`, `version_quarantined` and `downgrade_or_same` drop the
  matching attempt's offer and return to discovery. An operator-mode
  `rauc_install_failed` wrapper may preserve that marker in its direct `cause`;
  an unsafe wrapper or an arbitrary message never grants this transition.
  Unsafe confirmation is restricted to `rauc_recovery_unproven` and
  `os_stage_outcome_unknown_after_restart`. Matching package/X6 reasons never
  qualify, and their known contradictory unsafe records fail the shared schema.
  Generic untyped terminal records remain persistable, but are not clearable
  through this OS-specific confirmation.
  Confirmation also requires a settled (null active-id) attempt before probing;
  its unresolved notice is withdrawn only when the reducer accepts clearance.
  Receipt publication retains the active recovery identity until the producer
  settles. Its exact-token unsafe release failure may move `os-staged` to
  `failed`, replacing the retry notice without deleting the receipt or writing
  quarantine. Pending publication cannot arm activation; after backend loss it
  is observed and settled unsafe, never promoted to completed release.
   Receipt retirement requires exact new `installedImage` binding to the healthy
   actual booted rootfs, not stamp equality alone. Legacy receipts, including the
   HISTORICAL Rock `.64` and CURRENT prior-boot `.70`, KEEP. The supplied current
   Rock is booted `2026.10.70`, both slots good, agent idle; its unbound `.70`
   receipt from `1f6a990e` is inert and the next stage flow is unobstructed in the
   oracle host repro. The failed `.68` case is HISTORICAL, not this idle state.
   Under CONTROL, persisted recovery identity is reread
   before evidence and at the final rename boundary; drift/open lifecycle/active
   attempts KEEP. Judgment captures file device/inode/size/mtime/birthtime/hash;
   `os-receipt-retirement-store.ts` compares it again through a validated parent
   descriptor before rename. Rename is not compare-and-swap: CONTROL excludes
   cooperative production stage/arm/rebind callers, not privileged bypass.
   `commitStagedManifest` publishes via the leased stage callback;
   `rebindStagedReceipt` uses leased runtime reconciliation; retry uses leased
   stage admission. Low-level `saveStagedManifest` itself requires no lease.
   Image helper `ceralive-rauc-activate.sh --arm/--stop` uses its own activation
   flock, not CONTROL; direct or surviving helper effects can bypass it, while
   ExecStop deliberately remains CONTROL-independent (accepted residual D154).
   Parent fsync retries after rename, including absent-live crash residue; typed
   durability-pending is not “receipt kept”. Activation-marker absence is lstat
   ENOENT only and is re-probed after final authority; unknown never authorizes cleanup.
   Successful tombstone acknowledgement is cached by full identity only for this
   process; unchanged ticks avoid CONTROL/fsync, failure/change/restart retries.
   The final-lstat residual test pins consumption after privileged pathname
   replacement, not a conditional-rename guarantee. D154 also accepts forward-only
   strict schema-1 additions: older unreleased bench intermediates reject
   `receiptBaseline`; rollback requires bench-only stage job/witness clearance.
   `2026.9.5` is the first orchestrator release. Details: `docs/UPDATE-RECOVERY.md`.
  Stage-admission refusals keep `rauc_recovery_unproven`/unsafe and add the
   log-only `predicate` and bounded, message-free class/code `observation` diagnostics
  (`os-stage-admission-diagnostics.ts`); see `docs/UPDATE-RECOVERY.md`.
  Invalid present recovery metadata raises a typed load error; startup preserves
  the file and the legacy terminal reason rather than defaulting to idle. That
  runtime stays closed to OS migration and confirmation until maintenance fixes
  the file and restarts it; records without OS metadata keep existing resume.
  Progress belongs to the captured active attempt, not merely the staging
  phase. Untyped terminal settlement removes that candidate's stage-policy
  notices before raising the refusal; other candidates and `os-check:*` notices
  remain untouched.
  Contract:
  [`docs/UPDATE-RECOVERY.md`](../../../../docs/UPDATE-RECOVERY.md#os-staging-recovery-partial--fixture-proven-board-re-drill-owed).
- **Persistence and resume.** Reattach rather than replay an uncertain transaction;
  a replay could run dpkg twice. Settlement may run `apt-get clean`. A persisted
  `downloading` is dropped only when the unit probe PROVED it gone
  (`getLastInstallUnitVerdict() === "absent"`): `DOWNLOAD_RESUME_UNIT_ABSENT`
  goes to `idle` with the package check due now, so discovery, not the stale
  plan, decides what is left (an empty plan would fail the launcher). The plan
  file is NOT deleted there (a delete raced a newer install's plan), and no
  install start clears it either. The record has no reader before the next
  install start, which normally comes through discovery: a start from an
  `available` wire rewrites it before the unit exists. Discovery does not
  ensure the wire is still `available` at launch (a wire reset, or a restart
  in `awaiting-idle` before rediscovery); such a start keeps the record as it
  was (a6b8210c behaviour), so the commit-failure quarantine, the installed
  notice and the `committing` startup baseline then read the earlier plan.
  That is an inherited limitation on the owner-decision list, not a fix
  target here; clearing the record on that path lost the plan those readers
  need. Recovery's `false` also means "never
  probed" (updates disabled, mocks, already observing), so it is not absence:
  the phase stays `downloading` and that resumed download only is
  re-adjudicated each tick, fenced by `stateGeneration` (bumped on every state
  change, never `enteredAt`): an answer is applied only if nothing moved while
  the probe was awaited, with no `await` between that check and the dispatch.
  Absence itself is `LoadState=not-found` for the fixed unit name, not an
  identity check. Never extend this to `committing`.
- **The package step reuses `startSoftwareUpdate()`.** Post-acceptance limits:
  root D8 Known gaps (b), (c), (g). Classify availability by `actionable_count`,
  not the inclusive `package_count`, to avoid launching an empty install.
  **Do NOT split that unit into two to get a pause between download and commit.**
  Keep download and commit under the same unit-held flock, without a lock handoff.

  **APT candidate origin is a two-command join.** Join the full
  URL/distribution/component line, not the hostname alone, and fail closed on
  missing or conflicting metadata. Command shapes and bench limits:
  `docs/DEVICE-UPDATES.md`.
- **Successful commit ordering is a safety boundary.** Persist the observed
  successful commit before the deliberate backend exit, or resume can lose its
  evidence. Recovered `committing` and `downloading` register an explicit exit hook before unit
  attachment. Settlement remains separately awaitable; the hook waits for valid
  startup, then confirms/persists success under CONTROL, even for a unit that
  completes between ticks. Persistence/refusal cannot authorize exit: the process
  stays alive/degraded, preserving its observed success for retry or maintenance.
  Standalone recovery retains legacy exit/reboot behavior. Host terminating and
  delayed-CONTROL proofs: `tests/update-orchestrator-recovery-exit.test.ts`;
  hardware proof remains owed. See `docs/UPDATE-RECOVERY.md`.
  Successful owned completion marks `pending-success-fence.ts` BEFORE package
  wire `success`; the wire does not authorize restart. Both fresh synchronous
  callback failure (dispatch adopts before persisting) and recovered-hook failure
  retain baseline/exact intent. Every pending tick first services the existing
  snapshot replay and intent/witness owners, then retries package success once
  under CONTROL before returning, on the existing bounded cadence. Only authoritative
  success persistence/acknowledgement clears the fence; there is no maintenance
  clear API. Scheduler phase overwrites, discovery/install, OS staging/activation,
  mirror/cleanup and stale-service reconciliation are fenced at entrypoints;
  awaited scheduler probes and the per-unit restart boundary recheck it.
  Legacy Check/Install/periodic/deferred/recovery entries are also fenced while
  success is pending, not merely because startup was refused. Test reset cancels
  exit permission and clears pending authority; late CONTROL/read work grants
  no write, adoption or exit.
  Manual readiness composes validated startup AND OS durability AND package
  durability in `startup-readiness.ts`; neither startup completion nor package
  acknowledgement can independently open it. D8 refuses pending success with
  existing `update_in_progress` after awaited publishing recovery, rechecking the awaited commit probe before stop
  and the stop result before dispatch. Legacy continuations fence each shared
  APT command submission/result, the preflight command port, and channel writes
  after the source read; refusal releases refresh/discovery/install latches.
  Already-submitted commands and network preparation are not cancelled.
  Readable renamed success after a failed directory fsync is not acknowledgement:
  repeat completion must re-persist under CONTROL. Retained baseline and persisted
  non-phase identity cannot be replaced; no package UUID exists in this schema.
  Five consecutive disk mismatches or an unrelated persisted phase produce one
  reasoned maintenance escalation per completion without clearing its fence;
  repeated same-signature errors have a 60-second log floor. Combined host tests
  prove both observation orders when startup-tail snapshot failure coexists with
  package success, preserving original exit permission and exact snapshot rules.
  Valid publishing snapshots cannot attach a tracked package owner; their schema
  and real startup invariant are tested rather than simulated as a phase collision.
  See `docs/UPDATE-RECOVERY.md` for the limits. Independent combined-head review and
  board/power-loss qualification remain owed; no OS publication/intent proof is weakened.
  **OWNER DECISION:** withholding restart leaves installed new packages with the
  OLD backend running until success persists and normal restart authority returns,
  or local maintenance restarts the service. Operators see the error log and
  latched `update-orchestrator-maintenance` health flag, not a new UI refusal.
  Avoid Check AND Install; an accepted legacy Check clears `lastUpdateSucceeded`,
  so wire success is not immutable evidence. Preserve agent/plan/unit/output and
  repair storage/ownership while alive; restart only after a positive safe baseline.
  Terminal startup refusal still leaves independent legacy RPC/periodic callers
  active unless this separate pending-success fence is present. External kill,
  power loss and already-submitted effects remain outside this host proof.
- Schedule, idle inputs and operator RPC behavior: `docs/DEVICE-UPDATES.md`.
  Concurrent runtime admission callers join one in-flight probe and resume in
  registration order; settled readiness is never cached. The default still samples
  exact live ownership after its job-file await, before queuing reconciliation.
  Manual check/install ordering regressions use reversed controlled promises in
  `tests/update-orchestrator-admission-order.test.ts`.
  The shared observer refuses after 10 seconds without releasing any writer or
  counting as quiescence proof; a late completion cannot clear a replacement
  observer. `tests/update-orchestrator-h2a-interaction.test.ts` combines expiry
  with unsafe publication and the invalid-load legacy-migration latch.
- **The legacy RPCs bypass the orchestrator.** The Updates
  dialog's Packages section still calls `system.checkForUpdates` /
  `system.startUpdate`, which run `triggerManualUpdateCheck()` /
  `startSoftwareUpdate()` directly and dispatch nothing to the orchestrator.
  For launch and admission gaps see "D8 stream/update admission: what it does NOT
  cover" under Known gaps in the root [`AGENTS.md`](../../../../AGENTS.md).

### D8: STREAM/UPDATE ADMISSION [EXISTS]

The detailed table and probe semantics are in
[`docs/DEVICE-UPDATES.md`](../../../../docs/DEVICE-UPDATES.md#d8-stream-admission).
Keep D8 after earlier session gates so an update stop is not issued for an
attempt they already refused. Later launch limits: root AGENTS.md D8 Known gaps (h).

**THE STOP MUST NOT REACH DPKG: read before touching the abort-network path.**
Cached download progress can lag dpkg. Keep the fresh read and probe ahead of
the stop to reduce the risk of a half-installed package. A probe-only refusal
is not proof dpkg ran: latching `committing` would misclassify a pre-dpkg failure
as a bad candidate to quarantine. Preserve the single-unit/flock design and
exact ExecStart identity.

For launch windows see "D8 stream/update
admission: what it does NOT cover" under Known gaps in the root
[`AGENTS.md`](../../../../AGENTS.md). Coverage:
`update-orchestrator-runtime.test.ts` (the measured refusal and its no-latch
repeat, the probe-false abort, the fail-closed throw followed by a
probe-false admit, and a probe-only refusal whose later wire `failed` stays
`DOWNLOAD_FAILED`) and `update-orchestrator-commit-stage-probe.test.ts` (a real
fake cgroup/proc tree, incl. not-found, inactive, failed, exited, activating
and deactivating units, and empty `systemctl show` output).

### THE OS AGENT, THE SLOT MIRROR AND THE TRANSPORT PIN [PARTIAL]

- **OS agent** (`os-manifest.ts`, `os-agent.ts`; needs `apt-all-packages` +
  `rauc-verity-streaming`). `checkOsChannel()` fetches
  `channels/<channel>/<board>.json` and `.sig` as `ota_uid` under
  `updatePinController.run("os", ...)`; `validateSignedOsManifest()` accepts only
  a CMS verified against `/etc/rauc/ceralive-keyring.pem` with the exact signer
  CN, codeSigning and no emailProtection, and the extracted signer's RFC2253
  issuer DN exactly `CN=CeraLive RAUC Intermediate CA,O=CeraLive` (production)
  or `CN=CeraLive RAUC Bench Intermediate CA,O=CeraLive` (persistent bench).
  A root-direct or other intermediate is refused as `signer_issuer_invalid`,
  before the strict v1 fields.
  Discovery uses `discoverSignedOsManifest()` after the same trust/identity
  checks: an unexpired current version is successful with no candidate at any
  serial watermark. A consumed pointer at exactly the stored serial is also no
  candidate if positively older than booted and not quarantined. Expired or
  untrusted pointers and replayed newer targets still refuse. No discovery writes
  the serial watermark; staging freshly revalidates through strict admission,
  preserving `serial_replayed` before `downgrade_or_same`. Trusted-current
  discovery clears only the two obsolete equality/replay OS-check refusals via
  `clearUpdateNotice()` and its normal remove-frame publication. Success resets
  the check clock to normal cadence, not failure backoff. Coverage:
  `tests/os-manifest.test.ts`, `tests/os-agent-runtime.test.ts`.
  `tests/os-stage-strict-entry.test.ts` drives real `stageOsBundle` with injected
  I/O/job effects: current, replayed-newer, expired and quarantined fresh pointers
  refuse before RAUC dispatch; its valid control reaches the runner. The narrow
  `setOsStageEntryDepsForTest` seam leaves production admission unchanged.
  Receipt and activation ordering: `docs/DEVICE-UPDATES.md`.
- **An OS update is verified by THIS boot's healthcheck verdict, never by the
  CalVer alone.** In `os-verifying`, a booted staged version dispatches
  `OS_VERIFIED` + `os-activated` only when `healthy-state.json`'s `boot_id` is
  the current boot id (`readHealthyState()`, the same strict parser the slot
  mirror uses). A stale record from an earlier boot, a missing or garbled one,
  or an unreadable boot id keeps the phase in `os-verifying` (persisted, retried
  per tick and at backend start, no notice). A boot on another version is the
  unchanged `os_version_mismatch` rollback, judged first and without the healthy
  record. Do not "shortcut" this back to a CalVer comparison: a slot that boots
  and fails its healthcheck was declared verified that way on the Orange Pi 5+
  drill (task-45 opi-r5 C1), and the bootloader fallback was never quarantined.
  The UI therefore stays in the verifying state until the healthcheck passes.
  Fallback only follows failures BEFORE `mark-good`: the healthcheck marks good
  first and writes the record after, and `mark-good` refills the attempt
  budget, so a failed record write leaves a good slot in `os-verifying` with no
  timeout (checks, installs and the mirror blocked, streams allowed). Do not
  add a timeout or read RAUC `good` as a substitute; the remedy is on the
  image side (`docs/DEVICE-UPDATES.md`).
  Coverage: `tests/os-verify-healthcheck.test.ts` (drill replay with the
  board's boot ids).
- **Channel identity is not bundle identity.** `readBoardIdentity()` admits exactly
  `ceralive-rock-5b-plus` → `rock-5b-plus` and
  `ceralive-orangepi5-plus` → `orange-pi-5-plus` for channel URL selection.
  Unknown, near-spelled or product-slug-shaped physical compatibles refuse before
  transport selection or fetch. The original compatible reaches CMS-verified
  `validateSignedOsManifest()` and `stageOsBundle()` unchanged; both require
  exact signed board AND compatible equality. The Orange Pi publisher's signed
  pointer is still wrong until separately repaired; this CeraUI change cannot
  authorize that pointer or a bundle with an aliased compatible. Regression:
  `tests/os-board-identity.test.ts` (both boards, near matches, cross-board
  signed pointers) plus `tests/os-manifest.test.ts` (signer, serial, version).
- **Booted-version identity:** `/etc/ceralive/os-release-version`
  (`readBootedOsReleaseVersion()`). Do not infer a version from a build timestamp
  or commit; that would weaken anti-downgrade admission.
- **Slot mirror** (needs `slot-sync`). Integrity and external-lock checks stay
  atomic in the unit; a TypeScript pre-check cannot close that race. Completion
  is the matching `sync-receipt.json` plus a fresh probe taken after it, never
  the probe alone: systemd unloads the finished oneshot and resets
  `ExecMainCode`, so success usually probes `inactive-clean`; do not fail that
  without reading the receipt. Consult the receipt ONLY for the two positively
  validated shapes, `succeeded` and `inactive-clean` (both: exit 0, each of the
  five properties exactly once, loaded/inactive/dead; then
  `ExecMainCode=1`/`ExecMainStatus=0`, or both exit fields empty/`0`). The unit
  writes the receipt before `rauc status mark-good other`, so a matching receipt
  does not prove the run finished: settle only when the re-probe again reads one
  of those shapes AND RAUC, read before `SYNC_SUCCEEDED`, reports the receipt's
  target as the one inactive rootfs slot with `boot_status` `good`. A `bad`
  target fails as `slot-sync-incomplete` (mark-good interrupted); unreadable or
  undecidable RAUC gives no verdict. The healthy record names the booted slot
  only when its `boot_id` is this boot's; in the poll an `unknown` identity
  (e.g. the previous boot's record right after a reboot) stays a candidate and
  RAUC decides, while a receipt RAUC shows naming the booted slot is handled as
  non-matching. A read that would otherwise be one of those shapes but fails
  that validation is `absent` and must fail closed, but only after
  `SLOT_SYNC_QUEUED_START_GRACE_MS` (90 s from entering `syncing`): a
  `--no-block` job queued behind the healthcheck still reads the previous
  run's shape. On the shipped image that queue lasts milliseconds (the
  healthcheck is `RemainAfterExit=yes` and a re-run is a boot-id no-op), so the
  90 s is a defensive bound; it is wall-clock, so an NTP step forward can
  shorten it, and a backend crash between persisting `SYNC_STARTED` and
  `systemctl start` fails as a sticky `slot-sync-unit-absent` after it (both
  documented in UPDATE-RECOVERY.md). An `absent` CONFIRMATION probe (the second read,
  after a matching receipt) gives no verdict; the next poll's first probe
  decides. An `inactive-clean` read without this run's receipt waits out
  the same grace and is then re-probed, and the receipt re-read, before it
  fails. The parser's `running`,
  `failed` and `refused` verdicts are kept (exit 75 is `refused` on either
  lifecycle), and a failed or refused verdict is persisted before
  `reset-failed` clears the unit's record. A receipt matches only when its
  `target_slot` also names the slot that is not booted now: an OS activation
  swaps the booted slot without changing dpkg, and a SHA-only match skipped
  the post-activation mirror on hardware (task-45d OPI D1). Slot identity is
  tri-state (`classifyReceiptTarget`: `other` / `not-other` / `unknown`) from
  the system.conf bootname map and this boot's healthy record, never
  timestamps. The GATE never dispatches on `unknown`: with a matching SHA it
  skips the tick (`slot-identity-unknown`). The POLL rules out only
  `not-other`; an `unknown` receipt with this dpkg SHA stays a candidate and
  RAUC decides. Contract:
  [`docs/UPDATE-RECOVERY.md`](../../../../docs/UPDATE-RECOVERY.md).
- **Transport** (`update-transport/`). Routing scope and DNS limits:
  [`docs/HOST-UPLINK-ELECTION.md`](../../../../docs/HOST-UPLINK-ELECTION.md).
  `run()` optionally refreshes selection after safe cleanup, preserving one
  three-distinct-pair budget and the exact 15-minute pair hold. Its cancellation
  and metered-approval hooks are opt-in; omitted hooks preserve existing callers.
  Never unwrap a routing-teardown `AggregateError` to continue failover.
  OS retry readiness is a separate positive proof (`os-stage-recovery.ts`):
  settled CLI, active idle RAUC, retired prior installer/failed daemon and
  captured mount/NBD/dm identities, unchanged healthy booted rootfs, inactive
  target and no activation marker. Recovery polls at 1 s for at most 360 s;
  expiry is unsafe, never permission to release a writer's lock or force-clean.
  The attempt watcher reads fresh pinned-path topology every 3 s (2 s read
  bound), independent of RAUC progress/RX. TLS-verified bundle HEAD runs as the
  OTA UID/family every 10 s with a 5 s cap. Two consecutive attributable curl
  transport exits cancel; its 4 s deadline leaves outer-launcher headroom.
  An outer wrapper timeout is unavailable, not transport evidence, while
  HTTP 429/5xx is origin-side. Unknown, missing probes, flat
  progress and SIGBUS/EOF alone never prove link loss; stream cancellation wins.
  The OS job's lock owner is a PID-1 transient exec service wrapping the
  packaged `deployment/ceralive-os-stage-guard` under the shared flock (`-E 75`).
  Its fixed 0700 directory and 0600 token/ownership record are independent of
  the backend and CLI. No pipe, heartbeat expiry or recovery deadline releases
  it: the backend acknowledges the matching token only after quiescence and
  pin teardown. Exact transient fragment, argv, properties and token are
  required before adoption or retirement; a foreign same-named unit is refused.
  `os-stage-run.ts` and `os-stage-settlement.ts` connect that proof to the sole
  pin-controller retry loop; `os-stage-pin-retention.ts` parks its unchanged
  finally while a writer is unsafe. `os-stage-startup.ts` drains/sweeps only
  after proof and takes a fresh observation before release. Main queues this
  after control readiness, without awaiting recovery on the boot path; an
  unresolved job closes update admission again and joins one reconciliation.
  The live producer is rechecked after job/owner reads before adoption. A separate
  reconciliation-only flock can retire preparation-only or acknowledged/exited
  orphans with fresh client/resource/slot proof before and after sweep; it never
  owns a RAUC writer. Missing or changed `boot_primary`, a live guardian, foreign
  unit or unreadable private state prevents orphan retirement and keeps admission
  closed. Private acquisition/release lifecycle states make crash windows explicit.
  A never-launched guardian (acquisition failure, every pre-`beginAttempt` failure,
  or startup orphan) settles through `os-stage-unlaunched.ts`: kernel lock proof,
  fresh quiescence, matching release and normal exit (or owned terminal reset),
  witness before retirement, then the original typed safe refusal (or operator
  `rauc_install_failed` for an untyped acquisition failure). Lock rows match the
  validated fd/mount device plus inode, never inode alone. Short-lived helper
  children trigger bounded rescans, not a widened steady-state allowlist. Thrown
  physical proof errors retain their causes under `rauc_recovery_unproven`.
  Exit-75 cleanup checks stop/reset replies and positive owned-terminal absence
  before retirement; failed cleanup retains provenance for the next startup.
  Every controller
   holds the cross-process control lease first; see `docs/UPDATE-RECOVERY.md`
   → "Unlaunched guardian settlement".
   New jobs capture strict optional `receiptBaseline` under that lease before
   acquisition, and completed never-launched witnesses preserve it. Only the
   unchanged pre-existing receipt is inert for physical/state settlement; it is
   never deleted or consumed. New/changed receipts and launched provenance veto;
   legacy records without the baseline retain the presence veto. State recovery
   rechecks identity after final authority. A successful unrecorded installation
   or the Rock both-good unsafe case without a completed witness stays unsafe.
  Orphan absence uses the parsed `LoadState` field with duplicate-key rejection,
  independent of property order. Previously owned configured NBD devices retain
  their original resource identity across creator PID reuse until independent
  connection-attribute absence or device disappearance proves retirement.
  The optional `stageOs(..., control?)` seam carries stable identity,
  cancellation, the captured one-job cellular grant and a synchronous receipt
  commit callback. No await separates its final token check, receipt/serial
  writes and `OS_STAGED`. Activation waits for complete producer settlement.
  D8 cancels first and submits `systemctl restart --no-block rauc.service`;
  submission failures propagate, but daemon retirement is not a stream wait.
  Fixture/temporary-flock tests are not device qualification; see
  [`docs/UPDATE-RECOVERY.md`](../../../../docs/UPDATE-RECOVERY.md).

### CELLULAR, QUARANTINE, STALE SERVICES, NOTIFICATIONS [EXISTS]

- **D12** (`decideCellularGate()`): keep cheap checks and large bundle stages
  distinct so a check toggle does not imply approval of cellular download costs.
- **Quarantine** (`UpdateQuarantine`, `quarantine.json` schema 1): exact failed
  candidates pinned at -1 through `systemd-run`, lifted by a newer candidate;
  `isOsVersionQuarantined()` feeds the OS agent. Schema:
  [`docs/UPDATE-RECOVERY.md`](../../../../docs/UPDATE-RECOVERY.md).
- **Stale services** (`reconcileStaleUnits()`, `mayRestartUnit()`): preserve the
  protected-unit policy to avoid disrupting connectivity and media services;
  see `docs/UPDATE-RECOVERY.md`. `polkit` and `user@*` are in it because a
  restart also restarts units that `Requires=` the target (ModemManager requires
  polkit); the list is not a dependency graph.
- **Notifications** (`notifyUpdate()`, `update:<kind>:<id>`, re-send suppressed).
  Producer and credential-band limits: `docs/DEVICE-UPDATES.md`.

### SETTINGS AND IMAGE CAPABILITIES [EXISTS]

`update-settings.ts` reads/writes `update-settings.json` (CWD-relative like
`config.json`) through `loadJsonConfig` / `writeFileAtomicSync`; absent gets the
`@ceraui/rpc` defaults without touching the loader, logged once per path at info
(settings are re-read every orchestrator tick, so the loader's missing-file warn
would repeat every 3 s). Absent means `ENOENT` only: any other non-file path
state, such as a directory, still goes through the loader, which warns and
yields the defaults as before. Malformed PRESENT content still warns and throws
`UpdateSettingsValidationError` instead of partial salvage. `channel` is
stable/beta. Capability and launcher gates: `docs/DEVICE-UPDATES.md`.

Coverage: `tests/update-orchestrator-{reducer,admission,schedule,persistence,resume,runtime,lock,os-recovery-resume}.test.ts`, `os-stage-retry`, `update-notifications`,
`update-recovery`, `update-details`, `slot-sync-{gate,state,runtime}`,
`apt-all-packages`, `update-settings`, `update-capabilities`,
`update-transport*` (incl. `update-transport-pin-netns.test.ts`), `idle-detector`,
plus the frontend `src/lib/updates/*.test.ts` and `tests/e2e/update-system.spec.ts`.
All fixture, netns or Playwright proof; no board receipt.
