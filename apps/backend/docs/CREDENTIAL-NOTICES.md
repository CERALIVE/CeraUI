# Credential notices [EXISTS; host-tested, board proof owed]

The journal at `/data/ceralive/update-state/credential-notices.json` is schema 1.
Strict bounded no-follow reads reject corrupt, duplicate-member, invalid-UTF-8,
unknown-version or inaccessible authority without replacing it. Only genuine
absence initializes an empty history. Writes use private exclusive temporary
files, file fsync, atomic rename and parent directory fsync. A loaded record
also acknowledges its directory before it can authorize publication.

Each exact public DER digest maps locally to an opaque random generation UUID,
its expiry and per-threshold `pending`, `active`, `acknowledged` or `superseded`
facts. Notice identities contain only UUID and threshold, never the digest.
90/30/7-day boundaries use absolute milliseconds. Expired first observation
records all crossed facts but surfaces only expired; late warning observation
likewise coalesces to the most urgent threshold. Clock reversal never rearms a
recorded threshold and retires any standing claim that is no longer true.

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
The details RPC reads the same cached state without creating intents. The
public-date expiry does not prove private-key matching, chain trust, revocation
or successful server authentication. Board permissions, installed frontend and
real streaming latency require separate qualification.
