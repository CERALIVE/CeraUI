# Device logs wire contract [EXISTS]

Shapes: `src/schemas/logs.schema.ts`. Procedures: `src/contracts/logs.contract.ts`
(`appContract.logs`). Backend: [device-logs.md](../../../../apps/backend/docs/agents/device-logs.md).

## Procedures

| Procedure | Input schema | Output schema | Classified failure |
|---|---|---|---|
| `query` | `logQueryInputSchema` | `logQueryOutputSchema` | `{ ok: false, error }` |
| `around` | `logAroundInputSchema` | `logAroundOutputSchema` | `{ ok: false, error }` |
| `boots` | none | `logBootInfoSchema[]` | thrown |
| `followStart` | `logFollowStartInputSchema` | `logFollowStartOutputSchema` | `{ ok: false, error }` |
| `followStop` | none | `logFollowStopOutputSchema` | `success: false` when no follow |
| `getStorage` | none | `logStorageSchema` | thrown |
| `setRetention` | `logRetentionSchema` | `logStorageOutputSchema` | `{ ok: false, error }` |
| `deleteLegacyDebug` | none | `logStorageOutputSchema` | `{ ok: false, error }` |
| `clearAll` | none | `logClearAllOutputSchema` (includes boot counts) | `{ ok: false, error }` |
| `createExport` | `logExportInputSchema` | `logExportOutputSchema` | `{ ok: false, error }` |
| `previewBundle` | none | `logBundleManifestSchema` | thrown oRPC error, code and message `READ_FAILED` or `BUSY`; a classified `READ_FAILED` adds `data.stage` |
| `createBundle` | none | `logExportOutputSchema` | `{ ok: false, error }` |

Sources: `src/contracts/logs.contract.ts`;
`apps/backend/src/rpc/procedures/logs.procedure.ts`; `apps/backend/src/modules/device-logs/follow.ts:52`;
`apps/backend/src/modules/device-logs/bundle.ts:100-105`;
`apps/backend/src/modules/device-logs/redaction.ts:4-12`. `{ ok: false, error }` uses `logErrorSchema` with the nine
`LOG_ERROR_CODES` (`logs.schema.ts:21-31`). The 12 handlers are built on
`authedProcedure`, whose middleware throws oRPC `UNAUTHORIZED`
(`apps/backend/src/rpc/procedures/logs.procedure.ts`;
`apps/backend/src/rpc/middleware/auth.middleware.ts:19-25`).

The preview stage is the closed `logBundleFailureReasonSchema` in
`logs-boot.schema.ts`: `collision`, `pattern`, `budget`, `journal_read`,
`deadline`, `abort` and `internal`. It is additive: the message stays exactly
`READ_FAILED` or `BUSY`, which older and federated frontends match, and the
stage rides oRPC `data.stage` and the WS envelope's optional `stage` (the
adapter forwards only a value this schema accepts). An unclassified refusal and
BUSY carry no stage, so their envelopes are unchanged. A frontend reads a
missing or unknown stage as `internal`. The stage never carries a cause, input
text, secret or position. `createBundle` keeps `{ ok: false, error }` without a
stage.

## Follow push

`LOG_FOLLOW_EVENT = 'logs.follow'` (`logs.schema.ts:32`), sent on the socket
that started the follow (`apps/backend/src/modules/device-logs/follow.ts:102`).
Frame fields (`logs.schema.ts:161-169`): `subscriptionId`, `entries`,
`checkpointCursor`, `dropped`, optional `gap` (`catchup_exceeded`,
`cursor_unavailable`, `suppressed`), optional `ended` (`follower_exit`,
`boot_changed`, `cleared`).

On `catchup_exceeded`, the optional `gapFrom` field is a `logs.query` continuation
for direction `newer` using the same filter and `boot: "current"`. It starts after
the old checkpoint and ends at the restart checkpoint, including that record
if it matches. On the socket the continuation travels as a sibling envelope
field named `logs.follow.gapFrom`, alongside the unchanged `logs.follow`
payload. Receivers that understand the sibling fold it into the parsed follow
message. Older receivers ignore the sibling and still accept the original gap
payload through their strict schema.

A follow started on a verified empty boot returns a boot-start checkpoint in
the existing `checkpointCursor` field. Clients echo it as `afterCursor` to
replay from the beginning of retained history for that boot, even on another
socket. The checkpoint carries the boot ID and history epoch. Both boot-start
and ordinary journal checkpoints from another boot attach at the retained
start of the running boot without a cleanup gap. A boot-start checkpoint for
the current boot with an old history epoch reports `cursor_unavailable` and
attaches at the current head. A matching epoch with an unprovable retention
boundary reports the gap and reads from the retained start.

## Shapes

| Shape | Rule | Source |
|---|---|---|
| Filter `sources` | default `[]` | `logs.schema.ts:79` |
| Filter `levels` | at least 1, default all four | `logs.schema.ts:80-83` |
| Filter `text` | 1 to 256 UTF-8 bytes, no NUL | `logs.schema.ts:84-91` |
| Time range | `until > since` when both are set | `logs.schema.ts:64-75` |
| `boot` | `current`, `all` or 32 lowercase hex | `logs-fields.ts:3`, `logs.schema.ts:95` |
| `continuation` | `[A-Za-z0-9_-]`, at most 2048 | `logs.schema.ts:56-59` |
| `limit` | 1 to 200, default 100 | `logs.schema.ts:105` |
| Input objects | `z.strictObject` | `logs.schema.ts:77,100,142` |
| Page `hasMore` | `boolean` or `null` with `termination: "budget"` | `logs.schema.ts:129-130`, `apps/backend/src/modules/device-logs/scan-page.ts:53-66` |
| Version context | `bootId` (32 lowercase hex) and `ceraui` (string) required. `osImage`, `slot`, `board`, `boardModel`, `engine`, `senderVersion`, `kernel`, `bun` nullable strings | `logs-boot.schema.ts:4-16` |
| Boot `versions` | version context or `null` | `logs-boot.schema.ts:27` |
| `ceraui` fallback | `unknown revision` | `apps/backend/src/modules/system/version-context.ts:66` |
| Storage `ceiling` | object or `null` | `logs.schema.ts:182-187` |
| Retention | `maxAgeDays` at least 1 or `null`, `maxSizeMb` at least 16 or `null`, `detail` `debug` or `info` | `logs.schema.ts:172-176` |
| Retention upper bound | checked against the ceiling in `setRetention` | `apps/backend/src/modules/device-logs/retention.ts:113-120` |
| Bundle manifest | sections `versions`, `events`, `journal`, `settings` with `entries` and `redactions`; journal also has `bootsCovered` and `complete`; `exportedBy`; `boots` with versions | `logBundleManifestSchema` |

`system.getLog` and `system.getSyslog` are unchanged
(`src/contracts/system.contract.ts`).

## Tests

`src/schemas/logs.schema.test.ts`, `logs.schema.contract.test.ts`,
`logs.schema.vocabulary.test.ts`, `logs.schema.alphabets.test.ts`,
`logs.schema.type-test.ts`.
