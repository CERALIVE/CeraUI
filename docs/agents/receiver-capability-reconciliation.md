<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## RECEIVER CAPABILITY RECONCILIATION

Canonical decision record: [`docs/RECEIVER-RECONCILIATION.md`](https://github.com/CERALIVE/ceralive/blob/master/docs/RECEIVER-RECONCILIATION.md)

**Receiver kind in `device.hello` (Task 12, pending).** Extend `buildDeviceHello` in
`apps/backend/src/modules/remote-control/channel.ts` to carry the device's configured
receiver kind in `deviceCaps.receiverKind`. Derive from config:

- `relay_server` or `selected_ingest_endpoint` present → managed provider
  (`config.remote_provider` ∈ `{ceralive, belabox}`); emit that value.
- `srtla_addr` present (manual custom endpoint) → emit `custom`.
- Neither → omit the field (platform treats absent as `unknown` → baseline).

This is additive/optional on both sides: the platform (`ceralive-platform` Tasks 5/6)
tolerates its absence (defaults to `unknown` → baseline). CeraUI Task 12 and platform
Tasks 5/6 ship independently (R2-safe).

**Important:** derive from the MEDIA DESTINATION, not `config.remote_provider` alone.
A CeraLive-paired (control) device can stream its media to a Custom receiver while
`remote_provider` stays `ceralive`; reporting `ceralive` would wrongly get it pushed
FEC/L1. The derivation logic above handles this correctly.

**QA gate (Task 12):** a CeraLive-paired device with a manual custom endpoint reports
`custom` → platform resolves baseline-only (not FEC/L1). Unset `remote_provider` →
field omitted.

