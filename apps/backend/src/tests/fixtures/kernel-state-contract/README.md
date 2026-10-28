# Agreed kernel producer contract fixtures

These are agreed-contract examples, not producer output or device captures.
They encode the agreed A/B bootnames, null or machine-token reasons, lean
invalid overlay, RAUC byte identity and retained state-keyed UTC-Z timestamps.
The contract is documented in `docs/DEVICE-UPDATES.md`.

The pending overlay's base identity reuses the actual booted RAUC identity in
`../real-device/rock-admission-20261009.json`. The kernel transaction records
themselves are authored contract fixtures. They do not establish producer
serialization, installed-device interoperability or hardware qualification.
