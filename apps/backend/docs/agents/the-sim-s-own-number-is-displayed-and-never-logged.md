<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE SIM'S OWN NUMBER IS DISPLAYED, AND NEVER LOGGED [EXISTS]

ModemManager publishes the SIM's own number (MSISDN) as `Modem.OwnNumbers`, and
nothing in this stack read it — an operator holding four identical sticks had no
way to tell which SIM was in which slot. It now rides the wire as the
additive-optional `modem.own_numbers` and is rendered behind an explicit reveal.

**It is read on BOTH backends, from the same property.** mmcli's
`modem.generic.own-numbers` (`mmcli.ts` → `deriveOwnNumbers`,
`modem-registration.ts`) and the D-Bus fold's `Modem.OwnNumbers`
(`dbus-view-fold.ts` `readOwnNumbers`) produce the same field, so the two paths
cannot disagree about which SIM is in the slot.

Five decisions carry weight:

- **ABSENT, EMPTY and BLANK all read as NOT REPORTED.** Most SIMs carry no
  MSISDN in their elementary files, so an empty answer is the ordinary case;
  publishing `[]` would invite the UI to render "no numbers" as a finding rather
  than as silence. `own_numbers` is `z.array(z.string().min(1)).min(1)
  .optional()` — the schema cannot express the empty list at all.
- **It is an ARRAY, and the tail is not dropped.** MM's property is `as` and a
  dual-number SIM is expressible; collapsing to a first element would be a silent
  loss. The bench Quectel RM530N-GL reports exactly one.
- **A refresh REPLACES it, it does not retain.** This is the deliberate opposite
  of `sim_presence`'s withhold-on-unknown rule, and the reason is that the two
  absences mean different things: `parseModemInfo` already rejects a record with
  no `modem.` key at all, so a successful parse that omits this one is the modem
  saying "none" rather than a read that could not answer. Retaining would latch a
  swapped-out subscriber's number on screen — the `policy_route_missing` latch,
  with PII in it. `mergeRefreshedModem` therefore drops the previous value before
  spreading.
- **mmcli's `-K` array indices are ONE-BASED.** The bench capture reads
  `modem.generic.own-numbers.value[1]`, as do `drivers`, `ports` and
  `unlock-retries`. `mmcliParseSep` pushes in encounter order, so nothing may
  key on the index number.
- **It is its OWN redaction class** (`helpers/logger.ts`
  `isOwnNumberSensitiveKey`, plus the `OWN_NUMBER_RECORD_RE` value-side
  backstop for a raw `-K` record). It cannot join `SENSITIVE_KEY_RE`, which is a
  SUBSTRING match: `number` there would blank a slot index, a band count and
  every unrelated `numbers` on the device. `msisdn` stays in the SMS set, its
  historical home, and is not duplicated. `shadow-redaction.ts` gained the same
  keys for the mutation-free evidence collector.

**DISPLAYED is not LOGGABLE.** The UI shows the number behind a reveal because
the subscriber owns that surface; the device still scrubs it from every
transport, exactly like a PIN. Both halves are asserted — the render side in the
frontend suite, the log side by driving the REAL winston transport.

Engine-side half: `modem-stack` `AGENTS.md` → THE SIM'S OWN NUMBER. Frontend
half: `apps/frontend/AGENTS.md` → THE SIM'S OWN NUMBER IS HIDDEN BY DEFAULT.
Coverage: `tests/modem-own-number.test.ts` (the one-based-index parse, the three
absences, the multi-number case, the swap-clears-it merge, the additive
byte-compat diff against the legacy oracle, the D-Bus fold, and the redaction
matrix incl. the real-logger proof and the no-over-redaction control).

