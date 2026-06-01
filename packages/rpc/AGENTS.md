# @ceraui/rpc — Agent Knowledge Base

Parent: [`../../AGENTS.md`](../../AGENTS.md)

## OVERVIEW

Shared oRPC contract + Zod schema layer. The single source of truth for the WebSocket RPC surface between frontend and backend. Both consumers import from here — never define contracts inline.

## STRUCTURE

```
src/
├── contracts/   # oRPC oc.router() defs — auth, streaming, modems, wifi, network, system, status, notifications
│   └── index.ts # appContract root router + AppContract type
└── schemas/     # Zod v4 schemas mirroring contracts/ + common.schema.ts, relay.schema.ts
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add a new RPC procedure | `contracts/{domain}.contract.ts` → wire into `contracts/index.ts` |
| Add/change input or output shape | `schemas/{domain}.schema.ts` |
| Root router type (client inference) | `contracts/index.ts` → `AppContract` |
| New domain (e.g. `audio`) | New `audio.contract.ts` + `audio.schema.ts`, add to `appContract` router |

## IMPORT PATHS

```typescript
import { appContract, type AppContract } from '@ceraui/rpc';           // root router
import { streamingContract } from '@ceraui/rpc/contracts';             // granular
import { loginInputSchema } from '@ceraui/rpc/schemas';                // validation
```

## CONVENTIONS

- Contracts use `@orpc/contract` (`oc.*`). No runtime logic here — contracts are pure type/schema declarations.
- Schemas use Zod v4 (`zod@^4`). Import from `zod`, not `zod/v4`.
- One contract file per domain. One schema file per domain. Names must match (`streaming.contract.ts` ↔ `streaming.schema.ts`).
- `appContract` in `contracts/index.ts` is the only router — don't create sub-routers elsewhere.

## ANTI-PATTERNS

- Don't import `@ceraui/rpc` from within this package itself — circular.
- Don't add runtime handlers here. Handlers live in `apps/backend/src/`.
- Don't duplicate schema definitions in `apps/` — always import from this package.
- Don't use Zod v3 APIs (`z.string().nonempty()` etc.) — project is on Zod v4.
