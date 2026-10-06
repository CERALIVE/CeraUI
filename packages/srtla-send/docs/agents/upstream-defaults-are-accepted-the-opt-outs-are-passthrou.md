<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## UPSTREAM DEFAULTS ARE ACCEPTED; THE OPT-OUTS ARE PASSTHROUGH ONLY

Upstream ships re-home and stall-deselect ON. The binding does NOT re-assert a
default of its own: `noRehome` / `noStallDeselect` are optional and emit
`--no-rehome` / `--no-stall-deselect` only when explicitly set. Absent means
"whatever the sender ships", which keeps the fork's behaviour the source of
truth for the fleet rather than a number duplicated here.

