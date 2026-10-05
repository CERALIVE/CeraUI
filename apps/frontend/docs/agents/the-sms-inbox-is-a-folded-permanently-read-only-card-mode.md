<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE SMS INBOX IS A FOLDED, PERMANENTLY READ-ONLY CARD (modem-stack Phase B, todo 39) [EXISTS]

A fourth card, `modem-sms-card`, sits between the detail card and the USB-mode
card in `main/dialogs/ModemConfigDialog.svelte`, backed by the pure rune-free
`main/dialogs/modem-sms.ts` (`smsWallClock` / `smsRefusalKey` /
`isWithdrawingSmsRefusal`) and by todo 38's `modems.getSms`. Its schema is
consumed verbatim from `@ceraui/rpc` — `smsMessageSchema`, `SMS_INBOX_CAP`,
`modemSmsRefusalSchema` — and is never re-declared here.

**IT IS READ-ONLY STRUCTURALLY, NOT BY DISABLING.** There is no compose field,
no reply, no forward, no delete — not greyed-out ones, none at all. The only two
controls in the whole card are the disclosure toggle and a re-read. That is
asserted against the rendered DOM in `ModemConfigDialog.sms.test.ts` (every
button enumerated by testid, every form control counted at zero, every
accessible name matched against a send/compose/delete vocabulary), because the
backend's grep gate protects the DEVICE and this protects the promise the
operator is shown. A disabled compose box would pass a grep and fail an
operator. The typed `getSms` entry in `lib/rpc/client.ts` carries the same note:
that table is the one place a `sendSms` could be added without tripping the
backend gate.

**IT READS NOTHING UNTIL IT IS OPENED, AND HOLDS NOTHING WHILE CLOSED.**
`modems.getSms` costs up to one mmcli invocation per stored message (bounded at
`SMS_INBOX_CAP`, but a full inbox is 50 of them), so probing on dialog open would
tax every operator who came to change an APN. The reveal is a CSS
`grid-template-rows: 0fr → 1fr` transition — never `transition:slide` — for the
reason `CollapsibleSection.svelte` states: a JS transition compiles to the Web
Animations API, which runs outside CSS and escapes BOTH global motion freezes
(`prefers-reduced-motion` and the e-ink `transition: none`). The CONTENT stays
`{#if}`-gated inside that animated wrapper, so a collapsed inbox holds no message
text in the DOM at all — which matters because a real SIM's inbox carries
one-time codes, and "collapsed" must not mean "present, merely clipped".

**A REFUSAL IS NEVER AN EMPTY INBOX.** `{success: true, messages: []}` means this
modem has an inbox and it is empty; each refusal means we do not know what it
holds. `unsupported` is the ONE refusal that describes the device rather than the
moment, so it WITHDRAWS the whole section (`isWithdrawingSmsRefusal`) — no
header, no band, no refresh — the `uncertified` USB precedent applied to a
capability instead of a mutation. It has no copy at all, deliberately: it is
never rendered. The other three (`not_enabled` / `unknown_modem` / `read_failed`)
each get their OWN sentence in a calm `role="status"` band with the re-read still
offered, because they name conditions the device can leave. The verdict is per
dialog session — reopening asks again, since the thing in the USB port can change
between opens.

**TIMESTAMPS ARE THE NETWORK'S, NOT THE BROWSER'S.** The wire carries mmcli's
service-centre stamp verbatim (`2025-08-21T17:20:16-05` — an hours-only offset
that is not valid ISO 8601 and that `Date.parse` rejects), specifically so it is
not re-zoned. `smsWallClock` therefore matches the grammar and renders
`YYYY-MM-DD HH:MM` in the JetBrains Mono data face, `tabular-nums`, `dir="ltr"`
so an RTL locale cannot reorder its runs — it never goes through `Date`, which
would move the reading to whatever machine rendered it. An unparseable or absent
stamp renders "no time reported" rather than a raw token. Absence renders as
absence throughout: no sender → "Unknown sender", empty `text` (a real WAP/PDU
data-only message) → an explicit no-text line, and a list returned AT the cap says
so, because 50 rows are a window and not the inbox.

i18n: `network.modem.sms.*`, 16 keys × 10 locales. Coverage:
`main/dialogs/modem-sms.test.ts` (the pure helpers, incl. the no-re-zoning proof)
and `main/dialogs/ModemConfigDialog.sms.test.ts` (the state table + the
zero-mutation-affordance DOM lock). Backend half:
[`../backend/AGENTS.md`](../../../backend/AGENTS.md) → the read-only SMS inbox.

