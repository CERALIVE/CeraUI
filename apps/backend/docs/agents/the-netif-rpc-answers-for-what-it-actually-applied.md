<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE NETIF RPC ANSWERS FOR WHAT IT ACTUALLY APPLIED [EXISTS]

`handleNetif` returns `NetifApplyOutcome` (`{ok:true}` or `{ok:false, reason}`),
and `configureNetworkInterfaceProcedure` forwards a rejection as
`{success:false, error}` typed by `netifConfigErrorSchema` — `unknown_interface`
/ `stale_address` / `enable_refused` / `disable_all_refused`.

Every one of those was a bare `return` reported as `{success:true}`. The
`stale_address` path is the one that mattered: it is the CONCURRENCY guard
(`int.ip !== msg.ip`), and it discards the WHOLE request — including the bond
toggle riding alongside the address it was checking — so the operator was told
"Saved" over a link whose bond state had not moved.

- **The mock branch still answers `success:true`, deliberately.** Under mocks the
  mutation genuinely applied, to the overlay `setMockNetifConfig` wrote before
  `handleNetif` ran; `handleNetif` then works the RAW map, where its IP guard
  legitimately refuses because the mock-overlaid IP differs. Reporting THAT as a
  failure would report a dev/e2e toggle that visibly worked as broken. Do not
  "unify" the two branches.
- **The five reasons are not collapsible.** `enable_refused` already carries an
  operator notification naming the blocking error; `disable_all_refused` is the
  device protecting its last link; `unknown_interface` clears when the link comes
  back; `stale_address` means re-read and retry.

