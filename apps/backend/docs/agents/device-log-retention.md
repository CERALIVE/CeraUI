# Device log retention and clear [PARTIAL]

The service, storage readout and retention mutations exist in
`src/modules/device-logs/retention.ts`. Tests exercise the real query, follow,
export and sharing owners with controlled journal transports and real temporary
settings and legacy files. These tests do not establish physical board vacuum
qualification or complete device-log UI integration.

All retention mutations share the existing exclusive queue. `clearAll` and
`deleteOlderFiles` also share the history fence and the update reservation.
Daily maintenance, settings changes and `deleteLegacyDebug` serialize without
taking the history fence.

## Destructive operation ordering

The transaction first refuses a busy software-update phase. Inside the exclusive
queue, `beginHistoryClear` synchronously persists one `historyEpoch` increment
and then closes the settings-owned promise gate. If that write throws, clear
returns `READ_FAILED`, leaves the gate open and aborts no work. Clearing logs on
a full filesystem therefore requires enough space to persist that epoch first.

The follow, export and query owners start cancellation together. Clear joins
all their results, including rejected results, for at most 15 seconds. A
rejection or timeout returns `READ_FAILED`, reopens admission, deletes nothing
and never rolls the epoch back. Timeout does not repair an owner that still
cannot settle or release its existing capacity.

After joining, clear checks update ownership and takes the shared disruptive
action reservation in the same turn. An update that started during the drain returns
`UPDATE_IN_PROGRESS` without deletion; the epoch increment and cancellations
already happened and remain in force. Update admission stays closed through
rotation, vacuum and legacy file deletion, including when a command fails.

Native clear rotates, then vacuums with `--vacuum-time=1s --vacuum-files=1`
in one call. The active journal counts toward the limit, so even future-dated
archives are removed. Clear also removes legacy debug files and reports the
stored boot counts before and after the operation. Mock clear removes
legacy files before wiping the ring and immediately recording the clear marker,
so logging during unlink cannot precede the marker in the emptied ring. The
gate stays closed through the marker, `lastClearedAt` persistence and final
storage readout. A failure before a child is submitted releases immediately.
After submission, an RPC error can precede settlement. Both fences stay held
until the vacuum child exits or the daemon-side Rotate settles. A timed-out
Rotate client is never signaled by this deadline. Retention mutations return
`BUSY` while settlement is pending, and the daily tick defers to the next run.

On systemd v257 a zero `journalctl --rotate` exit acknowledges the synchronous
daemon operation, including its internal vacuum. On abnormal client exit,
Clear waits for a successful `journalctl --sync` **issued after reaping the
Rotate client**. In v257 `vl_method_synchronize` replies from a defer at
`SD_EVENT_PRIORITY_NORMAL+15`; the Unix listener, connection I/O, and
Varlink parsing and dispatch all run at `SD_EVENT_PRIORITY_NORMAL`. By the
time the defer runs, the old connection's queued request has either run
synchronously to completion or been discarded. The dead client cannot
submit again. The next daemon instance also cannot inherit an accepted
Rotate connection. See upstream `journald-server.c` (`server_open_varlink`,
`vl_method_rotate`, `vl_method_synchronize`), `sd-varlink.c`
(`sd_varlink_process`, `sd_varlink_attach_event`), and `sd-event.c`
(`sd_event_prepare`). A `rotated` timestamp is shared with SIGUSR2 and cannot
attribute settlement to this client. The barrier proves quiescence, not that
Clear succeeded. A failed barrier is retried with bounded commands and
backoff, and a rejected exit observation keeps both fences closed because a
still-live client could submit after the barrier. Fences are process-local.

## Deleting older files

Older cleanup does not rotate the active journal. It reads fixed
`journalctl --header` output before vacuuming. On v257 the Boot ID with the
`TAIL_ENTRY_BOOT_ID` flag describes the last entry. An archive ending in this
boot is protected by moving the uptime-based cutoff back to at least the
earliest such file head. The cutoff also accounts for older filesystem times
that systemd can use when aging the file. Unknown archive header evidence
refuses cleanup. A shared file can keep logs from earlier boots. The result
counts boots with retained journal entries before and after the vacuum.

## Admission and terminal ownership

Validated queries, around requests, follows, filtered exports and support
bundles arriving during clear wait for its gate, then use normal admission and
capacity checks. When an RPC fails with settlement still pending, waiters and
new calls receive `BUSY` or the existing sharing refusal. The gate check stays inside each replacement/wait loop, with
no yield between an open gate and ownership registration. Bundle preview,
creation and download deadlines include time spent at the gate.

Calls capture the epoch at entry. An older call still pending after a bump uses
the existing cancellation outcome instead of waiting on a gate whose drain may
need that call: queries and around return `READ_FAILED`; pending follow starts
return `READ_FAILED`; registered follows end once with `cleared`; old export
tickets are refused and running streams finish incomplete. Calls admitted
between successive clears belong to the clear that subsequently stops them.

The follow publisher checks its own abort state and seals after its first
terminal message, including queued catch-up continuations. Export finishing is
idempotent across request abort, stream cancellation and clear. Sharing
reservation remains synchronous. The export body checks whether it stopped
before requesting another query slot. Export and bundle page requests can wait
for a viewer slot to settle within their existing sharing deadline. Interactive
queries return `BUSY` at capacity. Scans and follow-position probes do not acquire
another slot from inside their existing owners.

## Known limitations

- `getStorage`, `listBoots`, classified-boot and shutdown-window metadata readers
  remain outside admission and cancellation. They may observe intermediate or
  mixed metadata across clear.
- A child whose exit has not been confirmed still occupies its query or follow
  slot, even after a failed TERM or KILL attempt. Clear returns `READ_FAILED`
  at its drain deadline and preserves logs in that case. Both owners release
  their pipe readers without waiting on stream cancel hooks, so a stalled hook
  on a reaped child cannot block clear.
