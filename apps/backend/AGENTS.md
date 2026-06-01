# CeraUI Backend — Agent Knowledge Base

Parent: [`../../AGENTS.md`](../../AGENTS.md)

## OVERVIEW

Bun/TypeScript HTTP + WebSocket server. Serves the frontend static bundle, exposes all device control via oRPC over WebSocket, and drives `ceracoder` + `srtla` via `link:` bindings.

## STRUCTURE

`src/main.ts` — entry. `src/modules/` — domain logic (no RPC awareness): `streaming/` (ceracoder + srtla consumers), `modems/` (mmcli), `network/`, `wifi/`, `system/`, `ui/` (HTTP + WS servers, auth), `ingest/`, `remote/`, `config.ts`, `setup.ts`. `src/rpc/` — oRPC layer: `router.ts`, `procedures/<domain>.procedure.ts`, `middleware/`, `events.ts`. `src/helpers/` — pure utils. `src/mocks/` — MOCK_SCENARIO providers. `src/tests/` — bun:test.

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add/change an RPC procedure | `rpc/procedures/<domain>.procedure.ts` + `rpc/router.ts` |
| ceracoder binding calls | `modules/streaming/ceracoder.ts` |
| srtla binding calls (flux — check `../../../srtla/AGENTS.md` first) | `modules/streaming/srtla.ts` |
| WebSocket server wiring | `modules/ui/websocket-server.ts` + `rpc/server.ts` |
| Auth token logic | `modules/ui/auth.ts` + `rpc/middleware/auth.middleware.ts` |
| Mock hardware data | `mocks/providers/` |
| Shared RPC schema types | `../../../packages/rpc/` (`@ceraui/rpc`) |

## CONVENTIONS

- Runtime: Bun only. No Node-specific APIs (`fs/promises` ok; `node:cluster` not).
- Build: `bun build --compile --minify --bytecode --target=bun-linux-{arm64|amd64}` — single binary, no runtime on device.
- Tests: `bun test` (not vitest). Files in `src/tests/`.
- Config files (`config.json`, `setup.json`, `auth_tokens.json`) read/written from working dir — path-sensitive in production.
- `MOCK_SCENARIO` env activates mock providers. Scenarios: `single-modem`, `streaming-active`, `multi-modem-wifi` (default dev).

## ANTI-PATTERNS

- Don't import from `@ceralive/srtla` without checking upstream merge status — binding API is in flux.
- Don't add HTTP REST endpoints — all device control goes through oRPC over WebSocket.
- Don't use `process.exit` directly — use `invariant` from `helpers/invariant.ts`.
- Don't read config files with raw `fs` — use `helpers/config-loader.ts`.
