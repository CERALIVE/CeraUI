<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A USSD REPLY IS ASYNCHRONOUS, AND THE PROPERTY THAT HOLDS IT IS RETAINED [EXISTS]

`mmcli-ussd.ts`'s two hardest rules are both measured rather than reasoned, from a
live `*611#` dialogue on bench `ceralive2` (Movistar Colombia, MM 1.24.2,
2026-08-18). BLOCKER B4 — "the exact framing of a USSD reply has NOT been verified
against a real carrier answer" — is resolved by that run, and the answer was that
**both previously-accepted shapes were wrong**.

**1. mmcli uses the word "reply" as a KEY nowhere.** An action prints
`… new reply from network: '<raw text>'` — a whole SENTENCE before the colon, with
the carrier's text spanning REAL newlines and closed by the LAST quote — and
`-K --3gpp-ussd-status` keys the same text `modem.3gpp.ussd.network-request`, note
*request*, g_strescape()d onto one line. `parseUssdReply` accepts both; the legacy
`…reply` suffix is retained only as forward tolerance, and a test pins that the
fabricated `Reply: '…'` shape the retired parser was built around does NOT match.

**2. `--3gpp-ussd-respond` DOES NOT BLOCK on the network.** `initiate` does (2.2 s
measured, reply on stdout). `respond` returns in **60 ms** with an EMPTY reply:

```
21:27:56.894  --3gpp-ussd-respond=4 dispatched
21:27:56.954  returned — 60 ms, reply EMPTY
21:27:56.958  status: idle,          request = the PREVIOUS turn's menu
21:27:57.238  status: idle,          request = the PREVIOUS turn's menu
21:27:57.524  status: user-response, request = this turn's answer   (+570 ms)
```

So reading the status ONCE, immediately, is wrong twice over: the state is
transiently `idle`, which reports a live dialogue as `closed`, and the property —
which is RETAINED across turns and even across a cancel — still holds the previous
turn's text, which is then served as this turn's reply. **A plausible, wrong menu
is worse than no menu**, and this was observed end-to-end on the board before it
was fixed.

`runTurn` therefore snapshots the property BEFORE dispatching (the only way to
tell this turn's answer from the last one's), and when stdout carried no reply it
polls `readUssdStatus` for a bounded `REPLY_WAIT_MS` (8 s, ~14× the measured
arrival) at `REPLY_POLL_MS` (250 ms). **Arrival is detected two ways and the second
is not redundant**: the text CHANGING is primary, but a menu can legitimately
repeat itself (answering `00:inicio` re-serves the root menu byte-identically), so
an observed `idle → not-idle` edge counts as arrival independently of the text. A
bound that elapses with no arrival yields NO reply — never the retained value.

**Never log a value on this path.** `parseUssdNetworkRequest` deliberately does not
route through `mmcliParseSep`, which logs an unsplittable line VERBATIM; every
value here is subscriber content. Verified live: a `debug.log` covering a full
four-turn dialogue contains 0 occurrences of the MSISDN or of any menu text.

Board-proven end to end through CeraUI's OWN authenticated RPC: `ussdInitiate`
`*611#` → the root menu (carrying the SIM's number), `ussdRespond` `4` → the
balance submenu, `ussdRespond` `1` → its submenu, `ussdRespond` `1` → `Total:$0`,
`ussdCancel` → `closed/cancelled`, session `idle`. Every reply byte-identical to
the manual `mmcli` walk. Coverage: `tests/modem-ussd.test.ts` (both real shapes,
the empty-respond negative, the two-turn dialogue over the board captures, and the
answer-never-lands case asserting NO reply rather than the retained one).

### …AND THE READ THAT PROVES THE CAPABILITY RE-PUBLISHES IT [EXISTS]

`readModemUssd` wrote `capabilityCache` directly and never called
`noteCapabilityEvidenceChanged()` — the one implemented capability module that
did not. `gps.ts`'s `recordCapability` and `band-capability.ts`'s refresh both
do, for the reason `capability-gates.ts` states: the wire build is SYNCHRONOUS,
so a probe that first proves a capability only reaches an operator on the next
30 s roster poll.

That window is not cosmetic for USSD, because the verbs are gated on the SAME
evidence. Until the claim moves, `withCapabilityModuleMutation` refuses every
one of them `module_unavailable` — so CeraUI's USSD section, which reads on
open and is withheld below `capable`, reported "not established yet" with no
control for up to half a minute on hardware that supports USSD, and any verb
forced through in that window was refused.

`recordUssdCapability` is that notifier, mirroring `gps.ts` exactly: it is
CHANGE-GATED, so the dialog's read-on-open costs one map lookup once the modem
is proven and broadcasts nothing. Both call sites go through it — the
`unsupported` read that records `absent` as well as the successful one that
records `present` — because a modem that positively LOSES the capability must
lower the claim just as promptly as one that gains it.

Frontend half: [`../frontend/AGENTS.md`](../../../frontend/AGENTS.md) → USSD IS A
SESSION, SO IT CARRIES A SECOND MACHINE.

