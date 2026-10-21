# Credential notices [EXISTS; host-tested, board proof owed]

The journal at `/data/ceralive/update-state/credential-notices.json` writes schema 2.
Strict bounded no-follow reads reject corrupt, duplicate-member, invalid-UTF-8,
unknown-version or inaccessible authority without replacing it. Only genuine
absence initializes an empty history. Writes use private exclusive temporary
files, file fsync, atomic rename and parent directory fsync. A loaded record
also acknowledges its directory once per ledger instance before it can authorize
publication; a failed write/sync invalidates that acknowledgement and retries it.
Unchanged active observations neither rewrite the journal nor resync its parent.

Each exact public DER digest maps locally to an opaque random generation UUID,
its expiry and per-threshold `pending`, `active`, `acknowledged` or `superseded`
facts. Notice identities contain only UUID and threshold, never the digest.
90/30/7-day boundaries use absolute milliseconds. Expired first observation
records all crossed facts but surfaces only expired; late warning observation
likewise coalesces to the most urgent threshold. The current intent is the most
urgent member of eligible thresholds union recorded pending/active thresholds.
Only a more urgent recorded threshold or certificate rotation supersedes an
undismissed intent, never a backward clock step. Rehydrating its same ID is
continuity, not rearming; acknowledged/superseded thresholds never rearm.

`latestObservedAt` is a wall-clock high-water checkpoint saved with semantic
journal changes (generation, threshold, activation or acknowledgement), not a
reason to write every minute. Process memory also tracks unchanged observations.
Details is unavailable while the device clock is earlier than either floor,
including immediately after a backward step before the next tick. Strict schema-1
bytes remain readable: their threshold crossings imply a conservative lower
bound, not the unknowable exact old observation time. The next semantic write
stores schema 2. Future versions still defer without replacing their bytes;
older schema-1-only binaries refuse schema 2 rather than resetting history.

Rotation retires older active intents. Returning to an older certificate reuses
its recorded identity and acknowledgements. At 1,024 generations the journal
refuses a new generation; it never silently evicts rollback acknowledgements.
The bounded file limit is 1 MiB. Saturation or storage failure requires local
maintenance and defers notice production, not update/stream admission.

Physical exactly-once frame delivery is not promised: a crash can happen after
broadcast. Durable logical intent/identity permits idempotent reconstruction.
`CredentialNoticeObserver` persists intent and activation before calling
`notifyUpdate`. Its callback commits acknowledgement in this journal instead of
the ordinary shared LRU, avoiding a two-store atomicity assumption. Any existing
shared dismissal is reconciled into the journal before re-publication. A failed
acknowledgement leaves the visible notification intact. The callback is internal
only; notification frames retain their existing keyed Updates navigation.

Startup and ticks schedule one exception-isolated observation flight before
recovery/automation gates, without awaiting it or touching D8 admission. The
observer reads at startup/forced refresh and otherwise caches public evidence
for 15 minutes; journal reconciliation is throttled to one minute. Unknown reader
or journal evidence projects unavailable, does not warn and is not renewal.
Reader/journal faults log one bounded closed reason on each fault-state change,
never raw exceptions, paths, certificate data or a per-tick repetition. A healthy
observation resets that suppression so a later recurrence can be diagnosed.
The details RPC reads the same cached state without creating intents. The
public-date expiry does not prove private-key matching, chain trust, revocation
or successful server authentication. Board permissions, installed frontend and
real streaming latency require separate qualification.

Dates and notices use the device clock, not a time-synchronization assertion.
An unsynchronized clock can show warnings early or late, particularly before
chrony converges after boot without a retained RTC. Clock-floor detection cannot
prove synchronization, undo a previously premature threshold, or prove the edge
rejected a certificate. Backdating cannot extend edge acceptance. Keep the device
online and install available updates before expiry; after expiry, check for a
system update, otherwise reflash or contact support. A suitable recovery system
release might not exist; the observer never performs renewal itself.

Host durability evidence is **fresh-process reload after injected faults** and
chosen publication states, not a process killed mid-write, SIGKILL or power-loss
qualification. Fresh-process clock regressions likewise inject observer time,
never the host or a board's system clock.
