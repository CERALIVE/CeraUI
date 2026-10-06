<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## EVERY REFUSAL AN OPERATOR CAN TRIGGER HAS ITS OWN MESSAGE [EXISTS]

`lib/modem/refusal-taxonomy.ts` (pure, rune-free) is the ONE mapping from the
modem-config surface's refusal vocabulary to operator copy. It exists because
every mutating surface used to resolve its own, and every one of them had an
escape hatch that turned an unknown refusal into something unactionable:
`ModemConfigDialog` and `modem-power-recovery.ts` built their key by
INTERPOLATION (`network.modem.saveRefused.${token}`), `lockErrorKey`
interpolated `lock.error.<token>`, and the operator-scan band printed ONE
generic "the scan failed" for all three typed answers. A new wire token
therefore reached an operator as a raw dotted path or as a confident wrong
sentence.

**EIGHTEEN CLASSES, and a class is "what the operator does next."** Two tokens
share a class exactly when they share a remedy — `identity_unresolved` reaches
this table from four different enums, and the catalog proved the per-surface
duplication was already byte-identical in places. The converse is the rule that
keeps it honest and is why there are eighteen rather than a tidy handful: two
tokens that point somewhere different NEVER share a class. `auth-failed` and
`unsupported-profile` are the pair the effort forbids collapsing (retype the
password versus this build cannot perform that login at all);
`credential-not-required` and `no-credential-stored` are the same argument one
step quieter.

**TWO EXHAUSTIVENESS FENCES, in opposite directions, and both are compile-time.**
`REFUSAL_CLASS_OF` is `satisfies Record<ModemRefusalToken, RefusalClass>`, so a
member added to any of the four in-scope wire enums removes a required key and
`tsc` refuses it. `refusalCopyKey` is a `switch` with **NO `default` arm** and a
non-optional `string` return, so an unkeyed class is a "not all code paths
return a value" error. **The absence of that `default` is the whole mechanism** —
a `default`, or a record lookup with `??`, would let an unkeyed class compile
and render a stand-in, which is precisely the defect this replaces.
`refusal-taxonomy.test.ts` asserts that absence against the comment-stripped
shipped source (comments are stripped so the module's own prose about the arm it
does not have cannot satisfy the detector), with a non-vacuity control that
plants one.

**THE THREE CREDENTIAL CAUSES REUSE THE LOCK SECTION'S OWN SENTENCES.** Todo 22
already wrote distinguishable ten-locale copy for wrong-password /
unsupported-login-shape / device-lockout, and those tokens reach the taxonomy
only from the dongle credential path — so `refusalCopyKey` points
`auth-failed` / `unsupported-profile` / `locked-out` back at
`network.routerCellular.lock.cause.*` rather than minting a second wording. The
other fifteen classes live under `network.modem.refusal.*` (10 locales).

**SCOPE IS THE FOUR ENUMS THE SURFACE ANSWERS WITH** — the shared
mutation-safety enum, `modemConfigRefusalSchema`, `modemCredentialsRefusalSchema`
and `modemScanFailureSchema`. The USB-composition switch, USSD, SMS, GPS,
band-lock and FCC are deliberately OUT: each already derives its required key set
from its own wire enum in a copy-completeness gate, so none can ship a token with
no copy, and each carries a surface-specific sentence a shared class would blunt
(the USB card composes a head plus a typed reason from two namespaces; USSD's
`lte-only-unsupported` is a CARRIER policy with its own band). Folding them in
would trade a proven distinction for a smaller table.

**EVERY CLASS IS REACHABLE THROUGH A REAL RPC PATH, and that is asserted.**
`tests/modem-refusal-rendered.test.ts` mocks the real `rpc.modems.*` method,
mounts the real component, performs the real gesture, and compares the rendered
text to the catalog string BY VALUE — nine classes through `modems.configure`,
two through `modems.scan`, seven through `modems.setCredentials`. Its last block
proves the cases name every member of `REFUSAL_CLASSES`, so a class added later
cannot silently have no rendered proof. The band's fixed heading is why the
save-refused SENTENCE has its own node (`modem-save-refused-reason`).

Do NOT re-introduce a per-surface refusal map, a `default` arm, a `??` fallback,
or a key built by interpolating a token into a namespace. Coverage:
`lib/modem/refusal-taxonomy.test.ts`, `tests/modem-refusal-copy-completeness.test.ts`
(10 locales, derived from `REFUSAL_CLASSES`, distinctness + falsifiability),
`tests/modem-refusal-rendered.test.ts`, and the widened
`tests/operator-copy-no-internals.test.ts` (which now also bans `mmcli`/`qmicli`/
`mbimcli` fragments, AT commands, `org.freedesktop.*` interfaces, JSON-RPC
envelopes, raw device nodes, and a leaked dotted i18n key — each with a planted
non-vacuity control).

