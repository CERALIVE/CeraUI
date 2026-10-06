<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## OVERVIEW

Shared oRPC contract + Zod schema layer. The single source of truth for the WebSocket RPC surface between frontend and backend. Both consumers import from here — never define contracts inline.

Update-system foundation [PARTIAL]: `schemas/update-settings.schema.ts` owns
the persisted/default and strict complete mutation shapes; `schemas/update-capabilities.schema.ts`
owns the image-file validator and the `{mode,features}` RPC output.
`contracts/system.contract.ts` registers get/set settings and get capabilities.
No backend-local wire types or alternate schemas may shadow them.
A schema-1 orchestrator record can carry optional `osStageDiscoveryRetryAt`:
the proven legacy OS failure's delayed permission before an exact candidate
exists. Discovery consumes it into `osStageRecovery`, never into a second
backend-owned shape. Older records gain no default field. An unsafe recovery
record cannot name the known package/X6 reasons
`apt-exit-nonzero`, `commit_unit_absent_on_resume` or `commit_resume_inconclusive`.
Generic terminal OS errors remain valid persisted data; the exported
`OS_STAGE_CONFIRMABLE_UNSAFE_REASONS` restricts confirmation to the two
positively identified unsafe OS outcomes, independently of schema validation.
State-level validation also binds active attempts to staging/publication, forbids
active retry deadlines and operator/unsafe deadlines, and permits unsafe policy
only in a matching terminal failure. Invalid present recovery is not first boot:
the backend preserves the original file and any valid legacy terminal reason,
closing update work until maintenance repairs the metadata. Absent recovery
retains the original schema-1/package resume behaviour.
The persistence-only recovery record additionally carries optional `attemptId`.
It is the validated historical OS job UUID, retained when `activeAttemptId` becomes null;
an invalid present UUID takes the backend's existing fail-closed recovery-load path.
while active, both identities must agree. Legacy records gain no default identity.
Neither `updateOrchestratorWireStateSchema` nor any RPC output includes this
record, so this extension changes no frontend wire type or locale vocabulary.
An image with no `apt-all-packages` feature is still legacy, and a `capable`
result never implies OS or slot-sync support without those explicit features.
Todo 35 adds optional `version` and `origin` to `updatePackageSchema` for
origin-vetted APT discovery; legacy frames omit both and parse unchanged.
`contracts/ui.contract.ts` adds authenticated `ui.heartbeat` using the existing
shared `successResponseSchema`; it carries no timestamp or new producer-owned
wire shape. The backend stamps receive time, not a client-supplied clock.

