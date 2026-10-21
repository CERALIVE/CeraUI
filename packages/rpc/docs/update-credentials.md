# Update credential observation [PARTIAL]

`system.getUpdateDetails` accepts an optional `credentials` block. An absent
block means an older backend. `expiresAt` is epoch milliseconds or `null` when
not established; `state` is `valid`, `expiring`, `expired`, or `unavailable`.
The block contains no certificate identity, path, digest or key material.

This additive schema establishes the shared backend/frontend contract. The
credential observer is a separate implementation step. A known certificate date
does not prove key matching, chain trust, revocation status or mTLS acceptance.
