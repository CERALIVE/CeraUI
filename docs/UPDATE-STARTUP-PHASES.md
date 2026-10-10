# Persisted update phases at startup [EXISTS — host-proven, board replay owed]

H9 restart policy, 2026-10-02. Physical reconciliation completes before one
orchestrator startup flight: a six-attempt burst, then one unreferenced 30-second
retry at a time for transient failures only, with mutation readiness closed.
The CONTROL-protected tail commits its
result before mutation readiness opens. Invalid present metadata remains
maintenance-blocked independently of this table.

| Phase | H8 startup action | Restart wedge? | H9 action |
|---|---|---|---|
| idle | Resume unchanged; inspect mirror eligibility | No unowned wedge | Unchanged |
| checking | **NOTHING**; retain checking, tick has no branch | **Yes: Check/Install busy forever** | Normalize to idle, both discovery deadlines due; preserve success/failure history and recovery |
| available | Resume unchanged; ordinary tick/operator discovery/install | No | Unchanged |
| downloading | Protected unit-observation/absence/deferred resume | Uncertainty deliberately stays closed; not an unowned wedge | Unchanged, downloading body frozen |
| awaiting-idle | Resume unchanged; tick/install can launch | Waiting for idle/explicit install is policy | Unchanged |
| committing | Reattach observed unit/result; fail-closed if unresolved | Sticky unresolved commit is intentional X6/maintenance policy | Unchanged |
| restarting-services | Resume unchanged; tick reconciles stale services | Idle/transaction gate owns deferral | Unchanged |
| settled | Resume unchanged; next tick acknowledges to idle | No | Unchanged |
| os-available | Resume unchanged; tick lazily rediscover/stage or wait for retry/operator | Recovery policy owns deferral | Unchanged |
| os-staging | Witness settlement if qualified; otherwise next tick observes interrupted writer | Missing quiescence is intentional fail-closed, not proof of an unlaunched attempt | H11: exact durable `publishing` intent plus independent physical absence/quiescence restores the pre-state before readiness; otherwise witness/interrupted settlement unchanged |
| os-staged | Resume unchanged; tick arms only after producer settlement/readiness | Retained producer identity is intentional closure | Unchanged |
| os-activation-armed | Reconcile receipt/current boot/activation evidence | Missing evidence remains closed; no guessed activation | Unchanged |
| os-verifying | Frozen C1 this-boot healthcheck/version verification | Missing health record can wait indefinitely by policy | Unchanged |
| sync-eligible | Start mirror if gate positive, otherwise skip to idle | No | Unchanged |
| syncing | Resume unchanged; tick polls unit/receipt/target | Positive-evidence/queued-start boundary owns deferral or failure | Unchanged |
| synced | Resume unchanged; next tick acknowledges to idle | No | Unchanged |
| quarantined | Resume unchanged; no automatic clearance | Terminal policy, not an unowned transient | Unchanged |
| failed | Witness settlement/exact legacy migration only; otherwise retained | Terminal/unsafe evidence policy, not an unowned transient | Unchanged; durability replay cannot redispatch |

Only `checking` is normalized. Its check kind is not persisted, so both clocks
become due. `lastAttemptAt`, `lastSuccessAt`, failure counts, rate-limit history,
failure reason, cellular grant and recovery metadata remain unchanged. Ordinary
automation/cellular gates still decide whether the following tick may check.
There is no synthetic check failure, terminal reset or transaction replay.

Coverage: `update-orchestrator-startup-discovery.test.ts` enumerates all 18
normalizer arms and all 18 real runtime loads, plus package/OS interrupted Check
and a next-tick rediscovery. Downloading/X6/C1 and state-generation bodies retain
their separately frozen comparisons. Real board restart/storage behavior remains
for the integrated delta rehearsal.

H11 pre-effect publication recovery, 2026-10-02, is not phase normalization.
The private attempt intent must match the whole staging snapshot and its derived
candidate/attempt/baseline transition. Launching intent or no intent cannot authorize
restoration from `os-staging`; both retain the existing unknown-outcome owner.
Corrupt, foreign, mismatched or unreadable authority stays closed. An intent over
its exact already-restored baseline replays durable cleanup only. See the
[recovery contract](UPDATE-RECOVERY.md#durable-os-attempt-intent-partial--host-crash-point-proof-board-power-loss-proof-owed).

Round 2 lifecycle qualification, 2026-10-03: a valid stale `launching` intent
over absent/superseding attempt metadata is retired under CONTROL only after
job/witness/guardian absence and fresh state/intent identity; it never restores
the earlier baseline. Corrupt or unreadable files retain closed readiness.
Retirement failure cannot replace a producer outcome or escape a scheduler tick;
its separate cleanup latch is repaired before admission can open. Same-attempt
active launching still belongs to interrupted settlement, and already-counted
settlement retires lazily without recounting. Startup boot bodies are unchanged.
