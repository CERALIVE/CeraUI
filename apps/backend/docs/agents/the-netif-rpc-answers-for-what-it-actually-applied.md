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
- **On a real device a disable also keeps the last link the bond would use.**
  Besides the raw-count refusal, `handleNetif` answers `disable_all_refused`
  (same notification) when the target is the only interface `isBondCandidate`
  admits, in the normal and the duplicate-IP branch alike. A raw-enabled peer
  that is opted out, gated (shared LAN, pending identity, concurrent AP) or
  unaddressed no longer keeps the bond up; disabling such a peer still works.
  The real-device answer is resolved once at boot (`initLastUplinkGuard`,
  awaited in `main.ts` before netif polling), so the check and the write stay
  one synchronous step and overlapping requests apply in arrival order.
  Development, mock mode, the scripted network monitor (`MOCK_SCENARIO`,
  `NODE_ENV=test`) and the hwsim guest keep the raw-count guard alone. A
  harness that sets the environment must call `initLastUplinkGuard()` after it,
  as boot does. Not covered: a disable whose bond opt-out also lands on a peer
  sharing the target's physical link id (an identity collision).
- **The five reasons are not collapsible.** `enable_refused` already carries an
  operator notification naming the blocking error; `disable_all_refused` is the
  device protecting its last link; `unknown_interface` clears when the link comes
  back; `stale_address` means re-read and retry.

