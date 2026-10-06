<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## OVERVIEW

The TypeScript helper layer for the `srtla_send` bonding sender: the CLI args
builder, the ADR-001 telemetry reader/watcher, and (pending a rewrite) the
control-socket client. `apps/backend` is its only consumer.

**PRIVATE, AND THAT IS THE POINT.** This used to be a public npm package. It is
now `"private": true` and consumed as `"@ceraui/srtla-send": "workspace:*"`.
Never publish it, never give it a registry pin, never add it back to
`producer-schema-drift.test.ts`'s `PRODUCER_PACKAGE_NAMES` (that list asserts
registry-resolved specifiers; `workspace:*` is precisely what it rejects). Its
telemetry schema stays in that test's drift MANIFEST — that half probes the
schema, not the pin.

The `srtla_send` BINARY is still external: it is built and released by the
sender repository as the `srtla` Debian package and installed at
`/usr/bin/srtla_send`. Only the helper layer lives here, so the binary's CLI and
telemetry contracts are still that repo's to define — read its
[AGENTS.md](https://github.com/CERALIVE/srtla-send-rs/blob/main/AGENTS.md) before touching a call site.

