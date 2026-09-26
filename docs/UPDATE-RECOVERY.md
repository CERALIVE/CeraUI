# Update recovery contract [PARTIAL]

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
action. Runtime events currently wired: package discovery, refusal, commit,
stale-service recommendation, and slot-sync completion. The OS-stage/activation/
rollback, one-time cellular approval, credential expiry, and transport-health
producer hooks require their respective later update-agent/credential tasks;
`notifyUpdate` already provides the keyed, translated event vocabulary for them.

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

On confirmed success the phase becomes `synced` *before* four independent,
best-effort effects: reuse bounded `apt-get clean`, remove leftovers from
`/data/ceralive/rauc-downloads`, reconcile superseded failed package versions,
and refresh both-slot status. Only afterwards does the existing `slots-current`
notice say “Both system slots are up to date.” A cleanup failure warns but
cannot reverse the mirror verdict. The internal `readBothSlotStatus` /
`parseBothSlotStatus` seam reads RAUC's detailed rootfs slot records and overlays
the target's receipt version (RAUC keeps an old bundle version after rsync);
an OS install newer than the receipt supersedes it. Todo 41 exposes it through
the additive `system.getUpdateDetails` RPC (`slots` is `null` unless the image
declares `slot-sync` and `rauc status` answered), and the Updates dialog's Slots
section renders A/B version, state, health and last mirror time from it.
`device-stats.raucSlot` remains the S1-locked single bare string.
