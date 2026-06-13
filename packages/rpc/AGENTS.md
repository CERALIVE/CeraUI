# @ceraui/rpc — Agent Knowledge Base

Parent: [`../../AGENTS.md`](../../AGENTS.md)

## OVERVIEW

Shared oRPC contract + Zod schema layer. The single source of truth for the WebSocket RPC surface between frontend and backend. Both consumers import from here — never define contracts inline.

## STRUCTURE

```
src/
├── contracts/     # oRPC oc.router() defs — auth, streaming, modems, wifi, network, system, status, notifications
│   └── index.ts   # appContract root router + AppContract type
├── schemas/       # Zod v4 schemas mirroring contracts/ + common.schema.ts, relay.schema.ts
└── capabilities/  # pure, browser-safe capability-intersection helpers (intersectCaps)
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add a new RPC procedure | `contracts/{domain}.contract.ts` → wire into `contracts/index.ts` |
| Add/change input or output shape | `schemas/{domain}.schema.ts` |
| Effective caps for a platform/source/mode | `capabilities/intersect-caps.ts` → `intersectCaps()` (pure) |
| Root router type (client inference) | `contracts/index.ts` → `AppContract` |
| New domain (e.g. `audio`) | New `audio.contract.ts` + `audio.schema.ts`, add to `appContract` router |

## IMPORT PATHS

```typescript
import { appContract, type AppContract } from '@ceraui/rpc';           // root router
import { streamingContract } from '@ceraui/rpc/contracts';             // granular
import { loginInputSchema } from '@ceraui/rpc/schemas';                // validation
```

## DEVICE-TOKEN CLAIM CONTRACT (canonical, single source)

`src/schemas/pairing.schema.ts` → `deviceTokenClaimsSchema` (Zod) + `DeviceTokenClaims` (inferred type) is the **single source of truth** for the PASETO v4.public device-token payload (ADR-0006). Both consumers reference these exact field names — no divergent duplicate definition:

- Device: `apps/backend/src/modules/pairing/device-token.ts` (mint/verify stub) imports the schema.
- Platform: `ceralive-platform/apps/api/lib/claim.ts` references it by name in `issueDeviceToken`'s TODO (cross-repo, not a build dep).

Canonical claims (field names fixed by the ADR-0006 claim table — snake_case `device_id`, `sub_status`, **not** `deviceId`/`sub`):

| Claim | Type | Required | Source |
|-------|------|----------|--------|
| `device_id` | string | yes | device serial → `DeviceConnection.serialNumber` |
| `sub_status` | `SUBSCRIPTION_STATUSES` enum | yes | platform `Billing.status` at issuance |
| `iat` | int (epoch s) | yes | platform clock — issued-at |
| `exp` | int (epoch s) | yes | platform clock — expiry; channel rejects expired |
| `tenantId` | string | no | platform-issued binding (absent on device stub) |
| `serial` | string | no | platform-issued binding (absent on device stub) |

`tenantId`/`serial` are optional because the device-side stub mints a token before tenant binding; the platform-issued (real) token carries all six. When changing this contract, update the ADR-0006 claim table, both consumers above, and this section in the same change (Rule A).

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
