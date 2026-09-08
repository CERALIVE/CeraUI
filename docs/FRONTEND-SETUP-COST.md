# Frontend setup-cost measurements

> Hosted reliability correction: the original local-only acceptance below was
> insufficient. PR345 run34177597851 failed. The worker-budget correction and
> constrained reproduction are recorded at the end; a new full hosted check set
> is required before this work can be accepted.

## Measurement contract

Base: `ca5b0b20ab0b78698461dafa866b2bffa5505127` (current `origin/main`
when fetched on 2026-09-07). Runtime: Bun 1.4.2; Vitest 5.0.0.

Measure the full frontend command, including catalog generation and hardware
preflight, twice for each candidate. Preserve file/test counts and failures as
well as wall time and Vitest phase durations. Run candidates sequentially, not
against each other on the same host. Optimizer, setup-lightening, isolation and
filesystem-cache changes require at least 20% lower mean wall time than baseline
and three green parity runs before adoption. Registration deduplication instead
requires a proven reduction in redundant registrations and green parity.

The inherited experiments were preserved separately and are not adopted. The
current setup eagerly imports the catalog for every isolated component file;
the storage setup registers no messages. The previous profile locates the cost
in eager namespace imports, not in test assertions or the retained 50 ms teardown.

## Results

| Configuration | Run | Wall seconds | Vitest seconds | Files / tests | Phase shares (setup / transform / import / tests / environment) | Exit |
|---|---:|---:|---:|---:|---|---:|
| Current main | 1 | 656.451 | 649.25 | 375 / 6,234 | 84 / 8 / 4 / 3 / 2 % | 0 |
| Current main | 2 | 669.204 | 661.09 | 375 / 6,234 | 84 / 8 / 4 / 3 / 2 % | 0 |
| Broad client optimizer | 1 | 65.120 | 61.37 | 375 / 6,234 | 5 / 49 / 29 / 5 / 11 % | 1 |
| Broad client optimizer | 2 | 59.279 | 56.36 | 375 / 6,234 | 6 / 47 / 29 / 6 / 12 % | 1 |
| Components isolate:false | 1 | 182.844 | 178.13 | 375 / 6,234 | 31 / 10 / 2 / 53 / 4 % | 1 |
| Components isolate:false | 2 | 141.334 | 138.53 | 375 / 6,234 | 35 / 11 / 2 / 47 / 5 % | 1 |
| fsModuleCache:true | 1 | 597.532 | 591.63 | 375 / 6,234 | 88 / 3 / 5 / 3 / 2 % | 0 |
| fsModuleCache:true | 2 | 591.017 | 585.78 | 375 / 6,234 | 89 / 2 / 5 / 3 / 2 % | 0 |
| Native compiled catalog | 1 | 148.495 | 140.80 | 375 / 6,234 | 3 / 21 / 38 / 29 / 8 % | 0 |
| Native compiled catalog | 2 | 126.658 | 121.21 | 375 / 6,234 | 4 / 16 / 35 / 36 / 9 % | 0 |
| Native catalog + pure isolate:true | 1 | 139.631 | 133.74 | 375 / 6,234 | 4 / 18 / 38 / 33 / 8 % | 0 |
| Native catalog + pure isolate:true | 2 | 134.593 | 128.39 | 375 / 6,234 | 4 / 18 / 37 / 34 / 8 % | 0 |
| Native catalog + per-file namespaces | 1 | 126.363 | 120.87 | 375 / 6,234 | 7 / 18 / 33 / 33 / 9 % | 0 |
| Native catalog + per-file namespaces | 2 | 127.820 | 122.32 | 375 / 6,234 | 7 / 17 / 32 / 35 / 9 % | 0 |

Baseline mean wall time: **662.827 seconds**. Adoption threshold: **530.262
seconds or less** (20% faster), plus three green runs at identical counts.
Vitest's phase percentages are rounded, aggregate worker-time shares; they may
sum to 101% and are not elapsed wall-time slices. Final adoption is recorded below.

**Broad optimizer: REJECTED.** Includes `bits-ui`, `@testing-library/svelte`,
`svelte`, and `@ceraui/i18n/eager` under `test.deps.optimizer.client` with
`enabled: true`. Both runs failed 181 files / 2,652 tests; failures include
Svelte `first_child_getter.call` / `effect.nodes`, storage isolation, and
unregistered message keys. Fast failure is not a speedup.

**Components isolate:false: REJECTED.** Threads remained enabled. Run 1 failed
117 files / 712 tests; run 2 failed 119 files / 811 tests. Cached mocks and
singleton state leak between files (including absent RPC methods and real
connection timeouts). Neither reaches the mandatory 3/3-green admission gate.

**Filesystem cache: REJECTED.** The installed Vitest 5 API is `test.fsModuleCache`,
not the obsolete `test.experimental.fsModuleCache`. Mean wall time 594.275 s is
10.34% faster, below the 20% threshold. The initially launched background attempt
was terminated with its tool process group and produced no result; it is excluded.
These two complete retry runs used the cache left by that partial attempt, so
even this warm-cache result cannot justify adoption.

**Native compiled catalog: qualifies for final parity testing.** The compiler
already emits plain ESM. `test.server.deps.external` narrowly selects only
`packages/i18n/generated/` and `packages/i18n/src/paraglide/`, letting Bun load
those modules natively instead of reprocessing the compiled graph through Vite.
The Svelte facade, Svelte itself, application code, and generated temporary
registries used by the lazy-loading tests stay transformed and isolated.
Mean wall time **137.576 s**, **79.24% faster** than current main. This is a
profile-driven additional candidate, not a relabeling of the rejected broad
optimizer. It keeps one coherent native registry/runtime graph and does not
share Svelte component state. The three final parity runs below authorize adoption.

**Pure isolation retest: retain isolate:false.** Tested both settings with the
same native-catalog boundary. `true` averaged 137.112 s versus 137.576 s for
`false`: 0.34%, not a meaningful improvement or a reason to replace the existing
policy. Components remain isolated; no tests, worker bounds or timeouts changed.

**Per-file namespace selection: measured, not adopted.** Task-1's profile justified
testing setup lightening. A temporary setup replaced the eager import with
`ensureNamespaces()` over namespaces detected in the test's transitive source
imports, using the inherited scanner under the native-catalog boundary. Both
full suites passed. Mean 127.092 s is 80.83% faster than original main, but only
7.62% faster than native loading alone; the substantial gain is already available
without the scanner. The scanner adds per-file synchronous source I/O and cannot
prove coverage of computed keys or package imports. We deliberately choose the
simpler full catalog, rather than make future test correctness depend on that
heuristic. Its current green runs do not prove its future key coverage.

## Registration scope

A full instrumented baseline passed all 375 files / 6,234 tests (750.791 s wall,
745.12 s Vitest; phase shares 82 / 11 / 4 / 2 / 2%). Instrumentation identified
registry instances by UUID and workers by `node:worker_threads.threadId`.
Observed: **244 registry evaluations, 244 eager evaluations, 244 eager calls,
7,564 namespace writes, 593,896 message writes, 244 distinct threads**.
**Zero namespace writes targeted an already-loaded namespace.** Vitest's isolated
threads are replaced per file, not a persistent 16-worker module cache. A global
memo flag cannot avoid those imports while preserving isolation.

The command's Paraglide compilation is a separate operation, invoked once before
Vitest. `vitest.storage.setup.ts` registers nothing; `vitest.setup.ts` no longer
exists. Federation's three entry modules each call `registerFederationMessages()`;
that real repeated-call path is not executed by the ordinary suite's current
tests and needs an explicit regression probe rather than fabricated baseline
duplicates.

### Reentrant registration regression (controlled full-suite probe)

The three-call case is deliberately injected at component setup to model the
three federation entrypoints, NOT presented as naturally occurring duplicates
in the ordinary baseline. A temporary transform calls the real eager function
three times and counts `Map.set` calls only inside each synchronous call,
restoring the method in `finally`. Both full runs use native catalog loading.

| Version | Calls | Registrations doing work | Message writes | Threads | Files / tests | Wall / Vitest seconds | Exit |
|---|---:|---:|---:|---:|---|---|---:|
| Before memo | 732 | 732 | 1,781,688 | 244 | 375 / 6,234 | 135.890 / 128.95 | 0 |
| After memo | 732 | 244 | 593,896 | 244 | 375 / 6,234 | 149.304 / 142.51 | 0 |

**Adopt the registration fix:** 488 redundant registrations removed (66.67% of
the controlled workload), without suppressing initialization of any worker.
Timing is secondary and showed no improvement for this small synchronous loop.
The generated eager entry memoizes only AFTER a successful registration, per
module instance. No process-global flag, persistent mutable catalog, or cache
outside the isolated worker is introduced. Package regression test: RED at
three calls instead of one, then GREEN (3 tests); full package gate: 709 tests
across 14 files, zero failures; package typecheck passes. The tooling and this
regression are now included in the package typecheck, with a package-local Bun
typing dependency; the generator and regression are also included in Biome.

## Final adopted configuration — 2026-09-08

Only native loading of compiled i18n ESM and the eager-registration memo are
adopted. No experimental environment switches or instrumentation remain in
tracked config. Existing worker bounds, project membership, full catalog, Storage
reset, 20-second timeout, 50 ms teardown and CI shard layout are unchanged.

| Full command run | Wall seconds | Vitest seconds | Files / tests | Setup / transform / import / tests / environment | Exit |
|---|---:|---:|---|---|---:|
| Final 1 | 132.286 | 124.62 | 375 / 6,234 | 3 / 23 / 33 / 32 / 8 % | 0 |
| Final 2 | 131.299 | 125.91 | 375 / 6,234 | 3 / 15 / 38 / 35 / 9 % | 0 |
| Final 3 | 124.110 | 118.60 | 375 / 6,234 | 4 / 17 / 36 / 34 / 10 % | 0 |

Mean **129.232 s**, **80.50% faster** than the 662.827 s current-main baseline
(5.13× throughput for this command). All three include catalog generation and
the hardware-preflight unit tests; no hardware is contacted. The three new
registration tests belong to the i18n package, not the frontend file/test count.

Verification: frontend `check` (zero errors/warnings), SPA build, federation
build, i18n package check and 709-test suite, and the six classifier/native-boundary
tests all pass. The new boundary test was RED before enabling the ordinary
config's native graph. Changed source-file LSP diagnostics are clean. The
federation build exits zero but reports static/dynamic catalog-import warnings;
it is not claimed to be warning-free. No backend or board code was changed, and
no board drill or hosted CI result is claimed.

## Hosted timeout diagnosis and worker-budget correction

Run34177597851 checked merge4b8aa10 (head6fbab467 onto main468f3d9d).
Shard3 failed3 tests across94files/1,598tests. The three specs explicitly set
`testTimeout:15000` with `vi.setConfig`; root20000 inheritance works correctly.
The old `minWorkers:4` option is ignored by installed Vitest5. Only `maxWorkers:16`
actually bounded the shared pool. Shutdown warnings have their own10-second
deadline and are distinct from assertion timeouts.

The five named files were compared with the original configuration (native
externalization removed) and the native loader on two physical CPUs,0 and2.
All17 tests passed in both cases. First-case timings, original versus native:
usage-policy955/930ms, preview639/656ms, passthrough633/690ms,
bitrate-remount66/46ms, autostart161/205ms. There is no measured basis for a
timeout increase or a native-loader regression in those isolated-file comparisons.
In the full pre-merge shard, original/native first passthrough cases took
5,284/1,539ms; native did not shave margin off that already-heavy case.

| Source / resource condition | Loader / workers | Files / tests | Wall seconds | Failures | Shutdown warnings | Peak RSS KiB |
|---|---|---|---:|---:|---:|---:|
| Original PR head; two CPUs | original /16 | 94/1594 | 285.861 | 0 | 5 | unmeasured |
| Original PR head; two CPUs | native /16 | 94/1594 | 85.663 | 0 | 0 | unmeasured |
| Hosted-equivalent merged tree; two CPUs | native /16 | 94/1598 | 87.625 | 0 | 0 | 8,212,388 |
| Hosted-equivalent merged tree; two CPUs | native /2 | 94/1598 | 83.403 | 0 | 0 | 2,206,676 |
| Bounded stress | native /16 | 94/1598 | 445.169 | 3 | 12 | transcript truncated after timing |
| SAME bounded stress | native /1 | 94/1598 | 225.344 | 0 | 0 | 1,341,920 |
| Toggle back, SAME bounded stress | native /16 | 94/1598 | 325.806 | 2 | 5 | transcript truncated after timing |
| Fixed config, SAME bounded stress | native /auto(1) | 94/1598 | 310.287 | 0 | 0 | 1,371,640 |

The bounded stress is a transient user scope: `CPUQuota=100%`,
`AllowedCPUs=0,2`, `MemoryHigh=6G`, `MemoryMax=10G`, `MemorySwapMax=0`.
It deliberately reproduces resource pressure; it is NOT claimed to be the exact
hosted hardware allocation. `availableParallelism()` reports1 in that scope and2
under affinity alone, while `os.cpus().length` remains28. Scope exit removes the
constraints; no desktop, board or persistent system configuration was changed.

The first stress run reproduces the SAME passthrough case at17,094ms against its
existing15-second limit, plus two other render/async tests. At one worker the
passthrough case takes992ms and all1598tests pass. Returning to16 workers brings
back failures and shutdown warnings; leaving the corrected config to choose its
own budget clears both again. Varying victims under fixed resource pressure,
and recovery by changing only concurrency, identify pool oversubscription rather
than a missing mock or a new catalog-identity defect. CPU-only results also show
that fewer workers substantially reduce resident memory without costing shard
throughput. The native loader and all test-specific timeouts remain intact.

**Fix:** cap workers by `min(16, availableParallelism())`, preserving the local
ceiling and choosing a feasible pool on smaller machines. A configuration
regression test checks the real runtime budget; under `taskset -c0` it fails
before the fix (`Expected <=1, Received16`) and passes afterwards. CI prints its
selected budget so a future incident does not have to guess the allocation.

Current main was merged into the published branch, rather than rewriting pushed
history. The five investigated specs are unchanged from the original base.
No backend changes were authored; the merge incorporates the already-merged
independent #343 work. Hosted acceptance requires every check of the new run to
pass; the earlier review/local completion is not carried forward. The latest
complete check set on PR345 is the acceptance authority, not this local table.

Local verification of the fixed, merged tree: the full frontend command under
four-CPU affinity and `CI=true` passes **378files /6,271tests** in161.154s wall
(Vitest155.70s, transform32%, import31%, tests17%, environment13%, setup7%).
The count increase is the merged #342/#344 test additions, not a test-scope
change here. The worker-budget/classifier suite passes7tests; frontend check
reports0errors/0warnings; SPA build and root Biome pass (three pre-existing
informational literal-key suggestions). Changed-source LSP diagnostics are clean.
