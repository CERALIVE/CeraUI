<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE MUTATION-SAFETY VOCABULARY IS SHARED, NOT PER-PROCEDURE

Every path that mutates a modem answers the SAME refusal set
(`modemMutationRefusalSchema`), because the seven members each name a different
operator action and collapsing any of them into a per-procedure generic error is
what makes a blocked device indistinguishable from a broken one.

Three shape decisions carry weight:

- **`setUsbModeRefusalSchema` GAINED the four states rather than flattening them.**
  A USB-mode switch is a mutation like any other, so `recovery_pending` /
  `mutation_blocked` / `device_decommissioned` / `rebaseline_required` are
  first-class refusals there; `identity_unresolved` and `mutation_in_progress`
  map onto that procedure's own older vocabulary
  (`transition_failed{identity_unresolved}` / `transition_in_progress`), which a
  test pins.
- **`mutationRefusal` is ADDITIVE-OPTIONAL on the SIM / scan / router outputs.**
  Those carry terminal `state`/`error` enums a frontend already renders, so the
  refusal rides beside `state: 'error'` — a consumer that does not know the field
  still renders the legacy terminal, one that does can say why nothing was
  submitted. `modemConfigRefusalSchema`, which already had a refusal slot, gained
  the members outright.
- **`modemMutationAckInputSchema` is `.strict()` with `confirm: z.literal(true)`,
  and the `mode` is REQUIRED.** That is the wire-level half of "a bare
  alert-dismiss never unblocks a failed mutation": a mode-less acknowledgement
  cannot even be expressed, so the rule cannot be bypassed by a client that
  simply omits it.

`MODEM_MUTATION_JOURNAL_VERSION` is exact-matched, never upgraded in place: a
mutation record the device cannot read is precisely the case fail-closed exists
for. Device-side contract: [`apps/backend/AGENTS.md`](../../../../apps/backend/AGENTS.md)
→ THE MODEM MUTATION-SAFETY CONTRACT.

