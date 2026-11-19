# Device log retention and clear [PARTIAL]

The service, storage readout and retention mutations exist in
`src/modules/device-logs/retention.ts`. Tests exercise the real query, follow,
export and sharing owners with controlled journal transports and real temporary
settings and legacy files. These tests do not establish physical board vacuum
qualification or complete device-log UI integration.

All retention mutations share the existing exclusive queue. Only `clearAll`
closes the history admission gate. Daily maintenance, settings changes,
`deleteOlderFiles` and `deleteLegacyDebug` serialize with clear without taking
that gate.

## Clear ordering

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

After joining, clear checks the update phase again immediately before rotation
or mock deletion. An update that started during the drain returns
`UPDATE_IN_PROGRESS` without deletion; the epoch increment and cancellations
already happened and remain in force.

Native clear rotates, vacuums and removes legacy debug files. Mock clear removes
legacy files before wiping the ring and immediately recording the clear marker,
so logging during unlink cannot precede the marker in the emptied ring. The
gate stays closed through the marker, `lastClearedAt` persistence and final
storage readout, and reopens in `finally` on success or failure. Later I/O
failures cannot undo deletion that already happened.

## Admission and terminal ownership

Validated queries, around requests, follows, export creation and export-ticket
consumption arriving during clear wait for its gate, then use normal admission
and capacity checks. The gate check stays inside each replacement/wait loop,
with no yield between an open gate and ownership registration.

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
before requesting another query slot; journal scans and follow-position probes
never wait on this admission gate.

## Known limitations

- `getStorage`, `listBoots`, classified-boot and shutdown-window metadata readers
  remain outside admission and cancellation. They may observe intermediate or
  mixed metadata across clear.
- A child whose exit has not been confirmed still occupies its query or follow
  slot, even after a failed TERM or KILL attempt. Clear returns `READ_FAILED`
  at its drain deadline and preserves logs in that case. Both owners release
  their pipe readers without waiting on stream cancel hooks, so a stalled hook
  on a reaped child cannot block clear.
