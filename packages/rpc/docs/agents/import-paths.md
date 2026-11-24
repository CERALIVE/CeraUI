<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## IMPORT PATHS

RPC package modules are side-effect-free: they export schemas, contracts and
helpers, but must not register handlers or mutate shared state at import time.
This lets the SPA drop unused procedure contracts and validators without
changing the wire schema or the package's import paths.

`status.schema.ts` imports `sessionSwitchTargetSchema` and re-exports
`SessionSwitchTarget` from the producer's browser-safe `dist/session-switch.js`.
The additive optional `active_encode.switch_targets` is session state, not discovery.
Both consumers pin published 2026.11.1/schema 0.23.0. The roster keeps the producer's
`input_id`/`kind` and optional source-mode fields; no local availability or label wire field is invented.
See [contract](../../../../docs/LIVE-SESSION-SWITCHING.md).

The capabilities message reuses the producer's `encoderCapsSchema`, including
optional `default_codec`. The RPC status projection adds optional `route_reason`
to its existing active-encode shape in `status.schema.ts`.

### Portal credential verification [EXISTS]

`modemCredentialsOutputSchema.verification` is additive-optional, with
`verified`, `admin_unreachable`, and `credentials_rejected`. The existing
credential refusal enum is unchanged; unsupported profiles and lockouts retain
their distinct legacy errors. No credential material is returned. Legacy replies
gain no default field. Both consumers import the inferred types from this package.

### Media block load [EXISTS]

`system.schema.ts` retains `encoderLoadSchema` and the original three-state
core union. Its optional `blocks` array uses `media-load.schema.ts`:
`{source, block, cores: [{core, load, utilization, sessions}]}`. MPP blocks
are `rkvenc`/`rkvdec`/`jpgdec`; the `rkrga` source can describe only `rga`,
with `utilization: null` and `sessions: null` enforced by its schema. Both raw
MPP percentages may exceed 100; the legacy `percent` view is not widened.
`MppSessionOwner` carries only the creating task's `pid` and driver `index`.
All fields inside a block core are explicit, and no field defaults onto a
legacy payload. Consumers replace snapshots, not merge owners by ordinal.
See [`docs/ENCODER-LOAD.md`](../../../../docs/ENCODER-LOAD.md).

### Event registry entry point [EXISTS]

`@ceraui/rpc/events` resolves to `src/schemas/events.schema.ts`
(`package.json:21`) and exports `EVENT_REGISTRY`. `src/schemas/index.ts`
re-exports `src/schemas/events-wire.schema.ts` (line 15), not
`src/schemas/events.schema.ts`.
Rule: boot-time frontend code imports `@ceraui/rpc/schemas`, not
`@ceraui/rpc/events`. No bundle measurement backs this section. See
[device-events-wire.md](device-events-wire.md).

### Package update progress hold [EXISTS]

`@ceraui/rpc/package-progress` resolves to `src/package-progress.ts` and
exports `holdUpdateProgress`, the one rule for what a running package
transaction shows: its phase never moves back and, within a phase, neither
does APT's number. The backend monitor, the update overlay and the Settings
packages section all apply it. See
[Package update progress](../../../../docs/DEVICE-UPDATES.md#package-update-progress).

```typescript
import { appContract, type AppContract } from '@ceraui/rpc';           // root router
import { streamingContract } from '@ceraui/rpc/contracts';             // granular
import { loginInputSchema } from '@ceraui/rpc/schemas';                // validation
import { EVENT_REGISTRY } from '@ceraui/rpc/events';                  // event registry; not for boot-time code
import { holdUpdateProgress } from '@ceraui/rpc/package-progress';    // running package progress never moves back
```

