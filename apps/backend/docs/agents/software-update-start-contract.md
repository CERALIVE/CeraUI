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
  fixed `/run/ceralive/software-update.{stdout,stderr}` files and its
  `/bin/bash` wrapper opens `/run/ceralive/software-update.status` for append
  as descriptor 3 for `apt-get -o APT::Status-Fd=3` (`/dev/null` if it cannot);
  no reader process sits between APT and the file. A status file the backend
  could not prepare launches the pre-channel form. The root-owned directory is not
  peer-writable, file creation is exclusive and no-follow, and the files are
  mode 0600. Caller-selected paths are rejected.
  Progress is a pure function of the bytes read (`apt-progress.ts`): APT's
  complete `dlstatus`/`pmstatus` records give the phase and APT's own
  percentage, capped at 99 and frozen at `pmerror`; a unit with the channel
  takes its phase from it alone, and stdout gives phases only for a
  pre-channel unit or a lost status file. The legacy step fields are phase
  markers. Each changed frame publishes both `updating` and `update_state`.
  Every poll and the final drain read stdout, stderr and status in that
  order, each until a read returns nothing (bounded per poll), so output
  larger than one bounded read is replayed whole. Recovery announces a
  reattached unit only from a poll that read every file to its end without
  an error; until recovery settles (`beginSoftwareUpdateRecovery` before the
  WS server binds), initial pushes omit `updating` and `update_state` rather
  than send `null` or idle state. An attached recovery answers later callers
  without changing state; a refused or failed bootstrap runs
  `observeSoftwareUpdateWithoutOwning()`, which shows the unit's real outcome
  but never retires it or restarts CeraUI.
  `holdUpdateProgress` (`@ceraui/rpc/package-progress`, shared with both
  browser views) keeps a running transaction's phase and in-phase number
  from moving back; the in-process pinned prefetch is announced as
  Downloading. Status-file read errors never block a drain or cleanup and
  never change the outcome; after 20 consecutive failures the file is
  dropped (`onStatusLost`). The detached result alone settles the outcome,
  including when stdout/stderr stay unreadable or retirement fails.
  The observer records the exit (`software-update.outcome`) before retiring
  the unit; a recorded finished unit is never adopted again (no second
  restart), an absent unit's fresh record is replayed once per boot, and a
  restart is withheld when neither retirement nor the record succeeded.
  Retirement and the record write are retried; a launch retires only a
  recorded leftover. Each attempt takes the record (new attempt id, no exit)
  before preflight, so an older exit is never replayed for it; an attempt
  that cannot take the record, or finds a registered unit, is refused. Below
  4 MiB free on `/run` there is no status channel. A pending boot whose unit
  is absent settles from the record without waiting for adjudication.
- **Reattachment identity is a safety boundary.** Adoption requires the
  exact unit id and transient fragment path, transient-service description/type,
  exact non-duplicated `[Service]` stdout/stderr append destinations, no pre/post
  hooks, and one canonical command: the status-channel `/bin/bash -ec` wrapper
  or pinned flock script, or the pre-channel `/usr/bin/apt-get` argv or flock
  script a previous release started. Only units in the status-channel form
  have their status file read. Do not loosen these checks to adopt a foreign
  same-named unit. Keep final output drain ahead of unit cleanup so recovery
  does not discard an unobserved outcome. Probe and drain contracts:
  `software-update-service-contract.ts`, `software-update-process.ts`,
  `tests/software-update-service-hooks.test.ts` and `docs/DEVICE-UPDATES.md`.

Coverage: `tests/software-updates-start-refusal.test.ts`,
`tests/software-updates-apt.test.ts`, `tests/package-progress-output.test.ts`,
`tests/software-update-status-channel.test.ts`, `tests/update-progress-timeline.test.ts`,
`tests/update-recovery-ordering.test.ts`, `tests/software-update-status-file.test.ts`,
`tests/update-restart-tab.test.ts` (real backend processes on loopback, a real tab socket,
an offline tab and five boots of a unit that cannot be retired).

