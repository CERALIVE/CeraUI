<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## MEASURED INTERFACE THROUGHPUT [EXISTS]

`netif` entries carry TWO different throughput quantities, and only one of them
is a rate:

| Field | Meaning |
|-------|---------|
| `tp` | raw TX **byte delta** since the previous poll, over an unstated interval (legacy; kept for wire compat) |
| `tx_bps` / `rx_bps` | measured throughput in **bits per second** (additive-optional) |

`tp` cannot be rendered as a rate — nothing on the wire says how long its window
was — which is why the Network page's Bonded Links card read `0 kbps` and its
`TOTAL BANDWIDTH` never moved. `computeInterfaceRate(current, previous,
elapsedMs)` is the pure derivation: 0 with no baseline, 0 when no time elapsed,
and 0 on a counter reset (interface bounce / 32-bit wrap) so a wrap reads as
idle rather than a multi-gigabit spike. `processIfconfigOutput` takes an
injectable `now` so the window is the ACTUAL elapsed time, not the nominal
`NETIF_POLL_INTERVAL_MS`.

These are kernel counters, so they are meaningful whether or not a stream is
running — that is the point. This does NOT relax the Live-Data Discipline rule
for stream telemetry: the HUD's stream-gated `throughputKbps` is unchanged, and
`linkTelemetry` still clears on stop.

Coverage: `tests/netif-throughput-rate.test.ts`.

