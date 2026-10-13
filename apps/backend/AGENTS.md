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
- Every bounded runner shares `bounded-spawn.ts` termination ordering: our timeout/abort before exit is failure even when TERM exits zero. Keep genuine zero observed before termination; preserve partial output and RunTimeoutError/RunAbortError. Add-on validation timeout auto-disables with `addon_validation_failed`, never enables.
- OS-stage refusal logs retain closed first-failure provenance separately from final settlement/startup proof. Context is bounded, message/path/PID/argv-free and in-memory/log-only; never persist it or use it as authority. Contract: UPDATE-RECOVERY.md → Self-describing stage refusals.
- Stored authority uses the shared anchored/no-follow/nonblocking bounded read and fatal UTF-8/raw duplicate-member boundary. Unit properties use the shared strict parser and not-found consistency rule. Diagnostic getter faults must never replace the original throw. Contract: UPDATE-RECOVERY.md → Strict stored authority.
- Unknown capability authority is never legacy: only genuine absence or a valid declaration selects an install regime. Refuse refresh/discovery/install with existing typed reasons, preserve bytes and re-read after repair. Terminal package completion needs present whole-string bounded exit properties and coherent lifecycle; unknown never grants cleanup. Repeated identity sections/keys refuse, never first-match. Contract: UPDATE-RECOVERY.md → Capability regime and terminal package evidence.
- Only OS metadata permits the exact `/etc/os-release` link to `/usr/lib/os-release`; its fixed target still uses the strict reader. Present invalid idle evidence is `activity-unknown`, never cached idle. Mixed config safety fields, setup, modem journal/FCC opt-in, auth tokens, add-on descriptors and shaper ownership cannot use preference defaults as authority. Contract: UPDATE-RECOVERY.md → Metadata and idle boundaries.
- An unknown read of an OPTIONAL record never aborts boot, wedges or seeds a write (required `setup.json` retries transient faults ~3 s in-process, then exits typed for systemd `Restart=always`; damaged `setup.json` aborts). Damaged records are archived (`helpers/persistent-record.ts`, digest-named, unpublished temps removed on every failure, a published copy is reused) before an allowed replacement; unavailable ones are never written over. Retry owners: config boot (`modules/config-boot.ts`), the modem barrier (`modems/mutation-recovery-owner.ts`, read-only after replay, strict inventory at block publication, disarmed on shutdown), the shaper's pending-application flag (cleared only by a successful apply), the per-operation token/FCC rereads, and the legacy-token prune timer (non-fatal, capped retry, stopped on shutdown). Remembered password login on damaged/unavailable `auth_tokens.json` is temporary and writes nothing (D209); only password change/revoke-all replaces it. KNOWN, PRE-EXISTING, OWNER DECISION: a zero-byte/unparseable `config.json` with no salvageable `password_hash` resets to first run and ANY LAN client can claim the device with `set_password`, exactly as at merge-base 23bcf379. Contract: `../../docs/UPDATE-RECOVERY.md` → Unknown optional-record reads: no boot abort, no wedge, no write baseline.
- Stream admission is cancellable before the D8 await. Stop disarms restoration intent immediately; OTA physical-liveness protection survives parked/failed/unknown stops until confirmed idle/cleanup, including reconciliation. Subprocess termination-induced zero exits never become success or positive CLI evidence.
- Stream-session projection is atomic with its ownership/transition guard. Submitted cleanup stays single-flight after caller timeout; reconciliation cannot admit a launch through it. Unknown launch cleanup/socket loss retains generation, OTA protection and last confirmed live status. Contract: `../../docs/START-LIFECYCLE.md` → Session ownership state machine; bounded subprocess drainage/retirement lives in `src/helpers/bounded-spawn.ts`.
- OS-stage enumerated process reads share scope-explicit ENOENT/ESRCH absence; never invent identity or keep a cached vanished member. Other errors/malformed identity stay unknown. ESRCH never proves cgroup, marker or block-resource absence; guardian disappearance requires fresh proof. Successful empty content is not a disappearance errno; preserve and report its content-classification limits in UPDATE-RECOVERY.md.
- The projection is what reaches the wire: preserve producer identity and schema; internal evidence must not invent operator-facing claims.
- Update outcomes need their own positive evidence: package success is not restart completion; activation-request submission is not a verified running OS. Present unreadable/invalid channel overrides refuse discovery, never fall back. Transport cost/history unknown stays unknown. See `../../docs/DEVICE-UPDATES.md` → Outcome evidence.
- Flow-sticky shared-client steering affects only forwarded client-zone traffic; preserve physical-identity marks and established flows.
- Streaming-first uplink shaping caps only shared clients; local stream egress stays uncapped. Foreign roots fail closed.
- The two NAT layers are watched, never arbitrated: diagnostics are read-only, tri-state, and never gate streaming or mutate either layer.
- Host-uplink family success survives joined sibling faults; unsuccessful unbound faults stay UNKNOWN and cannot abort candidate election or authorize release. See `../../docs/HOST-UPLINK-ELECTION.md`.
- Reboot, power-off, SSH mutations and remote reboot/factory-reset go through `disruptive-action-gate.ts`: run only on confirmed idle stream liveness and no interruptible update work; unknown refuses, a remote confirm re-reads the gate and a nonzero exit answers `ok:false`. Read liveness via `stream-liveness-source.ts`, never `getIsStreaming()` alone. Contract: `../../docs/START-LIFECYCLE.md` → Disruptive-action gate.
- Modem roster: exact triplets; RNDIS e0/01/03 admits; e0/01/01, e0/01/04 veto; ID_MM_DEVICE_IGNORE=1 excludes; weak retires, strong stays undriveable.
- Update roster uses exact package names, never prefixes; unknown names default to platform. Install only actionable entries.
- OS stage extras defer only under bounded fresh proof, never a helper whitelist or cached recovery grant. Retain CONTROL/private/guardian authority and the settled pair's absolute monotonic deadline through retry/release; bound every proof await and invalidate expired captures. Final observation follows awaited preparation; dispatch has only synchronous checks afterward. Positive CLI exit survives cancellation/output drainage and exact runtime/D8 settlement preserves terminal unpublished-success unsafe, never restage. Startup/orphan use the same strict proof seam. Contract and remaining board gates: `../../docs/UPDATE-RECOVERY.md`.
- OS receipt cleanup requires persisted CONTROL authority, read-time file identity and positive installed-image binding; legacy/unknown evidence KEEP. Cooperative production writers hold CONTROL: commitStagedManifest via stage callback, rebindStagedReceipt via runtime reconciliation, retry via leased stage entry. Low-level saveStagedManifest requires no lease. Root/image helper --arm/--stop uses its own activation flock, not CONTROL; ExecStop must stay CONTROL-independent. Re-probe the marker after final authority without claiming privileged exclusion. Cache successful tombstone acknowledgement by full identity for this process only; failure/change/restart requires retry. Unlaunched settlement may ignore only an unchanged recorded baseline, never launched/new/unknown outcomes. See the update-orchestrator contract and UPDATE-RECOVERY.md for accepted D154 residuals and bench rollback compatibility.
- Every modem mutation uses the identity-resolved lifecycle lease; connectivity mutations arm the durable journal before writing; retain rollback.
- OS staging's observer-internal final census follows optional diagnostics; drift returns no snapshot. Only its closed census-drift diagnostic permits bounded re-observation under the same authority/deadline, and only with valid non-census predicates; concurrent Operation/health/boot/slot faults stay terminal. Positive CLI success vetoes transfer retry. Carry one remaining deadline through outer ports and physical release, fencing late mutation callbacks. The non-atomic dispatch gap and inherited size exceptions are explicit in UPDATE-RECOVERY.md; never claim uniform size compliance or test type coverage from the normal backend check.
- Retained-pin drainage uses the reconciler's active deadline and CONTROL fence, not the expired producer deadline. Retained capture is read-only; ownership preparation precedes the final physical observation and synchronous release checks.
- OS routing teardown and reconciliation sweep pass their remaining budget through every command submission. Quiet startup's no-job/no-directory fallback uses one 10-second CONTROL/producer-fenced budget, checked again before admission opens. Timeout retains unresolved ownership; no late query can initiate a deletion or flush after its generation/CONTROL fence closes. Ordinary routing callers keep their existing teardown and per-command timeout semantics.
- Orphan unit/token/file inspection lives in `os-stage-orphan-inspection.ts`; `os-stage-orphan.ts` owns its bounded settlement lifetime. Keep both under the module-size ceiling.
- Capability feature gates are default-absent; absent/false is inert. Mutations use the shared gate helper and modem safety contract.
- Live capture and audio devices are never silently dropped: emit honest unavailable entries when a pipeline or route cannot honor them.
