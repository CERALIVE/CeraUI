# Update recovery contract [PARTIAL — local recovery implemented, board proof owed]

## OS staging lock and startup reconciliation

Physical startup reconciliation and orchestrator startup are ordered by a shared
completion promise. Both run off the control-server boot path; completion is not
a positive safety verdict. The orchestrator retries acquisition/persistence/cleanup
failures under one flight, with five waits (250, 500, 1000, 2000, 4000 ms) and six
attempts total. After transient exhaustion, mutation readiness stays closed while
one unreferenced timer retries a single startup attempt every 30 seconds until
success. Operator calls cannot rearm the burst or the timer. Authoritative safety
refusals without an I/O cause (except lock contention) are never retried; invalid
present recovery metadata stays maintenance-blocked without automatic repair.

Boot launches one detached update bootstrap: orchestrator startup, standalone
APT recovery, then periodic package checks. Unrelated boot surfaces never await
this chain. A failed transient burst flags `update-orchestrator` degraded through
the boot guard, but the chain waits for the cadence's eventual startup adjudication
before handing over any detached unit. Only successful, valid startup permits that
handoff. A terminal safety refusal or invalid-present metadata settles the chain
without bootstrap standalone recovery or hourly legacy refresh: preserving plan/unit evidence is
safer than letting legacy cleanup become its first reader. No metadata is cleared.

### OWNER DECISION: terminal startup refusal and legacy maintenance

Invalid metadata or an authoritative safety refusal produces one bootstrap error
and marks `update-orchestrator-maintenance` degraded on local `/api/health` through
the existing boot-readiness surface. The flag is latched for this process, not a
typed RPC refusal or a guarantee that every legacy path is blocked. The bootstrap
does **not** initialize standalone unit recovery or hourly legacy refresh in that
state. An untracked detached transaction, including its eventual terminal result,
therefore remains unobserved by this bootstrap.

Other callers remain independent: stream-stop (`process-runner.ts`) and a recovery
coordinator retry succeeding can still call `periodicCheckForSoftwareUpdates()`
and start/resume legacy discovery. `system.checkForUpdates` and `system.startUpdate`
remain callable under their existing guards; they do not consult this adjudication.
Install may acknowledge dispatch before its continuation refuses a retained unit.
The degraded flag must not be interpreted as a process-wide legacy-admission fence.

**Operator remedy:** avoid Check as well as repeated Install attempts; preserve `agent.json`, the
pending plan, unit status and output. Have a local administrator diagnose and repair
the invalid metadata or unsafe ownership using positive unit/package evidence;
never delete the retained unit or state merely to clear the warning. Restart CeraUI
only after that maintenance establishes a safe baseline. The narrow packaged
missing-commit recovery tool below is not a general invalid-metadata repair tool.
This choice keeps destructive recovery closed while leaving legacy RPC/discovery
entrypoints unchanged. Whether to add a product-wide legacy maintenance/admission
gate or separately safe discovery scheduling is an **OWNER DECISION**, not silently
implemented here. No new typed RPC refusal or unconditional cleanup is added.
An accepted legacy Check clears `lastUpdateSucceeded` before dispatch; only a
refused Check restores it. Retained wire success is therefore not immutable
evidence. This remains relevant to maintenance under terminal startup refusal,
where the pending-success authority below may never have observed the unit.

### Recovered package success: explicit exit authority [PARTIAL — host-proven]

A persisted `committing` **or `downloading`** owner registers its recovery exit
hook before attachment. Persisted downloading can lag a short commit.
`finish()` exposes drain/cleanup settlement separately so resume can observe success
without waiting on itself. Its deliberate restart tail consumes the hook, which
waits for successful, valid startup adjudication. For an already-finished unit,
startup durably reconciles the tracked snapshot under CONTROL first. The hook
then confirms or persists success; downloading uses `COMMIT_PHASE_ENTERED` followed
by `COMMIT_SUCCEEDED`, committing uses `COMMIT_SUCCEEDED`. The final successful
snapshot is persisted before exit, including a unit running at boot that completes
later without a scheduler tick. An already-durable `restarting-services` or `settled`
snapshot still grants permission; any other phase withholds it.
Overlapping standalone recovery joins the recovery coordinator; it gets no separate
completion tail. A unit with no orchestrator owner keeps legacy exit/reboot behavior.

**Failure decision:** no positive durable success means no deliberate exit. Terminal
refusal marks `update-orchestrator-maintenance` degraded; a transient startup burst
failure is marked degraded by the boot guard and keeps the tail parked for the
30-second cadence. A later running-unit persistence failure closes mutation
readiness, logs an error and marks maintenance degradation. The process stays alive
with its observed outcome; it does not invent `commit_unit_absent_on_resume` by
deliberately discarding that outcome. This is not a durable success journal: an
external kill/power loss before persistence can still lose consumed unit evidence.
Fix storage/ownership without restarting first. A failed completion write now
retains explicit pending-success authority for the scheduler retry below. The
completion tail waits for durable acknowledgement after its logged write failure;
successful replay permits that original deliberate exit once, and normal stale-service
reconciliation also regains restart authority. The narrow missing-unit tool applies only
to its documented reason and is not general metadata repair. Host delayed-CONTROL
tests use terminating exit seams; real systemd/APT and power-loss validation remain owed.

### OWNER DECISION: pending package success and the old running backend

Successful owned completion marks `pending-success-fence.ts` before publishing
package wire `success`. That wire says the package transaction succeeded, **not**
that restart permission passed or the new backend is running. A withheld restart
leaves the new packages installed with the **old backend still running**. The
operator's observable maintenance feedback is the error log and the latched
`update-orchestrator-maintenance` flag on `/api/health`; no new rendered band or
typed RPC refusal is claimed. The flag remains latched even if storage later heals.

While durable success is unacknowledged, every orchestrator tick services the
existing snapshot replay and intent/witness recovery owners before one
single-flight CONTROL-protected package-success retry, then returns. It never
enters ordinary scheduling while that package fence is present. The existing tick
cadence (3 s in active package phases, otherwise 60 s) remains bounded: no hot-spin
and no second retry timer. Replay accepts only the exact baseline, the reducer's
download-to-commit intermediate, or exact success intent on disk. It persists the
final intent, adopts/publishes it, then clears the fence. Disk drift or write failure
retains it. Fresh synchronous callbacks receive authoritative disk acknowledgement
too: memory ahead of disk, or a repeat no-op callback, cannot clear the authority.
Startup-tail successful persistence is another authoritative acknowledgement.
Readable equality is not durability: if rename succeeded but parent-directory fsync
failed, a repeated completion must re-persist under CONTROL before acknowledging.
Retention preserves the first baseline. Retention, acknowledgement and replay also
compare all persisted non-phase fields, excluding `phase`, `enteredAt`, `progress`
and `failureReason`; a changed plan, history or recovery record cannot borrow the
observed completion. This schema has no package transaction UUID, so transactions
identical in every compared field are not independently distinguishable.

Manual Check, Install and synchronous cellular approval require **all three**:
validated startup, no OS settlement durability pending, and no package success
pending. Startup's final `setReady(true)` cannot override package pending, and
package acknowledgement cannot authorize unfinished or invalid startup. D8 returns
its existing `update_in_progress` refusal before reading or mutating its tracked
phase when package success is pending, including after awaited publishing-intent
recovery. Download abortion rechecks after the awaited
commit probe, immediately before stop submission, and after stop before dispatch.

The tick entrypoint suppresses phase overwrites, discovery, package launch, OS
stage/activation, mirror start/poll/cleanup and quarantine retirement. Dependency
entrypoints fence system effects and recheck awaited settings/capability/idle/
discovery results. Stale-service reconciliation also rechecks immediately before
each restart, after its idle await. Legacy periodic/stream-stop/coordinator discovery,
Check, Install, deferred install and unit recovery are fenced only during this
pending-success window, using their existing skip/refusal results. Terminal startup
refusal alone does **not** activate that global legacy gate; the prior owner decision
still applies. A legacy call admitted before observation also rechecks at the shared
APT command funnel before each submission and after each awaited command result,
after network/capability/settings preparation, and at the preflight command port
(pre-clean, apt-config and print-uris). Refresh and discovery report the existing
`discovery_failed` outcome and release their in-flight flags; a pending install
continuation releases its updating latch without stamping shutdown or launching.
Shared APT channel reconciliation rechecks after its source-file read immediately
before the atomic write, including boot and settings callers. Already-submitted
APT/RAUC/systemd work and network preparation cannot be undone by this fence;
this is a submission-boundary guarantee, not cancellation of every internal effect.

Five consecutive authoritative disk mismatches produce one maintenance escalation
per retained completion, with reason `package_success_baseline_drift`. A persisted
phase outside committing/downloading/restarting-services/settled escalates immediately
as `package_success_phase_changed`. Neither verdict clears the fence or rewrites
the replacement. An exact replay match resets the mismatch count. Repeated retry
errors with the same name/message signature log at most once per 60 seconds;
distinct signatures can still log separately. The escalation names the remedy:
inspect `agent.json` and installed packages before restarting `ceralive.service`.

**Remedy:** avoid Check and Install, preserve agent/plan/unit/output evidence, and
repair storage or ownership while the backend stays alive. Storage recovery permits
the next tick to durably record success and subsequent normal reconciliation to
restart stale services. If replay reports authoritative drift, local administrative
diagnosis and a positively established safe baseline are required before a service
restart. Restarting early can discard the sole consumed outcome and recreate the
missing-unit failure. No operator/maintenance fence-clear API is added: only a
successful authoritative success persist/acknowledgement clears it in production.
Test reset cancels the reserved exit hook and clears the fence; late CONTROL/read
continuations cannot read/write/adopt into the next fixture. These are host proofs,
not a power-loss journal or a board qualification.

**Combined authority progress [PARTIAL — host-proven, independent review owed].**
`OsSettlementPersistence` also owns the authoritative startup-tail snapshot, even
for a package phase. A real parent-directory-sync failure after that tail's rename
can therefore coexist with retained package success. The controlled host tests
exercise package observation before the failed snapshot and running-unit completion
after it. A healed-storage tick acknowledges the exact snapshot through its own
owner; the original package exit remains withheld until valid startup reconciles
success. Resumed commit progress is not silently accepted as the package's exact
baseline: its replay may remain refused until the startup owner persists success.
Snapshot replay, intent cleanup and publishing retain their separate closure checks;
package acknowledgement does not open startup or another durability owner.

Valid publishing restoration, by contrast, accepts only its exact `os-available`
or `os-staging` snapshot. Neither phase attaches a tracked package owner or reduces
to package success. `update-orchestrator-combined-publishing-invariant.test.ts`
tests this production schema/startup invariant instead of fabricating a package-
shaped publishing record and calling it reachable. This does not prove every legacy,
trusted-uid or external writer obeys that invariant. Valid stale launching cleanup
remains restoration-free, and unreadable authority remains closed. The combined
tick still enters the existing recovery seam before package replay, so cleanup
cannot be permanently bypassed by package priority.

Host regression owners are `update-orchestrator-combined-snapshot-success.test.ts`
and `update-orchestrator-combined-d8.test.ts`. The D8 statement-order proof uses the
actual AST: publishing recovery, package refusal, then phase inspection; runtime
tests cover the post-probe and post-stop fences. Ordinary live-producer cancellation
and the original strict no-producer proofs are unchanged. Independent combined-head
review, systemd/RAUC and board/power-loss qualification remain separate gates.

The three non-witness recovery writers (interrupted settlement, generic
confirmation, legacy migration) retain a baseline plus exact settled snapshot
before dispatch. Write failure closes mutation admission; internal tick/startup
replay re-persist that snapshot under CONTROL, without a second reducer event.
Only the exact baseline or exact intent may be authoritative at replay. A changed
disk record or a safety refusal without an I/O cause never becomes retry-to-clear.

Initial attempt publication is inside the attempt lifetime, before any staging
effect. If it throws (including parent-directory fsync after rename), memory
returns to the pre-state and that pre-state is re-persisted under the held CONTROL
lease. A second storage failure keeps exact rollback intent pending for replay;
the active token still clears in `finally`. That rollback now also has durable
pre-effect authority, described below; it is no longer recoverable only from
the process's replay latch.

### Durable OS attempt intent [PARTIAL — host crash-point proof, board power-loss proof owed]

`os-attempt-intent.json`, beside `agent.json` under
`/data/ceralive/update-state/`, bridges initial attempt publication and producer
creation. It is additional authority, not a replacement for the guardian,
unlaunched witness or positive writer-quiescence proofs. The strict schema-1
record carries a UUID attempt ID, the complete already-verified signed manifest,
the exact pre-state and proposed staging snapshots, and `publishing` or
`launching`. Validation recomputes the staging transition from the baseline and
candidate; recovery requires exact disk equality, not just phase or ID equality.
No candidate version, cellular grant, clock or failed-round count is reconstructed
from defaults. Staging still freshly verifies the signed candidate before effects.

The uid-owned, mode-0600, single-link regular file is bounded to 65,536 bytes.
Like the witness, operations are anchored to a validated, non-peer-writable
directory fd, with no-follow reads and exclusive temporary creation. Every phase
write is temp → file fsync → rename → parent fsync. Retirement is unlink → parent
fsync. Production uses the backend's uid (root); tests own isolated temporary
directories and inject the same real store, never a production environment bypass.

Under the held CONTROL lease, `publishing` is durably written **before**
`OS_STAGING_STARTED` replaces `agent.json`. Once that publication succeeds,
`launching` is durably advanced immediately before calling `stageOs`, with no
await between the advance and producer creation. Failure cannot invoke `stageOs`:
memory returns to the baseline, durable rollback is attempted, and the existing
exact-snapshot latch retains a failed rollback for same-process replay. The intent
survives backend loss until the baseline has been durably restored or the launched
path has durably settled. A superseded producer cannot retire another intent.

Startup, ticks and manual admission enter intent recovery through the existing
state-side witness seam. Every baseline restoration also requires no job record,
no guardian (the existing strict systemd parser), no witness, and fresh positive
writer/resource/healthy-boot/slot/receipt/activation evidence under CONTROL. Intent
and complete disk state are read again after these awaits. Unreadable evidence
never permits cleanup. A both-good-slot board is permitted here because the intent
proves no producer was called, not because an absent job proves that fact.

| Durable intent / disk | Recovery |
|---|---|
| `publishing` / exact staging snapshot | Prove absence and quiescence, durably restore the exact pre-state, retire intent; no failed round or unsafe notice |
| `publishing` / exact pre-state | Same proof and durable baseline/cleanup; covers crash before agent publication and after rollback before retirement |
| `launching` / staging or pending publication | Existing witness/unknown-after-restart path unchanged; never downgrade to never-launched merely because no job exists |
| `launching` / exact pre-state already on disk | Proven rollback cleanup only, after the same absence/quiescence proof; this cannot restore a staging record |
| `launching` / matching durably settled attempt | Retire intent without redispatching or counting another round |
| `launching` / absent or superseding recovery record | Under CONTROL prove no job/witness/guardian, re-read disk and intent, retire and log the stale intent; never restore the old baseline or alter the new record |
| Missing intent / `os-staging` | Legacy behavior unchanged, including unsafe unknown outcome after positive quiescence; the real D8 record stays unsafe |
| Corrupt, foreign, wrong uid/candidate/attempt/baseline, drift, or unreadable physical evidence | Preserve records and keep mutation readiness closed; never infer clearance |

If the launching rename succeeded but its parent fsync failed and rollback also
failed before replacement, restart conservatively retains launching uncertainty.
The no-effect fact available to the original caller cannot be guessed by its
replacement. After a successful restoration a later automatic tick may legitimately
start a **new** attempt through ordinary policy; restoration itself starts nothing.
These are real-filesystem host fault-injection and fresh-runtime proofs, not
systemd/RAUC board rehearsal or an executed power-cut test.

Stale launching authority has no restoration permission. Its cleanup permits
existing receipts and activation state: it writes no agent state and may not
hold a verified activation or a replacement attempt hostage to an old intent.
Unparseable/foreign/oversized/wrong-owner files still cannot be classified as
stale and remain preserved with readiness closed. Same-attempt launching intent
retains its current rule: an active identity remains pending; a settled one may
be retired. Manual admission reaches this recovery seam before a new publishing
intent is created, so proven stale cleanup does not require a scheduler tick.

An unresolved publishing intent closes admission even when its first rename
landed but parent fsync failed before publication was acknowledged. Deferred
retirement is still pending cleanup, not a successful cleanup return. Synchronous
cellular grants, Check and Install receive the existing retryable initializing
refusal. Ticks resolve authority through recovery or remain closed before any
snapshot mutation. D8 joins the same finite recovery flight before adjudicating
the phase, without taking CONTROL itself. An exact-value startup re-adoption is
permitted; a changed snapshot still refuses recovery. Unproven recovery with no
positive live-producer evidence refuses D8 retryably rather than writing a third
snapshot. A matching launched job still permits D8's existing cancellation;
ordinary launching producers take no new recovery wait.
The same retryable refusal covers corrupt, wrong-owner, wrong-mode, oversized
or unreadable intent files, invalid/unreadable job files, and failed guardian
observations. Neither recovery rejection nor the fallback read can turn these
into an untyped RPC failure or proof of an absent producer. Unless a strictly
read, launched job positively matches the valid intent's attempt, D8 writes
nothing and issues no RAUC kill/restart. Repair does not require clearing a
stream-admission latch: the next start re-probes and can restore the exact
baseline before launch. Real-filesystem host regressions drive this contract
through session admission and the real WebSocket adapter in
`os-attempt-intent-stream-evidence.test.ts`; readable insufficient-job and live
matching-producer controls are in `os-attempt-intent-stream-producer.test.ts`.

The publishing-window writer census includes Check and Install RPCs, cellular
grants, package/OS discovery and their completions, package scheduling/launch/
progress/commit callbacks, terminal acknowledgements, stale-service completion,
mirror eligibility/start/poll/settlement, OS scheduling/publication/progress/
settlement, activation/reboot/verification, deferred-download re-adjudication,
D8 package and OS aborts, interrupted/witness/legacy/confirmation reconciliation,
snapshot replay/rollback/intent restoration and the startup tail. Manual and tick
entry closes or awaits recovery; grants close synchronously; D8 OS abort awaits
publishing recovery. Package, mirror, activation and deferred-download owners are
phase-unreachable from valid publishing snapshots (`os-available`/`os-staging`),
and reducer-inapplicable late completions cannot change those snapshots. Producer
callbacks are unreachable before launching. Recovery and rollback are the
coordinated authoritative writers, snapshot replay retains its own exact proof,
and the startup tail refuses pending durability. Settings writes only
`update-settings.json` and APT channel configuration; status/wire publication,
notice hydration/replacement and quarantine cleanup never write `agent.json`.

Retirement failure is not a different stage outcome. The finally logs a structured
`intent-retirement-pending` event and retains a separate single-flight cleanup
latch in settlement persistence; the original success/failure policy and durable
agent state are preserved. Token/in-process cleanup still runs. While this latch
is pending, manual mutations remain busy and ticks retry cleanup without throwing
its error into the scheduler. Recovery borrows CONTROL, preserves snapshot-write
pending state, rechecks current disk identity and synchronizes the validated
parent directory before clearing the cleanup latch. Every intent retirement,
including publication rollback and startup/tick restore, stale-launching and
settled-launching recovery, arms the latch before unlink. The initial recovery
failure propagates to its existing startup/scheduler error owner; subsequent
cleanup passes contain errors and retain closure. If unlink succeeded but parent
fsync failed, the next pass must synchronize even with no file left to read.
Corrupt or inconclusive evidence remains closed; absence never launders a known
failed acknowledgement. This is host-injected I/O proof, not an executed
power-loss/resurrection or cross-process CONTROL qualification.

The cleanup owner retains its last failure until acknowledgement. Startup checks
that owner before its authoritative tail: a contained retirement I/O failure keeps
its cause and therefore remains on the six-attempt/30-second startup cadence;
it is not replaced by a cause-free tail safety refusal. A cause-free ownership
refusal remains authoritative and schedules no retry. Successful cleanup clears
only that owner's failure/pending state, not startup adjudication or snapshot
durability. Reset generation-fences late failures as well as late success.
`update-orchestrator-combined-cleanup-cadence.test.ts` tests both I/O windows and
the unchanged cause-free refusal against real files and controlled timers. The
retirement matrix advances the production background cadence after storage repair,
rather than pretending another caller can rearm an exhausted startup burst.

The frontend preserves the optional retryability and startup code in the existing
RPC error envelope. Check, Install and cellular-grant refusals use the existing
Updates band with translated initialising/retry-shortly copy in all ten locales;
the backend's raw message is not shown. Persisted recovery output is unchanged.

Production backend single-instance ownership is enforced before the control server binds:
`/run/lock/ceralive-backend.lock` is held by a supervised flock/helper for the
entire backend lifetime, independent of port fallback, flags, device detection
or runtime mock overrides. Source-development boot skips enforcement only for
exact `NODE_ENV === "development"`; the device unit sets production and production
compilation inlines the direct environment read. Lock/proof primitives and the
separate OS-stage CONTROL lease are unchanged. A second production backend exits
nonzero. Observer-pipe EOF after backend
death ends the helper; unexpected helper death terminates the backend rather
than leave an unlocked writer. No stale PID file survives a restart.
Only EACCES/EROFS/ENOENT proving that the lock directory cannot create the lock
permits a warned fallback when enforcement applies; contention,
invalid lock paths, helper absence and readiness failure remain fatal.
Both pre-spawn and post-readiness censuses refuse only another granted singleton
holder: first `/proc/<pid>/status` must report real AND effective `Uid:` equal
to the backend's `process.getuid()`, then its full NUL-separated argv must equal
`singletonArgv(paths)`, then `/proc/<pid>/exe` must match the current
`/usr/bin/flock` by device/inode OR have the exact kernel link target
`/usr/bin/flock (deleted)` after package replacement. Proc-directory ownership
is not credential evidence: Linux
can make a non-dumpable foreign process's directory root-owned. Saved/filesystem
UIDs are parsed but are not additional gates; no setuid wrapper is used.
The pending child is excluded.
Only then is `singletonLockIdentity(pid)` read: it must prove one granted kernel
`FLOCK` owned by that PID on a held fd for a regular file. A positively foreign
real/effective uid stops examination before argv/exe/fd reads, even if those
would fail. Readable nonmatching argv and proven nongranted contenders do not count.
The census never compares that fd with the current lock pathname, so a holder
whose file was unlinked or replaced still refuses a second backend, including
a deleted-flock wrapper. Any other executable with exact argv, same uid and a
granted lock refuses as `BackendSingletonError("unproven")`, not absence.
Nongranted executable lookalikes are ignored only after their fd proof; an
unreadable executable/link or grant remains fail-closed. ENOENT/ESRCH
process races are ignored; other read failures propagate and fail startup closed,
including unreadable argv/exe/fd proof after credentials matched. Status EACCES
alone has a narrow exception: unreadable (EACCES) or readable nonmatching argv
is non-qualifying, but readable exact argv refuses as `unproven`, with the status
error retained. Other non-vanished status errors and malformed credentials fail
closed. This is not an availability promise on restricted procfs.
Failed uid/argv qualifiers are not read further. The census reads are non-atomic:
there is no pidfd or start-time fence against PID reuse/TOCTOU.
The granted helper fd's dev/inode is
retained and re-checked against the lock path about every 2 s; a replaced,
missing or unreadable path terminates the old backend nonzero through the same
exit path as helper loss. The 2 s cadence is not a strict termination bound:
scheduling and filesystem reads can delay detection. Root tampering with
`/run/lock` beyond this detection
(for example racing the census or forging all holder evidence) is outside the
threat model. The separate OS-stage control lease remains defence in depth for recovery
evidence and authoritative state rechecks. Host child-process tests are not
systemd-on-board SIGKILL/restart or power-loss qualification.

Startup's final save now holds CONTROL and compares the authoritative recovery
identity even when a witness was missing, mismatched or inconclusive. A fully
committed settlement is not written a second time. Generic unsafe confirmation,
interrupted-stage settlement and legacy migration retain CONTROL from evidence
through an authoritative re-read, dispatch and persistence; nested guard proof
borrows the same lease. Attempt, candidate, active attempt, count, mode, reason,
retry deadline, phase, terminal reason and legacy discovery delay must agree.
Pending settlement durability is rechecked after admission/witness awaits and
before discovery/staging transitions, including a previously admitted Check.

RAUC's top-level `boot_primary` must unambiguously name the healthy booted rootfs,
not the target, and remain identical across admission, recovery and final settlement.
Missing activation identity fails closed; an inactive slot and absent marker alone
do not exclude bootloader selection. Old job snapshots without this reading retain
unknown identity and cannot authorize release.
Live producer identity is checked synchronously after job and guardian inspection
awaits. A probe begun before a manual stage cannot later classify its new job as
abandoned or terminate its writer; genuinely abandoned jobs still close admission.

An OS staging job acquires `/run/lock/ceralive-update.lock` once, across every
candidate pair, daemon recovery and final settlement. The owner is a PID-1
transient exec service, `ceralive-os-stage-guard.service`, running the packaged
root-only `ceralive-os-stage-guard` helper under `flock -n -E 75 -x`.
The install CLI takes no nested flock. A private 0700 directory and 0600
token/ownership record identify the attempt, candidate, current pair, daemon
baseline and observed process/resource identities before an install can launch.
The service does not inherit a caller-owned pipe or scope.

A CLI exit, backend death, missing heartbeat or six-minute recovery deadline
never releases the guardian. The matching private token is acknowledged only
after positive writer quiescence and successful pin teardown. Receipt/serial
publication executes synchronously under the lock before that acknowledgement;
activation is fenced until the producer has finished settling. A write or
proof failure before acknowledgement retains the unreleased lock rather than
reporting a safe handoff; a later cleanup failure cannot promise lock retention.
The launched owner captures the private directory's device/inode at acquisition
(or at its first proven `held()` when adopted at startup) and re-runs the
authoritative private-owner assertion (`os-stage-private-owner.ts`: disk record
equal to the normalised in-memory record, matching token/ready/release content,
allowlisted single-link 0600 regular files, 0700 directory owned by the expected
uid, same inode) before the success callback, before the release marker, before
guardian retirement and before directory removal. Drift, including a foreign
release marker, refuses with `rauc_recovery_unproven`. Before the success callback,
that refusal publishes nothing and retains the directory and unreleased lock.
After the callback has published, later drift refuses the next publication or
cleanup step; it cannot retract the callback's publication. Once the release
marker exists, the guardian may consume it and exit independently, so a later
refusal cannot guarantee the lock remains held. Later failures retain the
remaining provenance and refuse further cleanup, rather than undoing publication
or claiming a safe handoff.
Lock contention is exit 75, distinct from an ordinary RAUC install failure.

Startup queues reconciliation after the control server's readiness barrier,
without awaiting it on the boot critical path. Update admission remains closed
while reconciliation runs. A loaded same-named unit without a matching private
record is foreign, not adoptable. Adoption and retirement require the exact
transient fragment, service properties, executable argv and attempt token.
Preparation records carry `acquiring`, `held` and `releasing` lifecycle states.
A never-launched record with an absent guardian, an acknowledged/exited guardian,
or a private preparation directory without a record can settle under a separate
reconciliation-only flock. Before retirement, fresh evidence must prove no install
client, idle RAUC, retired resources and the unchanged healthy booted/activation
identity. Proof is repeated after pin sweep. Only the exact exited transient unit
may be stopped; live or foreign units and unreadable private files remain untouched.
The temporary lock owns no writer and ends with its scoped reconciliation; it has
no lifetime timeout. The PID-1 writer guardian and its no-expiry rule are unchanged.

An absent unit is identified by the exact parsed `LoadState=not-found` property,
regardless of property order or other requested fields. Malformed and duplicate
properties refuse settlement. A previously owned configured NBD device keeps its
original tracked resource identity even if the numeric creator PID now identifies
an unrelated process; connection-attribute absence or device disappearance is the
independent retirement evidence. PID reuse alone is not retirement.

Concurrent admission callers share one observer with a 10-second fail-closed
deadline. Expiry returns refusal and clears only that bounded observer; it cannot
release a guardian, settle a job or prove writer quiescence. Late completion
cannot alter expired callers or clear a replacement observer. A post-publication
unsafe verdict and an invalid-load terminal latch remain closed across that boundary.

The HTTPS watcher treats an outer launcher timeout as unavailable, never transport
evidence. Curl's own 4-second deadline fits inside the 5-second supervision bound;
its explicit exit 28 remains attributable and counts toward the two-failure gate.

For an owned launched attempt, startup submits termination/restart, then proves
the old exact install client is gone and independently observes daemon/resource
retirement. Only after that proof may it drain a retained in-process pin, sweep
stale routing and release the guardian; a fresh final observation prevents
release on residue that appeared during cleanup. A later unresolved job can
re-close admission and queue the same single-flight reconciler. Unreadable
ownership or inconclusive retirement keeps admission closed and the lock held.
The control server and stream-start admission do not wait for this recovery.

### Fresh admission under read-helper churn [PARTIAL — host proven; both-board re-drill owed]

RAUC's idle custom bootloader backend can spawn read-side children inside
`rauc.service` during ordinary status reads, including the device-stats collector
and the stage observer itself. A clean recovery census is not a cached grant for
the later retry or publication census. `observeAdmission` now defers only
`extra-process`, with no dispatch, while obtaining fresh observations at up to
100 ms intervals. The final snapshot still passes the unchanged
`requireAdmissionSnapshot` / `failedAdmissionPredicate` validators. No helper
name, argv, ancestry, prior ownership, zombie state or role exempts a member.
The observer retains exact tracked identities even after cgroup escape; positive
ENOENT is still absence, while denied or malformed identity reads stay unknown.

Before a launched pair's outcome is handled, one local monotonic 360-second
deadline is established, before restart submission. Recovery's 1-second poll,
later next-pair admission and subsequent revalidation use that same deadline;
returning a recovery proof does not grant another six minutes. Initial prelaunch
proofs have a short 10-second bound. A newly authorized install has its own
outcome/retirement lifetime: the previous pair's retirement deadline is not a
timeout on the replacement download. Successful CLI settlement starts its one
bounded release/publication budget; helper expiry keeps that successful but
unpublished outcome unsafe and cannot route it back to install. No wait resets
the pin controller's three distinct unused pairs or the 15/30-minute three-round
policy. The deadline is never persisted or interpreted across backend restart.

The exhausted-pair/error cleanup branch also obtains a fresh bounded proof before
physical release, rather than converting one transient helper into terminal unsafe.
Cleanup may finish a proven FAILED pair after cancellation, without granting
dispatch or publication; CONTROL/private/guardian and final-clock checks remain.
Known CLI success followed by cancellation is different: its local typed
`OsStageUnpublishedSuccessError` retains the raw runner's cancellation surface,
while the sole production `stageOsBundle` entry normalizes it to the existing
`rauc_recovery_unproven` / unsafe policy before any agent settlement. Proven physical
cleanup may release the guardian while logical unsafe stays terminal; uncertain or
expired cleanup retains guardian/private provenance. No manual/automatic restage
grant is published.
Positive exit is captured independently of cancellation and output drainage,
including zero observed after cancellation. Runtime adjudicates the exact token,
attempt and candidate even after D8 has aborted its controller and returned to
`os-available`. Only that matching unpublished-success settlement can upgrade the
cancelled attempt to terminal unsafe, once; it grants neither manual nor automatic
restage. Ordinary cancellation before positive exit retains the existing behavior.
This marker is an in-process error type, not a persisted field or new wire reason.
Positive CLI success also dominates a failed transfer outcome. If topology loss
wins while a zero-exit client's descendant still holds output open, settlement
must not forward a retry-classifiable transfer error. That successful but
unpublished install settles terminal unsafe; the runner independently vetoes any
next-pair dispatch once success is known. Transfer failure without positive exit
retains the ordinary next-pair retry path.

Every rescan retains CONTROL, private ownership and the guardian. Admission and
recovery reassert the captured private-directory provenance separately from the
guardian's physical `held()` reading. Structural
slot/boot/primary/activation changes, lost authority, present admission resources
and missing evidence refuse immediately, even when extras mask a later predicate.
Recovery may still wait for the failed writer's existing resources to retire.
A changed MainPID/start-ticks or observed InvocationID during an extra-member
episode refuses rather than restarting the episode. Admission rechecks cancellation,
Go Live, ownership and the final clock; after a deferral, candidate and transport
are refreshed and a new strict snapshot is taken before `beginAttempt`. Signed
candidate expiry is checked again at dispatch. Release/publication checks the
same clock at its synchronous callback. Startup's final post-sweep proof shares
its original recovery deadline; acknowledged orphan proofs share one short bound
before and after sweep. Release predicates are unchanged and neither path guesses
install success after backend loss.
Awaited authority, guardian and admission preparation precede the final observation;
only synchronous token, lease, candidate-expiry and clock checks follow it before
dispatch. Optional process diagnostics run before the observer's final unit and
process/resource safety fence. Changed final unit, process or resource evidence
is rejected rather than returning the earlier census. Process/resource drift
between the two successful censuses returns null with the closed diagnostic
`census-drift: unproven`. Admission and post-cleanup quiescence retry that outcome
only inside their existing absolute deadline, retaining lease/ownership checks
on every attempt. They never dispatch or release from a drifted observation.
Every observation owns its diagnostic, including a final read after awaited
quiescence; an earlier drift cannot make a later unknown retryable. Command
failure, nonzero exit, malformed/duplicate properties, timeout, thrown errors
and changed ActiveState/MainPID/ControlGroup/InvocationID remain non-retryable
unknown. Only an identical clean pair reaches the unchanged strict validators.
Persistent drift settles unsafe at the original deadline. No stored format,
recovery budget, process whitelist or structural admission predicate changes.
There is **no intervening
awaited preparation between the last safety observation and the dispatch; this
is NOT an atomic census-and-dispatch guarantee**. The synchronous `beginAttempt`
persistence and external process changes still separate observation from action;
the census itself consists of separate reads. This does not reopen D154.
Every proof observation, authority read and evaluation, post-recovery admission,
replacement selection/revalidation, receipt preparation and release-proof read is
raced against the same remaining absolute deadline. Startup restart, retained-pin
drain, sweep and release spend that startup deadline; orphan baseline, sweep,
inspection and retirement spend its single short deadline. Producer capture checks
generation and the final recovery clock before remembering evidence; receipt and
guardian-release callbacks check their owning lifetime before submitting effects.
OS routing teardown bounds each command wait by that same remaining budget and
checks generation/CONTROL before every newly submitted deletion or table flush.
Reconciliation sweeps likewise fence each query, deletion and flush with the
reconciler's active budget and lease. A held query that resolves after timeout may
return data, but cannot initiate another command. Ordinary routing callers retain
their existing teardown and 30-second per-command default. These fences cannot
revoke already-submitted commands or filesystem I/O; their late completion is not
a new grant, and uncertain or expired settlement retains guardian/job provenance.
The intentional unsafe retained-pin gate still parks after notifying unsafe.
The reconciler's later drain of that parked pin observes after the expired job
deadline by design, under its own active budget and CONTROL lease. Its capture is
read-only: awaited ownership preparation precedes a final physical observation,
then synchronous lifetime, lease and quiescence checks gate pin release. Expired
or surrendered reconciliation cannot release using the earlier quiet snapshot.
The recovery loop's last diagnostic read at the deadline and the
proof wait's pacing pause are raced against the deadline without the start/finish
clock refusal, so the final refusal keeps its precise reason; neither can
authorize, because proof still requires the clock to be before the deadline.

The decision seam logs one deferral and its proven/final disposition, with bounded
episode logging (at most 16 defer/proven entries per runner proof, plus the final
refusal); saturated helper churn cannot reset this logging allowance. It retains
process evidence: observation start/end monotonic times, unit MainPID/InvocationID,
cgroup versus tracked-only members, PID:start-ticks, comm/state/PPID/Tgid, the
allowlisted read-helper operation (otherwise null), current/previous instances,
resource summary and remaining deadline. Recovery entry/deadline, refusal changes
and completion are logged too. Optional diagnostic reads and throwing diagnostic
sinks never change a safety result; missing reads do not become identity proof.
Drift-only episodes emit one proven/final decision, not a line on every retry.
Arbitrary cmdline text and exception messages are not emitted by these diagnostics.
The historical R14 veto PID remains unknown; later captured helpers are evidence
of the mechanism, not identification of that historical member.

Host regression coverage includes captured-stat runner replay, shared-budget and
final-clock negatives, cgroup escape/PID reuse/stale NBD, and four actual SIGKILL
producer boundaries with a real independent flock/private job. The crash tests
inject RAUC/systemd observation authority; they are not the shipped PID-1 guardian
or board power-loss qualification. Existing D154 privileged-bypass and forward-only
schema residuals below remain unchanged. Fresh Rock and Orange Pi failover/status-
pressure, cancellation and unknown-success crash drills are still required.

Module-size accounting is not a claim of uniform compliance: `os-stage-run.ts`
(493 pure LOC) and `runtime.ts` (2,292) carry explicit `SIZE_OK`
lifetime/state-machine exceptions. `spawn-policy.ts` (1,350 pure LOC) and
`reducer.ts` (667) are inherited size debt, not newly compliant modules. Accounting
excludes blank lines and comment-prefixed lines (including embedded shell comments).
Orphan inspection is separated from the settlement lifetime without changing its
predicates. New FIX7/FIX8/FIX9 modules stay below 250 pure LOC. The four
fix-6 test files and fix-7 regressions require an explicit TypeScript program:
the normal backend tsconfig excludes tests and did not catch the fix-6 runtime
fixture's receipt-returning stage port or synchronous job-reader mismatch.

### Standalone real-RAUC helper-census proof [PARTIAL — host only]

`scripts/tests/real-rauc-private-bus.integration.ts` is an explicit host integration
proof, **not part of `bun test`, the backend suite or CI**. It requires host
RAUC **1.15.2**, `dbus-daemon`, `gdbus`, `busctl`, Bash, `timeout`, and a working
user systemd manager with readable cgroups. Supply the unmodified image
`ceralive-rauc-boot-adapter.sh`, `ceralive-boot-state.sh` and `boot-state-core.sh`.
The first two belong in `CERALIVE_BOOT_HELPERS`; the core path can be supplied
separately. From `apps/backend`, with an existing private scratch directory:

```bash
TMPDIR=/var/tmp/your-private-scratch BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
  CERALIVE_BOOT_HELPERS=/absolute/path/to/boot-helpers \
  CERALIVE_BOOT_STATE_CORE=/absolute/path/to/boot-state-core.sh \
  CERALIVE_RAUC_PROOF_OUTPUT=/absolute/path/to/receipt.json \
  bun test ../../scripts/tests/real-rauc-private-bus.integration.ts
```

The test creates a disposable private bus, uniquely named user RAUC unit and
file-backed slots, exercises real read helpers, and cleans them up in `finally`.
Its barrier releases the helper **between** census reads. Holding it through
both reads blocks the real daemon's GetPrimary/status request and times out at
10 seconds: that is a harness artefact, not justification to relax the guard.
The result requires observed helper identity, a refused drift observation, then
exactly one replacement after fresh clean proof. Install/guardian, boot-health
and resource/slot identity ports are synthetic. Five repeated host passes do
not qualify a real installation, either board, power loss or kernel routing.

### Unlaunched guardian settlement [PARTIAL — hermetic and real-fixture proven, board rehearsal owed]

A guardian that started but never reached `beginAttempt` (`launched:false`) is no
longer stranded. One shared settlement (`os-stage-unlaunched.ts`) serves three
callers: an acquisition failure after this attempt created its private state, an
failure caught before `beginAttempt` (including cancellation, revalidation and
selector refusal), and startup, which routes validated
unlaunched records here before the generic launched path. Pre-existing state,
another attempt's directory and `EEXIST` are never adopted; flock contention
(exit 75) becomes `os_update_lock_held` only after checked stop/reset replies,
fresh owned-terminal/job/kernel proof and positive unit absence. Failed cleanup
keeps the record and reports unsafe; acquisition does not silently retry that
failed cleanup in the same invocation. Startup can later settle the retained
terminal-unlaunched record. A competing kernel holder that prevents retirement
proof also keeps this path closed.

The settlement re-reads record and tokens from disk, parses the unit into a typed
shape (absent, starting, live, terminal), proves kernel lock ownership (cgroup
membership, process argv/ancestry/start ticks, one granted `FLOCK` on the lock
device+inode, no foreign fd holder), then proves RAUC quiescence, install-client absence
without a URL filter, unchanged slot/activation identity and clean pins (a
never-created table answering exit 2 counts as empty). A live guardian receives a
`releasing` record and the matching release token and must exit normally; expiry
of that wait never stops a live helper. A dead or cleanly exited guardian is
settled under the temporary update flock: `stop` only after a clean exit,
`reset-failed` only for the owned terminal unit with no queued job, then positive
absence. The witness is written before the job directory is retired, and the
original typed safe failure is preserved; an untyped failure or recovered unsafe
pre-launch failure becomes `rauc_install_failed`/`operator`. Every unproved step keeps the
unit, job and admission closed as `rauc_recovery_unproven`.

The device number comes from a validated open fd's `mnt_id` and the matching
`/proc/self/mountinfo` row, not a guessed conversion of `st_dev`. A lock on another
filesystem with the same inode is unrelated. Listed children that vanish or show
an unexpected argv (including the helper's short-lived `stat`) trigger at most
three complete scans; no extra process is accepted as steady guardian membership.
Unknown/partial RAUC argv cannot prove installer absence, and supported global
options before `install` cannot hide a client. Thrown timeouts and private/kernel
I/O failures inside physical settlement are normalized to the same unsafe reason
with the original cause. Startup's launched-writer recovery is isolated in
`os-stage-startup-recovery.ts`; its post-cleanup proof uses the bounded fresh
seam above without changing the unknown-outcome or release predicates.

Real flagged installer argv, helper/sleep cmdline and inherited-fd metadata, the
exact combined guardian observation request, pre-ready/ack-pending windows and
positive live-install resource/pin/progress receipts remain separate capture
gates. Synthetic negative/race fixtures are not replacement hardware evidence.

Every stage and recovery controller also holds
`/run/lock/ceralive-os-stage-control.lock` (the helper's `--orphan-lock` mode),
because fallback control ports let a second backend run. Order is control lease,
then guardian/update-lock proof; the producer's dispatch fence drops before its
lease is released, and a retained unsafe pin drains only under the reconciler's
lease. Lease contention is `os_update_lock_held`.
Runtime acquisition always selects the real lease unless a caller explicitly
injects the existing dependency port. Device type, `NODE_ENV` and `MOCK_MODE`
never disable it. The hermetic disposable lease exists only in the test helpers;
fixture builders inject it explicitly, without changing production lock paths.

Reconciliation returns `os_stage_outcome_unknown_after_restart`, never a
successful install. An idle daemon, a partly written inactive slot or a retained
receipt cannot manufacture `OS_STAGED`. No blanket dm removal, forced NBD
disconnect, lazy unmount or manual slot marking is performed. This path is
hermetically tested, including a captured 315-second retirement sequence and
real temporary-file flock contention; its device drill is still owed.

## Cross-slot missing-commit adjudication [EXISTS — root-only, fixture-proven]

`/usr/sbin/ceralive-update-recover` is a root-only (0700, root-owned) local
maintenance entrypoint in the CeraUI `.deb`. It is **not** a browser, RPC,
remote-control or sudoers operation. The wrapper takes the shared
`/run/lock/ceralive-update.lock` nonblockingly and executes the separately
compiled root-only recovery binary under that lock. The standalone binary
imports the shared, dependency-light RAUC identity readers
from `os-identity.ts`; it never initializes the normal backend boot graph or
loads `setup.json`. An unprivileged host build reaches its explicit `root_required`
refusal after parsing valid arguments, without a device setup file.

For a root-authorized maintenance window, stop the backend and make the mask
**effective** before invoking the tool. The package installs a regular unit file
at `/etc/systemd/system/ceralive.service`. A `systemctl --runtime mask
ceralive.service` only adds a `/run/systemd/system/ceralive.service` symlink;
systemd prefers the real `/etc` file over `/run`, so that mask leaves
`LoadState=loaded` and the unit can still start. `systemctl mask --force` does
not replace a regular `/etc` file either. Do not use either shortcut.

With external APT initiators quiesced, and with a vacant, protected backup path
that will survive until restoration, run as root:

```sh
systemctl stop ceralive.service
mv /etc/systemd/system/ceralive.service /etc/systemd/system/ceralive.service.recovery-backup
systemctl mask ceralive.service
systemctl show ceralive.service --property=LoadState,ActiveState,SubState,MainPID,ControlPID,Job
```

Proceed only when systemd reports `LoadState=masked`, `ActiveState=inactive`,
`SubState=dead`, both PIDs zero, and no pending job. The tool checks those same
properties at each admission boundary; it does not stop or mask the service
itself. This fences new legacy `system.startUpdate` requests, which bypass
orchestrator phases: on a legacy image the detached unit does not take the
shared lock; on a capable image it waits on the lock and could run after the
tool releases it. Keep the backup and mask
in place until the recovery tool has exited, even if it refuses or fails. Then
restore the unit **before** starting the backend:

```sh
systemctl unmask ceralive.service
mv /etc/systemd/system/ceralive.service.recovery-backup /etc/systemd/system/ceralive.service
systemctl daemon-reload
systemctl is-enabled ceralive.service
systemctl enable ceralive.service   # only when the line above printed "disabled"
systemctl start ceralive.service
```

**`unmask` strips the boot-time enablement symlink too, so re-enable before
starting.** `systemctl unmask` removes every symlink that resolves to the mask
target, directly or through another link. After the `/etc` unit is moved aside
and masked, `multi-user.target.wants/ceralive.service` — the enablement symlink
the package's `postinst` installs for the unit's `WantedBy=multi-user.target` —
resolves through `/etc/systemd/system/ceralive.service`, which is itself the
mask's `/dev/null` symlink; `unmask` therefore deletes both, and the restored
unit comes back `disabled` even while it runs. Board-proven on a Rock 5B+
(2026-09-28): after the unmask/restore/reload sequence,
`systemctl show ceralive.service --property=UnitFileState` read `disabled` and
the service would not have survived a reboot. Check
`systemctl is-enabled ceralive.service`; a `disabled` reading means the next
reboot silently drops the backend. `systemctl enable ceralive.service` recreates
the `multi-user.target.wants` symlink and is safe to run against an
already-started unit — it does not restart or otherwise disturb the running
process.

If any preparation step fails after the move, do not run recovery; restore the
file using the same unmask/move/reload/enable/start sequence. Do not overwrite an
existing backup or lose the real unit file across a reboot. A persistent mask
left in place after maintenance prevents normal backend startup — this stripped
enablement symlink is the same class of gap, a second way the backend fails to
come back after a reboot.

Invoke as root with the six independently captured, exact expected readings:

```text
/usr/sbin/ceralive-update-recover \
  --agent-sha256 <64 lowercase hex of agent.json bytes> \
  --plan-sha256 <64 lowercase hex of pending-packages.json bytes> \
  --boot-id <current UUID> --slot rootfs.1 \
  --compatible ceralive-rock-5b-plus --os-version <current CalVer>
```

`rootfs.1` is an **example**, not a default: read the booted rootfs name from
RAUC first. The six values are assertions about THIS boot/current slot, never
about the old slot. The actual tool re-reads them under the lock and refuses on
any mismatch. It requires an explicit `LoadState=not-found` apt detached unit
(an unreadable probe is not absence), no live apt/dpkg process or other active
update unit, RAUC `Operation=idle`, empty `dpkg --audit` output and an empty
`/var/lib/dpkg/updates/` directory. It parses the persisted failed state and
the exact pending plan, checks `commit_unit_absent_on_resume` and confirms each
planned version differs from the installed version on the **current** slot.
The prior slot's observed 1.0.1 is not a claim that B runs 1.0.1; B's observed
1.0.0 must be checked afresh at execution time. Every probe that fails or
cannot be read refuses. Ordinary Debian timers and unrelated root callers do
not obey the CeraUI update lock; the tool checks their running units/processes
before each irreversible boundary, but this is a snapshot, not a claim of a
system-wide timer mask. The board maintenance run must additionally quiesce
external APT initiators and prove the actual systemd/APT interaction.

After admission, a unique `recovery-<sha256>.json` receipt records the decision
`historical_outcome_unresolved_current_slot_unapplied` and the **original bytes**
of both files (base64), the six identity readings, and the expected cleared-state
digest. It is written to a private temp file, fsynced, renamed and parent-fsynced
before the old plan is unlinked and directory-fsynced. Only then does the narrow
`HISTORICAL_COMMIT_ADJUDICATED` reducer event move this exact failed reason to
idle, durably writing the state. Its scheduling clocks are invalidated; the plan
is gone and cannot be reused. A subsequent install requires new discovery. A
receipt-first or archive-first crash replays from the receipt's byte-exact plan;
an already-cleared repeat compares the final state digest and never creates a
second receipt. No installed notice, quarantine entry or automatic replay is
emitted. The broad `RESET` event is not exposed or used by this path.

The decision table, injected systemd/dpkg/lock probes, byte-level receipt and
crash windows run unprivileged in `update-cross-slot-recovery.test.ts`; the
shipped entrypoint/packaging and RPC/remote isolation are statically checked.
**Residual [PARTIAL]:** the ineffective runtime mask was reproduced on a Rock
5B+ with a throwaway `/etc` unit; the corrected recovery tool has not been run
against a genuinely masked `ceralive.service` there. A separately authorized
maintenance-window board step must verify effective masking and legacy-launch
exclusion, quiesce external apt timers, and run this exact packaged executable
before any live clearance is claimed. No recovery invocation or release is
inferred from the unit-level mask experiment.

After a successful package commit, `update-orchestrator/stale-services.ts` scans
`/proc/<pid>/maps` for deleted mappings under `/usr/` or `/lib/`, then reads
`/proc/<pid>/cgroup` to identify the owning `.service` unit. A missing or
unreadable mapping or unit is **not** restart evidence. A service may restart only
after the existing idle detector approves. `systemd*`, `dbus*`,
`NetworkManager*`, `ModemManager*`, `wpa_supplicant*`, `rauc*`, `pipewire*`,
`wireplumber*`, `polkit` and `user@*` are never restarted automatically: a
persistent, dismissible restart recommendation with a stable unit ID appears
instead. `polkit` is listed because `ModemManager.service` has
`Requires=polkit.service`, so restarting polkit restarted ModemManager on the
Orange Pi 5+ drill (2026-09-30, X4). `user@*` is listed because a user-unit
process reports its session manager as the owning service. The policy is a
name list, not a dependency graph: any other unit that `Requires=` an
auto-restarted unit can still restart with it. `ceralive.service`
is deferred while the update transaction is actually running and can restart
once the detached APT unit has settled; a stale mapping is never a reason to
terminate a process by PID. This is fixture-proven, not board-proven.

## Resuming an interrupted download [EXISTS — fixture-proven]

The persisted phase can lag a short commit: the tick enters `committing` only
after it sees the wire report `installing`, and dpkg can finish in a few
seconds, so a power cut inside dpkg can leave `downloading` on disk. On the
Orange Pi 5+ drill (2026-09-30, X1) that left the orchestrator in
`downloading` after the reboot, with no unit, every check and install refused
as `busy`, and the half-installed package never repaired.

On resume, a persisted `downloading` is adjudicated against what the install
unit probe actually established, never against a bare "nothing was recovered":

- **Unit observed.** Recovery reattaches a unit, or the wire is `installing`,
  `downloading`, `success` or `failed`: the phase is kept and the tick reads the
  outcome as before.
- **Absence proven.** The probe ran: `systemctl show` named the fixed transient
  unit and answered `LoadState=not-found`. Absence is not identity-checked
  (there is no unit to check); a loaded unit is, and an unreadable probe throws
  instead. `DOWNLOAD_RESUME_UNIT_ABSENT` drops the interrupted attempt: the
  phase returns to `idle` with the package check due immediately. The old plan
  is not replayed and is not deleted either: `pending-packages.json` is only
  read on the commit/settle path of an install, so it has no reader before the
  next install start. From `idle` that start normally comes through discovery
  (`available` → `awaiting-idle` → start), and a start from an `available`
  wire rewrites the record with discovery's plan before its unit exists.
  Discovery does not ensure the wire still reads `available` at launch,
  though: if the wire is reset in between, or the backend restarts in
  `awaiting-idle`, the start keeps the earlier record (the existing limitation
  under "Still open" below). If discovery still finds actionable packages, the
  normal `available` → `awaiting-idle` path installs them; if it finds none
  (the transaction completed before the cut, or boot-time dpkg recovery
  finished it), the device stays `idle`. Nothing is quarantined, no
  `installed` notification is sent for the uncertain transaction, and no
  `failed` phase is entered.
- **Undecided.** The probe threw, or never ran (updates disabled with
  `apt_update_enabled: false`, mock mode, or this process already observing a
  transaction). Recovery answers `false` in those cases too, and that is not
  proof of absence. The phase stays `downloading`, so a stream start still runs
  the D8 commit-stage probe, and the orchestrator asks the same question again
  on every tick for that resumed download only. It clears once a probe is
  conclusive: a reattached unit goes to the normal poll path, a proven absence
  to the recovery above. A download started later is never judged this way:
  the deferral is tied to a state generation that every state change advances
  (not to `enteredAt`, which two attempts can share), and a probe answer is
  applied only if nothing changed while it was awaited, in the same synchronous
  step as the transition. A stream start during the boot probe already sees the
  persisted `downloading`; its abort wins over a late answer.

With updates disabled the deferral lasts until they are re-enabled, and the
phase keeps reporting `downloading`. The immediate package check honours the
usual gates (`packagesAuto`, the cellular policy); with `packagesAuto` off it
waits for a manual check. A restart at any of these points adjudicates again
from the persisted phase. An uncertain `committing` is still never retried
(see above).

Still open:

- The persisted phase still lags a short commit (B1); this change does not
  alter how often `committing` is persisted.
- Existing limitation, unchanged since before the interrupted-download work:
  an install start overwrites `pending-packages.json` only when the wire reads
  `available`. After a backend restart in `awaiting-idle` the wire is `idle` or
  `checking` until rediscovery, and a manual install or the scheduled idle gate
  started then keeps the record on disk as it was; the launcher rediscovers
  the plan itself.   That record is the plan persisted before the restart, so it
  names the packages actually installed only if discovery's plan did not change
  in between. The same holds after a dropped interrupted download (above) when
  the wire stops reading `available` between discovery and the launch: the
  start keeps the dropped attempt's record, and its readers (the
  commit-failure quarantine, the `restarting-services` installed notice, the
  `committing` startup baseline) see that earlier plan, so a later commit
  failure can quarantine the earlier plan's packages. Owner decision pending.
- `ceralive-dpkg-recover` cannot repair a package interrupted during unpack
  (`iHR`); only a later install of that package does, and that now depends on
  discovery offering it again. Whether discovery and the install succeed while
  dpkg reports an interrupted state is not board-proven.
- A healthcheck that fails before `rauc status mark-good` marks nothing good
  but does not reboot the board, so the bootloader fallback only happens on a
  later reboot. One that fails after `mark-good` never falls back (see
  [DEVICE-UPDATES.md](./DEVICE-UPDATES.md)).

## OS staging recovery [PARTIAL — fixture-proven, board re-drill owed]

A failed OS stage is no longer a sticky `failed` by default. The persisted
`osStageRecovery` record (one exact signed candidate) decides what follows, and
nothing here clears a package, X6 or quarantine failure.

| Settled outcome | State | Automatic restage |
|---|---|---|
| typed `automatic` (transport, origin 429/5xx, lock held) | `os-available` | after 15 min, then 30 min; the third round becomes operator-only |
| typed `operator` (cellular approval, RAUC failure after safe cleanup) | `os-available` | never; Install now runs one more round |
| typed `unsafe` (recovery unproven, outcome unknown after restart) | `failed` | never |
| untyped error | `failed` | never (fail-closed, unchanged) |
| stream cancellation | `os-available` | as before; no round counted |
| success | `os-staged` | record cleared |

The synchronous receipt/publication callback precedes final producer settlement.
While that producer is pending, `os-staged` retains its active attempt identity
and cannot arm activation. A matching unsafe failure during release returns it
to `failed` with an unresolved notice instead of a stale retry promise. Late
untyped/non-unsafe errors are unsafe at this boundary too. The receipt and serial
watermark remain intact; they grant no activation permission, and no quarantine
is written. A stream start or the 60-second tick cannot turn pending release into
success. On restart, a pending publication is observed under the same writer-proof
rule as interrupted staging, never armed from the receipt alone.

Packages keep their own schedule while an OS stage waits or is paused: a due
package check leaves `os-available`, and the record rides through the package
phases unchanged. No staging failure writes `quarantine.json`; quarantine stays
reserved for activation-verification evidence.

**Resume.** A persisted `os-staging` attempt is observed and never replayed.
While RAUC's `Operation` reads running the phase waits; an unreadable read
defers to the next tick; once RAUC is idle and the guarded adapter proves writer
quiescence the attempt settles `unsafe` with
`os_stage_outcome_unknown_after_restart`. The orchestrator never infers
`OS_STAGED` from a good target slot, a matching version, an old staged receipt
or a mirror receipt.

**Leaving `failed`, two narrow ways, both on positive evidence only.** Every
reading must positively agree: RAUC `Operation` idle, a writer-quiescence proof
from the RAUC recovery adapter, exactly two rootfs slots with the booted one
`good` and carrying this boot's `healthy-state.json`, the other `inactive` and
`bad`, no `os-staged.json` receipt and no `activation-armed` marker. A good
inactive target is refused: RAUC marks a completed install good, so it could
be a stage nobody recorded. Any unreadable input is "not proven".

- **Legacy migration.** Only the exact record an older build persisted,
  `failed / rauc_install_failed` with no recovery record, migrates (at start
  and on each tick) to `idle` with the OS check due 15 minutes later, so fresh
  discovery re-admits the candidate. No other failed reason migrates, by prefix
  or otherwise.
- **Unsafe-record confirmation.** A manual check (Check now) on `failed` with an
  `unsafe` record requires a settled attempt (`activeAttemptId === null`), its
  reason equal to `failureReason`, and exactly `rauc_recovery_unproven` or
  `os_stage_outcome_unknown_after_restart`. Only then, with all positive evidence
  above, does it dispatch `OS_STAGE_RECOVERY_CONFIRMED` and run discovery; the
  next round is operator-only. A generic untyped terminal record cannot be
  confirmed. Rejection retains the unresolved notice; only an accepted transition
  clears it. A retained staged receipt prevents confirmation even with writer proof.

**A consumed staged receipt is retired [PARTIAL — host-proven, board re-drill owed].**
`os-staged.json` records version, channel, `stagedAt` and the producer boot.
New writes optionally record strict `installedImage` evidence read after successful
installation: rootfs slot name, RAUC bundle hash, rootfs checksum and install
timestamp/count. Missing or malformed optional observations leave that field absent;
they cannot mint identity. Old receipts remain readable but **cannot be retired
automatically**. A receipt is consumed only when ALL of these hold under CONTROL:

- its version equals the booted OS version (`/etc/ceralive/os-release-version`);
- its recorded `installedImage` exactly matches fresh RAUC booted-slot identity;
  the slot is good, names the actual root device and has this boot's matching
  healthy-slot verdict. RAUC bundle versions are not CalVer and are never equated;
- its boot id differs from the current boot, and this boot carries its own
  `healthy-state.json`;
- the phase is not `os-staging`, `os-staged`, `os-activation-armed` or
  `os-verifying` or package `committing`, no attempt is active and no producer runs;
- persisted agent recovery identity agrees with memory, read under CONTROL before
  evidence gathering and again at the final rename boundary. Drift, missing
  authority, open persisted lifecycle or an active attempt means KEEP;
- `activation-armed` is absent by **lstat ENOENT only**, and RAUC's `Operation` is
  idle. The marker is probed again after the final awaited authority read, before
  synchronous retirement. EACCES, ENOTDIR and other errors remain unknown;
  dangling symlinks are present.

A syntactically valid but incorrect version stamp is not identity proof: a settled,
unarmed installation can still boot the previous image. Reading the receipt as
judgment evidence captures device, inode, size, nanosecond mtime/birthtime and a
SHA-256 of its bytes through a no-follow regular-file descriptor. Retirement
re-reads and compares that captured identity, not merely parsed JSON equality;
an identical-JSON replacement inode is kept. Path operations use a validated
directory descriptor, and the last synchronous lstat checks device/inode/size/mtime
before rename to `os-staged.consumed.json`. Its bytes remain evidence.
Symlink/hardlink/non-file receipts are never retired.

**The final rename is not a filesystem compare-and-swap.** A writer bypassing
CONTROL can replace the entry after the last lstat and before rename(2), or mutate
bytes after the final hash read. That privileged/noncooperative window is not
closed by another pathname check. Cooperative staging holds CONTROL from receipt
baseline capture through the final publication callback and producer release;
backend activation arming and receipt rebinding hold that same lease. The runner's
commit-token check includes lease liveness, and arming refuses an unheld lease.
Real-flock tests prove competing cooperative writers cannot enter these lifetimes;
they do not claim resistance to a privileged writer ignoring the lock.

**Cooperative writer census.** `commitStagedManifest()` in `os-agent.ts` publishes
through the leased stage callback; `rebindStagedReceipt()` writes through runtime
activation reconciliation under CONTROL. Retry enters the same leased stage path.
`saveStagedManifest()` is a low-level export and does not itself require a lease;
the exclusion claim applies to observed production callers, not every invocation.
The retained first-lstat replacement test proves KEEP at the descriptor entry
check. `os-receipt-final-lstat-residual.test.ts` separately pins that a pathname
replaced immediately AFTER the final lstat and BEFORE rename is still consumed;
it documents the residual rather than promising conditional rename.

**Accepted residual D154: privileged/noncooperative arming.** A root process or
the image systemd helper `ceralive-rauc-activate.sh --arm/--stop` takes the helper's
activation flock, not CeraUI's CONTROL lease. A direct `--arm`, including a helper
surviving caller death/timeout, can bypass CONTROL and race the last marker probe
before rename. The final re-probe closes the cooperative backend path only.
Retirement applies only to an ALREADY-BOOTED image's receipt; staging a new
candidate publishes a NEW receipt under CONTROL, and the identity check refuses
to consume that replacement. ExecStop activation deliberately stays CONTROL-
independent, so holding CONTROL does not block shutdown activation. This accepted
scope is not a claim of exclusion against privileged helper effects.

A directory-fsync failure after rename reports **retirement durability pending**,
not “receipt kept”. Subsequent CONTROL passes acknowledge the directory even when
the live receipt is absent; that acknowledgement does not mutate agent state.
After successful acknowledgement, the store remembers the tombstone's complete
device/inode/size/nanosecond mtime/birthtime/hash identity for this process lifetime.
Unchanged acknowledged tombstones no longer acquire CONTROL or fsync on every
tick. Failure never grants cached acknowledgement; identity changes require a
fresh sync, and a new process generation acknowledges again. No stored format
changes or cross-process durability assumptions are introduced.
Crash residue converges without replaying an installation. This is host process-
crash proof, not board power-loss qualification. Retirement runs at startup, on
each tick and before Check now or Install
now, ahead of witness settlement and unsafe-record confirmation.

This removes only the receipt blocker. **Both slots `good` still refuses
confirmation**, by the rule above. **HISTORICAL Rock evidence:** the legacy `.64` receipt has no
image binding and now stays intact; close install/publication timestamps do not
prove identity. Its failed `.68` record remains `failed / unsafe` independently.
A new, positively bound receipt can retire without clearing a both-good failure.
No owner-approved bench reset or activation is performed by this change.

**CURRENT Rock state supplied on 2026-10-10 (not a new board observation here):**
the legacy `.70` receipt was written on the prior boot by the `1f6a990e` bench
`.deb`; the board is booted on `2026.10.70`, both slots are good and the agent is
idle. This head KEEPS the receipt because `installedImage` is absent. It is inert:
the next Check → stage → install → staged → armed flow is unobstructed. The oracle's
Q5 real-file/runtime repro exercised that flow with fixture RAUC/arming ports,
not a board install. The historical failed/unsafe `.68` case is not this idle state.

**A pre-existing receipt is not necessarily this attempt's outcome [PARTIAL —
host-proven].** New private job records capture strict optional `receiptBaseline`
under CONTROL before guardian acquisition: `null` records positive absence; an
identity records the existing receipt without restamping it. Completed private
never-launched witnesses carry that baseline. Physical settlement still requires
`launched=false`, unchanged daemon/boot/slot/process/resource evidence, retired
clients and pins, and no activation marker. An unchanged baseline receipt is inert
for that proof and is neither deleted nor consumed. A created, replaced or changed
receipt vetoes settlement, even if its JSON is identical. State-side recovery
rechecks the baseline after its final awaited authority read before permitting
operator retry. Legacy job/witness records without `receiptBaseline` retain the
old presence veto. Unreadable identity is uncertainty, never positive absence.

Thus the HISTORICAL stale legacy `.64` receipt on booted `.64` no longer obstructs a positively
proved never-launched next attempt. It does **not** make an unrecorded successful
installation safe: launched provenance cannot produce this witness, and the
HISTORICAL Rock both-good failed/unsafe `.68` case without a matching completed witness
remains failed/unsafe. Host regression and mutation evidence do not qualify these
paths on either board or under power loss.

**Accepted residual D154: schema-1 additive fields are forward-read compatible
only.** `receiptBaseline` remains optional in strict schema-1 stage job/witness
records: this head reads older records, but older unreleased bench intermediates
`1f6a990e` and `d28fff27` reject records carrying it with `unrecognized_keys`.
Persistence across reboot does not make those records readable by an older backend.
`2026.9.5` is the FIRST release containing the orchestrator, so no released backend
reads these records. The other strict records (sync receipt and staged receipt's
`installedImage`) follow the same additive-forward-only discipline.
Rolling a bench board back to an intermediate build requires clearing its stage
job/witness records as a bench-only operation, only after positive no-writer proof
and preservation of recovery evidence; this is not an operator recovery shortcut.
Any future schema evolution must follow this same compatibility rule or bump the
schema number. Stored job/witness/receipt formats are unchanged by this correction.

**Admission refusals name their predicate [PARTIAL — host-proven].** The thrown
`rauc_recovery_unproven` error keeps `refusal: "stage-admission-unproven"` and
its unsafe mode. Its diagnostics add `predicate`, the first failing check in
evaluation order (`observation-unknown`, `daemon-inactive`, `operation-not-idle`,
`resources-present`, `extra-process`, `booted-unhealthy`, `target-not-inactive`,
`boot-primary-unknown`, `boot-primary-not-booted`, `boot-primary-is-target`,
`activation-armed`, `baseline-changed:<field>`) and, when the observation itself
stopped, `observation`: the boundary name plus allowlisted class/code, bounded to
200 characters, or `<boundary>: unproven` for a reply that
proved nothing. The refusal is logged once as
`update-orchestrator: OS stage admission refused`. Diagnostics are log-only; no
RPC schema changed, and the set of admitted snapshots is unchanged. Arbitrary
exception messages, class names and codes are omitted rather than sanitized.
Throwing exception getters use a safe fallback; formatting and reporting cannot
replace the observer's null refusal, even with no sink.

**Invalid recovery metadata is not first boot.** Schema 1 still makes the fields
optional, but present recovery must agree with phase, active identity and retry
deadline. Invalid or contradictory metadata raises a typed load error. Startup
retains any valid legacy terminal failure (including package/X6), keeps the
original file untouched, and closes migration/check/install until maintenance
repairs the record and restarts the backend. An absent recovery field leaves
legacy package/X1 resume unchanged; this adds no general clearance path.

The production writer-quiescence proof is supplied by the guarded RAUC
recovery adapter. Uncertain ownership or resource retirement keeps both exits
closed; the record stays terminal and the notice tells the operator to
re-verify or contact support. There is no general failure-clearance RPC, and
deleting `agent.json` is still never a recovery step.

## `quarantine.json` version 1

Stored at `/data/ceralive/update-state/quarantine.json`, written by atomic
rename and parsed strictly (unknown schema or invalid shape fails closed):

```json
{
  "schema": 1,
  "packages": [{ "name": "cerastream", "version": "2026.9.10" }],
  "os": [{ "version": "2026.10.0", "bootedVersion": "2026.9.1" }],
  "failedCommits": [{ "id": "transaction-id", "reason": "apt-exit-1" }]
}
```

All three arrays are required, empty on a new device. `packages` contains
**exact** bad `(name, version)` candidates, not installed versions, prefixes,
or version ranges. `failedCommits` records a confirmed nonzero APT commit even
if no exact package version is known; it is diagnostic and must never mint a
guessed APT pin. The APT pin file is `/etc/apt/preferences.d/ceralive-quarantine`,
one `Package: <name> / Pin: version <version> / Pin-Priority: -1` stanza per
exact candidate. The backend writes a private source file and delegates its
fixed-destination installation to `systemd-run`; no shell interpolation or
general-purpose privileged writer is exposed. The failed plan survives backend
restarts in the adjacent `pending-packages.json` file until success/failure is
observed. On discovery of a **newer** candidate (Debian `dpkg --compare-versions
candidate gt bad`), the exact old pin is removed and the store is rewritten.

The lagged mirror also runs this same comparison against the *installed*
package versions after successful sync. Rollback evidence and failed commit
diagnostics remain untouched; neither is superseded by an installed package.

For Todo 39, **read `os[].version` to reject a manifest version**. It is the
expected *staged* version after activation; `bootedVersion` records the surviving
version observed after a reboot/rollback and is diagnostic only. The writer
`recordOsRollback(expectedVersion, bootedVersion)` must be called only after the
booted slot's actual version differs from the expected staged version. Never
quarantine the surviving version. A new slot that boots but fails its
healthcheck is not verified: the orchestrator stays in `os-verifying` across
its repeat boots. If those failures come before `rauc status mark-good`, the
entry is written by the later boot on the old slot (the bootloader fallback),
with `bootedVersion` naming that old version. If the slot was marked good but
its healthy record could not be written, there is no fallback and no entry:
the orchestrator waits in `os-verifying` indefinitely (see
[DEVICE-UPDATES.md](./DEVICE-UPDATES.md)). `isOsVersionQuarantined(version)` is the query
API; it does not mutate state or infer a rollback from a failed download.

Notifications use stable `update:<event-kind>:<identity>` names and the existing
persistent-notification store, dismissal store, and allowlisted `updates-dialog`
action. Notification producers and their current limits are listed in [DEVICE-UPDATES.md](./DEVICE-UPDATES.md#notifications).

## Lagged slot mirror [PARTIAL — fixture-tested, no CeraUI board drill]

`slot-sync-gate.ts` is the pure, I/O-free pre-dispatch predicate. The image must
explicitly advertise `slot-sync`. The healthcheck's
`/data/ceralive/update-state/healthy-state.json` carries `boot_id`, `slot`,
`build_id`, `dpkg_status_sha256`, `recorded_at`; its boot ID, SHA-256 of the
current `/var/lib/dpkg/status` bytes and current build ID must agree. Build ID
comes from `/etc/os-release`'s first `BUILD_ID=` (quotes removed), falling back
to `/etc/ceralive/image-build-commit` only when empty. The image's
`sync-receipt.json` carries `state_sha256`, `build_id`, `image_version`,
`target_slot`, `completed_at`; an absent receipt permits a first sync, while a
matching status SHA whose `target_slot` names the slot that is not booted now
means the state is already mirrored. An APT commit within
the current uptime has no matching boot-health record and cannot be mirrored.

At startup and on every idle tick, a passing predicate dispatches
`SYNC_ELIGIBILITY_CONFIRMED` (`idle → sync-eligible`), then the same predicate is
rechecked before `SYNC_STARTED` and `systemctl start --no-block
ceralive-slot-sync.service`. `OS_VERIFIED` also reaches `sync-eligible` and
attempts promptly; it is dispatched only once this boot's healthy record exists
(see [DEVICE-UPDATES.md](./DEVICE-UPDATES.md)), so the gate's boot-health
condition already holds for the first mirror attempt after an OS update. A failed precheck returns
to idle with no unit start. A stream does not block this local-only operation;
commits and OS staging do. CeraUI treats its own busy phases as the cheap lock
precheck; the unit holds the shared update and dpkg locks nonblockingly. It also
checks `dpkg --audit`, partlabel guard, RAUC Operation, pending installation and
hawkBit under those locks. CeraUI deliberately does **not** duplicate the live
integrity probes before dispatch, because a pre-dispatch read cannot close that
race. Exit 75 is a typed refusal, unlike an operational failure. A oneshot's
stale previous exit-0 does not settle a newly queued run without its current
SHA-256 receipt.

Completion is confirmed by that receipt, not by the unit's exit status. The unit
is `Type=oneshot` without `RemainAfterExit`, and systemd 257 (Trixie) unloads a
finished oneshot within about a second, which resets `ExecMainCode`; the probe
then reads `inactive-clean`, so an exit 0 (`succeeded`) is only seen if a poll
lands inside that window. The receipt is consulted for exactly two positively
validated shapes, and for no other (`classifySlotSyncProbe`, `lock.ts`). Both
require `systemctl show` to have exited 0 and to have reported each of the five
properties exactly once (a repeated key, even with an equal value, fails
closed, because the last value would otherwise win) with `LoadState=loaded`,
`ActiveState=inactive` and `SubState=dead`; `succeeded` additionally requires
`ExecMainCode=1` (CLD_EXITED) with `ExecMainStatus=0`, and `inactive-clean`
requires both `ExecMainCode` and `ExecMainStatus` to be empty or `0`. A read
the parser would have taken for either of those shapes but that fails this
validation (nonzero `systemctl` exit, empty or incomplete output, a repeated
key, any other lifecycle, a killed process, a nonzero `ExecMainStatus` beside
`ExecMainCode=0`) is classified `absent` and, once the queued-start grace
below has passed, fails as `slot-sync-unit-absent` without consulting the
receipt, because the unit writes the receipt before its
last step, `rauc status mark-good other`, which can still fail. The restriction
covers only those two receipt-consulting branches: the parser's `running`,
`failed` and `refused` verdicts are kept as they are, and none of them settles.
For example, `ActiveState=active` still reads `running` even if `systemctl`
exited nonzero, and a complete inactive/dead record with `ExecMainCode=1` and
an unparseable `ExecMainStatus` reads `failed`. A failed unit is not unloaded,
so refused and failed runs are still detected from the unit; an exit status of
75 is the typed refusal whether systemd records it as `failed/failed` or as
`inactive/dead`.

On either validated shape during `syncing`, `pollSlotSync` reads the receipt.
Its slot identity (`classifyReceiptTarget`) is resolved from the
`/etc/rauc/system.conf` bootname map and this boot's healthy record, never from
a timestamp, and is one of `other` (it names the slot that is not booted now),
`not-other` (it names a known slot that is not the other rootfs slot, such as
the booted one) or `unknown` (that map and record cannot decide). The
pre-dispatch gate and the poll treat `unknown` differently. The gate never
dispatches on it: with a matching SHA it skips the tick
(`slot-identity-unknown`). The poll keeps a receipt whose state SHA-256 equals
the current dpkg status as a candidate unless its identity is `not-other`;
only `not-other` rules a receipt out, and for an `unknown` one RAUC decides
below. On a candidate it takes a
second, fresh probe, and if that probe again reads one of the two shapes it
reads RAUC (`rauc status --detailed`, rootfs slots only) before any verdict.
It settles `synced` only when RAUC reports exactly one `booted` and one
`inactive` rootfs slot, the receipt's `target_slot` names the inactive one (by
slot name such as `rootfs.0` or by bootname), and that slot's `boot_status` is
`good`. If that slot is `bad`, the mirror was interrupted between its receipt
and `rauc status mark-good other` (for example a power loss; after the reboot
the unit reads as never run this boot): the phase fails as
`slot-sync-incomplete`, persisted before anything else, rather than claiming a
mirror RAUC never confirmed. Before calling it incomplete the unit is probed once more: a
re-run that has started meanwhile (it un-marks its target while copying) keeps
the phase `syncing`, and a failed or refused re-run keeps its own verdict. If
RAUC cannot be read or reports another shape or status, there is no verdict
this poll: the phase stays `syncing`, a warning is logged once per change of
reason, and the next poll asks again. If RAUC shows that the receipt names the
booted slot, the receipt is not evidence for this run and is handled like a
non-matching one (grace, re-probe, then `slot-sync-unit-absent`); re-reading
that same receipt cannot defer the verdict again. The healthy record's slot
identifies the booted slot only when its `boot_id` is this boot's. After a
reboot with the phase still `syncing`, the new boot's healthcheck rewrites that
record only once the backend is up, so the first polls see an `unknown` slot
identity; such a receipt stays a candidate and RAUC, which names this boot's
booted and inactive slots itself, decides between `synced`,
`slot-sync-incomplete` and no verdict. A matching receipt alone does not prove
that this run finished cleanly. Within one boot the gate refuses
(`already-synced`) to dispatch while a matching receipt already exists, so on
that path a candidate was written by this run. On the resume path after a
reboot the receipt can predate the reboot, and what proves the mirror is RAUC's
view of this boot's slots, not the receipt's age. Either way the unit writes
the receipt before its last step, and the first probe can still be the previous run's
finished record while this run's job was queued. A second probe that reads
`running` waits; `failed` or `refused` fails with that verdict, persisted
before `reset-failed` clears the unit's record; an `absent` second probe gives
no verdict this poll (one unreadable `systemctl show` right after a clean read
is more likely transient than a vanished unit), and the next poll's first probe
fails a persistent `absent` as `slot-sync-unit-absent` once the queued-start
grace below has passed. A mismatched, missing or unreadable receipt leaves
`succeeded` waiting (the unit may be a queued re-run still showing the previous
exit). For `inactive-clean` and `absent` it is not terminal at first:
`systemctl start --no-block` queues the job behind
`ceralive-healthcheck.service` (the unit has `Requires=`/`After=` on it), and
until the job starts the unit still reads the previous run's unloaded shape.
Such a read is only failed once `SLOT_SYNC_QUEUED_START_GRACE_MS` (90 s, 30
polls at the 3 s active tick) has passed since the phase entered `syncing`
(`enteredAt`); a clock that stepped behind that start counts as past the grace.
On the shipped image that queue lasts milliseconds: the gate dispatches only
after the healthcheck wrote this boot's healthy record as its last step, the
healthcheck unit is `RemainAfterExit=yes`, and a re-run is a boot-id no-op
(image-building-pipeline `mkosi/runtime/ceralive-healthcheck.sh` l.444-456 and
l.474-476, `ceralive-healthcheck.service` l.22, at `36d8131`). The 90 s (the
healthcheck's own 60 s `HEALTHCHECK_TIMEOUT` plus 5 s probe timeouts, with
margin) is a defensive bound for any delayed start job, not a measured wait. Even then an `inactive-clean` read is re-probed first, because the
job may have started or finished while the receipt was read: `running` waits,
`failed`/`refused` keep their verdicts, and a clean re-probe re-reads the
receipt and judges that fresh copy, leaving a now-matching receipt to the next
poll. Only a clean re-probe with a still non-matching receipt fails as
`slot-sync-unit-absent`.
Hardware basis: both bench boards recorded `slot-sync-unit-absent` 1-3 s
after a successful mirror had written its receipt and marked the other slot good.

Known limitations of the grace, recorded rather than fixed:

- The grace is measured on the wall clock (`deps.now()` against `enteredAt`).
  An NTP step FORWARD while the phase is `syncing` makes the elapsed time jump
  and can therefore shorten the grace; a step backwards counts as past the
  grace, as above. Both fail closed, never towards a false `synced`.
- `SYNC_STARTED` is persisted before `systemctl start --no-block` runs. A
  backend that dies between the two leaves a persisted `syncing` phase with no
  job ever queued, so after the grace the unit still reads its previous
  unloaded shape and the mirror fails as `slot-sync-unit-absent`. That failure
  is sticky (nothing dispatches `RESET`) but honest: no mirror ran.

On confirmed success the phase becomes `synced` *before* four independent,
best-effort effects: reuse bounded `apt-get clean`, remove leftovers from
`/data/ceralive/rauc-downloads`, reconcile superseded failed package versions,
and refresh both-slot status. Only afterwards does the existing `slots-current`
notice say “Both system slots are up to date.” A cleanup failure warns but
cannot reverse the mirror verdict. The internal `readBothSlotStatus` /
`parseBothSlotStatus` seam reads RAUC's detailed rootfs slot records and overlays
the target's receipt version (RAUC keeps an old bundle version after rsync);
an OS install newer than the receipt supersedes it. Bundle version and install
time are read from RAUC 1.15's nested `slot_status` (the flat shape is still
accepted), and a non-rootfs slot such as `certs.0` with `null` bootname and
boot status is tolerated and left out. Todo 41 exposes it through
the additive `system.getUpdateDetails` RPC (`slots` is `null` unless the image
declares `slot-sync` and `rauc status` answered), and the Updates dialog's Slots
section renders A/B version, state, health and last mirror time from it.
`device-stats.raucSlot` remains the S1-locked single bare string.

## Unlaunched settlement witness [PARTIAL]

Update mutations cannot run against module-initialized idle. Check, Install and
the synchronous cellular grant require completed validated startup; arrivals
during load/resume/recovery get the retryable WebSocket RPC error
`UPDATE_ORCHESTRATOR_INITIALIZING`. An invalid-present terminal record never opens that barrier.
Read-only status, unrelated RPCs and stream admission remain available. The
runtime enforces the same rule for direct callers; explicit fixture dependency
injection supplies an initialized test runtime, never a production bypass.

`os-stage-unlaunched-witness.ts` exposes the internal guard/state handoff at
`/data/ceralive/update-state/os-unlaunched-settlement.json`. The guard must call
its writer only after physical settlement and before retiring the job directory.
Writes use an exclusive no-follow mode-0600 temporary file, file fsync, atomic
rename and parent-directory fsync. Consumption is matching-attempt-only unlink
plus directory fsync. Reads require a trusted non-peer-writable directory, a
regular single-link uid-owned mode-0600 file, strict canonical schema/UTF-8 and
a 16 KiB limit. Candidate identity is derived from the parsed manifest using
`osStageCandidateKey`, never by comparing the job's JSON string to a recovery key.

Guard/state integration is implemented and fixture-tested; board qualification
is owed. Future OS attempts persist optional UUID-validated `osStageRecovery.attemptId`
before effects, alongside the active ID; all failed-round settlement retains it
when active identity is cleared. Both IDs must agree while active. This record
is persistence-only: no frontend/RPC output or binding schema gains a field.
No record boot ID is persisted. Consumption requires the witness boot ID to
equal the **current** boot, its attempt ID to equal the retained record ID, and
its derived candidate key to equal that record's canonical key.

`OS_UNLAUNCHED_STAGE_SETTLED` is an internal event, not a ninth failure reason.
A matching interrupted `os-staging` counts one failed round; an already-counted
`failed` record can qualify only with null active identity, unsafe mode, a reason
matching the phase's failure and exactly `rauc_recovery_unproven` or
`os_stage_outcome_unknown_after_restart`. It retains its round count. Both return
to `os-available` with `rauc_install_failed` / `operator`, no automatic stage.
A good inactive target is allowed only on this provenance-specific path.
`osStageFailureSettledSafely` still demands a bad target for generic confirmation.
The original bench D8 record lacks historical identity and **remains unsafe**:
same-candidate witness evidence is never a wildcard. Its existing manual
confirmation path is unchanged. A reboot without a completed current-boot
witness also stays unsafe; no orphan-free reboot is treated as proof of outcome.

The adapter requires fresh idle RAUC, writer quiescence, a healthy current-boot
booted rootfs, exactly one inactive target, and no receipt or armed activation.
Generation, phase, candidate object, recovery object, active attempt and live
producer identity are fenced across the await. The cross-process control lease
is held from witness read through readiness, authoritative `agent.json` re-read,
dispatch/persistence and consumption. The disk phase, failure reason and complete
recovery identity must still match the snapshot (or its same-attempt operator
cleanup replay); drift throws `rauc_recovery_unproven`, preventing startup's
final save from overwriting another backend's newer unsafe attempt. Local
generation fences remain necessary but are not a cross-process proof.
It runs on startup, scheduling
ticks and both manual check/install admission paths. It consults the witness
before interrupted-stage uncertainty is recorded; later guard proof can also
settle an identified already-persisted unsafe failure. Invalid persisted recovery
still latches terminal admission closure, never fresh idle (H2-R2).

| Crash window | Restart behavior |
|---|---|
| Before completed witness publication | No state clearance; guard must retain/re-prove its job |
| Witness exists, before agent.json persistence | Witness remains; the original attempt settles once on retry |
| Persistence fails after dispatch adopts memory, including parent-directory fsync | Witness remains and a persistence-pending latch closes admission; inconclusive later readiness cannot retire the witness or grant a new attempt. Only successful settlement persistence clears the latch |
| agent.json durably persisted, before witness consumption | Operator record replays matching cleanup only; no second round and no repeated notice remove/show |
| Witness consumed, backend restarts with an empty notice store | No witness replay; startup hydrates the missing policy notice from the persisted record without touching an already-present or unrelated notice |
| Another backend replaces the attempt across readiness | Authoritative identity mismatch refuses settlement and the startup tail; the newer record is not overwritten |
| New attempt races a guard publishing its completed witness | One control lease serializes guard publication, leftover retirement and new identity persistence; the stage runner borrows that same lease rather than acquiring again |

The unchanged `dispatch` persists before the consumer proceeds. State saves fsync
the state file, rename it, and fsync its parent directory before witness unlink.
The pending latch wraps that unchanged adoption/write boundary; a failed write
cannot make operator-mode memory permission to install. Accepted
settlement replaces only the candidate's unresolved notice with
`os-stage-operator`, before matching witness retirement; other candidates and
OS-check notices are untouched. No staged, activated or success notice is raised.
Before any new attempt starts, the runtime acquires the control lease and
rechecks its authoritative recovery identity. Any leftover witness (same or other candidate,
including one a legacy record could never consume) is consumed synchronously:
the new attempt replaces the persisted identity so no earlier witness can match,
and a leftover file would make the guard refuse the new attempt's witness write.
A failed read or consumption refuses that admission. The lease remains owned by
the runtime through `OS_STAGING_STARTED` persistence, the borrowed stage runner
and its terminal state write. A borrower never releases its owner's lease.
Overlapping startup calls join one promise and already-started calls are inert;
the downloading-startup block is unchanged. Malformed present attempt UUIDs
follow H2-R2's terminal-load path, while absent legacy identity stays valid.
No guardian/systemd/orphan implementation, slot mutation or hardware qualification
is introduced by this state-side change.
