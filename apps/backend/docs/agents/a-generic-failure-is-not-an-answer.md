<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A GENERIC FAILURE IS NOT AN ANSWER [EXISTS]

`@ceralive/modem-control`'s `mapModemManagerError` has always answered the one
question an operator actually has — wait, re-authenticate, or stop trying — and
nothing read its answer. Three mutation paths threw it away, each in its own
words: `modems.setUsbMode` answered a thrown dependency `transaction_error`,
`modems.setFccUnlock` answered `write_failed`, and `unlockSimPuk` swallowed the
error entirely in a bare `catch {}`.

**The PUK one was the worst, because its collapse was a GUESS rather than a
shrug.** After a failed submit it re-reads the retry counter, and when that
re-read ALSO fails it returns `wrong-puk` — telling an operator their
carrier-issued code is bad when the daemon may simply have been unreachable and
the PUK never left the device. The counters structurally cannot separate "the
PUK was wrong" from "the submit was never taken".

`modules/modems/operation-outcome.ts` is the projection, and it is ADDITIVE at
every call site: the existing `error` literal is byte-unchanged and the
classified `operation` rides beside it, so a consumer that renders the legacy
terminal keeps working and one that knows the field can say why. Legacy payloads
still parse content-identically and gain no defaulted key.

- **Package consumption goes through the existing `modem-control-compat.ts`
  seam**, with local mirrors of `mapModemManagerError` and
  `classifyOperationCompletion` behind it — behaviour mirrors, not stubs, pinned
  against the real package per reason.
- **The mirror matches the transport errors by `name`, not `instanceof`.** A
  fallback that imported the package's own classes would defeat the point of
  being a fallback. Its regex ARM ORDER is the rule and is reproduced exactly:
  several ModemManager errors match more than one pattern, and the first match is
  what the package publishes.
- **`retryable: false` on a CeraUI-authored refusal is a statement, not a
  default.** An identical request re-issued against an identical CeraUI-side
  decision produces an identical refusal; only the daemon is describing a device
  state that can clear on its own.
- **It is safe to DERIVE from the PUK error and unsafe to LOG it.** That catch
  block's `execFileP` error message embeds the argv — the PUK and the new PIN —
  so the projection is used precisely because it answers one of eight enum
  members and never echoes the message. Do not widen it to carry a free-text
  detail from that path.
- **It opens no transport.** It is in the projections gate's KEEP allowlist only
  because its fallback names the `dbusName` error property; it holds no session
  and issues no call.

Coverage: `tests/modem-operation-vocabulary.test.ts` (all 20 values, one test per
refusal reason, the write-vs-read split, the fallback-mirrors-the-package matrix,
and the wire shape refusing an empty reason / a retryable success / a
free-string unknown-outcome). Wire contract:
[`../../packages/rpc/AGENTS.md`](../../../../packages/rpc/AGENTS.md) → AN OPERATION'S
OWN WORDS SURVIVE THE BOUNDARY.

