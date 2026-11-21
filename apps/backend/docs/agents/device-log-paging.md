# Device log paging [EXISTS]

`src/modules/device-logs/query.ts` exports `queryLogs(conn, input, admission?)`,
`locateAround(conn, input, admission?)` and `abortLogQueries()`. The connection object owns
one running operation. A replacement aborts and joins that operation before
starting; at most two operations run device-wide. Each operation holds its slot
through boot discovery and its sequential scans. Filtered export and support
bundle reads use separate owners and acquire a slot per page. Each class
admits its oldest eligible request. A same-socket replacement keeps its place
in the queue while its owner is running, but another owner can use a free
slot without waiting for that replacement.

Viewers get priority, but after two viewer admissions while download pages
are queued, the oldest eligible download gets the next free slot. A download
admission resets that count. With both slots held by downloads, the first
eligible viewer gets the first freed slot before another download page. As
long as holders settle, history admission is open, and waiters stay live,
neither class can starve. This is a bound on handoffs, not on elapsed time.
A slot is not free until its read settles, including confirmation of child exit.

Raw query and Around RPCs wait up to the journal scan deadline plus its
termination grace and 1,000 ms (currently 3,100 ms). Expiring that wait returns
`BUSY` if another viewer still holds a slot, and `READ_FAILED` otherwise,
including when only download readers hold slots. Socket closure or request
cancellation while waiting also returns `READ_FAILED`. The admission timer is
cleared when the wait ends, before any granted read starts. Clear wakes queued
operations, including replacements blocked on their own socket, so an older
history epoch returns `READ_FAILED` without waiting for reap. Clear still joins
all active operations through `abortLogQueries()`. The separate refusal while
[Clear is awaiting settlement](device-log-retention.md#admission-and-terminal-ownership)
remains `BUSY`.

The service consumes the reader, parser, mock adapter, compiler, settings and
event-store public APIs.
`residual.ts` exports `matchesResidual` for paging and the subsequent follow
service: literal case-insensitive displayed-message text, inclusive timestamp
membership and source relevance of suppression notices. Out-of-range records
never stop traversal. Suppression text/ID remain synthetically tested; the
systemd conformance flood has not produced a real notice.

`continuation.ts` binds a position to the first 16 hex characters of SHA256 over
JSON `{sources, levels, text, since, until}`. Sources and levels are deduplicated
and sorted; omitted optional values stay omitted. Boot, history epoch and
direction are separate token fields. Limit is deliberately outside the binding.
Decoded JSON is parsed before any cursor is used. Malformed tokens and stale
epochs return `CURSOR_UNAVAILABLE`; changed filter, boot or direction returns
`FILTER_CHANGED`. Tokens are positions, not authorization credentials.

`page-window.ts` owns the pure per-record transition; `scan-page.ts` composes
that window with the bounded reader. An inclusive continuation must first emit
its exact anchor, which is discarded before applying residuals. A mismatched
first record or zero-record EOF expires the position. A further matching record
proves look-ahead and resumes from the last returned entry. Physical EOF alone
proves end. Budget exhaustion has unknown `hasMore` and resumes from the last
examined record, including an out-of-range record; before examining anything it
preserves the incoming token or returns null on the first page. Query options
contain only the direction and an optional inclusive cursor, never native time
bounds or line limits.

Event location first seeks forward with rounded native realtime bounds around
the requested time, scoped to the selected boot and app unit. If the seek
misses or spends its budget, a bounded reverse scan without native time
pruning can recover records hidden by a clock step.
The parser recognizes the event producer's `module: "events"`, `msg: "event"`
and string `meta.event_id` before formatting the display message. The scan
requires an exact case-sensitive ID and inclusive five-second membership on
each side on both passes, independently of the native seek. The first
matching entry becomes the exact anchor, excluded from both surrounding
50-entry pages. The seek stops at a verified record and the surrounding scans
stop at lookahead or an expired cursor. The reader still joins the child.
Without an exact anchor, each approximate page starts with rounded realtime
hints and applies its exact membership window: `max(0, at - 60000) <= ts <= at`
for older and `at < ts <= at + 60000` for newer. A hinted scan that does not
reach lookahead retries in the same direction without time pruning to account
for clock steps. If that retry exhausts its budget, the page reports `budget`
with unknown `hasMore`. If the hinted scan located rows, the page keeps them
and continues from the last returned cursor. At timestamp zero, the older query
omits its redundant lower bound so its wire range stays valid. Both replies
carry the exact queries for continuing without hints.

Derived upper bounds saturate at the wire timestamp maximum (`Number.MAX_SAFE_INTEGER`).
When the inclusive newer lower bound reaches that maximum, its redundant upper
bound is omitted to keep the query valid. At the maximum itself the strict newer
window is empty: its page is terminal with no continuation. Admission is unchanged,
including timestamps zero and the maximum.

`boot-list.ts` parses native boot-list JSON and assembles journal rows with
stored boot versions. Journal timestamps are microseconds converted to whole
milliseconds; stored-only rows project their start timestamp into the wire range and report
`logsAvailable: false`. Rows are newest journal index first, followed by
stored-only boots with older indices. Shutdown is `unknown` until the
classifier is integrated; the current boot is `current`. `boots.ts` performs the
native list command. Under mocks it assembles one current journal boot
together with stored-only boot history, without spawning. The current mock
boot's `firstTs` is captured the first time that boot ID is listed in the
backend process and stays fixed even if the log ring is pruned or cleared.
Its `lastTs` still comes from the last retained entry, or is zero for an empty
ring.
Stored-only indices saturate at `Number.MIN_SAFE_INTEGER`; stored start times
are floored and saturated to the nonnegative safe-integer wire timestamp range.

Tests are `src/tests/device-logs-query*.test.ts`, `device-logs-around*.test.ts`,
`device-logs-boots.test.ts`, `device-logs-boot-list.test.ts`, `device-logs-continuation.test.ts` and
`device-logs-residual.test.ts`. The service-owned golden is
`test-harness/journal-conformance/query/golden-argv.txt`; regenerate only with
`UPDATE_GOLDEN=1 bun test ./src/tests/device-logs-query-golden.test.ts`.
The separate query directory preserves the landed filter golden's exact-byte
contract. The conformance fixture replays its option/match combinations against
real systemd 257 with fixture cursor substitution and exact expected message IDs.

This is a backend service, not a released UI. Physical device latency, CPU and
streaming log volume remain unmeasured.
