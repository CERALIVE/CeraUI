<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A SIM LOCK IS REACHED FROM ITS OWN ROW, NEVER BY INTERCEPTION [EXISTS]

`SimUnlockDialog` is opened by an OPERATOR ACTION on the modem it belongs to.
There is no auto-open effect, and `src/tests/sim-unlock-trigger-gate.test.ts`
fails the build if one reappears.

It REPLACED a `$effect` in `NetworkView.svelte` that popped the dialog over the
whole Network destination the moment any modem reported a lock. Three things were
wrong with it, and the third is why it is GONE rather than debounced:

1. It hijacked a shared page for a device-scoped problem — an operator opening
   Network mid-broadcast to check bonding got a modal PIN prompt.
2. It was `modemEntries.find(...)`-based, so with two locked modems the second
   was unreachable no matter what the operator did.
3. **A PIN2 unlock cannot be made to stick.** `Sim.SendPin` verifies for the
   current UICC power session only, ModemManager caches no PIN, and the one
   persistent mechanism (`EnablePin(pin,false)`) has no PIN2 equivalent — so the
   lock returns on EVERY boot, forever, for something that blocks no traffic. An
   auto-prompt for it is a nag the operator could never silence. Full evidence:
   [`../backend/AGENTS.md`](../../../backend/AGENTS.md) → "AN UNLOCK DOES NOT PERSIST".

**…AND PIN2/PUK2 IS NOT A SIM LOCK THIS UI HAS.** Point 3 above is now settled
the other way round, by product decision rather than by routing: `sim-pin2` and
`sim-puk2` are not surfaced ANYWHERE. Not a row state, not a badge, not a band,
not a note. A modem carrying one and nothing else renders exactly as an unlocked
modem does.

The reasoning is the one this section already made, followed to its end. PIN2
gates ONLY the SIM's Fixed-Dialling-Number list, and **this product exposes no
calls and no contacts/FDN surface at all** — so the lock blocks nothing a CeraUI
operator can reach, and an unlock would not even survive a reboot. Surfacing it
therefore flagged a working modem as "locked" over a credential with nothing
behind it: the bench Quectel RM530N-GL registers on its carrier with `sim-pin2`
outstanding, and its row carried a warning pill saying `SIM locked` beside the
truthful `Registered` one. The band in `ModemConfigDialog` had the same problem
one step quieter — its copy said service was unaffected while its presence said
"locked".

**`BLOCKING_SIM_LOCKS` (`network/cellular-row.ts`) is now the WHOLE surfaced
set**, and the two questions collapse into one: a lock this UI shows IS a lock
that stopped the radio.

| Lock | Row state | Row action | Destination |
|---|---|---|---|
| `sim-pin` / `sim-puk` | `locked` (`modem-state-badge`) | **"Unlock SIM"** (`open-modem-unlock-dialog`) | `SimUnlockDialog` |
| `sim-pin2` / `sim-puk2` | its REAL state (`registered`, …) | "Configure" (`open-modem-config-dialog`) | `ModemConfigDialog`, with no band |

- **A blocking lock RENAMES the control rather than repurposing it.** Until the
  card is unlocked the radio cannot register, so the config form could apply
  nothing — and a button reading "Configure" that opens a PIN prompt is the same
  surprise this whole change removes. The testid follows the action so a spec
  cannot assert one while the operator sees the other. **This path is entirely
  unchanged.**
- **`activeSimLock` answers `undefined` for a `2` variant.** It is the single
  read every surface goes through, so nothing downstream can re-derive a lock the
  row decided not to show. `resolveRowState` no longer has a "no connection
  reported ⇒ locked" fallback for them either: "nothing was reported" is
  `unknown`, and a lock this product cannot act on may not stand in for it.
- **`lockBadgeLock` and `modem-lock-badge` are DELETED**, as are
  `modem-locked-band` / `modem-locked-unlock`, `ModemConfigDialog`'s `onUnlock`
  prop, and the config→unlock handoff in `NetworkView` (`unlockReturnToConfigId`
  / `returnFromSimUnlock`). The row's own button is the only route into
  `SimUnlockDialog`.
- **This is a RENDERING decision, not a contract change.** ModemManager still
  reports `sim-pin2` truthfully, the wire still carries it, and
  `modems.unlockSimPin2` still exists. CeraUI simply declines to render it.
- **`SimUnlockDialog`'s PIN2 branch is unreachable but KEPT**, deliberately. It
  is not a separable branch — it shares that dialog's title, icon, open-edge
  reseed, single keyed op, submit guard and footer with the blocking PIN/PUK
  flow, so excising it means editing the blocking flow in half a dozen places.
  Likewise the `sim-puk2` token inside `pukRequired` is one arm of the PUK1
  predicate, not a PUK2 path (there has never been a distinct one — the PUK2
  input is submitted through the PUK1 call). Both are documented in the
  component's own header. Removing them is its own change, with its own gate.

Do NOT add `sim-pin2`/`sim-puk2` back to `BLOCKING_SIM_LOCKS`, and do NOT
reintroduce a second, non-blocking surface for them — the first makes a working
modem's settings unreachable behind an FDN-credential prompt, and the second is
what this removed. Copy: `network.cellular.unlockAction` (10 locales);
`lockBandTitle` / `lockBandBody` are deleted. Coverage: `cellular-row.test.ts`
("SIM-lock routing" + "a `sim-pin2`-only modem is indistinguishable from an
unlocked one"), `CellularSection.test.ts` ("SIM-lock affordance"),
`ModemConfigDialog.detail.test.ts` ("a `sim-pin2` modem is treated as unlocked"),
and the trigger gate.

