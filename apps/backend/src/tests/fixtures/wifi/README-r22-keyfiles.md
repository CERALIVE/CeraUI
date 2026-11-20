# R22 masked keyfile captures

The two `r22-*-timestamp.nmconnection` files are unchanged masked post-write
blocks for UUIDs `4d482559-9fdc-49f0-ba43-68b14322f114` and
`38339d30-6a07-4ef3-b022-8f77798d88f7` from `r22-keyfiles-masked.txt` in
`task-21-22-integ-r22-guest-receipts.tar.gz`. The archive SHA-256 is
`6e86342c9388fb3eb72925e4d43f7c97125080eedbdd91b3e242520f3e9dc145`.
Secrets were already replaced by `<redacted>`.

Tests explicitly reconstruct pre-write and predicted controls. Those controls
are not additional captured byte streams. These files are data, never executed
or sourced, and do not establish physical NetworkManager qualification.
