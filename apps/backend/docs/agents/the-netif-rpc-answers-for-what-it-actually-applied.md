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

- **Mock writes retain immediate overlay readback except for a disable of the
  last effective link.** The shared guard decides that refusal before the
  mock overlay is written or broadcast. All other mock requests keep the
  existing overlay-first behavior and use the observed interface address for
  the best-effort raw mutation; a requested mock address need not match it.
- **The five reasons are not collapsible.** `enable_refused` already carries an
  operator notification naming the blocking error; `disable_all_refused` is the
  device protecting its last link; `unknown_interface` clears when the link comes
  back; `stale_address` means re-read and retry.
- **The disable guard uses the same eligibility rule as the sender and netif
  readback.** A raw-enabled peer does not keep the bond up if `isBondCandidate`
  excludes it (for example, because it is opted out or serves shared LAN). The
  existing refusal for the sole raw-enabled interface still applies when a
  mapped duplicate-IP peer is bonded with raw `enabled: false`. The separate
  duplicate-IP toggle path, refusal message, and mock receipt behavior for
  legacy raw-only refusals with a surviving effective peer are unchanged.

