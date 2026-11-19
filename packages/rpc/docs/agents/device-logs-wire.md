# Device logs wire contract [EXISTS]

Shapes: `src/schemas/logs.schema.ts`. Procedures: `src/contracts/logs.contract.ts:24-38`
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
| `deleteOlderFiles` | none | `logDeleteOlderFilesOutputSchema` | `{ ok: false, error }` |
| `deleteLegacyDebug` | none | `logStorageOutputSchema` | `{ ok: false, error }` |
| `clearAll` | none | `logDeleteOlderFilesOutputSchema` (includes boot counts) | `{ ok: false, error }` |
| `createExport` | `logExportInputSchema` | `logExportOutputSchema` | `{ ok: false, error }` |
| `previewBundle` | none | `logBundleManifestSchema` | thrown oRPC error, code `READ_FAILED` or `BUSY` |
| `createBundle` | none | `logExportOutputSchema` | `{ ok: false, error }` |

Sources: `src/contracts/logs.contract.ts:25-37`;
`apps/backend/src/rpc/procedures/logs.procedure.ts:41-106` (`previewBundle`
at `:90-101`); `apps/backend/src/modules/device-logs/follow.ts:52`;
`apps/backend/src/modules/device-logs/bundle.ts:85-90`;
`apps/backend/src/modules/device-logs/redaction.ts:1-5`. `{ ok: false, error }` uses `logErrorSchema` with the nine
`LOG_ERROR_CODES` (`logs.schema.ts:18-40`). The 13 handlers are built on
`authedProcedure`, whose middleware throws oRPC `UNAUTHORIZED`
(`apps/backend/src/rpc/procedures/logs.procedure.ts:39-106`;
`apps/backend/src/rpc/middleware/auth.middleware.ts:19-25`).

## Follow push

`LOG_FOLLOW_EVENT = 'logs.follow'` (`logs.schema.ts:29`), sent on the socket
that started the follow (`apps/backend/src/modules/device-logs/follow.ts:102`).
Frame fields (`logs.schema.ts:150-157`): `subscriptionId`, `entries`,
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
socket. The checkpoint carries the boot ID and history epoch. A stale boot-start
checkpoint reports `cursor_unavailable` and attaches at the current head.
An ordinary journal checkpoint from a different boot attaches at the retained
start of the running boot.

## Shapes

| Shape | Rule | Source |
|---|---|---|
| Filter `sources` | default `[]` | `logs.schema.ts:68` |
| Filter `levels` | at least 1, default all four | `logs.schema.ts:69-72` |
| Filter `text` | 1 to 256 UTF-8 bytes, no NUL | `logs.schema.ts:73-80` |
| Time range | `until > since` when both are set | `logs.schema.ts:57-64` |
| `boot` | `current`, `all` or 32 lowercase hex | `logs.schema.ts:42,84` |
| `continuation` | `[A-Za-z0-9_-]`, at most 2048 | `logs.schema.ts:45-48` |
| `limit` | 1 to 200, default 100 | `logs.schema.ts:94` |
| Input objects | `z.strictObject` | `logs.schema.ts:66,89,131` |
| Page `hasMore` | `boolean` or `null`; `null` with `termination: "budget"` | `logs.schema.ts:118-119`; `apps/backend/src/modules/device-logs/scan-page.ts:53-66` |
| Version context | `bootId` (32 lowercase hex) and `ceraui` (string) required; `osImage`, `slot`, `board`, `boardModel`, `engine`, `senderVersion`, `kernel`, `bun` nullable strings | `logs.schema.ts:160-172` |
| Boot `versions` | version context or `null` | `logs.schema.ts:183` |
| `ceraui` fallback | `unknown revision` | `apps/backend/src/modules/system/version-context.ts:66` |
| Storage `ceiling` | object or `null` | `logs.schema.ts:197-202` |
| Retention | `maxAgeDays` at least 1 or `null`; `maxSizeMb` at least 16 or `null`; `detail` `debug` or `info` | `logs.schema.ts:187-191` |
| Retention upper bound | checked against the ceiling in `setRetention` | `apps/backend/src/modules/device-logs/retention.ts:113-120` |
| Bundle manifest | sections `versions`, `events`, `journal`, `settings` with `entries` and `redactions`; journal also has `bootsCovered` and `complete`; `exportedBy`; `boots` with versions | `logBundleManifestSchema` |

`system.getLog` and `system.getSyslog` are unchanged
(`src/contracts/system.contract.ts`).

## Tests

`src/schemas/logs.schema.test.ts`, `logs.schema.contract.test.ts`,
`logs.schema.vocabulary.test.ts`, `logs.schema.alphabets.test.ts`,
`logs.schema.type-test.ts`.
