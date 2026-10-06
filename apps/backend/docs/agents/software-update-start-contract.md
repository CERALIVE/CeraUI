<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## SOFTWARE-UPDATE START CONTRACT [EXISTS]

`modules/system/software-updates.ts` owns whether an apt update may run, and it
never refuses in silence.

- **`aptUpdatesEnabled()` is the ONE predicate.** Discovery
  (`getSoftwareUpdateSize`), the apt package-list refresh
  (`checkForSoftwareUpdates`), the periodic loop, and the install path all read
  it, so the UI can never advertise an update the install path would refuse.
- **`apt_update_enabled` defaults to TRUE** (`SETUP_CONFIG_DEFAULTS`,
  `helpers/config-schemas.ts`). The shipped `setup.json` carries no such key and
  the field is `z.boolean().optional()`, so "absent ⇒ falsy" left the install
  path dead on 100% of field hardware while discovery — which was never gated —
  kept offering an Update button. Confirmed live on a Rock 5B+: `debug.log`
  recorded `System: software update started` and then nothing at all. Only an
  explicit `"apt_update_enabled": false` opts a device out.
- **`startSoftwareUpdate(): UpdateStartOutcome`.** Every refusal is a typed
  `UpdateStartRefusal` — `updates_disabled` / `streaming` / `already_updating` /
  `check_unavailable` — logged at `warn` and returned to the caller.
  `rpc/procedures/system.procedure.ts` `startUpdateProcedure` forwards it as
  `{success:false, error:<reason>}` and does NOT re-check the guards itself;
  duplicating them is what let a refusal answer `{success:true}`.
- **A skipped pre-check no longer wedges the latch.** `defaultSoftwareUpdateRunner`
  routes through the `softwareUpdateCheckRunner` seam and latches `softUpdateStatus`
  only once the check has actually started. The check's callback is the ONLY
  thing that ever clears that latch, so latching it after a declined check left
  `isUpdating()` true for the lifetime of the process — refusing every later
  update and silently killing the periodic loop with it.
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
  fixed `/run/ceralive/software-update.{stdout,stderr}` files; the backend polls
  them and feeds the unchanged apt parsers and `SoftUpdateStatus` broadcasts.
  The root-owned directory is not peer-writable, file creation is exclusive and
  no-follow, and the files are mode 0600. Caller-selected paths are rejected.
  Progress is derived from the cumulative log, so tokens split across arbitrary
  file reads are still counted exactly once. No wall-clock deadline is added: a
  valid package transaction may run for minutes.
- **A restarted backend reattaches; it never starts a second apt.** The transient
  service uses `RemainAfterExit` so PID 1 retains both a running transaction and
  its terminal `ExecMainStatus`. During boot, `main.ts` awaits the bounded
  recovery probe BEFORE starting the periodic apt refresh. Adoption requires the
  exact unit id and transient fragment path, transient-service description/type,
  exact non-duplicated `[Service]` stdout/stderr append destinations, no pre/post
  hooks, and the canonical
  `/usr/bin/apt-get` upgrade argv; a foreign same-named unit is never trusted. An
  unreadable probe keeps discovery and starts gated
  instead of treating uncertainty as absence, and schedules a coalesced retry that
  resumes the periodic loop after a conclusive answer. Concurrent recovery callers
  join one probe/observer, so only one consumer can replay and settle the retained
  unit. Before a fresh launch, a
  second probe rejects any existing unit before output is reset; the command builder
  also refuses any apt operation outside the upgrade/install-held-packages contract.
  Once attached, transient read/probe failures are retried without clearing
  `softUpdateStatus`; stdout and stderr advance independently, so one failed read
  cannot replay the other, and the terminal unit is retained until BOTH final drains
  succeed. A permanently unreadable final output is bounded to 20 local attempts,
  reports failure, and deliberately leaves the terminal unit intact for the next
  recovery instead of deleting evidence. Only a complete drain permits stop/reset.
  Cleanup failure is an explicit failed outcome. Package discovery is single-flight;
  delayed starts while a refresh/discovery is active are coalesced to one timer, and
  a later refusal is published as a terminal failure rather than disappearing.
  The package-list refresh and read-only `dist-upgrade --assume-no` discovery are
  argv-only `/usr/bin/apt-get` `spawnWithTimeout` calls too (5-minute and 2-minute
  local bounds respectively); no privileged apt call resolves through `PATH`. Those
  bounds cover checks only and never cap the detached package transaction. A non-zero
  `systemctl show` is unknowable and retries fail-closed even if it emitted
  valid-looking properties; only an explicit `LoadState=not-found` is absence.

Coverage: `tests/software-updates-start-refusal.test.ts`,
`tests/software-updates-apt.test.ts`.

