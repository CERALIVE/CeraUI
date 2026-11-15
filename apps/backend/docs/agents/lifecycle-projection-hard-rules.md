<!-- Moved verbatim from apps/backend/AGENTS.md on 2026-11-15 to keep it within its nested budget; full HARD RULES section as of be1b880a; the lifecycle projection rule is routed here from AGENTS.md; backticked paths stay relative to apps/backend/, as in the original manifest -->

## HARD RULES
- The update-orchestrator, recovery, D8 stream-admission, disruptive-action, OS-stage, journal and add-on helper hard rules are binding and live verbatim in [update-orchestrator-hard-rules.md](update-orchestrator-hard-rules.md); read it before touching those paths.
- The projection is what reaches the wire: seed lifecycle state from the owner at composition before hydration, without broadcast or engine-query wait. Retained protection seeds reconciling; absent/unprotected boot seeds idle. The first safe transition still broadcasts, including same-state reconciliation. Runtime evidence is bound to its producing client/epoch and invalidated at new Start/acquisition/commit; old idle cannot establish new-session idle. Preserve producer identity and schema.
- Streaming-first uplink shaping caps only shared clients; local stream egress stays uncapped. Foreign roots fail closed.
- The two NAT layers are watched, never arbitrated: diagnostics are read-only, tri-state, and never gate streaming or mutate either layer.
- Modem roster: exact triplets; RNDIS e0/01/03 admits; e0/01/01, e0/01/04 veto; ID_MM_DEVICE_IGNORE=1 excludes; weak retires, strong stays undriveable.
- Update roster uses exact package names, never prefixes; unknown names default to platform. Install only actionable entries.
- Every modem mutation uses the identity-resolved lifecycle lease; connectivity mutations arm the durable journal before writing; retain rollback.
- Capability feature gates are default-absent; absent/false is inert. Mutations use the shared gate helper and modem safety contract.
- Live capture and audio devices are never silently dropped: emit honest unavailable entries when a pipeline or route cannot honor them.
