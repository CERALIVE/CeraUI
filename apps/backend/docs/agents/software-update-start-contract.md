<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## SOFTWARE-UPDATE START CONTRACT [EXISTS]

This is the launcher the orchestrator's package step calls
(`startSoftwareUpdate()`), on legacy and `apt-all-packages` images alike.

Post-acceptance limits: root AGENTS.md D8 Known gaps (c).

- **`apt_update_enabled` defaults to TRUE** (`SETUP_CONFIG_DEFAULTS`,
  `helpers/config-schemas.ts`). Do not treat an absent optional key as disabled.
- **`startSoftwareUpdate(): UpdateStartOutcome`.** Every synchronous refusal is a typed
  `UpdateStartRefusal` — `updates_disabled` / `streaming` / `already_updating` /
  `check_unavailable` — logged at `warn` and returned to the caller.
  `rpc/procedures/system.procedure.ts` `startUpdateProcedure` forwards it as
  `{success:false, error:<reason>}` and does NOT re-check the guards itself;
  duplicating them is what let a refusal answer `{success:true}`.
- Latching a declined pre-check would wedge `isUpdating()`. For later latch gaps,
  see "D8 stream/update admission: what it does NOT cover" under Known gaps in
  the root [`AGENTS.md`](../../AGENTS.md).
- **`resetSoftwareUpdateState()`** is a test seam (mirrors the `reset*Runner`
  seams): it drops the in-flight latch and the last terminal outcome. Never call
  it from production code — it would discard a real in-flight update.
- **The package transaction is NOT a child of `ceralive.service`.** On
  2026-08-29 the update path was confirmed to kill itself: upgrading CeraUI runs
  a package script that restarts `ceralive.service`, and systemd then terminates
  every process left in that unit's cgroup — including the `apt-get`/`dpkg`
  transaction performing the upgrade. `software-update-process.ts` launches the
  transaction as a PID-1-owned transient service instead. This is a service, not
  `systemd-run --scope`: a scope remains caller-owned and did not survive the
  parent-unit teardown in the rootful regression drill.
- **Progress is durable, never pipe-owned.** `systemd-run --pipe` couples the
  transaction's output to the backend process and produced `SIGPIPE` after the
  parent unit stopped. The transient service appends stdout/stderr under
  fixed `/run/ceralive/software-update.{stdout,stderr}` files and runs the
  released commands (`ExecStart` unchanged) with `LC_ALL=C` set on the unit
  (`--setenv`; systemd gives a unit its manager's locale, not the caller's, and
  the counted lines are translated). APT gets no telemetry descriptor (no
  `APT::Status-Fd`, pipe or extra file), because APT 3.0.3 fails an install
  whose status write failed and a pipe makes APT wait on its reader. The
  root-owned directory is not peer-writable, file creation is exclusive and
  no-follow, and the files are mode 0600. Caller-selected paths are rejected.
  Progress is a pure function of the complete stdout lines read
  (`apt-progress.ts`), counting only whole lines in APT's and dpkg's own shape,
  each package step once: the plan's package lists and dpkg's
  `Unpacking`/`Setting up` steps of planned packages give a number capped at
  99 (any dpkg step gives the phase); a sized `Get:` line gives the
  Downloading phase only, because APT prints it as an archive starts and
  nothing as one is done; the step fields are phase markers. No wall-clock
  deadline is added: a valid package transaction may run for minutes. Each
  changed frame publishes both `updating` and `update_state`. Every poll and
  the final drain read stdout then stderr, each until a read returns nothing
  (bounded per poll), so output larger than one bounded read is replayed
  whole. Four consecutive unreadable polls send the phase without a number.
  Recovery announces a reattached unit only from a poll that read both files
  to their end without an error; until recovery settles
  (`beginSoftwareUpdateRecovery` before the WS server binds), initial pushes
  omit `updating` and `update_state` rather than send `null` or idle state.
  An attached recovery answers later callers without changing state. The
  bootstrap's `observe` starts recovery at boot with startup's verdict as
  `ownership`: the unit's progress and outcome are shown at once; retirement,
  cache cleanup and the restart wait for an admitted startup, and a refused or
  failed one leaves the unit watched only. `holdUpdateProgress`
  (`@ceraui/rpc/package-progress`, shared with both browser views) keeps a
  running transaction's phase and in-phase number from moving back, and lets
  a same-phase frame without a number replace a held one; the browser shows a
  number only while the device's own latest frame on this connection carries
  it in the same phase and not below one already shown in that phase, from a
  drop until that field is delivered again (the status ingestion announces each
  delivery of `updating` and `update_state`, an unchanged one included). The in-process pinned prefetch is
  announced as Downloading, and its failure is the same failure for the tab
  and the orchestrator (`finish(..., { local: true })`: no unit, no claim). The detached
  result alone settles the outcome, including when stdout/stderr stay
  unreadable (`drained: false` after 20 failed final reads) or retirement
  fails; an observer that loses the unit reports no outcome (`updating:
  null`, no success or failure, no restart).
  One attempt record (`software-update.attempt`) is all replay reads, owned by
  `software-update-attempt.ts`: an exit is used only through
  `claimOutcome(attempt, { invocation })`, claimed before any effect and
  confirmed at each later use (`claim.confirm()`; an unrecorded exit is no
  outcome) for replay, the attempt's own success effects and the
  orchestrator's `getPlanUpdateState`, which settles only from a claim whose
  `plan` is the key of the saved plan read then (a hash of the pending
  package list in `/data`; the orchestrator registers the reader), the pending
  success's persistence and the restart (confirmed again right before the
  exit), and the unit's retirement, which follows its claim (a failed claim or
  `drained: false` keeps the unit and withholds the restart). A second start while one waits
  for discovery is refused. Every write is a synchronous compare-and-set (`updateSoftwareUpdateAttempt`)
  that writes nothing when the writer no longer owns the record, and an
  unreadable record refuses every write but a new admission's:
  `startSoftwareUpdate` writes `accepted` (new id) before publishing or
  starting anything, the launch writes `launched` before the unit exists, only
  for the caller's own admitted id, under main's one fixed unit name. CeraUI
  alone starts or retires that unit: one in-process lock
  (`software-update-process.ts`) serializes every launch, the observer's
  record, claim and retire step, recovery and the start's settle, each across
  the probe that decides its action, and a launch starts only into an empty
  slot,
  and the observer adds the unit's `InvocationID` (the attempt's identity)
  and later its exit with `drained` and `transcript` (stdout inode:size:mtime),
  only into its own exit-less record (or none); a record of another attempt
  makes the exit unknown. A unit no record names (an older release's) is
  adopted once (bound to its invocation and the saved plan of that moment) by
  the same compare-and-set; otherwise it is watched for display only, never
  recorded, claimed or retired. Only a `launched` record's own fresh
  exit with an invocation is replayed, and only while stdout is still the file
  that exit was read from. Starts are refused until boot recovery has looked at
  the unit, and while a finished unit is left in place (`already_updating`);
  `startSoftwareUpdateWhenSettled` (the RPC start and the orchestrator's package
  start) first settles it under the lock, claim then retire, and one no attempt
  can claim, or with an unread transcript, is retired after 30 minutes of
  uptime with the reason logged. CeraUI restarts only after the exit is recorded; the unit
  is retired only when, besides, its transcript was read and systemd, asked
  again right before every stop, still shows the same finished invocation; a
  retirement that finds a replacement vetoes the restart. A recorded finished unit is never adopted again. The
  completion hook of a unit watched at boot is read at hand-over.
- **Reattachment identity is a safety boundary.** Adoption requires the
  exact unit id and transient fragment path, transient-service description/type,
  exact non-duplicated `[Service]` stdout/stderr append destinations, no pre/post
  hooks, and the canonical
  `/usr/bin/apt-get` upgrade argv. Do not loosen these checks to adopt a foreign
  same-named unit. Keep final output drain ahead of unit cleanup so recovery
  does not discard an unobserved outcome. Probe and drain contracts:
  `software-update-service-contract.ts`, `software-update-process.ts`,
  `tests/software-update-service-hooks.test.ts` and `docs/DEVICE-UPDATES.md`.

Coverage: `tests/software-updates-start-refusal.test.ts`,
`tests/software-updates-apt.test.ts`, `tests/package-progress-output.test.ts`,
`tests/software-update-attempt-record.test.ts`, `tests/software-update-unit-command.test.ts`,
`tests/update-progress-timeline.test.ts`, `tests/update-recovery-ordering.test.ts`,
`tests/update-restart-tab.test.ts` (real backend processes on loopback, a real tab socket,
an offline tab, five boots of a unit that cannot be retired, a restart at each step
between accepting an update and starting its unit and at each step after it finished,
and a predecessor that cannot be retired refusing the next start until it can be, then
two more updates), `tests/software-update-claim-authority.test.ts`.
