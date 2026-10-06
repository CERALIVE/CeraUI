<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE EXTENDED SIGNAL READING IS A METRIC, NOT A NUMBER [EXISTS]

`status.signal` is ModemManager's 0-100 `SignalQuality` percentage and is all an
operator ever got. The radio measures far more than that, and modem-stack 1.3.0
normalizes it — so `dbus-view-fold.ts` now folds three additive blocks beside the
legacy `status`: `signal_detail`, `registration_context`, `sim_presence_evidence`.
Wire contract: [`../../packages/rpc/AGENTS.md`](../../../../packages/rpc/AGENTS.md) →
AN ABSENT READING STILL SAYS SOMETHING.

**Every value is a METRIC — a reading or a typed REASON — and that is the whole
point.** `unsupported` (the source cannot express it), `not-reported` (it
answered and this was not in the answer), `not-observed` (nobody read that
interface) and `malformed` (it was there and would not decode) are four different
operator facts, and a bare `null` renders them identical.

**`Signal.Setup` is what makes any of this non-null on hardware, and it is
permitted on the LIVE path only.** `LIVE_OBSERVATION_MEMBERS` admits it;
`STRICT_SHADOW_MEMBERS` keeps refusing it as a named mutation. Do NOT use the
live policy in shadow mode, and do not read this section as licence to widen
either set.

- **The RAT ladder is newest-first and merges NOTHING.** `rsrp`/`rsrq`/`snr` read
  `Nr5g` → `Lte`; on an NSA attach both dicts are populated with different
  carriers' measurements, so the ladder picks one reading rather than averaging
  two into a number no radio produced.
- **`sinr` reads `Evdo` ALONE.** MM 1.24.2's introspection gives `sinr` to that
  dict and to no other, while `Lte`/`Nr5g` publish `snr`. So an LTE/NR modem
  answers `not-reported`, NOT `unsupported` — the latter is a capability claim
  ModemManager itself disproves.
- **A primed-but-empty interface is `not-reported`; an unread one is
  `not-observed`.** That distinction is the reason the block exists at all, and
  it is what tells an operator whether to wait for the next sample or to look at
  why nothing is reading the interface.
- **`quality_recent` is the `b` of `SignalQuality`'s `(ub)`.** The percentage and
  "was it measured recently" are separate facts about one measurement; only the
  first was ever projected, so a stale 40% and a live 40% were indistinguishable.
  `status.signal` is byte-unchanged.
- **Cell context is COARSE and enables nothing.** `cell_id`/`tac` come from
  `Modem.Location`'s `3gpp-lac-ci` entry, decoded through `dbus-mm-enums.ts`
  `decodeLacCi` (the package's `decode3gppLacCi` behind the compat seam). MM
  MASKS that property unless `Location.Setup` ran with `signal_location = true`,
  which is permanently forbidden here and which the audit allowlist does not
  admit — so the shipped steady state is an honest `not-observed`, and a value
  appears only where something else already enabled the source. Both come out of
  ONE decoded string, so they can never describe two different cells; the tokens
  stay MM's own uppercase hex, because `0A1B2C3D` read as decimal renders
  `169552957`, which matches nothing `mmcli` or a vendor UI shows.
- **`operator_name` duplicates `status.network` deliberately.** `status` is
  byte-locked and OMITS the field when the modem reported none, which loses the
  reason; the metric keeps it.
- **`sim_presence_evidence` rides EVERY row, including an `unknown` one.** That
  is the row it exists for — `no-evidence` naming the inspected fields separates
  "we looked and the modem said nothing" from "we did not look" — and a
  present-only-when-decisive field could never lower its claim.
  `readSimPresenceEvidence` (`sim-presence.ts`) is the ONE reader both backends
  hand facts to, so `absent` stays reachable through exactly one evidence kind.
- **The mmcli path emits none of the three, and that is honest rather than a
  gap.** It observes no `Modem.Signal` interface at all, so publishing four
  `not-observed` metrics would claim a read it never attempted. The blocks are
  additive-optional; the legacy byte-compat oracle is unaffected.

Coverage: `tests/modem-signal-detail-wire.test.ts` — the RAT ladder and its
NSA no-merge rule, the `not-reported`-vs-`unsupported` SINR distinction, the
`not-observed`-vs-`not-reported` split in both directions, `malformed`, the
`(ub)` recency with `status.signal` unchanged, operator name/code as text, the
`3gpp-lac-ci` decode with its hex-stays-hex and 2G-no-TAC arms, the fenced
`not-observed` steady state, a negative proving no ARFCN is claimed, the
SIM-evidence table with its exactly-one-kind-answers-`absent` audit, the
additive-only projection proof, and the redaction pass with its non-vacuity
control.

