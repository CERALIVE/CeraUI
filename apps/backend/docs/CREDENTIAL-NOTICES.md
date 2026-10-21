# Credential notice journal [PARTIAL]

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
Producer and dismissal integration is a separate step from this journal.
