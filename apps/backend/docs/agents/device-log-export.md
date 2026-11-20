# Streamed device log export [EXISTS]

`src/modules/device-logs/export.ts` exports `createExport(conn, input)`,
`handleLogExportRequest(request)` and `abortLogExports()`. The authenticated RPC
composition (todo 19) calls creation. Creation parses the export and query
schemas, pins the requested boot and history epoch, and reserves sharing with a
32-byte random hex ticket. A ticket expires after 60 seconds and is consumed by
one GET to `/api/logs/export`. Missing, unknown, expired and reused tickets return
an empty 403; other methods return 405 without consuming a ticket. The server
routes this path before frontend proxying or static serving.

`sharing.ts` provides `reserveLogSharing()` for exports and the subsequent bundle
service. A reservation exposes `start()` and `release()`: start makes a ticket's
reservation active; release follows stream completion or joined cancellation.
An unused reservation expires opportunistically, without a timer. Only one
reservation or active download exists device-wide.

`export-format.ts` owns the attachment filename and plain text formatting.
The header distinguishes current `exported-by` versions from each covered boot's
stored versions. Missing historical versions remain `versions: not recorded`.
The filter records deduplicated, sorted source and level sets, literal text and
time bounds. The header states its creation time, newest-first order and sensitive
data warning. Values are JSON-escaped; embedded message newlines become indented
continuations, including suppression notices, which start with `# gap:`.

`export-body.ts` composes todo 13's `scanPage` with `withQuerySlot` using a
dedicated owner object. This shares the two-scan device admission limit while
remaining independent of the requesting socket. The parsed query uses older
direction and limit 200. Budget pages, including an unchanged or null
continuation, continue until physical EOF, an error or a limit. Time membership
and anchor validation remain owned by the paging pipeline.

The response has attachment, no-store and UTF-8 plain text headers, with no
Content-Length. Backpressure retains one page; no export content is sent over
WebSocket or written to disk. UTF-8 output is capped at 64 MiB, reserving 64 bytes
inside that ceiling for the final footer. The 120-second deadline includes
header collection. Request abort, reader cancellation, clear and deadline abort
an in-flight scan and join it before releasing sharing. A paused client cannot
keep the reservation after termination: the abort path drives the footer and
closes without requiring another read.

Clear calls `abortLogExports()` in addition to updating the history epoch.
It invalidates pending tickets and joins active downloads. Epoch checks also
fence header collection and page/entry delivery. Footers state either
`# complete: <n> entries` (including gap records) or `# incomplete: <reason>`.

Tests are `src/tests/device-logs-export.test.ts`,
`src/tests/device-logs-sharing.test.ts` and
`src/tests/device-logs-export-http.test.ts`; the latter downloads through the
real Bun HTTP server. This service is not a released viewer. Physical device
latency, CPU and streaming journal volume remain unmeasured. User documentation
is coordinated by the device-log-system plan's documentation todo.
