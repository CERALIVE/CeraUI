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
