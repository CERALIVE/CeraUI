<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## SIM PIN AUTO-UNLOCK [EXISTS]

Opt-in boot auto-unlock for a PIN-locked SIM. Two modules under `modules/modems/`:

- **`sim-secrets.ts`** — the secret store. `storeSimPin` / `loadSimPin` / `clearSimPin`
  read/write the PIN to a **chmod-600 tmpfs** file `/run/ceralive/sim-pin.secret`
  (override `CERALIVE_RUN_DIR` in tests — same pattern as `kiosk-token.ts`).
  Content I/O is `Bun.write` / `Bun.file`; the 0600 mode is enforced with a
  `node:fs/promises` chmod afterwards (Bun.write ignores mode on an existing file).
  **The PIN is NEVER in `config.json`** — `runtimeConfigSchema` has no `simPin` field.
- **`sim-autounlock.ts`** — the boot hook `maybeAutoUnlockSimPins(deps)`, wired into
  `initModemUpdateLoop` (after the initial discovery, gated by the `autoUnlock`
  option, default true). Contract: gated on `isRealDevice()`; submits the stored
  PIN **at most once** per locked modem; on the FIRST non-success it **clears the
  stored PIN and stops** (no loop toward a PUK lockout — the modem surfaces for
  manual entry via the `unlockSim` RPC); a success triggers one re-discovery.

The opt-in is performed via `storeSimPin` (persist a **confirmed-correct** PIN) /
`clearSimPin` (opt back out) — only a PIN the SIM has accepted is ever stored, so
boot never resubmits a known-wrong PIN. The unlock flow is the intended caller
(store on a successful unlock when the user chooses "remember"). Coverage:
`tests/sim-autounlock.test.ts` (mode-600 + config-untouched, boot unlock, bounded
wrong-PIN, and the no-op gates).

**A successful manual unlock retracts the lock in the same response cycle.**
`unlockSim`, `unlockSimPuk`, and `unlockSimPin2` clear the affected modem's cached
`sim_lock` and call `broadcastModems({ [modemId]: true })`. The targeted full
descriptor is load-bearing: status-only modem frames cannot retract an omitted
optional lock field in the frontend merge, so without it the dialog closes while
the row remains locked until a reload. Coverage:
`tests/mock-pin-unlock-rpc.test.ts` plus the `modem-pin-locked` browser scenario.

### AN UNLOCK DOES NOT PERSIST — WHICH IS WHY THIS HOOK EXISTS [EXISTS]

Investigated for todo 46 against the ModemManager 1.24.2 D-Bus API + source and
re-confirmed on the bench board (`busctl introspect …/SIM/0`). Recorded here
because "can the device just remember the unlock" is the first question anyone
asks of this module, and the honest answer is architectural rather than a
missing feature.

- **`Sim.SendPin` is a VERIFICATION, not a setting.** The unlocked state lives in
  the UICC's own security state, so it is re-applied whenever the card is
  re-initialised after a power cycle. A host reboot and a modem power cycle
  therefore both require re-entry; a `Modem.Enable(false)`/`Enable(true)` cycle
  is modem-firmware dependent (`Enable(false)` is documented as low-power, NOT as
  a durable-unlock promise), and a USB replug only preserves it on hardware that
  happens to keep the UICC powered — never something to rely on.
- **ModemManager caches NO PIN.** The generic backend formats the PIN into
  `AT+CPIN`, submits it, and frees the string with the request context
  (`src/mm-base-sim.c`); the D-Bus handler copies it only for the in-flight
  request. There is no daemon-wide cache, so nothing replays a PIN after a modem
  reset and nothing survives an MM restart. Any "it remembered my PIN" behaviour
  on a Linux box is NetworkManager's `gsm.pin` connection secret (governed by
  `pin-flags`) or a vendor quirk — host-side credential storage, exactly like
  this hook's own `/run/ceralive/sim-pin.secret`, and NOT an MM feature.
- **The ONE persistent mechanism is `Sim.EnablePin(pin, false)`** — it turns the
  card's PIN-verification facility off (generic backend: `AT+CLCK="SC",0,"PIN"`)
  and survives power cycles because it changes the SIM rather than the session.
  **CeraUI deliberately never calls it.** Disabling a SIM lock outright is the
  operator's security decision, not a side effect of using a streaming encoder.
- **There is NO `EnablePin2`.** `EnablePin` takes no PIN-kind argument and the
  protocol backends hardcode PIN1 (`mm-sim-qmi.c` selects `PIN1` explicitly), so
  a PIN2/FDN lock cannot be persistently cleared through ModemManager at all. It
  returns on EVERY boot for as long as FDN is enabled on the card — the bench
  Quectel shows exactly that (`enabled locks: fixed-dialing`, `lock: sim-pin2`,
  `sim-pin2 (3)` attempts intact).

**Consequences that are load-bearing elsewhere:**

1. This PIN1 hook is the only available answer for "come up bonded after a
   reboot without an operator present", short of the operator disabling their
   SIM lock on a phone. That is what justifies the stored-secret exposure.
2. **A PIN2 prompt can never be permanently satisfied**, which is why the UI does
   not intercept the operator with one. That decision and its rationale live in
   `apps/frontend/src/main/NetworkView.svelte` (`openModemConfig`) and
   `apps/frontend/AGENTS.md` → "A SIM LOCK IS REACHED FROM ITS OWN ROW".

