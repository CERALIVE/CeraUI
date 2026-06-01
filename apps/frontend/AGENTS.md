# CeraUI Frontend — Agent Knowledge Base

Parent: [`../../AGENTS.md`](../../AGENTS.md)

## ROLE

Svelte 5 PWA. Talks to the backend exclusively via WebSocket RPC — no REST, no direct hardware access.

## STRUCTURE

```
src/
├── main.ts / App.svelte      # entry: initRPC(), auth gate, Layout
├── main/tabs/                # Streaming, Network, General, Advanced, DevTools
├── lib/rpc/                  # RPCClient + TypedRPC + subscriptions.svelte.ts
├── lib/stores/               # runes stores (*.svelte.ts)
├── lib/components/ui/        # shadcn-svelte primitives (bits-ui)
├── lib/components/streaming/ # StreamingStateManager, ConfigService, Validation
└── lib/env/ lib/helpers/ lib/config/ lib/types/
```

## RPC PATTERN

```ts
import { rpc, rpcClient } from '$lib/rpc';
await rpc.streaming.start(config);          // typed via TypedRPC in client.ts
rpcClient.onMessage((type, data) => { }); // raw push events
```

New procedures: add to `@ceraui/rpc` schemas first, then extend `TypedRPC` in `client.ts`.

## COMMANDS

```bash
pnpm dev / build / check / test / lint   # Vite :5173 / dist/ / svelte-check / vitest / ESLint
```

## CONVENTIONS

- Stores: Svelte 5 runes only (`$state`, `$derived`, `$effect`) — files named `*.svelte.ts`.
- UI primitives: extend via shadcn-svelte CLI, not by hand.
- Mock scenarios: `MOCK_SCENARIO` env var. Runtime switching via `rpc.streaming.setMockHardware`.
- Design: read `../../.impeccable.md` before touching visuals.
- i18n: `@ceraui/i18n` workspace package — all user strings via `LL.*`.

## ANTI-PATTERNS

- No direct backend calls — everything through `rpc.*` or `rpcClient.onMessage`.
- No manual UI primitive files — use `pnpm dlx shadcn-svelte@latest add <component>`.
- No `$:` reactive statements — Svelte 5 runes only.
- No hardcoded socket URL — use `ENV_VARIABLES` from `$lib/env`.