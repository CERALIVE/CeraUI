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

- **Mock writes retain immediate overlay readback.** The RPC writes and
  broadcasts the overlay first, then uses the observed interface address for
  the best-effort raw mutation. A mock reply can report a link off even when the
  raw guard refused the disable and the sender still uses it.
- **The refusal reasons are not collapsible.** `enable_refused` already carries an
  operator notification naming the blocking error; `disable_all_refused` is the
  device protecting its last link; `unknown_interface` clears when the link comes
  back; `stale_address` means re-read and retry.
- **On real devices, a normal disable also protects the sole effective WAN
  bond candidate.** A raw-enabled peer does not keep the bond up if the
  sender's `isBondCandidate` rule excludes it (for example, because it is
  opted out or serves shared LAN). The raw guard still applies first and is
  the only guard in emulated mode, development, mock mode, and the native
  hwsim guest.
  The separate duplicate-IP toggle path is unchanged.

