# Device log live follow [EXISTS]

`src/modules/device-logs/follow.ts` exports `startFollow`, `stopFollow` and
`stopAllFollows("cleared")`. Authenticated `logs.followStart` and `logs.followStop`
call these exports; adapter close removes the client before joining its follower.
There is no remote log transport here.
Each socket owns one subscription; replacement stops and joins the old one first.
Four subscriptions may run device-wide, independently of query scan admission.
Missing current boot identity refuses the start.

`follow-position.ts` probes one record through the landed bounded reader.
A start without a position resolves the current boot's newest cursor. A resume
validates its cursor against the boot alone, independently of source and severity.
An unavailable resume emits `cursor_unavailable`, then resolves a fresh head.
An ordinary journal cursor that identifies a previous boot starts from the
first retained record of the running boot. A same-boot boot-start checkpoint
still reports `cursor_unavailable` if retained history cannot be proven
complete, then reads from the retained start.
An empty start returns an opaque boot-start checkpoint. A mock checkpoint
contains the process's ring identity and the first expected sequence and is verified against the oldest
retained sequence before replay. A wrapped ring or an old checkpoint without
sequence evidence reports `cursor_unavailable` and reads from the retained
start. Native journal cursors and boot IDs alone cannot prove that records
before the first retained cursor were not vacuumed. Native boot-start resume
therefore reports possible truncation and reads from the retained start.
Both cases use the same existing catch-up bounds. A stale boot or epoch
reports `cursor_unavailable` and starts at the current boot's fresh head.
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
watcher, resolves a fresh head for the same journal match and emits
`catchup_exceeded` before restarting. The old checkpoint becomes `gapFrom`,
a newer-query continuation bound to the same filter, boot and history epoch.
It pages after the old checkpoint through the restart head, inclusive, in
journal order. A boot-start checkpoint begins at the retained start. A
checkpoint excluded by the filter is verified in a boot-only scan.
Unexpected completion or output failure emits `follower_exit` once without retry.

Stop cancels the flush before aborting and joining. It returns the checkpoint of
the last message actually sent, or the initial position when no batch was sent.
Queued entries remain after that position and are read again on resume. Clear
ends each subscription with `cleared`. No child, timer or polling remains without
a subscription. `follow-stream.ts` bounds each JSON transport record to 1 MiB,
decodes chunked UTF-8, drains stderr without retaining it, and owns TERM, 100 ms
KILL escalation and reaping. Parsing and wire projection use the landed parser.
Mocks use the landed logger-ring scan/follow APIs without spawning.

The publisher advances only on Bun-accepted frames, including frames queued
under Bun's connection backpressure limit. A dropped frame stops delivery and
attempts one terminal `follower_exit` notice at the previous checkpoint, or
`cleared` when retrying a clear notice. If the notice also drops, the socket
disconnects so Resume uses the client's last received checkpoint, including a
boot-start checkpoint when the first entry has not been acknowledged.

The spawn registry grows from 75 to 76 entries with `deviceLogs.journalFollow`.
Tests live in `src/tests/device-logs-follow*.test.ts`; fake schedulers and children
cover batching and lifecycle, while the real mock ring covers filtered resume and
an entry pending at pause. Physical board latency, CPU and streaming log volume
remain unmeasured.

## Local log RPC integration [EXISTS]

`src/rpc/procedures/logs.procedure.ts` exposes paging, event location, classified
boots, follow, storage, retention, cleanup and export-ticket creation. Every
procedure requires authentication and uses `@ceraui/rpc/schemas` for admission
and replies. The router registers the eleven procedures under `logs`; bundle
procedures belong to the subsequent bundle work. The frontend's `TypedRPC.logs`
imports the same shared input and output types.

A socket's authenticated session owns its follow until `followStop`, logout,
credential revocation or socket close. Ending the session cancels queued
replacement starts and stops the current follower before further delivery. The subscription
listener retains no messages, ignores malformed frames silently and contains
throwing consumers. Mock mode uses the logger ring without systemd. Startup
awaits guarded retention initialization immediately after log settings; failure
degrades readiness and boot continues. The legacy `system.getLog`,
`system.getSyslog` and `log` push remain unchanged. No remote log command or
subprocess is added.

`src/tests/logs-procedures.test.ts`, `logs-delegation.test.ts`,
`logs-lifecycle.test.ts` and `logs-retention-startup.test.ts` cover integration;
the frontend listener tests are `lib/rpc/subscriptions-log-follow.test.ts`.
Board latency, CPU and streaming log volume remain unmeasured.
