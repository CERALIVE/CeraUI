# Streamed device log export [EXISTS]

`src/modules/device-logs/export.ts` exports `createExport(conn, input)`,
`handleLogExportRequest(request)` and `abortLogExports()`. The authenticated RPC
composition (todo 19) calls creation. Creation parses the export and query
schemas, pins the requested boot and history epoch, and reserves sharing with a
32-byte random hex ticket. A ticket expires after 60 seconds and is consumed by
one GET to `/api/logs/export`. Missing, unknown, expired and reused tickets return
an empty 403, as do replaced tickets; other methods return 405 without
consuming a ticket. The server routes this path before frontend proxying or
static serving.

`sharing.ts` owns one device-wide lease: preparing, issued, or streaming.
The authenticated WebSocket that requested a ticket can replace it while it
is still unused, with either kind of download. The lease revokes the previous
ticket from its issuing service before the new request proceeds. Other
connections get `BUSY` until the ticket expires; no request can replace
preparation or streaming. Expiry is checked opportunistically, without a
timer. Stream completion or joined cancellation releases the lease.

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

The export uses the support bundle's known-value matcher (`redaction.ts`) and
shared inventory (`bundle-data.ts`). The export-only projection runs after Raw
Logs filter membership is decided but sees the decoded message before its 16 KiB
cut and the original unit before `.service` is stripped. It redacts before
clipping, checks the unit and message together, and checks the rendered entry
again after continuation lines are indented. If an alternative representation
or an unsafe replacement is detected, it can withhold the entire affected value
or entry text. The bundle's identifier and address masks stay bundle-only.

Header values (versions, boot IDs, creation time and filters) are checked,
including after JSON escaping and across elements of a serialized filter array.
An unsafe JSON value is replaced with a safe placeholder without breaking the
JSON. Fixed labels and the sensitive-data warning stay in place.

The authenticated export RPC checks credential readiness before giving the
browser a ticket. **Export this view** keeps the existing dialog open and shows
localized advice to wait and retry, change or remove a short credential, or
contact support if a read failure persists. The attachment checks independently
when streaming starts, since credentials can change after the ticket was issued.
A refusal then sends only a footer:

- `# incomplete: CREDENTIALS_LOADING` while the hotspot or modem credential store
  has not finished loading (`helpers/credential-store-state.ts`: `pending`).
- `# incomplete: READ_FAILED` when one of those stores existed but could not be
  loaded (`failed`; it started empty and its values are unknown), when a
  credential cannot be read, or when the matcher refuses the held set.
- `# incomplete: CREDENTIAL_TOO_SHORT (<kinds>)` when a held value shorter than
  four characters (`MIN_REDACTED_LENGTH`, counted in UTF-16 code units), which
  the matcher skips, is a password, key (including a managed ingest key),
  pairing or relay secret, hotspot, APN or router password, or any kind not
  listed below. The export also refuses if a nonempty value's normalized form
  is too short to match safely. Only those kinds are named. If the
  footer with its generated kind list would match a held value, it is just
  `# incomplete: CREDENTIAL_TOO_SHORT`, which is fixed text.

Short values of the kinds in `SHORT_VALUE_EXPORT_KINDS` (`bundle-data.ts`):
`stream` (a short `srt_streamid` with an unconfigured or literal loopback
receiver and no managed/relay selection), `apn_user`, `router_user` and `serial`
do not stop the export. A selected managed slot always classifies the configured
ID as an ingest key, even with no cached slots. A non-loopback manual
receiver may authenticate by stream ID, so ambiguous short IDs also refuse. The matcher skips
non-empty values under four characters, so these values are not redacted
anywhere: they can appear in entries and in header values such as the search
text, after the usual formatting (continuation lines are indented, header
values are JSON-escaped), unless a longer held value that covers them is
replaced. The header then carries
`# not redacted, shorter than 4 characters: <kinds>` before the warning line,
naming the kinds (sorted, once each) and never the values. The line is checked
as written: if it would match a held value it reads `...: some held values`
instead, and if that would match too, the line is left out. Values of four
characters or more are matched as before, with the limits below. Empty values
are ignored.

Limits:

- **Values.** The export compares its initial snapshot before emitting the
  header, after page reads and at delivery boundaries. An observed change stops
  it with `# incomplete: CREDENTIALS_CHANGED`; retry the export. Already sent
  bytes cannot be recalled. Earlier or transient values absent at every
  comparison, and values not held by the inventory, are not covered.
- **Representations.** Whole-value literal, JSON string escaping, URI component
  escapes (either hex case), base64 and padded/unpadded base64url are matched.
  Export also checks NFC, CR/LF and default-ignorable Unicode splits, one URL
  decode pass (including form spaces), and numeric/common named HTML entities.
  These are bounded checks, not arbitrary decoding or deobfuscation. Separate
  journal records, nested/composite encodings, and fragments already lost
  upstream of the device journal reader are not reconstructed.
- **Fixed text.** Footers, the header's fixed labels and the attachment filename
  are not passed through the matcher, apart from the generated kind lists
  described above. They carry only status codes, credential kinds, counts and
  the validated boot id and time, so a held value that happens to equal such
  text can still appear there.
- **Header boundaries.** Individual values and array values are checked, not
  arbitrary combinations across header lines or fixed JSON member names.

The support bundle uses the same held list and exact matcher but none of the
export-only normalization, store states, short-value refusal or header line.
The held list includes every currently pushed managed slot key. It collects
`relay_streamid_override` as `relay`, so the bundle marks it
`[REDACTED:relay]` instead of `[REDACTED:stream]` (unless the same value is
also held as the ordinary stream ID, which is listed first). The bundle's
structured fields remain fail-closed and its wider privacy masks are unchanged.

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
`src/tests/device-logs-export-held-secrets.test.ts`,
`src/tests/device-logs-sharing.test.ts`,
`src/tests/device-logs-sharing-replace.test.ts` and
`src/tests/device-logs-export-http.test.ts`; the latter downloads through the
real Bun HTTP server. This service is not a released viewer. Physical device
latency, CPU and streaming journal volume remain unmeasured. User documentation
is coordinated by the device-log-system plan's documentation todo.
