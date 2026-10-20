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
  fixed `/run/ceralive/software-update.{stdout,stderr}` files; the backend polls
  them and feeds the unchanged apt parsers and `SoftUpdateStatus` broadcasts.
  The root-owned directory is not peer-writable, file creation is exclusive and
  no-follow, and the files are mode 0600. Caller-selected paths are rejected.
  Progress is derived from the cumulative log, so tokens split across arbitrary
  file reads are still counted exactly once. No wall-clock deadline is added: a
  valid package transaction may run for minutes.
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
`tests/software-updates-apt.test.ts`.

