<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## CONVENTIONS

- Runtime: Bun only. No Node-specific APIs (`fs/promises` ok; `node:cluster` not).
- Build: `bun build --compile --minify --sourcemap --target=bun-linux-{arm64|amd64}` — single binary, no runtime on device. `--sourcemap` is deliberate and EMBEDDED in the binary (device stack traces stay symbolicated); the frontend's maps follow the opposite policy — emitted `hidden` and relocated out of the packaged tree, see `apps/frontend/vite.sourcemaps.ts`. **There is no `--bytecode`, and it cannot be added as a flag**: `bun build --bytecode` forces `--format=cjs`, and `main.ts`'s boot ladder is 20 top-level `await`s (`runCritical`/`guardNonCritical` phases), so the build fails outright. Adopting it means restructuring boot away from top-level await first.
- Tests: `bun test` (not vitest). Files in `src/tests/`.
- Config files (`config.json`, `setup.json`, `auth_tokens.json`) read/written from working dir — path-sensitive in production.
- `MOCK_SCENARIO` env activates mock providers. Scenarios: `single-modem`, `streaming-active`, `multi-modem-wifi` (default dev), `modem-pin-locked` (2 modems, modem 0 SIM PIN-locked, fixture PIN `0000` — the `unlockSim`/`unlockSimPuk` RPCs route to the mock SIM state machine). Three additional scenario-seeded capability scenarios: `caps-full`, `engine-starting`, `engine-unavailable` (T5).
- Frontend dependency `bits-ui` is at v2.19.0 (frontend concern only; backend has no direct bits-ui dep).
- Use `shouldUseMocks()` — never raw `isDevelopment()` — to gate mock-hardware paths. `shouldUseMocks()` requires both `isDevelopment()` AND `mockState.initialized`.
- **Frontend store-ownership mirror [EXISTS]:** the frontend's legacy `websocket-store.svelte.ts` wrapper is deleted; `rpc/procedures/auth.procedure.ts` (`auth.login`/`auth.setPassword`/`auth.logout`) is now called exclusively through the frontend's `lib/stores/auth-status.svelte.ts` (`authenticate`/`createPassword`), and every other push event is consumed exclusively through `lib/rpc/subscriptions.svelte.ts`'s single `rpcClient.onMessage` handler. Don't casually rename/reshape these procedure signatures or add a second push-consumption path on the frontend side — see `apps/frontend/AGENTS.md` → CONVENTIONS (store ownership).

