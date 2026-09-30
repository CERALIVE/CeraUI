# Update recovery contract [PARTIAL — local recovery implemented, board proof owed]

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
`NetworkManager*`, `ModemManager*`, `wpa_supplicant*`, `rauc*`, `pipewire*` and
`wireplumber*` are never restarted automatically: a persistent, dismissible
restart recommendation with a stable unit ID appears instead. `ceralive.service`
is deferred while the update transaction is actually running and can restart
once the detached APT unit has settled; a stale mapping is never a reason to
terminate a process by PID. This is fixture-proven, not board-proven.

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
quarantine the surviving version. `isOsVersionQuarantined(version)` is the query
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
matching status SHA means the state is already mirrored. An APT commit within
the current uptime has no matching boot-health record and cannot be mirrored.

At startup and on every idle tick, a passing predicate dispatches
`SYNC_ELIGIBILITY_CONFIRMED` (`idle → sync-eligible`), then the same predicate is
rechecked before `SYNC_STARTED` and `systemctl start --no-block
ceralive-slot-sync.service`. The existing unconditional `OS_VERIFIED` transition
also reaches `sync-eligible` and attempts promptly. A failed precheck returns
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
closed, because the last value would otherwise win) with `LoadState=loaded`, `ActiveState=inactive` and `SubState=dead`;
`succeeded` additionally requires `ExecMainCode=1` (CLD_EXITED) with
`ExecMainStatus=0`, and `inactive-clean` requires both `ExecMainCode` and
`ExecMainStatus` to be empty or `0`. On either shape during `syncing`,
`pollSlotSync` reads the receipt; if its state SHA-256 equals the current dpkg
status it takes a second, fresh probe and settles `synced` only if that probe
again reads one of the two shapes. The receipt alone is not enough: the gate
refuses (`already-synced`) to dispatch while a matching one exists, so a match
was written by this run, but the unit writes it before its last step, and the
first probe can still be the previous run's record while this run's job was
queued. A second probe that reads running waits; failed or refused fails with
that verdict; anything else fails as `slot-sync-unit-absent`. A mismatched, missing
or unreadable receipt leaves `succeeded` waiting (the unit may be a queued
re-run still showing the previous exit) and fails `inactive-clean` as
`slot-sync-unit-absent`. Any other read that looks like either shape (nonzero
exit, empty or incomplete output, any other lifecycle or exit record, such as a
nonzero `ExecMainStatus` beside `ExecMainCode=0`) is classified `absent` and
fails as `slot-sync-unit-absent` without consulting the receipt, because the
unit writes the receipt before its last step, `rauc status mark-good other`,
which can still fail. A failed unit is not unloaded, so refused and failed runs
are still detected from the unit; an exit status of 75 is the typed refusal
whether systemd records it as `failed/failed` or as `inactive/dead`. Hardware basis: both bench boards recorded `slot-sync-unit-absent` 1-3 s
after a successful mirror had written its receipt and marked the other slot good.

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
