<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE RADIO MODE AN OPERATOR READS MUST BE A LIVE READ [EXISTS]

The 3G/4G/5G selector's apply path is REAL — board-proven on a Rock 5B+
(Quectel RM530N-GL, mmcli 1.24.2, 2026-08-16): five modes driven through
`modems.configure` each landed at the device
(`--set-allowed-modes=3g|4g|5g --set-preferred-mode=5g` →
`modem.generic.current-modes: allowed: 3g, 4g, 5g; preferred: 5g`). What was
wrong was everything around it.

**`refreshModemStatus` carried DISCOVERY's `network_type` forward, forever.** It
rebuilt `status` and `sim_lock` from each fresh `-K` payload and spread the rest
of the previous modem — so `current-modes`, which rides that SAME payload, was
read once at registration and never again. Measured: the modem was moved to
`allowed: 3g` and 40 s later, past the 30 s poll, `modems.getAll` still answered
`active: "5g4g"`. Nothing re-registers an already-known modem, so the wrong label
stood for the process lifetime.

**That latch was not cosmetic — it disabled the write.** `applyModemConfig` asks
`msg.network_type !== modem.network_type.active` before spending an mmcli call,
so a save of the mode the dialog was SHOWING compared equal to a value the radio
had left behind and skipped `--set-allowed-modes` entirely. Board-measured:
`configure({network_type:"5g4g"})` answered `{"success":true}` while the modem
stayed on `allowed: 3g`. Same family as todo 47's interface-address field and
todo 50's APN save — a control that looks wired and silently does nothing.

- **`deriveNetworkTypes(modemInfo)`** (`modem-registration.ts`) is now the ONE
  derivation, shared by registration and refresh. It costs no extra spawn: both
  mode fields are already in the payload the refresh fetched.
- **`undefined` means the PAYLOAD could not answer**, and the caller keeps what
  it had. A read that names no mode fields, or a `current-modes` line that does
  not parse, is a statement about the READ — blanking a modem's whole mode list
  over one unreadable poll would be the opposite error. `mergeRefreshedModem` is
  the pure merge that applies that rule, so it is provable with no mmcli on the
  host.
- **A parse failure no longer aborts REGISTRATION.** The old code called
  `mmConvertNetworkType` bare, so a malformed line threw out of `registerModem`
  and `registerModemSafe` swallowed it — the modem never appeared at all. It now
  registers with an empty mode list, which the next poll fills in.
- **Residual window: one poll interval.** An out-of-band change is reflected
  within 30 s rather than never. Do NOT "fix" that by deleting the skip guard —
  it is what stops every save re-establishing the bearer (see A MODEM SAVE SPENDS
  A RECONNECT ONLY WHEN IT MUST).

**And a refused write no longer reports "Saved".** `mmSetNetworkTypes` answers
`false` when mmcli did not print its confirmation and `undefined` when the spawn
threw, and both were dropped on the floor — the retired comment claimed the
outcome rode "the ordinary configure-echo", but that echo parrots the REQUEST
(`applied.network_type: input.network_type`), and the dialog locks its form to
`applied`. So a mode the modem rejected reached the operator as a success toast
with the rejected value selected. It is now the existing wire-stable
`write_failed` refusal — no new token, no locale change — and `active` is still
left untouched, so the next poll's live read is what settles the display.

Coverage: `tests/modem-network-type-truth.test.ts` (the derivation against the
board's verbatim 12-row supported-modes list, the out-of-band re-read, both
withhold cases, the merge that replaces the latched value, the
everything-else-survives control, and the refused/threw/accepted write matrix
driven through the REAL `applyModemConfig`).

