# Device log paging [EXISTS]

`src/modules/device-logs/query.ts` exports `queryLogs(conn, input)`,
`locateAround(conn, input)` and `abortLogQueries()`. The connection object owns
one running operation. A replacement aborts and joins that operation before
starting; at most two operations run device-wide. Each operation holds its slot
through boot discovery and its sequential scans. Export callers can use a
dedicated owner object to share the device limit independently of socket queries.
Clear awaits `abortLogQueries()` to join all active operations.

The service consumes only the landed reader, parser, mock adapter, compiler,
settings and event-store public APIs. No viewer or RPC wiring is added here.
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

Event location uses one bounded reverse app-source scan in journal cursor order.
The parser recognizes the event producer's `module: "events"`, `msg: "event"`
and string `meta.event_id` before formatting the display message. The scan
requires an exact case-sensitive ID and inclusive five-second membership on
each side, without native realtime pruning when the clock steps. The first
matching entry becomes the exact anchor, excluded from both surrounding
50-entry pages. The seek and enclosing pages retain their first decisive
result and let the bounded reader settle without requesting an early stop, so
a short native scan may finish before its stdout is processed. A budget cut
without an anchor returns `READ_FAILED`. At EOF
without a match, two independent
pages scan the boot in opposite directions with membership windows
`max(0, at - 60000) <= ts <= at` and `at < ts <= at + 60000`. At timestamp zero,
the older query omits its redundant lower bound so its wire range stays valid.
Both replies carry the exact query objects for continuing each page.

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
native list command. Under mocks it assembles one current journal boot from the
ring, together with stored-only boot history, without spawning.
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
