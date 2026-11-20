# Redacted support bundle backend [EXISTS]

`src/modules/device-logs/bundle.ts` owns `previewBundle()`,
`createBundle(conn)`, `handleLogBundleRequest(request)` and
`abortLogBundles()`. The local authenticated `logs.previewBundle` and
`logs.createBundle` procedures accept no input. Extra input is refused before
collection. Preview returns the frozen `LogBundleManifest`; creation returns
the existing ticket result or an existing error code. Preview failures use
`READ_FAILED` or `BUSY` as sanitized RPC errors, without causes or input text.
The viewer and coordinated English/Spanish user documentation belong to later
device-log-system todos; this backend does not upload a file.

The existing legacy WebSocket adapter retains its `INTERNAL_ERROR` transport
envelope for procedure errors, with the constant `READ_FAILED`/`BUSY` message.
Direct oRPC errors retain the matching existing log error code. No transport
error vocabulary or adapter behavior is changed.

Preview and creation execute the same bounded pipeline. `bundle-data.ts`
collects current versions, the current and previous available journal boots'
stored versions, retained events and boot records, and an allowlist of facts:
log settings/state, effective update channel, autostart, cached hardware kind
and the cached used/total bytes for `/data`. Missing historical versions stay
null. No config dump, password hash, authentication-token file, Wi-Fi PSK or
NetworkManager profile is included. `readUpdateChannel()` reuses the update
owner's validated readers without migrating or writing settings.

Held config, relay, hotspot, APN and router credentials are inputs to redaction
only. `getStoredModemCredentials()` returns copies of the username/password
pairs, including disconnected devices, without identity or verification
metadata. They never become bundle records. The backend has no SRT passphrase
field to read; an absent credential is not invented or probed from the engine.

`redaction.ts` replaces non-overlapping exact occurrences, choosing the longest
match at each position, for secrets of at least four JavaScript string units.
It also recognizes their JSON-escaped, percent-encoded (either hex case),
base64 and base64url representations. Short values are ignored. Every performed
replacement is counted once. The pattern pass masks 15-digit identifiers,
19/20-digit ICCIDs beginning with 89, MAC suffixes, IPv4 outside the specified
private/loopback/link-local/CGNAT ranges, global unicast IPv6 (`2000::/3`),
decimal coordinate pairs, and the logger's Bearer/PASETO/JWT shapes. IPv6
masking includes compressed forms and zone identifiers. IPv4-mapped and
`64:ff9b::/96` addresses follow the embedded IPv4 policy in dotted and
hexadecimal forms. Other nonlocal IPv6 literals still get dotted IPv4
masking when no whole-address mask applies.
Bracketed endpoints keep their port, as in `[IP]:9000`. Link-local IPv6
(`fe80::/10`), unique local IPv6 (`fc00::/7`), and `::1` remain visible.
The first three MAC octets and private IPv4 remain useful diagnostics.
Arbitrary personal text and historical credentials no longer held by the
backend are not guaranteed to be recognized.
Literal matching is case-sensitive and does not normalize Unicode; case-folded
or differently normalized spellings are outside the exact-occurrence contract.

Accepted secret values have a cumulative 64 KiB UTF-8 compilation budget.
An oversized held dictionary refuses the operation with `READ_FAILED` before
allocating its escaped/encoded patterns.

Patterns are matched against the original text, then overlapping ranges are
merged before substitution. A partial exact secret or numeric identifier cannot
break a token's shape and leave the rest of that token visible. A merged range
uses its first known-secret marker when available and counts one actual
replacement; adjacent ranges remain separate.

The collision policy is **fail closed**. A known secret colliding with a boot
ID, cursor, timestamp, unit, version, event ID, settings value or other structured
field refuses the entire operation with `READ_FAILED`. Pattern masking that
would alter structured text is also refused. Only designated boot ID fields
can suppress a numeric match, and only when the entire field equals its
authoritative boot ID. A journal cursor receives the same exception only
for its single `b=` component when that component and the entry's boot ID
both equal the scanned boot. Version text, event parameters, other cursor
components and journal messages keep all pattern checks. Known secrets
still match inside every boot ID. A final check of each serialized record prevents JSON
framing or replacement markers from reintroducing a known secret. The manifest
is checked independently, including on deadline paths. No exception or abort
reason is copied into output or logs.
Object keys are structured text too: a retained event parameter name containing
a supported sensitive pattern refuses the operation instead of being renamed.
The final manifest check also covers section counts after processing; a count
whose serialized digits equal a held secret refuses preview and creation.

`bundle-journal.ts` reads one page at a time using `scanPage` and `withQuerySlot`,
all sources/levels, older direction and limit 200, independently of the caller's
socket. It reads one running-boot page first, then gives the previous available
boot at most half the remaining time, including query slot admission. At the
handoff it stops waiting for any pending previous-boot read. The reader retains
its query slot until the child is reaped and cannot write a late page. It writes
previous-boot entries first, using at most half of each byte budget remaining
after the prelude, then writes the buffered running-boot page and continues that
boot with a separate query owner and the remaining time and bytes. The preview's
journal section reports `bootsCovered` based on
admitted entries and `complete` based on whether collection finished without a
cut or read failure. The separate `boots` list still reports version context.
Budget pages continue when the cursor advances. A missing or unchanged budget
cursor ends that boot with `READ_FAILED` and marks the journal incomplete. Sections are
versions, settings, events and journal, followed by an end record. A journal
failure or cut adds an incomplete journal record and `complete:false`. Caps are
32 MiB of NDJSON, 8 MiB of gzip and sixty seconds, including reserved termination
records inside both byte caps.

Privacy failures must emit zero download bytes, even when a collision occurs
late. Creation therefore stages only bounded compressed records until every
included record passes validation. It never retains the whole uncompressed
body or writes a device scratch file. Each record is compressed through
`CompressionStream("gzip")` as a complete member; their concatenation is a gzip
file. This permits exact compressed-size admission and a valid termination
record without rolling back a compressor. Read all members with the streaming
`DecompressionStream("gzip")` or a multistream gzip reader; Bun 1.4.4's
`gunzipSync` reads only the first member and is unsuitable for this file.
Preview performs identical compression/admission and discards each member.

Sharing admission is device-wide with the existing export service. Preparation
and active downloads hold the lease; a pending 32-byte random hex ticket
expires sixty seconds after preparation. A new bundle or export request from
the same authenticated WebSocket replaces its unused ticket; other connections
remain Busy until expiry. Preview does not replace tickets. Only GET redeems a
ticket. Missing, unknown, reused, expired or replaced tickets return an empty
403; other methods return 405 without consuming it. The response uses
attachment/no-store/application-gzip headers and no Content-Length. Request
abort and cancellation release download ownership;
throwing consumers cannot leak errors or retain a lease. The existing
`abortLogExports()` clear hook also joins bundle preparation/downloads and
invalidates tickets. Preview, creation and GET redemption share the filtered
export history gate. A clear blocks admission before any snapshot or ticket
redemption, and the sixty-second deadlines include the gate wait.
Download finalization is idempotent: an abort followed by a throwing consumer
cannot repeat timer cleanup, listener removal or lease retirement.

Preparation remains registered through ticket minting and lease transfer.
Cancellation queued at preparation release therefore invalidates the ticket
rather than leaving a reservation behind. After the final gzip member finishes,
the pipeline checks abort/epoch/deadline state again. A deadline crossing replaces
the provisional end member with the incomplete marker and one false end member.

A paused active download also has a sixty-second transport deadline. It fails
the stream with a constant error and releases sharing without another client
pull; a stalled client cannot reserve exports forever.

Tests are `src/tests/device-logs-redaction.test.ts` and
`src/tests/device-logs-bundle*.test.ts`, including real HTTP and RPC, adversarial
collisions, throwing readers/consumers, cancellation, both byte caps and
deadlines. Board latency, CPU load and physical streaming volume remain
unmeasured.

The frozen NDJSON and manifest formats carry no review-before-sharing statement.
The sharing dialog owns that copy (todo 34); forwarding the gzip file outside the
dialog loses that warning. No field is added to the public format to carry it.
