# Device logs: the raw journal path [EXISTS]

Entry contract for the backend's systemd journal reads. Each fact cites its
source; the linked contracts hold the detail.

## Device log

| Fact | Source |
|---|---|
| The service unit runs `/usr/local/bin/ceralive` with `SyslogIdentifier=ceralive`; read it with `journalctl -u ceralive` | `deployment/ceralive.service:12,15` |
| With `NODE_ENV=production` the logger has a Stream transport (in-memory ring) and a Console transport, and returns before adding the File transport (`debug.log`) | `src/helpers/logger.ts:640,651,668,670` |
| Console lines carry a journal priority: error 3, warn 4, info 6, any other level 7 | `src/helpers/logger.ts:629-633,663` |
| `logs.deleteLegacyDebug` and `logs.clearAll` delete `debug.log` and `debug1.log` to `debug5.log` from the working directory; in production code `deleteLegacyDebugFiles` is called only from those two (unit tests also call it) | `src/modules/device-logs/retention-files.ts:4-11,48-61`; `retention.ts:164,206`; `src/tests/device-logs-retention-files.test.ts:45` |

## Module map

Paths under `src/modules/device-logs/`.

| Modules | Area | Contract |
|---|---|---|
| `catalog.ts`, `filter.ts` | Sources to units, filter to journal matches | [Journal conformance](../../test-harness/journal-conformance/README.md) |
| `reader.ts`, `parse.ts`, `bounds.ts`, `termination.ts`, `mock-journal.ts` | One bounded scan; mock journal | [device-journal-reader.md](device-journal-reader.md) |
| `query.ts`, `scan-page.ts`, `page-window.ts`, `residual.ts`, `continuation.ts`, `around.ts`, `query-admission.ts`, `boots.ts`, `boot-list.ts`, `boot-id.ts` | Pages, around window, boots | [device-log-paging.md](device-log-paging.md) |
| `shutdown-classifier.ts`, `shutdown-window.ts`, `classified-boots.ts` | Boot shutdown class | [device-log-shutdown.md](device-log-shutdown.md) |
| `follow.ts`, `follow-position.ts`, `follow-delivery.ts`, `follow-batch.ts`, `follow-stream.ts` | Live follow | [device-log-follow.md](device-log-follow.md) |
| `retention.ts`, `retention-files.ts`, `storage.ts`, `ceiling.ts`, `settings.ts` | Storage, limits, cleanup | [device-log-retention.md](device-log-retention.md) |
| `export.ts`, `export-body.ts`, `export-format.ts`, `sharing.ts` | View export | [device-log-export.md](device-log-export.md) |
| `bundle.ts`, `bundle-body.ts`, `bundle-data.ts`, `redaction.ts` | Support bundle | [device-log-bundle.md](device-log-bundle.md) |

Procedures: 13 handlers in `src/rpc/procedures/logs.procedure.ts:41-106`.
Download routes `/api/logs/export` and `/api/logs/bundle`: `src/rpc/server.ts:134,137`.
Wire shapes: [logs wire contract](../../../../packages/rpc/docs/agents/device-logs-wire.md).
Events: [device-events.md](device-events.md).

## journalctl argv

| Call site | argv | Source |
|---|---|---|
| Every scan | `journalctl -o json --all --output-fields=<JOURNAL_OUTPUT_FIELDS> <options> -- <matches>` | `reader.ts:13-14,71-80` |
| Follow | `journalctl -f -o json --all --output-fields=<...> [--cursor=<c>] --lines=all -- <matches>` | `follow.ts:161-164,248-258` |
| Follow position probe | options `-r`, or `--cursor=<afterCursor>` | `follow-position.ts:11` |
| Paging | options `-r` for `direction: "older"`; `--cursor=<decoded cursor>` when continuing | `scan-page.ts:28-29` |
| Around event-id seek | options `--since=@<floor(max(0, at-5000)/1000)>`, `--until=@<ceil(min(MAX_SAFE_INTEGER, at+5000)/1000)>`; matches compiled for source `app` and the event's boot; the scan stops at the first record that passes the residual test with `text: eventId` (a substring match) | `around.ts:16,23-43` |
| Storage oldest entry / recent sample | options none / `-r` | `storage.ts:33,57` |
| Shutdown window | options `-r` (tail) or none (head) | `shutdown-window.ts:14` |
| Boot list | `journalctl --list-boots -o json` | `boots.ts:41` |
| Disk usage | `journalctl --disk-usage` | `storage.ts:19` |
| Retention maintenance | `--vacuum-time=<maxAgeDays>d` and/or `--vacuum-size=<maxSizeMb>M`, each when set | `retention.ts:74-84` |
| Delete older files | `--header`, then `--vacuum-time=<seconds>s` with the current boot protected | `older-journal.ts` |
| Clear all | `--rotate`, then `--vacuum-time=1s --vacuum-files=1` | `clear-journal.ts` |

Matches: `_BOOT_ID=`, `PRIORITY=`, `_SYSTEMD_UNIT=`, `_TRANSPORT=kernel`,
`MESSAGE_ID=a596d6fe7bfa4994828e72309e95d61e` (`filter.ts:21-39`).
Level to priority: error 0-3, warning 4, info 5-6, debug 7 (`filter.ts:9-14`).

| Source | Journal candidates | Recent volume attribution |
|---|---|---|
| CeraLive app | `ceralive.service` | App records without the sender prefix |
| Bonding sender | `ceralive.service`, `srtla-send.service`, `srtla.service` | `srtla_send: ` messages from `ceralive.service`, plus entries from the two standalone receiver units when present |

The shared unit is matched once when both sources are selected. Source
membership uses the message prefix before display formatting. A suppression
notice naming `ceralive.service` can affect both sources.

Values from a request:

| Value | Check | Source |
|---|---|---|
| Continuation token | characters `[A-Za-z0-9_-]`, at most 2048; decoding is checked in `continuation.ts:51-65` | `packages/rpc/src/schemas/logs.schema.ts:45-48` |
| Decoded continuation cursor | `[A-Za-z0-9=;:_.-]`, 1 to 1024 characters; filter hash, boot or direction mismatch returns `FILTER_CHANGED`, epoch mismatch `CURSOR_UNAVAILABLE` | `continuation.ts:5-18,51-74` |
| Follow `afterCursor` | `[A-Za-z0-9=;:_.-]`, at most 1024 characters | `logs.schema.ts:49-52,133` |
| Around `at` | non-negative integer | `logs.schema.ts:43` |
| Boot id | 32 lowercase hex | `logs.schema.ts:42` |
| Search text | not in argv; case-insensitive substring test on the message | `residual.ts:12-16` |
| Time range | paging input accepts `since`/`until` (`logs.schema.ts:53-56,91`); not in argv; inclusive test on the record timestamp (`residual.ts:10-11`). The follow input has no `since`/`until` and its strict schema rejects them (`logs.schema.ts:131-134`) | as cited |

Retention ceiling: `setRetention` returns `INVALID_RETENTION` for a value above
the ceiling or any limit when the ceiling is unreadable (`retention.ts:113-120`).
The RPC parses `logRetentionSchema` once before the service checks the
deployment ceiling and persists the typed settings. Settings loaded from disk
are parsed separately without a ceiling check.
Maintenance runs when a ceiling is readable and a limit is set
(`retention.ts:46-52,72`) and does not compare values with the ceiling
(`retention.ts:71-101`).

## Limits

| Limit | Value | Source |
|---|---|---|
| Scan deadline | 2000 ms | `reader.ts:7` |
| Records examined per scan | 4096 | `reader.ts:8` |
| Stdout bytes per scan | 8 MiB, counted per chunk read; the chunk that exceeds it is not parsed and the scan ends with `budget` | `reader.ts:9,160-163`; `bounds.ts:26-29` |
| One record | 1 MiB, else `RECORD_TOO_LARGE` | `reader.ts:10,126,168,178` |
| Stderr kept | 64 KiB | `reader.ts:11` |
| Page size | 1 to 200, default 100 | `logs.schema.ts:94` |
| Search text | 1 to 256 UTF-8 bytes, no NUL | `logs.schema.ts:73-80` |
| Queries | a new query on a socket aborts its previous one; `BUSY` at 2 running | `query-admission.ts:25,28` |
| Follows | a new start on a socket stops its previous one; `BUSY` at 4 running | `follow.ts:80-83` |
| Follow batch | flush delay 0 at 200 entries or 64 KiB, else 250 ms; an entry past 200 entries or 256 KiB is counted in `dropped` | `follow-batch.ts:23,34` |
| Follow catch-up | more than 2000 records examined before the first flush restarts the follower with `gap: "catchup_exceeded"` | `follow-delivery.ts:47-50`; `follow.ts:206-213` |
| Export | 64 MiB, 120 s; ticket 60 s, deleted on use | `export-body.ts:10-11`; `export.ts:65,90` |
| Bundle | 32 MiB plain, 8 MiB compressed; 60 s to prepare, 60 s to download | `bundle-body.ts:12-13`; `bundle.ts:53,70,128` |
| Sharing slot | one lease at a time | `sharing.ts:4-15` |
| Clear all and sharing | releases unused export and bundle tickets and aborts running downloads | `retention.ts:180`; `export.ts:174-180`; `bundle.ts:196-201` |

## Error codes

`LOG_ERROR_CODES` (`packages/rpc/src/schemas/logs.schema.ts:18-28`), with
example origins:

| Code | Returned at |
|---|---|
| `CURSOR_UNAVAILABLE` | `continuation.ts:62,65,73`; `scan-page.ts:51` |
| `BOOT_UNAVAILABLE` | `query.ts:39,64`; `follow.ts:85` |
| `FILTER_CHANGED` | `continuation.ts:72` |
| `JOURNAL_UNAVAILABLE` | `reader.ts:92` (spawn `ENOENT`); `boots.ts:44` |
| `BUSY` | `query-admission.ts:28`; `follow.ts:83`; `export.ts:61`; `bundle.ts:45` |
| `RECORD_TOO_LARGE` | `reader.ts:126,168,178` |
| `READ_FAILED` | `reader.ts:93,134,153`; `retention.ts:128,150,157` |
| `INVALID_RETENTION` | `retention.ts:112,120` |
| `UPDATE_IN_PROGRESS` | `retention.ts:176,201` |

## Spawn policy

| Id | Symbol | Class | Source |
|---|---|---|---|
| `deviceLogs.journalScan` | `scanJournal` (`reader.ts`) | `bounded-command` | `src/helpers/spawn-policy.ts:337-353` |
| `deviceLogs.journalFollow` | `nativeFollow` (`follow.ts`) | `watcher` | `src/helpers/spawn-policy.ts:319-335` |

## Tests

| Test | Asserts |
|---|---|
| `src/tests/spawn-policy.test.ts:106-128` | the `deviceLogs.journalScan` site |
| `src/tests/device-logs-follow-policy.test.ts:5-7` | the `deviceLogs.journalFollow` site |
| `src/tests/device-logs-filter.test.ts:235-248` | compiler matches equal `test-harness/journal-conformance/golden-argv.txt` (15 rows) |
| `src/tests/device-logs-query-golden.test.ts:76-104,116-171` | paging (`:76-104`) and around-seek (`:116-164`) argv, compared at `:171`, equal `query/golden-argv.txt` (20 rows: 9 paging, 11 around seek) |
| `test-harness/journal-conformance/query/replay.sh:12-23` | replays each `query/golden-argv.txt` row against a fixture journal and checks the returned ids |
| `src/tests/device-logs-suppression-conformance.test.ts:81-98` | a captured systemd 257 suppression record parses with its `MESSAGE_ID` and message, maps to marker `suppressed`, and classifies a boot ending on it as `unknown` (`too_few_entries`) |
| `test-harness/journal-conformance/live.sh:136-166` | journald burst 2000 per 30 s: a 6000-line flood stores 6000 entries and no `Suppressed` notice is written |
| `test-harness/journal-conformance/live.sh:168-206` | unit rate limit burst 1 per 2 s: fewer than 6000 of 6000 lines are stored, a notice with `MESSAGE_ID=a596d6fe7bfa4994828e72309e95d61e` appears, and `assert-suppression.sh:3-9` checks its `MESSAGE_ID`, `N_DROPPED`, message text and a positive dropped count |

`live.sh` runs through `bun run test:journal-conformance` (`package.json:32`).
`src/tests/device-logs-*.test.ts` hold the other unit tests.

## Child-process stderr

`src/modules/streaming/streamloop/process-runner.ts` logs each nonempty sender
stderr line with the `srtla_send: ` prefix. Warn or warning wins, failure
keywords map to error, and the remaining lines are info. Notifications still
receive the original stderr chunks. In production `setJournalDetail`
sets the console level (`src/helpers/logger.ts:707-714`); it is called from
`initLogSettings` (`settings.ts:96`, run at `src/main.ts:446`) and from
`setRetention` (`retention.ts:124`).

## Not qualified on hardware

Owed measurements on a real device:

- Query latency on a full journal, for each direction and range preset.
- CPU cost while streaming with follows open.
- Debug-detail journal volume per day and the eMMC wear it causes.
- Four simultaneous followers under streaming load.
