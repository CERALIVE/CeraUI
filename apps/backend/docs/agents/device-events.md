# Device events: the plain-language timeline [EXISTS]

Entry contract for the event registry, emitter and store. Each fact cites its
source; the linked contracts hold the detail.

## Pieces

| Piece | Source | Contract |
|---|---|---|
| Registry: per code a family, params schema, severity and subject | `packages/rpc/src/schemas/events.schema.ts:107`, export `./events` in `packages/rpc/package.json:21` | [Events wire contract](../../../../packages/rpc/docs/agents/device-events-wire.md) |
| Wire record, list input and output, `EVENT_PUSH`, `LOW_DISK_THRESHOLD_BYTES` | `packages/rpc/src/schemas/events-wire.schema.ts:8-83`, re-exported by `packages/rpc/src/schemas/index.ts:15` | same |
| Emitter | `src/modules/events/emit.ts` | [event-emitter.md](event-emitter.md) |
| Store: event and boot JSONL rings, and the event ring's epoch | `src/modules/events/store.ts`, `src/modules/events/epoch.ts` | [store README](../../src/modules/events/README.md) |
| `events.list`, `events.boots`, `events.clear` | `src/rpc/procedures/events.procedure.ts:19,45,49` | [event-timeline-rpc.md](event-timeline-rpc.md) |
| Producers | per family | [stream](stream-lifecycle-events.md), [network](network-events.md), [cellular](cellular-events.md), [update](update-events.md), [device](event-emitter.md#device-lifecycle-producers-exists), [capture](capture-events.md) |

Raw journal reads: [device-logs.md](device-logs.md).

## Registry counts

From `Object.keys(EVENT_REGISTRY)` grouped by `family` (Bun import of
`@ceraui/rpc/events`):

| Family | Codes |
|---|---:|
| stream | 11 |
| network | 9 |
| cellular | 7 |
| update | 23 |
| device | 10 |
| capture | 8 |
| **Total** | **68** |

22 update codes use the `update(...)` helper (`events.schema.ts:91-97`); the
other 46 use `entry(...)`. Severities: `error`, `warning`, `info`, `success`
(`events-wire.schema.ts:16`). No registry code contains `thermal` or
`voltage`.

## Emit rule

Authoring rule for producers: emit where the code already decides the fact,
or from a diff over a snapshot it already publishes; add no probe, timer,
subprocess or threshold for an event. Named exception: `disk_low` and
`disk_ok`.

| Fact | Source |
|---|---|
| The disk observer starts with `wasLow = false`, ignores readings that fail its schema, and emits when `freeBytes < LOW_DISK_THRESHOLD_BYTES` (512 MiB) changes: `disk_low` on the first such low reading and on each fall below, `disk_ok` on each return | `src/modules/events/device-disk.ts:10-19`; `events-wire.schema.ts:18` |
| It is created and called in device stats | `src/modules/system/device-stats.ts:658,666` |
| `disk_low` and `disk_ok` share the subject `device:disk` | `events.schema.ts:261-262` |
| Params that fail the code's schema are not emitted; one warning is logged | `emit.ts:158-161` |

## Coalescing

| Fact | Source |
|---|---|
| Window per non-update subject: 30 s; repeats inside it replace the pending state and increment `suppressed`, which is published when the window closes | `emit.ts:65,203-230,145-150` |
| Update family: one emission per subject per boot in this process; the set is seeded once per boot from stored events | `emit.ts:181-202` |
| At most 1024 subjects per collection; new subjects past that are dropped | `emit.ts:67,201,214` |

## Store

| Fact | Source |
|---|---|
| Events: at most 8 files of at most 512 KiB each; boots: at most 2 files of at most 128 KiB each; the active file rotates when an append would exceed its limit | `store.ts:17-28,123-132` |
| Directory: `CERALIVE_EVENTS_DIR`, else `CERALIVE_DATA_DIR/ceralive/events`, else a dev temp dir, else `/data/ceralive/events` | `store.ts:54-65` |
| `mkdir` mode 0700; active file `fchmod` 0600 on append | `store.ts:102,136` |
| Readers skip oversized files, the unterminated last line, unparsable lines and records failing the `v: 1` schema | `store.ts:159-160,173-189` |
| Ring epoch: a UUID in `events.epoch`, mode 0600, kept across reads, rotation and restarts; a missing or damaged file gets a new one on the next `events.list`, and one that cannot be read or written is omitted from the reply | `epoch.ts:12-41`; `events.procedure.ts:34,41` |
| `events.clear` calls `clearEvents`, which deletes the ring epoch first, then the `events` generations, and not the `boots` files | `events.procedure.ts:51`; `store.ts:212-234` |

## Sync

| Event | `fdatasync` requested | Source |
|---|---|---|
| `shutdown_requested`, `service_stopping` | on each published record | `emit.ts:116-117,125` |
| `device_started`, severity `error` or `warning` | at most once per second | `emit.ts:118-125` |
| Others | no | `emit.ts:123-127` |
| Boot records | yes | `store.ts:156` |
| Ring epoch | yes | `epoch.ts:35` |

The store calls `fdatasyncSync` when `sync` is set (`store.ts:138`); failures
are caught and logged as one warning (`store.ts:76-86`).

## Adding an event

1. **Code.** Add a snake_case key to `EVENT_REGISTRY` in
   `packages/rpc/src/schemas/events.schema.ts`.
2. **Params.** A `z.strictObject` of flat values; text fields use `text`
   (`z.string().max(1024)`, `events.schema.ts:42`). Do not pass ICCID, IMEI,
   IMSI, phone numbers, passwords or stream keys.
3. **Severity.** One of the four severities, constant or computed from params.
4. **Subject.** The function that names the entity whose transitions fold
   together.
5. **Emit point.** Call `emitDeviceEvent` (`src/modules/events/device-emit.ts`)
   or `emitEvent` at the producer; add a test beside `src/tests/events-*.test.ts`
   and a line in the family contract.
6. **Copy in ten locales.** `timeline.<code>.title`, and detail keys as needed,
   in `packages/i18n/messages/<locale>.json` for en, ar, de, es, fr, hi, ja,
   ko, pt-BR and zh.
7. **Completeness test.** `apps/frontend/src/tests/timeline-copy-completeness.test.ts`
   asserts, for all ten locales (`:16-27,155-158`), non-empty keys for:
   `timeline.<code>.title` per registry code, `timeline.family.<family>`,
   `timeline.unknown.title`, `timeline.unknown.detail`, one
   `timeline.<code>.detail.<value>` per value for the codes in
   `ENUM_VARIANT_PARAMS` and `FIXED_VARIANTS`, and
   `timeline.stream_start_failed.capture.<cause>` (`:57-77,100-120`). It also
   asserts that each locale's `timeline.*` keys equal English (`:184-194`) and
   that no English code has both a plain detail and variant details
   (`:171-181`). A new enum-variant code must be added to its table to be
   checked. `packages/rpc/src/schemas/events.schema.test.ts` holds the
   registry tests.

## Not qualified on hardware

Owed measurements on a real device: emit latency, CPU cost, event volume per
day and the store's eMMC write rate.
