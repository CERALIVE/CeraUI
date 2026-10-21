# Update credential observation [EXISTS; installed-board proof owed]

`system.getUpdateDetails` accepts an optional `credentials` block. An absent
block means an older backend. `expiresAt` is epoch milliseconds or `null` when
not established; `state` is `valid`, `expiring`, `expired`, or `unavailable`.
The block contains no certificate identity, path, digest or key material.

This additive schema establishes the shared backend/frontend contract. The
independent backend credential observer now projects its cached public
observation through this block; pulling details never emits a notice or creates
an intent. The visual date/state row is a separate consumer change. A known
certificate date does not prove key matching, chain trust, revocation status or
mTLS acceptance. See the credential section in `docs/DEVICE-UPDATES.md` for the
producer, durable acknowledgement and qualification boundaries.

A backward clock step never retires the current generation's undismissed warning
or expired notice. Details reports `unavailable` with `expiresAt:null` while the
clock precedes the latest recorded observation checkpoint or the process's
observation high-water time. Semantic journal changes persist that checkpoint;
unchanged minute observations stay in memory, without rewriting the journal.
Legacy schema-1 history supplies only the lower bound implied by threshold
crossings. Dates/notices use device time and can appear early or late while the
clock is unsynchronized; neither a date nor a notice proves edge rejection.
Host tests cover fresh-process reload after injected faults, not power loss.

The additive wire schema intentionally remains lenient for compatibility. This
producer emits unavailable only with a null expiry and known states only with a
numeric expiry; consumers must not treat schema acceptance as certificate trust.
