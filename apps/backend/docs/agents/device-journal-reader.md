# Device journal primitives [EXISTS]

`src/modules/device-logs/reader.ts` exports `scanJournal`, `JournalReadError`,
`JOURNAL_LIMITS` and `JOURNAL_OUTPUT_FIELDS`. Callers supply internal `options`
and the filter compiler's `matches`; these arrays must never contain client argv.
The reader requests JSON with unabridged messages and an end-of-options boundary.
It never uses the buffered `run` helper.

The default limits are 2,000 ms, 4,096 candidate records (including skipped
records), 8 MiB stdout, 1 MiB per JSON line and 64 KiB retained stderr. Stderr
continues draining after its capture limit. An unfinished line spends its byte
budget before JSON parsing; malformed JSON and invalid UTF-8 fail the scan.
Callbacks receive `RawJournalRecord` and return `continue` or `stop`.
The result carries `status`, the reaped `exitCode` (null only when cancelled
before spawn), and `skippedRecords`.

Only `eof` proves a successful physical end of the scope, including both pipe
drains and a zero child exit. `stopped` is callback or signal cancellation;
`budget` proves no end. The paging owner decides look-ahead and `hasMore`.
Termination sends TERM, escalates to KILL after 100 ms and joins the child's
exit. A signal failure is retained as a typed cause of `READ_FAILED` when
there is no earlier read failure. The reader cancels the pipes and releases
their locks without joining stream cancel hooks. A zero exit induced by
cancellation does not become EOF. Unexpected
nonzero exits fail with `READ_FAILED`. Exit classification happens after reaping:
cancellation accepts zero or a signal exit matching TERM/KILL actually sent by
this reader. An external KILL remains a failure when the reader sent only TERM,
including when stop or abort races with that death. ENOENT at spawn is
`JOURNAL_UNAVAILABLE`; an oversized line is `RECORD_TOO_LARGE`.

`parse.ts` exports `parseRecord`, `RawJournalRecord` and `toLogEntry`. Missing
or malformed cursor, timestamp or journal-form boot ID returns null and is
counted by the reader. Timestamps must be nonnegative safe integer
microseconds, expressed as numbers or decimal digit strings. Conversion
floors to integer milliseconds; cursors retain ordering authority.
Only a case-sensitive `.service` suffix supplies the display unit; its final
suffix is removed. Other unit kinds use `SYSLOG_IDENTIFIER`, then `system`.
Empty service stems also fall back. Fields are not trimmed or case-normalized:
leading whitespace is retained by literal suffix matching, trailing whitespace
prevents that match, and a nonempty identifier remains verbatim.
Missing priority defaults to info. Missing message remains empty with an
explicit truncation flag; oversized messages retain their first 16 KiB.
Journal byte arrays decode as UTF-8, retaining replacement characters for
invalid message bytes. Invalid UTF-8 in the JSON transport itself is an error.
Classifier fields `messageId`, `unitField` and `pid` stay internal;
`toLogEntry` removes them at the wire boundary.

The contracted suppression ID is recognized synthetically by the parser.
The systemd 257 conformance flood produced no suppression notice: its text and
ID remain unproven. No notice text is inferred or manufactured here.

`mock-journal.ts` exports `scanMockJournal`, `followMockJournal` and
`mockJournal = { scan, follow }`. Callers choose it through `shouldUseMocks()`.
Scans accept the reader's options excluding `spawn`, share its bounds and
results, and use the real redacted logger ring without spawning. Positions
support forward/reverse traversal and inclusive/exclusive mock cursors.
Compiled field groups apply before delivery; residuals remain with callers.
The cursor is `mock=<seq>` using the logger's monotonic eviction/clear offset.
Boot identity comes only from `currentBootId()`.

Mock follow accepts `options`, `matches`, `signal` and `onRecord`, returning
`{ abort, exited }`. It subscribes before draining the snapshot, keeps reentrant
appends in journal order, and unsubscribes on abort, callback stop or error.
Its pending queue is bounded by the ring capacity. It owns no timer.
The real follower and its batching/admission remain separate consumers.

These are backend primitives, not a released viewer. Container behavior is
host evidence; board latency, CPU and streaming volume remain unmeasured.

### Scan budget [EXISTS]

`src/modules/device-logs/bounds.ts` exports only `scanBudget(limits, clock)`.
It captures the start time at creation; the reader creates it before spawning
and calls `delay()` afterward so spawn time spends the deadline.
`delay()` returns the remaining milliseconds, clamped to zero.
`exhausted()` checks the candidate count before reading the supplied clock,
then checks elapsed time. Either reaching or exceeding a limit exhausts it.
`take()` counts one candidate, including a record the reader later skips.
`overStdout(bytes)` accumulates bytes and reports only totals above the limit.

The default scan limits are 2,000 ms, 4,096 candidate records (including skipped
records) and 8 MiB stdout. Exactly 8 MiB is allowed; the next byte is over budget.
The constants and all errors remain the reader's responsibility; this helper
has no default clock, timer, process or reader import. Reader composition is
provided by the separate bounded-reader unit.

### Termination decision table

`JournalChild.signalCode` is the native termination kind, read after reaping.
A normal exit has `signalCode === null`; numeric 143 and 137 are ordinary
failures in that case. They never prove TERM or KILL death.
One classifier owns every process-completion decision after the child is joined.

In this table `F` means `READ_FAILED`, `S` means `stopped`, and `B` means `budget`.
`T` means the reader issued TERM; `TK` means it issued TERM and then escalation
KILL. A cancellation request alone owns no OS signal.

| Reaped observation | EOF/no signals | stop/no signals | stop/T | stop/TK | abort/no signals | abort/T | abort/TK | budget/no signals | budget/T | budget/TK |
|---|---|---|---|---|---|---|---|---|---|---|
| Normal exit 0, signal null | eof | S | S | S | S | S | S | B | B | B |
| Normal exit 1, signal null | F | F | F | F | F | F | F | F | F | F |
| Normal exit 42, signal null | F | F | F | F | F | F | F | F | F | F |
| Normal exit 137, signal null | F | F | F | F | F | F | F | F | F | F |
| Normal exit 143, signal null | F | F | F | F | F | F | F | F | F | F |
| Any other nonzero normal exit | F | F | F | F | F | F | F | F | F | F |
| Signal TERM death | F | F | S | S | F | S | S | F | B | B |
| Signal KILL death | F | F | F | S | F | F | S | F | F | B |
| Signal INT death | F | F | F | F | F | F | F | F | F | F |
| Signal HUP death | F | F | F | F | F | F | F | F | F | F |
| Any other signal death | F | F | F | F | F | F | F | F | F | F |
| Unknown numeric signal metadata | F | F | F | F | F | F | F | F | F | F |

A signal is reader-owned only when its observed kind is among the signals this
reader issued. Thus an external KILL after only TERM is F; reader escalation
observed as KILL is S/B. A late TERM observation after escalation is also owned
because TERM was issued. An ordinary 137 or 143 exit is always F.
An exit already learned before stop/abort sends no new signal and uses the
no-signals column. Stop/abort before reaping uses the signals actually issued.
No cancellation arriving after successful completion changes an already returned
EOF. A pre-aborted scan has no child and returns S with null exit code.

| Non-completion condition | Required outcome |
|---|---|
| Spawn ENOENT | `JOURNAL_UNAVAILABLE`, no child |
| Other spawn failure | `READ_FAILED`, no child |
| Malformed/truncated JSON or invalid transport UTF-8 | `READ_FAILED`, retire and reap |
| JSON record over 1 MiB | `RECORD_TOO_LARGE`, retire and reap |
| Stdout, candidate or deadline budget | B only if termination passes the table; otherwise F |
| Callback/stream failure | Preserve the failure after retirement; never return success |

These rules preserve the first failure when parsing/delivery already failed.
Missing/unknown termination metadata is not treated as a clean normal exit.
Only zero normal exit establishes physical EOF; cancellation never does.

### Observable death before a reader signal

The classifier also receives `diedBeforeOurSignal`. When true, every cell in
the termination table is `READ_FAILED`, including a normal zero exit whose death
was already visible before the reader's first signal attempt. It is not evidence
of a cancellation caused by the reader. An exit already learned before retirement
does not cause a signal attempt and retains the no-signals table behavior.

| Observation before signaling | `diedBeforeOurSignal` | Signals claimed | Normal 0 | Normal nonzero, including 137/143 | TERM death | KILL death | Other signal |
|---|---|---|---|---|---|---|---|
| Already dead before first TERM | true | none | F | F | F | F | F |
| ESRCH on first TERM | true | none | F | F | F | F | F |
| Alive/unknown before first TERM | false | only successfully attempted signals | prior table | F | prior table | prior table | F |
| Already dead before escalation after valid TERM | false | TERM only | prior table | F | S/B | F | F |
| Alive/unknown before escalation after valid TERM | false | TERM and successful KILL attempt | prior table | F | S/B | S/B | F |

Immediately before TERM and before escalation KILL, the reader inspects the
native `exitCode`, `signalCode` and `killed` fields. On Linux, when a child PID is
available, it also reads `/proc/<pid>/stat`: zombie `Z`, dead `X`, or missing stat
means already dead. The command name is delimited by its final closing parenthesis;
state is field 3 and starttime is field 22. The reader captures starttime after
spawn and compares it before signaling; a changed identity is never signaled.
Missing stat at spawn remains evidence of death even if that PID later exists.
These observations occur before joining/reaping the child.

If death is visible before the first reader signal, the reader sends no signal
and sets `diedBeforeOurSignal`. Before escalation, an already-dead child receives
no KILL; a previously valid TERM attribution is retained and the classifier still
checks the final termination kind. Thus an external INT/HUP/KILL after TERM
cannot become reader-owned, while a death genuinely caused by that TERM remains
a valid stop/budget. ESRCH from a signal attempt is harmless: no ownership is
claimed for that signal and the child is still joined.

On non-Linux or mock children without a PID there is no proc read; only native
handle fields are used. An unreadable or malformed proc record is unknown,
not already dead, and leaves the native-field observation in force. If the
initial identity was unreadable, no starttime comparison is possible; observations
remain restricted to the unreaped child handle and occur before the reader joins it.

There is an irreducible race: an external identical-kind signal can arrive in
the nanoseconds between the pre-kill observation and the reader's kill. The
runtime exposes no pidfd attribution for these signals, so that case is
indistinguishable and is classified as the reader's. The reader sends exactly
one TERM; no later TERM can disambiguate which sender caused that death.
This check proves only that death was not already observable before our signal,
not universal causal ownership across that window.
