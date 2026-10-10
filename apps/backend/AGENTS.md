# CeraUI Backend — Agent Routing

Parent: [workspace rules](https://github.com/CERALIVE/ceralive/blob/master/AGENTS.md); [CeraUI rules](../../AGENTS.md).

## ROLE
Bun/TypeScript device HTTP + WebSocket control plane. Serves the frontend,
exposes oRPC, and drives cerastream and the SRTLA sender through their bindings.
The engine owns capture identity; the backend preserves and projects it.

## STRUCTURE
- `src/` — entrypoint, domain modules, RPC, helpers, mocks and tests.
- `scripts/` — backend guards and bench harnesses.
- `docs/` — preserved backend subsystem contracts.

## COMMANDS
From the checkout root: `bun run --filter backend check`, `bun run lint`,
`bun run --filter backend test`, `bun run build:backend`.
Full PR gate: `bun run test`, `bun run test:e2e`, `bun run check:tech-debt`,
`bun run build` (see parent rules and CI; reader sweep precedes the gate).

## WHERE TO LOOK
| Code path or task | Contract |
|---|---|
| Before changing anything else here, open docs/agents/README.md and read the contract for the subsystem you touch | [All backend contracts](docs/agents/README.md) |
| Projection and modem roster | [an-isolated-dongle-is-surfaced-without-entering-the-bond.md](docs/agents/an-isolated-dongle-is-surfaced-without-entering-the-bond.md) |
| Cellular composition and wire projection | [the-cellular-subsystem-one-composition-root-one-wire.md](docs/agents/the-cellular-subsystem-one-composition-root-one-wire.md) |
| Modem presence and exact-identity admission | [a-device-is-announced-before-any-modem-service-can-descri.md](docs/agents/a-device-is-announced-before-any-modem-service-can-descri.md) |
| Modem mutation leases, journal and rollback | [the-modem-mutation-safety-contract.md](docs/agents/the-modem-mutation-safety-contract.md) |
| Modem feature gates | [the-capability-feature-gate-framework.md](docs/agents/the-capability-feature-gate-framework.md) |
| Shared-client flow-sticky steering | [flow-sticky-shared-client-steering.md](docs/agents/flow-sticky-shared-client-steering.md) |
| Streaming-first shaping and read-only NAT diagnostics | [streaming-first-uplink-shaping.md](docs/agents/streaming-first-uplink-shaping.md) |
| Exact-name update roster and installation | [software-update-start-contract.md](docs/agents/software-update-start-contract.md) |
| Update discovery and actionable entries | [software-update-check-contract.md](docs/agents/software-update-check-contract.md) |
| Update orchestrator, D8, OS staging and slot mirroring | [the-update-orchestrator-and-d8-admission.md](docs/agents/the-update-orchestrator-and-d8-admission.md) |
| Streaming RPC and lifecycle | [streaming-rpc-procedures.md](docs/agents/streaming-rpc-procedures.md) |
| Live capture and audio visibility | [a-live-capture-device-is-never-silently-dropped.md](docs/agents/a-live-capture-device-is-never-silently-dropped.md) |
| Audio identity and naming | [audio-device-naming.md](docs/agents/audio-device-naming.md) |
| Audio backend override | [the-audio-backend-is-an-override-and-absent-is-not-a-defa.md](docs/agents/the-audio-backend-is-an-override-and-absent-is-not-a-defa.md) |
| Preview origin and auth | [preview-websocket-proxy-single-origin-task-20.md](docs/agents/preview-websocket-proxy-single-origin-task-20.md) |
| Engine IPC ownership | [streaming-engine-seam.md](docs/agents/streaming-engine-seam.md) |
| Hotplug and cleanup | [sigusr2-udev-hotplug-hook.md](docs/agents/sigusr2-udev-hotplug-hook.md) |
| Wi-Fi mutation locking | [every-wifi-mutation-shares-one-adapter-lock.md](docs/agents/every-wifi-mutation-shares-one-adapter-lock.md) |
| Notifications and scoped retraction | [a-persistent-notification-must-be-retractable.md](docs/agents/a-persistent-notification-must-be-retractable.md) |
| Test fixtures and forbidden patterns | [anti-patterns.md](docs/agents/anti-patterns.md) |
| Start failures and operator diagnostics | [start-failure-diagnostics.md](docs/agents/start-failure-diagnostics.md) |

## HARD RULES
- The projection is what reaches the wire: preserve producer identity and schema; internal evidence must not invent operator-facing claims.
- Flow-sticky shared-client steering affects only forwarded client-zone traffic; preserve physical-identity marks and established flows.
- Streaming-first uplink shaping caps only shared clients; local stream egress stays uncapped. Foreign roots fail closed.
- The two NAT layers are watched, never arbitrated: diagnostics are read-only, tri-state, and never gate streaming or mutate either layer.
- Host-uplink family success survives joined sibling faults; unsuccessful unbound faults stay UNKNOWN and cannot abort candidate election or authorize release. See `../../docs/HOST-UPLINK-ELECTION.md`.
- Modem roster: exact triplets; RNDIS e0/01/03 admits; e0/01/01, e0/01/04 veto; ID_MM_DEVICE_IGNORE=1 excludes; weak retires, strong stays undriveable.
- Update roster uses exact package names, never prefixes; unknown names default to platform. Install only actionable entries.
- OS stage extras defer only under bounded fresh proof, never a helper whitelist or cached recovery grant. Retain CONTROL/private/guardian authority and the settled pair's absolute monotonic deadline through retry/release; bound every proof await and invalidate expired captures. Final observation follows awaited preparation; dispatch has only synchronous checks afterward. Positive CLI exit survives cancellation/output drainage and exact runtime/D8 settlement preserves terminal unpublished-success unsafe, never restage. Startup/orphan use the same strict proof seam. Contract and remaining board gates: `../../docs/UPDATE-RECOVERY.md`.
- OS receipt cleanup requires persisted CONTROL authority, read-time file identity and positive installed-image binding; legacy/unknown evidence KEEP. Cooperative production writers hold CONTROL: commitStagedManifest via stage callback, rebindStagedReceipt via runtime reconciliation, retry via leased stage entry. Low-level saveStagedManifest requires no lease. Root/image helper --arm/--stop uses its own activation flock, not CONTROL; ExecStop must stay CONTROL-independent. Re-probe the marker after final authority without claiming privileged exclusion. Cache successful tombstone acknowledgement by full identity for this process only; failure/change/restart requires retry. Unlaunched settlement may ignore only an unchanged recorded baseline, never launched/new/unknown outcomes. See the update-orchestrator contract and UPDATE-RECOVERY.md for accepted D154 residuals and bench rollback compatibility.
- Every modem mutation uses the identity-resolved lifecycle lease; connectivity mutations arm the durable journal before writing; retain rollback.
- OS staging's observer-internal final census follows optional diagnostics; drift refuses. Positive CLI success vetoes transfer retry. Carry one remaining deadline through outer ports and physical release, fencing late mutation callbacks. The non-atomic synchronous dispatch gap and inherited size exceptions are explicit in UPDATE-RECOVERY.md; never claim uniform size compliance or test type coverage from the normal backend check.
- Capability feature gates are default-absent; absent/false is inert. Mutations use the shared gate helper and modem safety contract.
- Live capture and audio devices are never silently dropped: emit honest unavailable entries when a pipeline or route cannot honor them.
