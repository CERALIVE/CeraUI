<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE READ-ONLY SMS INBOX [EXISTS]

`modems.getSms` follows the composition root's COMMITTED `modem_backend` through
`sms-backend.ts`. Under `dbus`, `dbus-sms.ts` owns one
`@ceralive/modem-control` `createDbusSmsPort` plus `createSmsInboxStore` per
physical modem: list at activation, then fold `Added` / `Deleted`; the package's
reconnect resync REPLACES the store. Under `mmcli`, the original two-read path
remains shipped unchanged: `--messaging-list-sms` for object paths, then `-s
<path>` per message. That value is the explicit rollback and its exact gate
assertion remains `toEqual(["--messaging-list-sms"])`.

**THE PORT IS EPOCH-SCOPED, NOT PATH-CACHED FOREVER.** A package port captures
one immutable `/Modem/N`, while MM restarts renumber the entire roster. On a new
observer epoch the registry stops every old port and its subscriptions FIRST,
then matches previously-read modems by `ID_PATH` and rebuilds against the new
runtime path. A path-only row is not carried across the epoch. The explicit
`11 → 0` test proves the old `Added` subscription is dead, the new one is live,
and a replay cannot duplicate the inbox; the same reconciliation also rebuilds
an ID_PATH whose runtime index changes within one epoch after a replug.

The live audit policy adds only `Messaging.List`, SMS-object-scoped
`Properties.GetAll(args: ["org.freedesktop.ModemManager1.Sms"])`, and the
`Added` / `Deleted` subscriptions. Strict shadow gains none. The four D-Bus SMS
write members are named refusals under both policies. USSD is untouched and
continues through `mmcli-ussd.ts`; no `Ussd.*` member is admitted.

**READ-ONLY IS PERMANENT, AND IT IS ENFORCED BY A TEST.**
`tests/modem-sms-readonly-gate.test.ts` greps the whole modem surface (both
`modules/modems/` and `modules/cellular/`, the modem procedure, the mocks, and
the `@ceraui/rpc` modem schema + contract) for `--messaging-create-sms`,
`--messaging-delete-sms`, `--create-sms`, `--delete-sms`, a quoted `--send` /
`--store`, and any `sendSms`/`deleteSms`/`createSms`/`smsSend`/`smsDelete`
identifier — and asserts that the ONLY `--messaging-*` flag anywhere in that
scope is `--messaging-list-sms`. It scans code with comments stripped, so the
prose in this file and in the contract may name the forbidden verbs freely.
Adding a send/delete path means arguing with that test, which is the point:
sending or deleting is billable and irreversible, and it is out of scope
permanently rather than "not yet".

**Five things are easy to get wrong here.**

1. **`MODEM_PATH_RE` does NOT match an SMS path.** Its path branch is anchored on
   `/Modem/`, so `/org/freedesktop/ModemManager1/SMS/36` fails it outright.
   `SMS_PATH_RE` is the same precedent retargeted at the SMS object tree; using
   the modem regex would refuse every message on the device.
2. **mmcli's timestamp is not valid ISO 8601.** The board emits
   `2025-08-21T17:20:16-05` — an HOURS-ONLY offset — and `Date.parse` returns NaN
   for it. `smsTimestampEpoch` widens it to `-05:00` first. Skip that and EVERY
   message scores as undated and "newest first" silently degrades to object-index
   order, which is the one ordering this module must not trust (ModemManager
   reuses freed indices).
3. **The record parser does not use `mmcliParseSep`.** That parser logs the
   offending LINE VERBATIM whenever a line does not split cleanly, so any drift
   in how mmcli frames a message body would print the body into `debug.log`.
   `parseSmsRecord` has its own splitter, and its `ParseError.raw` carries the
   KEY NAMES it found and nothing else. The LIST parse does reuse
   `mmcliParseSep`; that output is only D-Bus paths. It DOES share
   `mmcliUnescapeValue` with it — see 5.
4. **A refusal is never an empty list.** `{success: true, messages: []}` means
   this modem has an inbox and it is empty. A modem with no Messaging interface
   answers `unsupported`, a radio that has not come up answers `not_enabled`, and
   CLI drift answers `read_failed` — all typed, all distinct operator facts.
   `unsupported` is decided from mmcli's own "modem has no messaging
   capabilities", never guessed from an empty read.
5. **mmcli never prints non-ASCII text — it prints the octal escape's LITERAL
   characters.** `cli/mmcli-output.c` runs every `-K` value through
   `g_strescape()`, so a Spanish message arrives on stdout as
   `\302\241Disfruta…` — the eight ASCII characters, where the wire carried the
   two UTF-8 bytes `0xC2 0xA1`. `mmcliUnescapeValue` (in `mmcli.ts`, shared by
   `mmcliParseSep` and `parseSmsRecord`) rebuilds the BYTES and then reads them
   back as UTF-8; decoding each escape to a code unit instead turns `á` into
   `Ã¡`. Two rules: the decode runs AFTER the key/value split, never before, so
   a decoded `\072` can never forge the `:` the line was split on; and the
   decoder stays total and silent — it neither throws nor logs, because the
   value it holds is message content.

Bounded and fail-loud: the list is cut to the 50 highest-indexed paths BEFORE any
per-message read, so a modem holding hundreds of messages costs at most 50 mmcli
invocations. A record that does not parse aborts the whole read with
`read_failed` and is NEVER retried; a message that vanished between the list and
the read is skipped (that is ordinary storage rotation), logged by path only.

Redaction is layered: the module never puts content in a log at all, and
`helpers/logger.ts` additionally scrubs SMS content by key (`isSmsSensitiveKey` —
whole-key, not the substring rule `SENSITIVE_KEY_RE` uses, so `smsCount` and a
`from` bound survive) and by value (a raw `sms.content.text:` / `.number:` record
in any free-text log line is replaced wholesale). Coverage:
`modules/modems/mmcli-sms.test.ts` (parsers over verbatim board fixtures, the
scripted-runner flow incl. zero-retry and the 50-read cap),
`tests/modem-sms-redaction.test.ts` (drives the REAL logger),
`tests/modem-sms-readonly-gate.test.ts`. UI half: todo 39.

