<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

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

