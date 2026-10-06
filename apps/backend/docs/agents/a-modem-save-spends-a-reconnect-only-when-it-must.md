<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A MODEM SAVE SPENDS A RECONNECT ONLY WHEN IT MUST [EXISTS]

`applyModemConfig` used to end with an UNCONDITIONAL `nmDisconnect(connUuid)` —
one line, no guard — so re-saving an untouched dialog, or toggling roaming and
putting it back, tore the bearer down exactly as hard as a real edit. Operator
report: "disabling and enabling the roaming or the automatic APN shouldn't
trigger another search reconnection."

**Both halves of the question were answered on the board** (Rock 5B+,
NetworkManager 1.42.4, 2026-08-17), and the second one is the reason this is a
SCOPING fix rather than a removal:

- The tear-down really was unconditional, and the board's own journal shows it
  firing at a modem holding nothing:
  `nmDisconnect err: … '091ca73b-…' is not an active connection`.
- And no lighter apply path exists for a modem that IS connected. NM keeps a
  per-property reapply allowlist and refuses everything outside it
  (`Can't reapply changes to '802-3-ethernet.mac-address' setting`), the gsm
  device answers `Device is not activated`, and a bare profile write moves
  nothing — NM logs `gsm-6: connection profile changed` and leaves the device
  alone. Every field here is consumed by ModemManager at `Simple.Connect`:
  `gsm.home-only` becomes the bearer's allow-roaming, `gsm.auto-config` decides
  whether the APN is looked up at all, `gsm.apn`/`username`/`password`/
  `network-id` are connect parameters. So the reconnect is unavoidable for a
  real edit on a live bearer — which is precisely why it must not be spent on
  anything else.

**The rule lives in `@ceraui/rpc` (`modem-apply-scope.ts`), not here**, because
the dialog warns the operator BEFORE the save and this module decides whether to
act. Two copies would drift into a UI promising no interruption while the device
causes one. `decideModemReactivation` answers in a fixed order: unchanged ⇒
never; NM not holding the profile ⇒ never; otherwise reconnect and say which
fields forced it.

- **The comparison is of NORMALIZED values** (`normalizeModemConnectionFields`,
  mirroring `sanitizeModemConfigForNetworkManager`). A stale APN behind an
  enabled automatic-APN switch, an operator lock behind a disabled roaming
  switch, and an automatic-APN toggle on a device that cannot honour it are all
  written identically, so none of them is a change. Comparing raw form values
  would reconnect for all three.
- **The hold is READ, never assumed** — `readModemConnectionHold` runs
  `nmcli --get-values GENERAL.STATE connection show <uuid>`, which prints
  `activated` for an attached profile and NOTHING for a detached one (both
  measured). Non-empty means NM has it in hand, including `activating`, where a
  bearer is being built from the values about to be replaced.
- **`unknown` is treated as HELD.** A failed read is not evidence of an idle
  profile, and skipping there would leave the operator's setting unapplied with
  nothing on screen saying so — worse than an interruption they were warned
  about.
- **The hold is only read once a change is established**, so an untouched save
  costs no nmcli spawn either.
- **The profile WRITE stays unconditional.** Todo 50's ranking can re-point a
  save at a different duplicate, so skipping it would leave the operator's
  values on a profile NetworkManager is not using. Only the tear-down is gated.
- **A write that FAILED reconnects nothing** and still reports `write_failed`.
- **The network-type half is untouched.** `--set-allowed-modes` is mmcli's own
  path with its own guard (`msg.network_type !== modem.network_type.active`) and
  must not start depending on the connect-time diff, or one save would
  re-establish the radio twice.

`modems.configure` now reports what it actually did (`reconnected`, additive-
optional on `modemConfigOutputSchema`) rather than what the dialog predicted.
The effectful surface is injected through `ModemApplyDeps` /
`defaultModemApplyDeps` so the decision is provable with no nmcli on the host.

**Honest status:** the not-held and unchanged arms are board-proven (three saves
including two real edits produced ZERO `nmcli conn down` and no mmcli state
transition at all, while `nmcli` confirmed the new values landed). The HELD arm
is proven by the state-string discriminator measured on the board plus the unit
table — the bench Quectel is rejected by its network (`searching`, todo 49), so
no gsm bearer has ever been up on it to interrupt.

Coverage: `@ceraui/rpc` `modem-apply-scope.test.ts` (the decision table),
`tests/modem-config-reconnect-scope.test.ts` (the wiring, driven through the
REAL `applyModemConfig`). Frontend half:
`apps/frontend/src/main/dialogs/ModemConfigDialog.reconnect.test.ts`.

## …AND EVERY PROFILE BOUND TO THE SIM CARRIES THE SAME ANSWER [EXISTS]

Todo 50 fixed WHICH NetworkManager profile a modem save writes to, and disarmed
`connection.autoconnect` on the clones its retired duplicate-factory had left
behind. That narrows NetworkManager's own selection race; it does not close it,
because nothing forbids NM from activating a DISARMED profile — an explicit
`nmcli connection up <uuid>`, an autoconnect-priority change, a boot-time
reconnect. Board-measured on the bench Quectel RM530N-GL: ONE SIM, **FOURTEEN**
gsm profiles sharing an identical `gsm.device-id` + `gsm.sim-id`, **eleven** of
them still reading `gsm.home-only: no` while the operator had roaming DISABLED.

That is a safety defect rather than an untidiness one. `gsm.home-only` becomes
the bearer's allow-roaming flag at ModemManager's `Simple.Connect`, so activating
any of those eleven registers a roaming session — no error, no notification, and
a UI still reporting the value of the one profile CeraUI wrote.

**The guarantee comes from the profiles AGREEING, not from predicting which one
NM picks.** `modules/modems/gsm-duplicate-reconcile.ts`
(`reconcileDuplicateGsmProfiles`) runs three ordered steps, and only the first is
the guarantee:

1. **ENFORCE** — write the operator's own gsm fields to EVERY profile sharing
   this (device, SIM). After this, "which profile does NM activate" cannot change
   any operator-visible behaviour.
2. **DEMOTE** — disarm `connection.autoconnect` on the duplicates (todo 50's fix,
   preserved verbatim).
3. **PRUNE** — delete only what `classifyGsmDuplicate` can PROVE is abandoned.

- **The order is load-bearing in both directions.** Enforcing before demoting
  means a profile NM activates DURING the reconciliation already carries the
  right values; classifying from the PRE-demotion audit means step 2 cannot
  manufacture the evidence step 3 acts on. A prune that fails costs nothing,
  because step 1 already holds.
- **Deletion is now permitted — todo 50's "demote, never delete" is SUPERSEDED
  by decision, not by drift — but only on positive evidence.** Todo 50 stopped
  because "created by us" was inferred from a shared device+SIM alone; this adds
  the missing evidence rather than dropping the requirement. A duplicate is
  prunable only when it is not the selected profile, NM is not holding it (an
  EMPTY `GENERAL.STATE`), `connection.autoconnect` is already `no` (CeraUI's own
  footprint — nothing else writes it on a same-(device, SIM) clone), AND
  `connection.timestamp` is `0`, i.e. NetworkManager has never successfully
  activated it. Nothing reasons from absence: an unreadable timestamp parses to
  NaN and RETAINS.
- **Convergence is two-pass by construction.** An armed clone is enforced and
  demoted on one pass and can only become prunable on a LATER audit that observes
  the demotion — so a profile is never deleted on the strength of a flag we set
  moments earlier.
- **A different SIM is untouched.** NM matches a gsm profile on
  `gsm.device-id`/`gsm.sim-id`, so a second SIM in the same slot carries a
  different `sim-id`, falls outside the reconciled set entirely, and still gets
  its own profile from `addConnectionForModem`. Consolidation here removes no
  per-SIM capability.
- **The audit is READ FRESH, never from `gsmConnections`.** That cache is a
  snapshot taken for a different purpose at an unrelated moment, and this is the
  input to a destructive decision. A prune calls `resetGsmConnections()`, because
  the cache it invalidated is what the caller read its `keepUuid` from.

**Two call sites, and both are needed.** `applyModemConfig` fans the save out
(`enforceAcrossProfiles`, injected — it runs immediately after the primary write
and BEFORE any reconnect, so the profile NM brings back up already agrees), and
`registerModem` reconciles at discovery from the SELECTED profile's own values —
which is what covers a duplicate that appeared, or drifted, since the last save.
The registration call sanitizes a COPY of the config; normalizing the live one
there would rewrite state the operator did not touch.

**Todo 50 and todo 57 are unaffected.** `preferGsmConnection`'s ranking is
untouched (pruning only shrinks its candidate set), and `decideModemReactivation`
still reads the SELECTED profile's hold — enforcement adds no `nmcli conn down`.
An unchanged save still reconnects nothing and still re-asserts the answer
everywhere, which costs no bearer interruption and is exactly the case a drifted
duplicate needs.

Coverage: `tests/modem-roaming-enforcement.test.ts` (the classifier table incl.
every retain arm, the board's own 14-profile fixture ending with roaming
disabled everywhere, the enforce-before-delete ordering, the failed-prune
fallback, the armed-clone two-pass rule, the foreign-SIM and consolidated-modem
negatives, and the `applyModemConfig` wiring driven through the REAL procedure) +
the retargeted policy locks in `tests/modem-config-save-reliability.test.ts`.

