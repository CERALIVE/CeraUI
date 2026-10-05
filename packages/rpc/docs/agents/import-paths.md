<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## IMPORT PATHS

`status.schema.ts` imports `sessionSwitchTargetSchema` and re-exports
`SessionSwitchTarget` from the producer's browser-safe `dist/session-switch.js`.
The additive optional `active_encode.switch_targets` is session state, not discovery.
Both consumers pin published 2026.9.11/schema 0.21.0. The roster keeps the producer's
`input_id`/`kind` and optional source-mode fields; no local availability or label wire field is invented.
See [contract](../../../../docs/LIVE-SESSION-SWITCHING.md).

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

```typescript
import { appContract, type AppContract } from '@ceraui/rpc';           // root router
import { streamingContract } from '@ceraui/rpc/contracts';             // granular
import { loginInputSchema } from '@ceraui/rpc/schemas';                // validation
```

