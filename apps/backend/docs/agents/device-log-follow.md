# Device log live follow [EXISTS]

`src/modules/device-logs/follow.ts` exports `startFollow`, `stopFollow` and
`stopAllFollows("cleared")`. This is a backend service; RPC and socket-close wiring
belong to the subsequent integration todo. There is no remote log transport here.
Each socket owns one subscription; replacement stops and joins the old one first.
Four subscriptions may run device-wide, independently of query scan admission.
Missing current boot identity refuses the start.

`follow-position.ts` probes one record through the landed bounded reader.
A start without a position resolves the current boot's newest cursor. A resume
validates its cursor against the boot alone, independently of source and severity.
An unavailable resume emits `cursor_unavailable`, then resolves a fresh head.
Only a proven empty boot permits a cursorless start; an exhausted probe is a failure.
EOF with skipped unreadable records cannot prove an empty boot in a head probe.
The watcher uses an inclusive cursor and `--lines=all`, never `-n 0`.
Only an exact first-record cursor match is discarded. An excluded checkpoint
therefore cannot discard the first matching entry after it.

`follow-delivery.ts` owns one generation's pending batch and one one-shot timer.
`follow-batch.ts` contains pure queue and flush-boundary transitions. Residual
membership comes from paging's `matchesResidual`, without a second implementation.
The first pending entry schedules 250 ms. At 200 entries or 64 KiB of serialized
UTF-8 entry bytes, the timer is advanced to the next event-loop opportunity.
Additional entries in that same burst are dropped once the pending batch reaches
200 entries or would exceed 256 KiB; each is counted. Records rejected by residual
membership still advance the examined checkpoint.

Every sent message carries a subscription ID, entries in journal order, the last
examined cursor and the dropped count. A relevant kept suppression notice marks
its batch `suppressed`. The systemd conformance flood has not reproduced a real
suppression notice; notice handling is tested with synthetic records only.
More than 2,000 records before the first flush discards that generation, joins its
watcher, resolves a fresh head and emits `catchup_exceeded` before restarting.
Unexpected completion or output failure emits `follower_exit` once without retry.

Stop cancels the flush before aborting and joining. It returns the checkpoint of
the last message actually sent, or the initial position when no batch was sent.
Queued entries remain after that position and are read again on resume. Clear
ends each subscription with `cleared`. No child, timer or polling remains without
a subscription. `follow-stream.ts` bounds each JSON transport record to 1 MiB,
decodes chunked UTF-8, drains stderr without retaining it, and owns TERM, 100 ms
KILL escalation and reaping. Parsing and wire projection use the landed parser.
Mocks use the landed logger-ring scan/follow APIs without spawning.

The spawn registry grows from 75 to 76 entries with `deviceLogs.journalFollow`.
Tests live in `src/tests/device-logs-follow*.test.ts`; fake schedulers and children
cover batching and lifecycle, while the real mock ring covers filtered resume and
an entry pending at pause. Physical board latency, CPU and streaming log volume
remain unmeasured.
