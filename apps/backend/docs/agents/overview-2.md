<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## OVERVIEW

Host default-route election now ranks device-bound repository HTTPS ahead of
ordinary connectivity, with a sole-uplink fallback. All apt paths await route
application and a fresh unbound family reading; an install failure re-arms gateway
maintenance rather than returning success. The policy, shared primitives and
source-only validation boundary are in
[`HOST-UPLINK-ELECTION`](../../../../docs/HOST-UPLINK-ELECTION.md).

The dev mock-preview server accepts explicit `PREVIEW_PORT=0` for an OS-assigned
listener, matching its existing `startMockPreviewServer(0)` test seam. Unset or
non-numeric values retain the previous 9997 fallback. E2E uses this to isolate preview
upstreams; its private child readiness protocol lives in frontend test fixtures,
not in a production endpoint. See [`../../docs/E2E-BACKEND-OWNERSHIP.md`](../../../../docs/E2E-BACKEND-OWNERSHIP.md).

Bun/TypeScript HTTP + WebSocket server. Serves the frontend static bundle, exposes all device control via oRPC over WebSocket, drives the `cerastream` engine over structured IPC (`@ceralive/cerastream` public-npm registry dep) and the `srtla` sender (`srtla_send`) via the private workspace package `@ceraui/srtla-send` (`packages/srtla-send/`).

