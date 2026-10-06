<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## ANTI-PATTERNS

- Don't publish this package, and don't remove `"private": true`.
- Don't make `--conn-timeout-ms` optional or change `15000` without changing the
  receiver's `CONN_TIMEOUT` in lockstep.
- Don't reorder the telemetry schema keys.
- Don't format the fixtures.
- Don't build on `control/` before the rewrite lands.
- Don't redeclare a local type for a field this package already exports —
  a shadow type is what hides a stripped field from `tsc`.
