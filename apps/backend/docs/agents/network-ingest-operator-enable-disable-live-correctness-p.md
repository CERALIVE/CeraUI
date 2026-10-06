<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## NETWORK-INGEST OPERATOR ENABLE/DISABLE (live-correctness-pass Todo #6–9) [EXISTS]

`modules/network/network-ingest-control.ts` adds a topology-aware desired-state
layer on top of the always-on gateway probe (`network-ingest.ts`, above):

- `readIngestDesired(config) → {rtmp, srt}` — the SOLE defaulting point
  (`?? true`); a missing config key defaults both protocols to enabled.
- `persistIngestDesired(protocol, enabled)` — mutates `getConfig().network_ingest`
  and calls `saveConfig()`; the singleton-only writer.
- `planIngestUnitActions(desired, markers) → {start, stop}` — PURE resolver.
  Topology-aware: the NEW shared `ceralive-rtmp-gateway.service` topology stops a
  unit only when BOTH protocols are off and starts it when EITHER is on; the OLD
  `srtUnitPresent` topology keeps rtmp↔rtmp / `ceralive-srt-gateway.service`↔srt
  independent. The apply step is isActive-GATED (only issues `systemctl
  start/stop` when current state differs from target) — that gating, not the pure
  resolver, is what makes reconcile idempotent.
- `setIngestEnabled(protocol, enabled)` — persist FIRST, then systemctl-apply
  (apply errors are swallowed; persisted desired-state is the truth, reconciled
  next boot), then re-broadcast BOTH `status` and `sources`.
- `reconcileIngestDesiredState()` — fire-and-forget boot reconcile; never throws,
  self-serialising, emulated no-op. Wired in `main.ts` beside
  `runAddonReconciler()`.
- `rpc.network.setIngestEnabled({protocol, enabled})` — persists first (even in
  the `shouldUseMocks()` branch, which also flips the mock's SEPARATE
  `networkIngestActive`/`gatewayActive` maps so the toggle and the
  `streaming.start` gate agree), else `{success:false, error:
  NETWORK_INGEST_UNAVAILABLE_ERROR}` when `!isRealDevice()`, else the real
  `setIngestEnabled` path.
- `status.network_ingest.{rtmp,srt}.operator_disabled?: boolean` — additive,
  present only when `true`, DISTINCT from `service_active` (a shared unit can
  stay active while a sibling protocol is operator-disabled).

**The fail-visible three-mirror predicate** — "start-eligible = unit-active AND
NOT operator-disabled" — is enforced identically in three places that MUST
agree: the real gateway probe (`network-ingest.ts` `buildGatewayProbe()`), the
mock gate (`mocks/providers/streaming.ts` `isMockGatewayActive()`, dev/CI
parity), and the frontend `pipelineAvailability()` (operator intent checked
FIRST, reason `live.education.reason.disabledInSettings`). See root `AGENTS.md`
→ "LIVE-CORRECTNESS-PASS FIXES" for the frontend-side contract
(`NetworkIngestDialog.svelte`, `SourceSection.svelte`'s visible-row filter).

