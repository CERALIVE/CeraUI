# Device journal primitives [EXISTS]

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

These are backend primitives, not a released viewer. Container behavior is
host evidence; board latency, CPU and streaming volume remain unmeasured.
