<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## PREVIEW WEBSOCKET PROXY — single-origin (Task 20) [EXISTS]

The cerastream engine serves its video preview over a WebSocket on a loopback
port, but the browser NEVER dials the engine directly. The backend proxies the
preview through its OWN origin at `/preview` (`modules/ui/preview-proxy.ts`), so
the preview travels the same authenticated, single-origin path as the RPC socket.

**Remote-access rationale (the decision):** a device reached through a reverse
proxy / cloud tunnel exposes exactly one origin. A direct engine-port dial from
the browser would require a second exposed port (and mixed-origin/CORS handling)
that a remote operator does not have. Proxying through the backend keeps the
preview reachable wherever the RPC socket is reachable — no extra port, no
divergence between dev and prod dial targets.

- **Fork order (`rpc/server.ts`):** the `fetch` handler branches on
  `pathname === PREVIEW_WS_PATH` BEFORE the generic oRPC upgrade — the oRPC path
  would otherwise adopt every WS into the RPC handler. Bun exposes ONE `websocket`
  handler, so `rpc/adapter.ts` `createServerWebSocketHandler()` dispatches by the
  `ServerSocketData` `kind` discriminant (`isPreviewSocket`).
- **Auth AFTER upgrade (pinned):** a fresh WS upgrade starts unauthenticated, and
  RPC auth is per-socket, so "same auth as RPC" is NOT reusable. The route ALWAYS
  upgrades on a pathname match, then validates+consumes a single-use token on
  `open`, closing `PREVIEW_CLOSE_UNAUTHORIZED = 4401` when it is
  invalid/expired/consumed — NEVER a pre-upgrade HTTP refusal (a browser
  WebSocket cannot distinguish a pre-upgrade HTTP error from a network failure).
- **Token (`modules/ui/preview-token.ts`):** in-memory, single-use, TTL 30s,
  minted by the authed `system.mintPreviewToken` RPC and passed as the `?token=`
  query param — the RPC password/credential never appears in the URL. Mirrors the
  kiosk single-use token pattern; raw entropy, never persisted, never logged.
- **Upstream + close codes:** the proxy dials the engine loopback socket
  (`ws://127.0.0.1:<preview.port>` from the capability snapshot
  `preview {enabled, port, bound}`), or the mock preview server
  (`getMockPreviewPort()`) under `shouldUseMocks()` — dev and prod dial the
  identical URL/token flow. `PREVIEW_CLOSE_UPSTREAM_DOWN = 4502` (loopback
  unreachable), `PREVIEW_CLOSE_UPSTREAM_UNAVAILABLE = 4503` (preview
  unbound/disabled). Close-code constants live once in `@ceraui/rpc/schemas`.
- **`start` frames resolve their `input_id` by STABLE IDENTITY (Todo 19a):** the
  ONE frame that is not a byte-for-byte passthrough. `streaming.start` resolves
  the persisted `config.source` through `resolveSourceRouting` →
  `resolveSourceIdentity` before dispatching, but PREVIEW had no such step —
  `PreviewCanvas` puts the applied `config.source` on its `{action:"start"}`
  frame verbatim and this proxy forwarded it unchanged. So a device that
  re-enumerated under a new node path streamed fine and would not preview.
  Confirmed live: de-authorizing the RØDE renumbered the Osmo `/dev/video3` →
  `/dev/video2`, the UI still showed it "Selected" (it matches by stable id), and
  preview answered `SourceUnavailable` **0/5**.
  `resolvePreviewStartFrame(frame, resolveInputId)` closes it at the proxy —
  the choke point EVERY preview start frame crosses, whichever client sent it —
  so the rule lives at one seam instead of in each client. The injected
  `PreviewProxyDeps.resolvePreviewInputId` defaults to the SAME
  `resolveSourceIdentity` the stream path runs, against `getSourcesMessage()` +
  `config.last_seen_devices`. **It resolves, it never rejects:** an id with no
  live stable-identity match (a TRUE unplug, or a different device that merely
  took the freed node) passes through UNCHANGED, so the engine still answers its
  own typed `source-unavailable` and the `lost` row is untouched. Do NOT
  "harden" this into a `resolveSourceRouting` call — that one refuses
  lost/unavailable sources and would replace the engine's typed reason with a
  silent drop. An unchanged id returns the ORIGINAL frame object (no
  reserialization), and anything that is not a well-formed `start` frame with a
  non-empty string `input_id` — binary access units, WebRTC signaling, `stop`,
  malformed JSON, a coarse-source start that omits `input_id` — is untouched.
  The resolver is FAIL-OPEN: any throw yields the original id. Config self-heal
  is unchanged and still persists the migration via
  `reconcileConfiguredSourceIdentity` on the `sources` broadcast.
  Coverage: `tests/source-renumber-dedup.test.ts` → "preview start — resolves to
  the CURRENT node, not the saved one" (the renumber fixture, the self-heal
  assertion, the true-unplug + wrong-device negatives, and the passthrough table).
- **Backpressure — bounded drop-oldest (Todo 14):** frames are a transparent
  passthrough BOTH ways (text control frames + binary access units). The
  downstream (browser) leg is backpressure-aware — when the client's
  `getBufferedAmount()` exceeds `PREVIEW_BACKPRESSURE_HWM_BYTES` (1 MiB) forwarding
  pauses and upstream frames are held in a BOUNDED DROP-OLDEST queue
  (`modules/ui/preview-frame-queue.ts` `BoundedDropOldestQueue`), resuming on
  `drain`. Above `PREVIEW_MAX_PENDING_FRAMES` (256) or `PREVIEW_MAX_PENDING_BYTES`
  (1 MiB) the OLDEST media frame is evicted — the queue PLATEAUS, the socket stays
  OPEN (a live-edge skip-on-lag), and the browser resumes at the freshest media,
  paired with the frontend live-edge seek policy (`preview-live-edge.ts`). This
  REPLACES the previous close-on-overflow ("NEVER drop-oldest") contract: a
  permanently-slow consumer no longer tears the preview down. The newest MSE init
  segment (codec-config text frame) is PINNED — never dropped, dequeued first — so
  the latest fragments stay decodable. Socket close frees every buffered frame
  (`freePreviewProxyState` clears the queue).
- **WebRTC signaling relay — never-dropped control lane (Todo 16, ADR-0006):** the
  preview WS ALSO carries WebRTC signaling. Server→client control frames
  (`webrtc-offer`/`webrtc-ice`/`webrtc-connected`/`webrtc-failed`/`preview-error`,
  classified by `isPreviewControlFrame`) are relayed transparently like every other
  frame, but routed into the queue's separate never-dropped CONTROL LANE
  (`BoundedDropOldestQueue` `isControl`): they are forwarded AHEAD of any queued
  media, in FIFO arrival order, and a backpressure eviction can NEVER drop a
  handshake frame (dropping an offer or ICE candidate would break the WebRTC
  session). Media still drop-oldest; the pinned MSE init still newest-wins — the
  control lane is orthogonal. WebRTC media itself rides the browser↔engine peer
  connection, NOT this WS, so a WebRTC session puts almost nothing on the WS media
  path. Client half: `apps/frontend/.../PreviewCanvas.svelte` + `preview-tier-ladder.ts`.

Coverage: `tests/preview-token.test.ts` (mint/consume/expire/single-use) +
`tests/preview-proxy.test.ts` (pipe, 4401/4502/4503, authed mint gate) +
`tests/preview-frame-queue.test.ts` (drop-oldest by count/bytes, pinned init,
never-drop control lane) + `tests/preview-proxy-bounded.test.ts` (slow-consumer
plateau, socket stays open, signaling frames survive backpressure, teardown frees
buffers).

