# Update fixture ownership

Update tests exercise the production dependency ports explicitly. Runtime
fixtures that reach startup, OS admission or recovery inject
`acquireTestOsStageControl` through `acquireOsStageControl`; runner and startup
fixtures use `acquireControl`. The disposable lease tracks its own lifetime.
No environment selector, preload default or production no-op chooses it.

Every fixture that reaches orchestrator startup also injects an immediate
`startupRetryClock`, including the download, recovery-resume, healthcheck and
slot-sync split helpers and invalid-load fixtures. The latter still inject the
test lease even though their terminal loader returns before CONTROL acquisition.
Permanent-fault assertions exhaust the real finite budget without wall-clock
waits; cadence-specific tests override that clock with controlled barriers or
recorded delays. No timeout or outcome assertion is relaxed.

The same clock has optional `scheduleBackground` for H11's later startup cadence.
Injected clocks omitting it are intentionally burst-only/inert: no real background
timer is installed. `startup-cadence-clock.ts` supplies controlled one-shot timers
for cadence/composition tests and records unref/cancel calls. Production's default
clock always supplies the unreferenced 30-second scheduler.

Helpers hold reusable inputs and fixture construction, not registered tests.
The shared APT preflight harness delegates its terminating exit observer to
`../software-update-exit-harness.ts`, keeping both modules below the code-line
ceiling. Its sentinel aborts the production restart continuation; only the outer
fixture observer catches that sentinel, and every other rejection propagates.
Each consuming test file retains its cleanup hooks. Mutable directory rosters
remain worker-local under `bun test --parallel`, and every disk-backed fixture
uses `mkdtemp`. A helper import does not acquire CONTROL or launch a subprocess.

`withMemoryPersistence` keeps agent snapshots in memory but supplies a REAL
private intent-file store per fixture invocation, rooted in `mkdtemp`. Those
worker-local roots are removed at process exit; the helper registers no tests
or test hooks. Disk-backed restart fixtures colocate intent, agent and witness
under their own temporary root and retain it across fresh runtime instances.
New staged-attempt fixture IDs are UUIDs, matching the strict private-intent
boundary; legacy absent-provenance records remain unchanged. Existing assertion
semantics, test names and timeouts are retained.

`os-attempt-lifecycle-fixture` extends that ownership through launched settlement:
it uses the existing private-job creation/read/retirement primitives and real
`saveStagedManifest` receipt/serial publication in the same private directory.
Receipt reads are byte-bound to that producer-parsed value. Boot/health/root-slot
and systemd/RAUC observations remain explicit fixture ports, not board evidence.
Controlled promises hold producer release and D8 cancellation; every terminal
case resets the runtime and reloads the same disk without retaining its latches.

Publishing-admission tests inject first-rename fsync faults and different grants
against these real files. Recovery-retirement tests cover restore, stale and
settled launching sites from startup and tick, including unlink success with
failed directory acknowledgement. Automation is disabled in that matrix so a
legitimate new stage cannot consume the grant being checked after repair.
The D8 ordering file wraps the disposable lease in a serialized CONTROL queue;
opposite caller orders share held evidence and one recovery flight without a
second lease acquisition. D8-first is requested through the injected startup
clock immediately after actual disk adoption, not by pre-seeding runtime memory
ahead of an asynchronous startup load. This is same-process fresh-runtime restart evidence,
not killed-process or kernel-flock/systemd/power-loss qualification.

The recovery-retirement matrix opts into `startup-cadence-clock.ts` and advances
its retained background timer after storage repair. An extra startup caller cannot
rearm an exhausted burst. The cellular-detail fixture uses `withMemoryPersistence`
for the same real private intent-store port as the other memory-backed OS fixtures;
its installed/staged assertions and synthetic observation boundaries are unchanged.

## Responsibility groups

| Test family | Fixture modules | Coverage in sibling test files |
|---|---|---|
| `os-stage-run*` | `os-stage-run-inputs`, `os-stage-run-harness` | Failover, settlement fences, cancellation, signed-pointer revalidation |
| `os-stage-startup*` | `os-stage-startup-harness` | Recovery/retirement and update admission |
| `os-stage-recovery*` | File-local fixtures | Recovery predicate and resource observation |
| `os-agent-runtime*` | `os-agent-runtime-harness` | Install dispatch, channel publication, trusted discovery, stream abort |
| `os-manifest*` | `os-manifest-fixture` | Strict admission, discovery, boot/channel/serial persistence |
| `update-orchestrator-os-recovery-resume*` | `os-recovery-resume-inputs`, `os-recovery-resume-harness` | Interrupted attempts, legacy migration, unsafe confirmation |
| `update-orchestrator-reducer*` | `orchestrator-reducer-recovery` | Package transitions, schedules, totality, OS-stage transitions and recovery |
| `update-orchestrator-runtime*` | `orchestrator-runtime-harness`, `orchestrator-runtime-stream-admission`, `orchestrator-runtime-os-scheduler` | Operator actions, install admission, pending installs, D8, commit probes, OS retry scheduling |
| `update-orchestrator-download-resume*` | `orchestrator-download-inputs`, `orchestrator-download-boot`, `orchestrator-download-probes` | Unit evidence, deferred probes, restarts, generation fencing, pending-plan ownership |
| `os-verify-healthcheck*` | `os-verify-healthcheck-harness` | This-boot verdicts and failing-slot/fallback restart replay |
| `slot-sync-poll*` | `slot-sync-poll-harness` | Durable failure, fresh receipt confirmation, property uniqueness/exit classification |
| `slot-sync-runtime*` | `slot-sync-runtime-harness` | Admission, completion, absence, classifier integration |
| `update-details*` | File-local fixtures | Read projection, transport summaries, cellular approval/publication |
| `update-orchestrator-resume-race*` | File-local fixtures | Consumed recovery evidence and post-commit restart ordering |

The splits retain the original describe/test names, assertion order and timeout
arguments. Run all sibling files for a logical family; an original filename is
no longer its complete coverage set. These are host fixture proofs, not board
qualification.

Signed discovery/recovery keeps real `dpkg --compare-versions` comparisons but
executes them through `runTestCommand`. Synchronous spawning can lose Bun's
private-loop poll accounting when prior worker-global stderr writers are finalized
during a call (oven-sh/bun#40078); a completed child can then strand the fixture.
The helper's disposable-VM GC regression owns this mechanism. Production OS
version comparison already uses the supervised async spawn policy.

The singleton boot-order test locates the nonblocking orchestrator launch and
asserts that it exists before comparing order; an absent source match cannot
stand in for startup ordering.
