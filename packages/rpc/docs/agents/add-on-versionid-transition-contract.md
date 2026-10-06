<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## ADD-ON `versionId` TRANSITION CONTRACT [EXISTS]

`AddonDescriptorSchema.versionId` accepts the numeric OS identities `'12'`
(Debian bookworm) and `'13'` (Debian trixie) during the platform transition.
This is compatibility for mixed fleets, not a claim that every device runs
trixie: the add-on reconciler still compares the descriptor's materialized OS
identity with the live `/etc/os-release` `VERSION_ID` before reuse. Keep both
values accepted until the bookworm fleet is retired; do not narrow the schema
back to a bookworm-only literal or treat acceptance of `'13'` as an image-suite
migration by itself.

- Contracts use `@orpc/contract` (`oc.*`). No runtime logic here — contracts are pure type/schema declarations.
- Schemas use Zod v4 (`zod@^4`). Import from `zod`, not `zod/v4`.
- One contract file per domain. One schema file per domain. Names must match (`streaming.contract.ts` ↔ `streaming.schema.ts`).
- `appContract` in `contracts/index.ts` is the only router — don't create sub-routers elsewhere.

