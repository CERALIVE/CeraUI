# Journal conformance [EXISTS]

Run `bun run test:journal-conformance` from the repository root with Docker and
an existing `debian:trixie` image. The runner refuses to pull an image.
CI provisions that image explicitly before invoking the same command.
`CONFORMANCE_SELFTEST=1 bun run test:journal-conformance` deliberately reverses
the first paging expectation and must fail.

`fixture.sh` imports seven records into a real journal and asserts systemd 257
paging, filtering, cursor, JSON and clock-step behavior. A second seven-record
fixture tests a backwards wall-clock step. `live.sh` asserts daemon behavior:
priorities, backlog and follow, excluded anchors, restart, suppression, rotation,
vacuum, predecessor accounting, boot boundaries and clean versus killed boots.
It refuses to run outside the explicitly marked disposable container.

Only the live container is privileged. Packages install into its writable layer;
no temporary image is built, and no image is removed. A unique named volume
retains journals across clean shutdown and two abrupt shutdowns of that container.
The fake boot-id bind is inside its mount namespace. No host journal directory,
socket or cgroup filesystem is mounted. Each run removes its own containers,
volume and repository-local ignored scratch directory on exit, printing a
cleanup receipt. The final success line follows cleanup.

Follower checks read exact journal events with bounded timeouts. Readiness uses
a FIFO written by a systemd unit after journald and D-Bus start. The suppression
check uses a systemd timer to cross the configured 30-second rate interval,
then awaits a journal marker and inspects any suppression notice. The per-unit
case reads a readiness marker from its journal follower before scheduling the
release that triggers the notice. It then allows 15 s for the notice to arrive.
The overall runner has a 12-minute deadline. Individual follower, readiness,
live-suite and shutdown waits have shorter deadlines.

With `-n 0 --after-cursor`, systemd 257 defers cursor backlog until the next
journal event. That check subscribes to the follower's stdout epoll registration
through `strace`, then writes the live entry and asserts backlog plus live
delivery. Waiting for backlog before that write would deadlock the test.

Experimental result on systemd 257.13: `RateLimitIntervalSec=30s` plus
`RateLimitBurst=2000` stores all 6,000 flood lines, and the next write after
the interval emits no suppression notice (`MESSAGE=null`, `MESSAGE_ID=null`).
Journald scales burst limits with available disk space; the configured burst
alone does not establish an effective 2,000-line ceiling. The suite asserts
the observed count and absent notice rather than manufacturing a suppression
record (`live.sh:136-166`). A second case sets a per-unit rate limit
(`LogRateLimitBurst=1`, 2 s), asserts that fewer than 6,000 of 6,000 lines are
stored, waits for the journal's notice with `MESSAGE_ID=a596d6fe7bfa4994828e72309e95d61e`
and checks its message id, `N_DROPPED`, message text and a positive dropped
count with `assert-suppression.sh` (`live.sh:168-209`).

The predecessor directory is excluded from `journalctl --disk-usage` and
vacuum, while `du` includes it. Injected boots can share an archived file:
both old and current boot ids remained after the boot-age vacuum in this run.
Consumers must report the remaining boot list instead of promising old boots
were deleted. Docker reported exit 130 after `systemctl poweroff`; the
shutdown assertion uses the persisted last journald lifecycle record, rather
than treating a container exit code as evidence of a clean journal shutdown.

The journal's native time bounds are traversal bounds, not record membership:
after a backwards clock step, reverse `--since` can hide in-range records.
Readers must validate an anchor without applying the user's match and filter
realtime timestamps themselves. A missing well-formed cursor can exit zero.
The suite prints suppression text and message id, boot lists around vacuum,
predecessor disk accounting and lifecycle ids for downstream consumers.

This proves the Debian systemd 257 behavior in containers. Physical device
latency, CPU load and streaming log volume remain unmeasured.

## Source catalog and filter compiler [EXISTS]

`src/modules/device-logs/catalog.ts` assigns the named services and the remaining
inventory services to sources; unlisted units return `null`. The inventory in
`src/tests/fixtures/device-units.txt` records service basenames from image
`origin/master` at `36aef71b1ce032726d7bfe2e91594fef02af560b` under `mkosi/runtime`,
then CeraUI's deployment services and the engine and sender service names.
Template names stay literal; the two known rauc-arm instances are listed
separately. Arbitrary template instances are not expanded into journal matches.
The device remainder also contains the inventory's certificate, PipeWire,
WirePlumber and legacy hawkBit units.

`compileFilter(filter, { bootId })` returns field `matches` for placement after
the reader's `--` boundary and an unchanged literal `residual.text`. The reader
applies case-insensitive substring search to the displayed message and tests
time membership per record. This compiler emits neither options nor time bounds.
Repeated and reordered source or level selections produce a bounded canonical
token list. Suppression notices use a separate boot-scoped OR group without a
priority restriction; their source relevance belongs to the reader.

Run `cd apps/backend && bun test ./src/tests/device-logs-filter.test.ts`.
`golden-argv.txt` is JSONL with `name`, `filter`, `bootId` and `matches` per row.
Tests compare it without writing; regenerate explicitly with `UPDATE_GOLDEN=1`
on the same test command. `query/golden-argv.txt` holds the paging and
around-seek option cases (`src/tests/device-logs-query-golden.test.ts:76-171`);
`query/replay.sh` replays each row against a fixture journal.

## Retention and cleanup [EXISTS]

`src/modules/device-logs/retention.ts` owns retention changes and serializes
maintenance, older-file vacuum, legacy-file removal and clear. Settings and
maintenance receipts use the existing atomic settings store. With an unknown
image ceiling, `setRetention` refuses any non-null limit; a save with both limits
`null` (for example a Detail-only change) is accepted (`src/modules/device-logs/retention.ts:109-126`).

The daily check runs only with an explicit user limit and a readable ceiling.
It vacuums archived files without rotating. Its receipt reports whether observed
size and oldest-entry age meet the target; active journal files may prevent that.
Storage reports journalctl usage separately from recursive journal-directory
bytes, including the image-owned predecessor directory. Recent source volume
is a sample of up to 4096 records (`src/modules/device-logs/storage.ts:55-59`).

Older-file cleanup rotates and vacuums using rounded uptime plus sixty seconds,
then reports journal boot counts before and after. Files may contain more than
one boot. Clear refuses during a busy update phase, persists a new history epoch
and closes admission in one synchronous step. Follow, export and query
cancellations start together and join for at most 15 seconds. A rejected or
timed-out drain returns `READ_FAILED`, reopens admission and deletes nothing.
After another update-phase check, clear rotates and vacuums, removes only the six
legacy debug files, and records its completion time. Admission stays closed
through final storage readout; new requests wait and old pending requests use
their existing cancellation outcome. Export queries share scan admission;
their captured history epoch expires after clear. Clear does not delete the
event store or the predecessor directory (`src/modules/device-logs/retention.ts:171-217`). Export cancellation invalidates unused tickets and
releases a paused download's sharing lease without requiring another client read.
Mock operations use the logger ring without native
journal commands or image/journal-directory reads; legacy unlink precedes the
ring reset and its immediate clear record.

The [retention contract](../../docs/agents/device-log-retention.md) records
the full-disk persistence limit, metadata readers outside admission, and the
landed reader and follow-stream defects that retention cannot repair.

`ceiling.ts`, `retention-files.ts` and `storage.ts` keep parsing, filesystem
operations and readout separate. Disk usage, rotation and vacuum run through the
argv-only `run()` helper; the oldest-entry and recent-volume samples call
`scanJournal` under the `deviceLogs.journalScan` policy
(`src/modules/device-logs/storage.ts:19,29-38,48-71`; `src/helpers/spawn-policy.ts:337-353`).
Tests are `src/tests/device-logs-retention*.test.ts`.
The 13 logs procedures are registered in `src/rpc/router.ts:189-203`. Board latency, CPU and streaming
log volume remain unmeasured.
