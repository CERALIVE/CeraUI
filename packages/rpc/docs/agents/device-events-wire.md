# Device events wire contract [EXISTS]

Backend: [device-events.md](../../../../apps/backend/docs/agents/device-events.md).

## Modules

| Module | Import path | Holds | Source |
|---|---|---|---|
| `src/schemas/events-wire.schema.ts` | `@ceraui/rpc/schemas` | `deviceEventSchema`, list input and output, boot records, `EVENT_PUSH`, `EVENT_FAMILIES`, `EVENT_SEVERITIES`, `LOW_DISK_THRESHOLD_BYTES` | `src/schemas/index.ts:15` |
| `src/schemas/events.schema.ts` | `@ceraui/rpc/events` | `EVENT_REGISTRY` and the enums it uses | `package.json:21` |

`src/schemas/index.ts` does not re-export `events.schema.ts`. Rule: boot-time
frontend code imports `@ceraui/rpc/schemas`, not `@ceraui/rpc/events`
([import paths](import-paths.md)). No bundle measurement backs this file.

Procedures `events.list`, `events.boots`, `events.clear`:
`src/contracts/events.contract.ts:9-13`. Push: `EVENT_PUSH = 'event'` with
`{ append: DeviceEvent[] }` (`events-wire.schema.ts:17,80-82`).

## Wire record

| Field | Schema | Source |
|---|---|---|
| `code` | any string | `events-wire.schema.ts:40` |
| `family` | `EVENT_FAMILIES`, falls back to `device` | `events-wire.schema.ts:41` |
| `severity` | `EVENT_SEVERITIES`, falls back to `info` | `events-wire.schema.ts:42` |
| `params` | record of string, number, boolean, null or string array | `events-wire.schema.ts:26-32,43` |

A record with a param value outside those types fails the schema. The store
reader skips records that fail its `v: 1` schema
(`apps/backend/src/modules/events/store.ts:160-161,186`). The Events tab
renders an unknown code with `timeline.unknown.title`
(`apps/frontend/src/lib/device-logs/timeline-copy.ts:124-125`).

## Writer checks

| Check | Source |
|---|---|
| Each registry params schema is a `z.strictObject` | `src/schemas/events.schema.ts:107-279` |
| Text fields are `z.string().max(1024)` | `events.schema.ts:42` |
| The emitter parses params with the code's schema and drops the event on failure | `apps/backend/src/modules/events/emit.ts:158-161` |
| The emitter passes params through `logRedact` before storage | `apps/backend/src/modules/events/emit.ts:113` |

`logRedact` masks what its key and text rules in
`apps/backend/src/helpers/logger.ts` match.

## List input and output

`beforeSeq?`, `limit` 1 to 200 default 100, `bootId?`, `families?`,
`problemsOnly?`; output `events`, `nextBeforeSeq`, `headSeq`,
`retainedFromSeq`, `epoch?` (`events-wire.schema.ts:48-68`).

`epoch` is `eventRingEpochSchema`, a UUID naming the retained ring
(`events-wire.schema.ts:57-59`). It is replaced by a clear, after which `seq`
and event ids can start again at 1. It is optional: the backend omits it when
the store cannot keep one. An omitted epoch cannot establish that the
client's existing window still belongs to that ring. The output
is still a strict object, so a reader built before the field rejects a reply
that carries it. The field and its readers were added before the event wire
reached any release tag.

## Tests

`src/schemas/events.schema.test.ts` (registry params, text ceilings, enums,
severities, subjects, unknown family and severity fallbacks, the optional list
`epoch`).
