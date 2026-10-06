<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## `no_sim` REPORTS A SLOT, NOT A NETWORKMANAGER PROFILE [EXISTS]

`modules/modems/sim-presence.ts` (pure) is the ONE rule behind the wire's
`no_sim`, and both builders route through its `claimsNoSim`.

The wire's `no_sim` was derived from the absence of an NM GSM connection
profile. That is a different fact: a profile is provisioned only once a SIM has
been READ **and** a connection created for it, so a modem holding a working card
that has not registered yet has none. Board-measured on a Quectel RM530N-GL
(2026-08-18): `mmcli -m 3` reported `modem.generic.sim:
/org/freedesktop/ModemManager1/SIM/0`, an occupied slot, `lock: sim-pin2`, the
SIM's own number, and `state: searching` under a `gprs-and-non-gprs-not-allowed`
network rejection — while CeraUI rendered **"No SIM card detected"** in the modem
dialog and simultaneously offered that same card's SMS inbox and its optional
PIN2 unlock band. Three operator-visible surfaces, exactly one of them reading
the wrong fact.

**THREE ANSWERS, and the third is not a synonym for the second.** `present` (MM
named a SIM object — the ONLY value that suppresses the claim, regardless of
profile, lock or registration state), `absent` (MM's own
`state-failed-reason: sim-missing`, a positive statement rather than an
inference from silence), and `unknown` (neither — the read could not answer).

- **`unknown` keeps the pre-existing behaviour**, so no modem class silently
  stops reporting a genuinely missing SIM. It is also what a poll that could not
  answer resolves to, and `mergeRefreshedModem` then RETAINS the previous value
  — the same withhold-on-unknown rule `deriveNetworkTypes` follows, for the same
  reason: a statement about the READ must not demote a card that was seen.
- **`sim_lock` follows the same three-answer merge discipline.** A stated lock
  replaces the previous value; `unlock-required: none` positively clears it; an
  unreadable or unknown lock answer retains the previous value. The `none` arm is
  explicit — omitting a fresh field while spreading the previous modem would
  otherwise latch "SIM locked" forever after a successful unlock.
- **AN EMPTY SLOT IS PUBLISHED AS `/`, not dropped.** Board-measured on the
  SIMCom SIM7600G-H, whose two `sim-slots` values both read `/`. So the test is
  the object-path SHAPE (`isSimObjectPath`), never "is this string non-empty" —
  the latter reports every empty-slot modem as holding a card.
- **The failed-reason is consulted LAST**, so a modem reporting both a SIM object
  and a stale `sim-missing` failure resolves `present`: a card MM can NAME is a
  card that is physically there.
- **BOTH backends read the SAME three MM facts.** `dbus-view-fold.ts`
  `readSimPresence` is the D-Bus twin (`Modem.Sim` / `Modem.SimSlots` /
  `Modem.StateFailedReason`), so the mmcli and D-Bus paths cannot disagree about
  whether a modem holds a card. This matters more on the D-Bus path than on
  mmcli: the fold never populates `config` at all, so under the old rule EVERY
  D-Bus-backed row claimed `no_sim`.
- **A SIM-present modem with no profile emits no `config` and no `no_sim`** —
  the honest "SIM present, not yet configured" state. The row then renders the
  radio's real state (`searching` plus the network's own rejection reason), its
  PIN2 lock badge, and a usable config dialog.
- The `simVisibility: "opaque"` router-dongle rule is UNCHANGED and orthogonal:
  it still emits NONE of the slot keys for a device whose SIM the host cannot see
  at all.

### …AND THE READING THE FOLD CONSUMES NOW RIDES THE WIRE BESIDE IT

`claimsNoSim` is `presence !== "present"`, so `absent` and `unknown` leave this
module as ONE `no_sim: true`. That fold is correct for its consumer — bonding is
binary, a link either joins the pool or does not — and lossy for every other
consumer: "we know the slot is empty" and "the read could not answer" are
different facts with different operator actions, and a modem with no NM profile
AND an unreadable slot published the same claim as a genuinely empty one.

`modemSchema.sim_presence` (`present` / `absent` / `unknown`,
additive-optional) is that fold's INPUT, published beside it by BOTH wire
builders. Four rules:

- **`claimsNoSim`, `isSimlessForBond` and bond membership are UNTOUCHED.** The
  gate still reads the binary claim, so the same device is refused exactly as
  before. Making `claimsNoSim` positive-evidence-only would change which links
  bond and is still its own change; this one is additive by construction.
- **It is emitted EXPLICITLY, including `unknown`.** The internal `Modem` state
  OMITS `sim_presence` when the read could not answer (that omission is what
  `mergeRefreshedModem`'s retain-on-unknown rule needs), so the builders resolve
  absence to `"unknown"` rather than dropping the key — the consumer merge
  preserves an omitted optional field, so a present-only-when-known field could
  be raised and never lowered (the `policy_route_missing` latch, exactly).
- **It rides the `simVisibility === "visible"` branch**, so an opaque device
  emits it no more than it emits `no_sim`: its slot is not unknown, it is
  unreadable from this host, which is a different claim.
- **The legacy oracle emits it too**, because `buildModemsMessage` is asserted
  byte-identical to the projection. A field added to one and not the other is a
  red suite, which is the point of keeping the oracle.

`ModemInfo` gained `modem.generic.state-failed-reason` and
`modem.generic.sim-slots` (both optional — mmcli drops a `--` value), and `Modem`
gained `sim_presence`. Coverage: `tests/modem-sim-presence.test.ts`, driven
through the REAL parser, the REAL refresh merge and BOTH wire builders against
verbatim board captures — the Quectel for `present`, and the SIMCom /
HiMi U01 / Fibocom FM350-GL for `absent` — plus "the pre-collapse reading rides
the wire beside the fold" (the unreadable slot carrying `unknown` AND `no_sim`,
the re-asserted `isSimlessForBond` verdict on that same fixture, the stated
`absent`/`present` pair, and the opaque-device negative). Rule-E proof: forcing
`claimsNoSim` to `true` reddens 4 tests; dropping the explicit `unknown` emission
reddens 1. Frontend half: `apps/frontend/AGENTS.md` → "…AND THE `unknown`-AS-
`absent` ASYMMETRY IS NOW CLOSED".

