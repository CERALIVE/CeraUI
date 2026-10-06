<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## AN ABSENT READING STILL SAYS SOMETHING [EXISTS]

`@ceralive/modem-control@1.3.0` normalizes every ModemManager reading as a
`NormalizedMetric<T>` — a value, or an `unknown` carrying one of SEVEN reasons.
`modemMetricUnknownReasonSchema` plus the three value-typed unions
(`modemNumberMetricSchema` / `modemFlagMetricSchema` / `modemTextMetricSchema`)
are the wire form of that, and they exist so the REASON survives the trip.

**A bare `null` would destroy the only information worth carrying.**
`unsupported` is a durable claim about the SOURCE, `not-reported` is about ONE
reading, and `not-observed` is about US — three different operator actions (hide
the control / wait for the next sample / prime the read) that a single `null`
renders identical. This is the same distinction `routerSignalMetricSchema`
already draws for the dongle dialects.

**It is NOT `routerSignalMetricSchema` re-used, and that is deliberate.** Its
five reasons are the router-admin dialects' own vocabulary and carry no
`not-observed` or `refused`; a ModemManager reading genuinely reaches both,
because the extended `Modem.Signal` dicts stay empty until `Signal.Setup` primes
them. Widening the router union instead would tell a dongle consumer that two
reasons its dialects cannot produce are now possible.

Three blocks consume it, all additive-optional on `modemSchema`:

| Field | Carries |
|---|---|
| `signal_detail` | `quality_recent` + `rsrp` / `rsrq` / `snr` / `sinr` |
| `registration_context` | `operator_name` / `operator_code` / `cell_id` / `tac` |
| `sim_presence_evidence` | WHICH FACT decided `sim_presence` |

Four shape decisions carry weight:

- **Inside a present block every metric is REQUIRED.** The modem merge preserves
  an omitted optional field, so a metric published only when known could be
  raised and never lowered (the `policy_route_missing` latch, exactly). The
  BLOCK is optional because only a backend that reads the interface can answer
  at all — the mmcli path omits all three rather than publishing metrics it
  never looked for.
- **`sinr` is `not-reported` on an LTE/NR modem, never `unsupported`.**
  ModemManager 1.24.2's own introspection gives `sinr` to `Signal.Evdo` and to
  no other dict, while `Lte`/`Nr5g` publish `snr` — a different quantity. So
  ModemManager CAN express SINR, and a capability claim it disproves would be
  the invented reading this layer exists to prevent.
- **`operator_name` is deliberately DUPLICATED with `status.network`.** `status`
  is byte-locked against the pre-Phase-B builder and OMITS the field when the
  modem reported none, which destroys "not registered yet" vs "never looked".
  The metric keeps the reason; `status.network` keeps the legacy shape.
- **There is no EARFCN, and there cannot be one from these sources.** MM
  publishes no generic ARFCN on `Modem` / `Modem3gpp` / `Location`; the only one
  is per-cell, under two DIFFERENT keys for two DIFFERENT quantities (`earfcn`
  LTE, `nrarfcn` 5GNR). One slot would have to merge them or pick a RAT.

`modemSimPresenceEvidenceSchema` is a `kind` union whose whole purpose is
auditability: `absent` is reachable through exactly ONE member
(`state-failed-reason`), which turns "never inferred from a blank field" into a
property a consumer can VERIFY. `no-evidence` names the fields that were
inspected. Its `value` fields carry D-Bus object paths and MM's own
failed-reason token — never a subscriber identifier, and they must never be
widened to carry one.

Device contract: [`apps/backend/AGENTS.md`](../../../../apps/backend/AGENTS.md) →
THE EXTENDED SIGNAL READING IS A METRIC, NOT A NUMBER.

