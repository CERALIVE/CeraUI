# Full-suite E2E backend ownership investigation

Status: [PARTIAL] — backend-ownership controls pass, but the fresh draft-PR full
run returned 265 failures and did not reproduce the earlier one-failure result.
This is not a merge-ready receipt; see the post-commit result below.

## Baseline, before changes

On 2026-09-17, freshly fetched `origin/main` at
`c668f9af7a26b7ba955683d9fd7ec6376ef475f4`, with no tracked modifications, ran
`bun run test:e2e` under Bun 1.4.2 / Node 26.7.0. It completed with **44 failed,
398 passed, 280 skipped** in 16.8 minutes, using the default four workers and no
retries. The first failure was `audio-backend.spec.ts:191`, at login with
“Incorrect password”, before the audio assertion. PR #362 was not in that tree.

The same unmodified audio file was repeated three times: each four-worker run
returned **1 failed / 3 passed**. Its `:191` scenario alone passed three separate
invocations. No worker override was used: a single selected test naturally uses
one worker slot.

## Mechanism

The fixture assigned `3100 + TEST_PARALLEL_INDEX`. A backend process from an
earlier candidate-checkout run was already listening on 3101 (PID 2772455,
started 02:51). After validation, `lsof` still reported its CWD as the deleted old
`apps/frontend/test-results/worker-backends/3101` directory in the candidate
checkout. The new control child reported failure to bind 3101. The fixture
nevertheless resolved readiness, because its TCP probe only asked whether
*anything* accepted a connection there. It neither correlated the listener with
its child nor rejected the child's exit. A page could therefore authenticate
against a different backend and observe its password, notifications or scenario.
Worker replacement reused the same parallel slot, so the occupied port remained
eligible throughout the suite; an isolated scenario normally used unoccupied 3100.

The incumbent was not killed or altered to obtain the post-fix results.
Original trace artifacts do not establish every failed test's port; do not infer
per-test routing from the old per-port logs, which were overwritten at each seed.
The baseline also included a notification-isolation assertion failure and four
locator-timeout variants. None of those failures recurred in the fixed full run.

## Fix and regression controls

- Linux local RPC slots are kernel-leased in the existing 3100–3149 range;
  occupied slots are excluded, not killed. Fixed explicit-port/CI requests fail
  honestly if they cannot bind. A non-cooperating external binder can still win
  between admission and bind, but child-owned readiness then rejects startup,
  never hands the foreign process to a test.
- Per-acquisition state uses a unique directory, not a destructive per-port reset.
- Mock preview accepts `PREVIEW_PORT=0`, so its upstream is independently bound
  by the OS rather than competing on a guessed adjacent port.
- A private launcher reports the child's actual bound RPC/preview ports over IPC
  after normal boot. Startup exit/error/timeout and wrong-port binding reject;
  parent-channel loss terminates the child. There is no product auth bypass or
  test-only HTTP endpoint.
- The fixture records the chosen RPC port as a test annotation.

`backend-startup.spec.ts` failed **6/6** before the fix (two controls repeated
three times): an occupied listener was returned as a ready backend, and two
simultaneous acquisitions returned one shared port. After the fix, those controls
plus all four audio tests passed **18/18 at four workers**. The initial arbitrary
RPC-port attempt was rejected because existing socket-interception patterns
deliberately match 31xx; the leased range preserves that contract unchanged.

## Prior investigation evidence and limits

The unchanged full `bun run test:e2e` entrypoint on main plus this fix completed
with **444 passed / 1 failed / 281 skipped** in 15.0 minutes, at four workers,
without retries. The two new controls run on both projects, adding four cases
to the original 722. No existing test, assertion, skip condition, timeout, worker
budget or exclusion filter was changed. There were no auth/startup failures.

The remaining failure is `eink-transitions.spec.ts:217`, at its final
Settings → Live navigation: `helpers/index.ts:100` waited five seconds for
`#nav-tab-live[aria-current="page"]`, but the attribute remained absent.
Login and the preceding navigation had succeeded. Eight focused repetitions of
that unchanged scenario at four workers passed. The missed-navigation mechanism
has not been established; no retry or larger timeout was added. Its trace and
error context are retained in `test-results/e2e-main-fixed.tar.gz`.

Other validation: all changed TypeScript files have clean LSP error diagnostics;
`bun run lint` passes (29 warnings and 3 infos in untouched files, Svelte check
zero errors/warnings); `bun run check:tech-debt` passes; `bun run test` passes
(RPC 512, i18n 709, frontend 6,299 plus four hardware-preflight tests, backend
6,121 passed / two existing skips / zero failed); and
`BUILD_ARCH=amd64 bun run build` passes.

Local receipts are gitignored: `apps/frontend/e2e-main-control.log`,
`e2e-audio-parallel-{1,2,3}.log`, `e2e-audio-isolated-{1,2,3}.log`,
`e2e-startup-red.log`, `e2e-startup-pool-green.log`, and
`test-results/e2e-main-baseline.tar.gz` (original traces and worker logs).
The post-fix full and focused navigation logs are `e2e-main-fixed.log` and
`e2e-eink-repro.log`; lint/unit/build receipts are `test-results/e2e-infra-*.log`.
Keep credential-bearing traces private.

The run-wide Vite/reference-backend setup still uses fixed ports and is not made
safe for simultaneous whole-suite invocations in one namespace by this fix.
No board was accessed. No lifecycle implementation was changed, and no PR was
merged, published or marked ready during that investigation. Its changes were
left uncommitted on `fix/e2e-backend-ownership` for a separate draft PR.

**2026-09-23 local reference-backend follow-up.** The older fixed-port caveat
above became a deterministic auth failure: a developer backend from another
checkout had held port 3002 since September 21, and Playwright's
`reuseExistingServer: true` silently adopted it. Both a fresh `origin/main`
control and the capture-failover branch failed the same autostart spec before
rendering the authenticated shell; the foreign backend logged an invalid token.
Local E2E now owns reference port 3003 and refuses to reuse an occupied reference
or Vite port. This is fail-closed ownership, not a claim that two whole local
suites can share 6173/3003; run them sequentially. A second, independent auth
race was confirmed by checking the sidecar's SHA-256 against the token store:
spec modules captured a placeholder or prior run's raw token before global
setup replaced it. The sidecar is now seeded before discovery and is not rotated
after collection; global setup still proves a genuine remember-me issuance and
admits the preselected test token only for the worker backends. Neither fix
changes production authentication or test timeouts, worker counts or skips.

The confirmed ownership defect predates PR #362 and does not require its
composition/engine-recovery changes to reproduce or repair. That clears those
changes of causing this auth failure, not of every possible regression. The
e-ink failure also occurred without PR #362, but whether it predates this
infrastructure fix is not established. PR #362 is therefore **not yet clear to
proceed after this fix alone**: characterize and resolve the navigation failure,
then obtain a green full gate on the combined candidate tree. That combined run
and hosted CI-preview validation were not performed here.

## Draft-PR preparation verification (2026-09-17)

The landing lane re-read the complete diff on freshly fetched `origin/main`
`c668f9af`, without changing the implementation or existing test bodies. The
audio and e-ink specs, Playwright configuration, CI workflow, assertion budgets,
skips, retries and exclusion filters are unchanged. The fixture retains its
60-second startup deadline and four-second shutdown grace.

Fresh verification under Bun 1.4.2 and Node 26.7.0:

```sh
bun run --filter frontend test:e2e -- backend-startup.spec.ts audio-backend.spec.ts --project=desktop --repeat-each=3
```

Result: **18 passed, zero failed or skipped**, four workers, no retries, in
46.1 seconds. Fresh lint/typechecks, tech-debt check, complete unit suites and
`BUILD_ARCH=amd64 bun run build` also passed. All six changed/new TypeScript files
have clean LSP error diagnostics. Receipts are retained privately under the
repo-local `test-results/e2e-ownership-fresh-*.log` paths. An initial combined
lint/unit/build shell invocation exhausted its 120-second tool budget during
frontend tests; the complete unit/build invocation then ran to completion with
a longer shell budget. No test timeout was changed.

Read-only `ps` and `lsof` confirmed PID **2772455**, started at **02:51:00**, still
listening on **3101** and **3201**, with its CWD at the deleted candidate-checkout
`apps/frontend/test-results/worker-backends/3101` directory. It was not killed or
altered for validation.

The **local lease pool is 3100–3149**. The pre-existing CI preview predicate in
`apps/frontend/vite-preview-routing.ts` already accepts **3100–3199**, as does
the `31\d\d` interception pattern in the page-RPC fixture. Neither is changed
or widened here; the concurrent CI control uses the existing upper-half peer.

The draft PR requires its own CI and review, and should land before or alongside
PR #362. The post-commit full-suite rerun is reported on that PR; earlier counts
above are investigation evidence, not a substitute for that fresh run. The
remaining e-ink navigation failure belongs to a separate lane and is not repaired
or investigated by this change.

## Fresh post-commit full-suite result

Draft PR: [#363](https://github.com/CERALIVE/CeraUI/pull/363), targeting `main`.
After opening it, the unchanged `bun run test:e2e` ran on the clean committed
checkout at **`f99e2e4affb3a6e0922bca51a95a687bfaa3436e`**, based on `c668f9af`
with this ownership fix alone, without PR #362. Bun 1.4.2 / Node 26.7.0, four
workers, no retries or command-level test filters beyond the existing entrypoint.

The result was **171 passed / 265 failed / 277 skipped / 13 did not run**
(726 total) in **12.6 minutes**, exit code 1. The earlier **44 → 1** failure
improvement **did not reproduce**. The desktop `eink-transitions.spec.ts:217`
case passed in this run; its source and failure mechanism were not investigated
or changed. No attribution for the new full-run failures is established here.

The full receipt is retained privately at
`test-results/e2e-ownership-fresh-full.log`, with Playwright artifacts under
`apps/frontend/test-results/`. The only subsequent tracked edit is this result
record; no implementation, test, configuration or gate was changed to repair the
run. PID 2772455 was not signalled or cleaned up. Keep the PR draft and blocked
on its own CI/review and full-gate reconciliation; do not substitute the older
444/1/281 result for this fresh evidence.
