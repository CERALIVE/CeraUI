# @ceraui/rpc

Shared browser-safe RPC contracts and Zod schemas for the device backend and
frontend.

Device events have two entry points:

- `@ceraui/rpc/schemas` exports the lenient `deviceEventSchema`, `EVENT_PUSH`,
  list/boot/push schemas, and `LOW_DISK_THRESHOLD_BYTES`. Boot-time frontend code
  uses this entry point.
- `@ceraui/rpc/events` exports `EVENT_REGISTRY`, `EventCode`, `EventParams<C>`,
  and the shared stop/recovery/uplink taxonomies. Import it only from backend
  producers or the lazily opened event timeline.

Each registry entry owns its family, strict flat params, severity and coalescing
subject. Text params are bounded to 1024 characters, including string array
elements. Update notice kinds become snake_case codes and retain their `id` for
deduplication. Modem rejection params carry the existing rejection's `error`
token, not its nested object. Reconfiguration outcomes name the destination
lifecycle state: `streaming`, `idle`, or `reconciling`.

New boot selectors and typed boot params use 32 lowercase hexadecimal characters
(journal form). The wire record deliberately accepts arbitrary boot-id strings
and future codes; unknown families and severities become `device` and `info`.
Consumers parse each pushed record independently. Boot records preserve their own
version context, separately from the flat `device_started` event params.

`appContract.events` exposes `list`, `boots`, and `clear`. This package defines
the contract only; event storage, emission and UI integration are separate work.

From the repository root, run `bun run --filter @ceraui/rpc check`,
`bun run --filter @ceraui/rpc test`, and `bunx biome check packages/rpc`.
