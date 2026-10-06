<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE DONGLE LOGIN IS TYPED HERE, AND THE CAPABILITY EXPANSION IS VISIBLE [EXISTS]

`lib/modem/lock-state.ts` (pure, rune-free) + `main/dialogs/ModemLockSection.svelte`
are the operator half of todo 10's five-state `modem.lock_state`. Until now the
only answer CeraUI had for a gated dongle was "go and use the vendor's page";
that page is still reachable (`dongle-open-admin`) as the SECONDARY affordance,
and is no longer the primary one.

**…AND A DONGLE THAT WANTS ONE OPENS ON IT.** `RouterDongleDialog`'s `lockLeads`
moves the section to the TOP of the dialog whenever the lock is anything but
`open`. Measured on the shipped 1024×600 kiosk before the fix, a `locked` dongle
opened on its Connection card — copy reading "its network settings live in its own
web interface, not here" — with the "Dongle login" heading itself clipped at the
bottom edge and the password field **191 px** below the fold; `locked-out` was
worse, because the wait IS that state's entire payload and sat fully off-screen.
Three properties are load-bearing. **`open` is the only exempt state**, and not
for symmetry: it asks for nothing and is the common case on this fleet, so
leading with it would push the readings an operator DID come for down the page.
**Keying on `open` rather than on `lockWithholdsCapabilities` keeps the position
stable across the unlock** — `unlocked` leads too, so a successful sign-in never
moves the section out from under the outcome band that just confirmed it (the two
render sites are separate blocks, so a state crossing that boundary would remount
and drop the band, and `open` is a device reading no action here can produce).
**The leading position is BELOW the `dongle-unavailable` / `dongle-stale` bands**,
because either band qualifies everything under it, this login included. Nothing is
hidden to make room — the readings render one position lower. Coverage:
`RouterDongleDialog.lock.test.ts` (DOM order, with `open` as the negative control)
and `tests/e2e/modem-lock-fold.spec.ts` (the geometry, at the kiosk viewport).

**`open` IS THE COMMON CASE, AND IT GETS NO PROMPT.** Every bench dialect
answered unauthenticated, so most fleet devices have no password at all — a
prompt at one of them is exactly the dishonesty this surface exists to remove.
`offersEntryFor` is the gate, and it withholds the field in FOUR situations, not
one: `open` (nothing to ask), `unlocked` (nothing left to ask), `locked-out`
(see below), and a `locked` row carrying `sub_reason: "unsupported-profile"` —
where the dialect asked for a login shape this build ships no proven
implementation for, so a password would never be sent to the device at all and
offering the field invites an operator to blame their own typing for a
limitation of this build. The field is WITHHELD rather than rendered disabled,
because a disabled password box still says "there is a password here".

**SIX SITUATIONS, SIX SENTENCES — and three of them are the failure causes.**
`lockMessageKey` is a table over the wire vocabulary, not branches in the
component. Wrong password (`auth-failed`), unsupported firmware profile
(`locked` + `unsupported-profile`) and device lockout (`locked-out`) call for
three different actions — retype it, stop and use the vendor's page, wait — so
folding any pair is a lie about what to do next. `dongle-lock-body` carries
`data-lock-state`, so all six are distinguishable to a gate as well as to a
reader, and every state prints its own words (colour is reinforcement only).

**`locked-out` RENDERS THE WAIT, NOT A RETRY.** Every dialect counts a failed
login toward a window the operator cannot clear, so a retry there spends the
attempts that would have let them fix a typo: no entry, no submit, nothing that
reads as "try again". `lockoutRemainingMinutes` renders the device's OWN
`lock_detail.lockout_until`, rounded UP and floored at 1 (a wait shown as
"0 min" reads as "try now"), and answers `undefined` — the honest "it did not
say" — both when the device named no window AND when that window has elapsed on
THIS host's clock, because only the dongle can see that counter. **"Forget
stored login" DOES remain**, deliberately: clearing performs ZERO device
requests, so it is a removal rather than a retry, and during a lockout it is the
one useful thing an operator can do (it stops the rejected credential being
presented again on the next cycle).

**…AND IT IS THE ONE DESTRUCTIVE ACTION HERE, SO IT IS CONFIRMED.** Clearing
DELETES a secret this device cannot re-derive — there is no reveal toggle and no
second copy anywhere — so an operator who no longer knows the password loses the
dongle's whole settings surface until they find it again. It takes two acts:
`dongle-lock-clear` ARMS `dongle-lock-clear-confirm` (dispatching nothing) and
`dongle-lock-clear-apply` performs it. The confirmation is INLINE rather than a
`SimpleAlertDialog`, copying this dialog's own subnet rewrite: a modal inside an
already-portalled dialog puts the consequence on a layer a kiosk touchscreen must
dismiss before it can re-read what it is confirming, and one stored credential is
a smaller radius than the band-lock and USB-mode switches that earn a modal. It
stays reachable at `locked-out` — it still spends no attempt — and neither step
reads as a retry, which the enumeration test asserts.

**THE CREDENTIAL IS HELD BY THE MOUNT, AND NOTHING ELSE.** The password lives in
the section's own `$state` — never a store, never `$persist`, never
`localStorage`, never a URL — and `AppDialog` renders children only while open,
so the retention bound is the mount rather than a cleanup somebody has to
remember. A failed draft stays only in that mount; success clears it, and a
device change discards it. One `setCredentials` RPC performs verification before
persistence; no second login is dispatched. Typed `admin_unreachable` and
`credentials_rejected` results have distinct translated outcome bands.
The draft is never echoed into a heading or outcome band.
There is no reveal toggle and no autofill: `type="password"` +
`autocomplete="off"`, and no `value` ATTRIBUTE, so the secret is never in the
serialized document.

**THE EXPANSION RIDES `router_admin`, NOT A NEW WIRE FIELD.** The device's
`gateRouterAdminByLock` withholds `capabilities` + `controls` while a lock
stands and serves them again after a verify, so a control that was hidden
arrives through the SAME uniform sections (`dongle-net-mode`, `dongle-controls`)
every other reading on this dialog uses. Two consequences are load-bearing and
were both defects before they were rules:

1. **The no-controls band must not blame the hardware.** A withheld control set
   is byte-identical on the wire to "no write was ever proven", so
   `dongle-no-controls` reads `lock.controlsWithheld` (with `data-locked="true"`)
   while `lockWithholdsCapabilities` holds, and keeps `control.none` otherwise.
2. **A locked dongle's Configure must still open.** `configureDisabledReasonKey`
   read that same absence as an unverified write and DISABLED the row's
   Configure — so the operator was refused entry to the only surface carrying
   the login. Every router row now keeps that dialog reachable, including
   `open`/`unlocked` without controls: diagnostics and portal access are useful
   independently of settings writes. Individual settings retain their gates.

Copy: `network.routerCellular.lock.*` (29 keys × 10 locales). Coverage:
`lib/modem/lock-state.test.ts` (the entry/clear/withhold tables swept over
`MODEM_LOCK_STATES`, the three-distinct-causes proof, and the lockout rounding
incl. both `undefined` arms), `main/dialogs/RouterDongleDialog.lock.test.ts`
(the five rendered states, the `open` absence sweep WITH its positive control,
the retry-affordance enumeration at `locked-out`, the withheld→served control
transition, and the DOM/storage/URL credential sweep with the RPC-received
non-vacuity check), `tests/modem-lock-copy-completeness.test.ts` (derived from
the wire enums; asserts the six sentences are DISTINCT within every locale, not
merely present), `main/network/cellular-row.test.ts` (the reachability rule both
ways), and `tests/e2e/modem-credential-unlock.spec.ts` (locked → enter →
unlocked → expanded, plus the lockout and `open` legs, in a real browser).

**Honest status:** fixture-proven only. No locked device exists on this bench —
all three dialects answer unauthenticated — so `open` is the only state hardware
has exercised, and the locked→unlocked drill is owed against a real ZTE MF79U.

