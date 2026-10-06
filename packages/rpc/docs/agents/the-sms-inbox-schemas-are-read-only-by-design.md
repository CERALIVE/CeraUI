<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE SMS INBOX SCHEMAS ARE READ-ONLY BY DESIGN

`smsMessageSchema` / `modemSmsInputSchema` / `modemSmsOutputSchema` back
`modems.getSms`, and there is deliberately no compose, send, or delete counterpart
— not "not yet", but permanently. The backend enforces this with a grep gate that
also scans THIS package's modem schema and contract, so adding a write schema here
turns that suite red.

Three shape decisions carry weight:

- **`state` uses `.catch('unknown')`**, like `connectionStatusSchema`. This is
  OUTPUT-validated, so one unrecognised `MMSmsState` token from a future
  ModemManager would otherwise reject the entire inbox rather than one field.
- **`from` is a free string, and optional.** A real board's inbox is mostly
  shortcodes and alphanumeric sender IDs (`CLARO`, `85573`), so a phone-number
  type would reject legitimate traffic; mmcli prints `--` when there is no
  originator at all. `timestamp` is likewise optional and passed VERBATIM —
  re-zoning a timestamp the carrier stamped is a lie about when it was sent.
  `text` is required but MAY be empty: a data-only WAP/PDU message has no text.
- **A refusal must never be an empty array.** `{success: true, messages: []}`
  means "this modem has an inbox and it is empty". `unsupported` / `not_enabled`
  / `unknown_modem` / `read_failed` are four distinct operator facts and are
  reported as such. `messages` is capped by the schema at `SMS_INBOX_CAP` (50),
  so an over-long inbox fails validation instead of reaching a consumer.

Coverage: the `read-only SMS inbox schemas` block in `schemas/modems.schema.test.ts`.

