<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE CHANGE-CONFIG BOUND IS MIRRORED HERE, WITH ITS DERIVATION

`schemas/config-change.schema.ts` carries cerastream's declared worst-case
`change-config` transaction bound (65 000 ms). The published
`@ceralive/cerastream` bindings deliberately do NOT ship this constant — it lives
in the engine's `bin` crate, not `cerastream-ipc` — so CeraUI has to carry it.

It is reproduced as the DERIVATION (`3 × teardown + 2 × start`, per
`cerastream/docs/adr/schema.md` §11), not as a literal, and
`config-change.schema.test.ts` asserts the total. Shrinking an engine phase
budget therefore reddens a test rather than silently invalidating the number the
device sizes its timeout from. The test also pins that it is NOT 60 000 — the
intuitive `attempt × 2` reading, which a healthy transaction can legitimately
exceed.

It lives in this package, like the device-mode-truth rule, because BOTH consumers
must agree by construction: the backend orchestrator sizes its `reconfiguring`
deadline from it and the frontend renders `applying` progress against it.

The same file also carries the config-change REASON tokens. `change_rejected`
(`CONFIG_CHANGE_REASON_REJECTED`) is the one CeraUI raises when the engine
refuses the parameters: the engine returns a JSON-RPC error ONLY when the
transaction never began, so that outcome is `reverted` (nothing was torn down)
and must never be reported as `rollback_failed`. It is a wire-stable token, keyed
to operator copy on the frontend — never rendered raw.

