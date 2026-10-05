<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## CAPABILITY-TRUTHFULNESS REGRESSION GATE [EXISTS]

`apps/frontend/tests/e2e/truthfulness.spec.ts` is the capstone rendered-DOM proof that the
UI never lies about a capability. It injects three capability snapshots (full /
engine-starting / engine-unavailable) over the page WebSocket against ONE mock backend
(`MOCK_SCENARIO=multi-modem-wifi`, fixed per worker) using the same `routeWebSocket` proxy
pattern as `source-overhaul.spec.ts`, and asserts three things:

1. **Real DOM flips**, not just internal state — the H.265 codec button, the latency-slider
   `aria-valuemin`/`aria-valuemax`, the audio live-switch control, the capability-tier
   banner, and the `network-ingest-select-rtmp` row all genuinely enable/disable/change
   bounds across the three snapshots (RIST/SRT transport pills are asserted honest
   coming-soon — `role="note"`, never fake-interactive — since they never flip).
2. **No orphan `data-debt-id`** — every rendered `[data-debt-id]` (from `ComingSoon.svelte`)
   is cross-checked against the `open` entries in `docs/TECHNICAL_DEBT.md`, reusing the SAME
   parser (`DEBT_ID_RE`) as `scripts/check-tech-debt.mjs`.
3. **No undefined-RPC crash** on a full dialog click-walk (encoder/audio/server open+close,
   destination navigation) — `page.on('pageerror')` plus filtered console-error assertions.

This is the terminal regression gate for every truthfulness contract landed across this
plan (gateway-availability, capability-vs-active split, disabled-with-reason everywhere) —
extend it, don't duplicate it, when a new capability-gated control ships.

