# Frontend phantom-green audit

Status: [EXISTS] — bounded audit complete, with explicit follow-up debt below.
No backend or board changes.

## Baseline and boundaries

Audited base: `4ba8a774cba67c37d6481cdf01bfccef0b0fae53` (PR #345 merged).
Bun 1.4.2, Vitest 5.0.0, Biome 2.5.9; frozen lockfile install. Native i18n
loading, `min(16, availableParallelism())`, isolation, timeouts, project
membership and E2E exclusions remain unchanged.

The current-main baseline is **378 files / 6,271 tests**, not the plan's historical
375 / 6,234 (`ca5b0b20`). Merged PRs #342/#344 added `LinkBadge.test.ts`,
`hud/bond-membership.test.ts`, and `BondedLinksSection.signalParity.test.ts`.
No existing file is removed to recreate the old count. The NaN regression adds
one test inside an existing file: expected final count **378 / 6,272**.

## NaN timeout: test fixture defect, not a product workaround

The full command `NODE_OPTIONS=--trace-warnings bun --bun vitest run
--reporter=verbose` reproduced the warning while all 378 files passed
(Duration 134.65 s). Bun printed no stack for that Node option. A temporary
timer proxy captured `ModemGpsSection.svelte:179`, called by the GPS success
and persistent-outcome cases in `ModemConfigDialog.liveRegions.test.ts`.
The proxy was removed after diagnosis.

The fixture returned `{kind: "acquiring"}` without the required `since` and
`deadline`. `gnssAcquirePollDelay` subtracts the deadline, producing NaN;
the runtime then coerced the timeout to 1 ms. Both GPS mocks now use exported
RPC output types, include the complete status shape, and supply the acquisition
window. No product guard was added to conceal an invalid mock.

`schedules finite acquisition delays after the GPS success reply` observed
the real component's timer calls: RED with the incomplete fixture, GREEN with
the typed reply (14 tests in that file). Raw captures are repo-local under
`test-results/phantom-green/{baseline-trace,instrumented-trace,nan-red,nan-green}.log`.

## Exact static sweeps

Run from the repository root with Bash `shopt -s globstar`; the test glob
expanded to 378 files. No empty-glob fallback or repository-wide expansion.

| Pattern | Hits | Exit / PIPESTATUS | Disposition |
|---|---:|---|---|
| `rg -n "\.then\(\s*\(\)?\s*=>\s*\{?\s*expect" apps/frontend/src` | 0 | 1 / 1 | No hits to classify |
| `rg -n "setTimeout\([^)]*\)\s*;?\s*$" -A3 apps/frontend/src/**/*.test.ts \| rg expect` | 0 | 1 / 1,1 | No hits to classify |
| `rg -n "catch\s*\(?\w*\)?\s*\{\s*\}" apps/frontend/src/**/*.test.ts` | 0 | 1 / 1 | No hits to classify |

These exact regexes are bounded heuristics, not a claim to detect every multiline
or named-argument promise pattern. No unclassified hits remain.

| Additional explicit inspection | Classification | Why |
|---|---|---|
| `src/lib/modem/async-surface.test.ts:174–195` | INTENTIONAL | Registers the rejection listener before rejecting the late loser, asserts no unhandled rejection after draining, and removes that exact listener in `finally`; existing comments state the purpose. |

## Biome availability and bounded adoption

`biome explain noFloatingPromises` reports `lint/nursery/noFloatingPromises`,
available since 2.0.0; `biome explain useAwait` reports
`lint/suspicious/useAwait`, available since 1.4.0. The CLI expects bare rule
names, not group/name arguments. **`suspicious/noFloatingPromises` is absent**;
use the shipped nursery rule rather than inventing a guard script.

Only frontend `*.test.ts` / `*.spec.ts` overrides change: floating promises is
error-level (the audit found no diagnostics); useAwait is warning-level.
The latter reports 29 existing test warnings, including promise-shaped mocks
(the initial whole-source diagnostic sweep reported 36, seven outside tests).
Making it an error would require editing files outside this audit's
authorized defect set. Those warnings remain visible, not suppressed; this is
not a zero-warning lint claim. No product lint rule was relaxed.

## One-shot assertion-presence probe

Temporarily added `beforeEach(() => expect.hasAssertions())` in BOTH setup
files, ran the full suite exactly once, then removed both hooks. Result:
**2 failed / 376 passed files; 2 failed / 6,270 passed tests**, Duration 149.56 s.
Both failures say `expected any number of assertion, but got none`:

| File / case | Observation | Disposition |
|---|---|---|
| `src/tests/sim-unlock-trigger-gate.test.ts` — explicit action, not an effect | The effect-block loop executes zero assertions when no matching effect exists; separate planted-relapse control asserts the detector. | Follow-up, not selected by mutation probe; no edit authorized by assertion count alone. |
| `src/lib/components/custom/SourceSection.test.ts` — multi-source selection callback | The native-option/native-select guards bypass the only callback assertion when the native option is absent. | Suspected vacuous case, not mutation-proven; follow-up rather than an out-of-scope fix. |

Raw complete failing-file/case list: `test-results/phantom-green/has-assertions.log`
and `.json`. No temporary assertion-count global remains.

## Mutation-kill probe

Selection is fixed in
`test-results/phantom-green/{components,pure}-selection.txt` using `shuf -n 5`
over existing single-line assertions in each classifier project. No seed or
hand-picked replacement was used. Five assertions per project, ten total;
two component selections are in `SharingSection.test.ts` (a directly-called
shared helper and an independent client-zone case).
Inversion must preserve the original expression and matcher; a compile error
or a different failure is not a kill receipt.

The candidate population was line-start `expect(...)` expressions with a
single-line `toBe`, `toEqual`, `toHaveLength`, `toBeTruthy`, `toBeFalsy`,
`toBeNull` or `toBeDefined` matcher. Each project's candidate stream was piped
through `shuf -n 5` independently. Helpers and parameterized assertions were
eligible; multiline assertions and other matchers were outside this bounded
sample. The temporary candidate-list script was removed after selection.

**10/10 killed in hosted CI**, with assertion stacks at all ten selected lines.
Probe head: `40436c39ca7cbc2ea038a3431bf751ef5091399c`, forked from audit head
`0f17fd4e`. [Throwaway PR #347](https://github.com/CERALIVE/CeraUI/pull/347)
was closed without merging and its remote branch deleted. The ordinary audit
branch contains none of the inversions.

Run: **[34185568466](https://github.com/CERALIVE/CeraUI/actions/runs/34185568466)**.
All paths below are relative to `apps/frontend/`; each mutation inserted `.not`
before the original matcher and left the expression and expected value unchanged.

| Project | Selected assertion | Owning shard | Result |
|---|---|---|---|
| components | `src/main/network/SharingSection.test.ts:414` — zone is serving | [3/4][shard3] | RED at 414:47 |
| components | `src/tests/encoder-status.test.ts:366` — core tone equals tone | [1/4][shard1] | RED at 366:66 |
| components | `src/lib/streaming/destination-validation.test.ts:312` — failed verdict is false | [3/4][shard3] | RED at 312:65 |
| components | `src/main/dialogs/ModemConfigDialog.detail.test.ts:292` — radio text is 5G NR | [3/4][shard3] | RED at 292:40 |
| components | `src/main/network/SharingSection.test.ts:131` — disclosure is DETAILS | [3/4][shard3] | RED at 131:31 |
| pure | `src/lib/helpers/wifi-mode-outcome.test.ts:24` — station is confirmed | [4/4][shard4] | RED at 24:55 |
| pure | `src/main/dialogs/modem-detail.test.ts:69` — keys are tech/sinr | [2/4][shard2] | RED at 69:36 |
| pure | `src/main/network/cellular-row.test.ts:889` — unmanaged action is configure | [3/4][shard3] | RED at 889:64 |
| pure | `src/lib/rpc/rpc-error.test.ts:125` — internal error name | [1/4][shard1] | RED at 125:29 |
| pure | `src/main/dialogs/modem-five-g.test.ts:120` — distinct key count | [1/4][shard1] | RED at 120:34 |

[shard1]: https://github.com/CERALIVE/CeraUI/actions/runs/34185568466/job/101933147751
[shard2]: https://github.com/CERALIVE/CeraUI/actions/runs/34185568466/job/101933147747
[shard3]: https://github.com/CERALIVE/CeraUI/actions/runs/34185568466/job/101933147872
[shard4]: https://github.com/CERALIVE/CeraUI/actions/runs/34185568466/job/101933147716

The [merged report](https://github.com/CERALIVE/CeraUI/actions/runs/34185568466/job/101933506046)
is RED: **9 failed / 369 passed files; 26 failed / 6,246 passed tests**.
Its total remains **378 / 6,272**. Ten assertion sites produce 26 failing cases
because the disclosure helper and core-tone table execute in multiple cases;
both SharingSection sites independently appear in the failure stacks.
The [required summary](https://github.com/CERALIVE/CeraUI/actions/runs/34185568466/job/101934442430)
is RED specifically for `test-fe=failure merge-fe-reports=failure`.
Every non-FE prerequisite passed, including backend, both builds and all E2E lanes.

No selected mutation survived. Thus no additional file is authorized for a
phantom-green repair by this sample. The two assertion-presence findings and
test-only missing-await warnings remain explicit entries in
[`TECHNICAL_DEBT.md`](TECHNICAL_DEBT.md), not claims that those cases were cleared.
Raw receipt: `test-results/phantom-green/mutation-ci.log` and `mutation-jobs.json`.

## Final restored-tree verification

Both ordinary commands ran sequentially after all mutation inversions and both
temporary assertion-presence hooks were removed:

| Command | Files | Tests | Vitest Duration | Exit |
|---|---:|---:|---:|---:|
| `bun run --filter frontend test` — run 1 | 378 passed | 6,272 passed | 132.19 s | 0 |
| `bun run --filter frontend test` — run 2 | 378 passed | 6,272 passed | 114.38 s | 0 |

Both also passed all four hardware-preflight **unit** tests (no board access).
Neither full log contains `TimeoutNaNWarning`. Raw logs: `final-1.log` and
`final-2.log` in the receipt directory. Counts match current main's file inventory;
the historical 375-file difference is accounted for above.

Frontend typecheck: zero errors/warnings. Production frontend build: PASS.
Workflow-shape tests: 41 pass. Runner/classifier tests: 12 pass.
Debt gate: 28 entries, 22 open, no orphan markers. Biome check exits zero with
29 documented `useAwait` warnings and three pre-existing `useLiteralKeys` infos;
no errors. Source/config language-server error diagnostics are clean; the Biome
JSON language server is not installed (previously declined), so JSON validation
uses the installed 2.5.9 CLI. No LSP installation or dependency pin changed.

This proves the ten sampled assertions propagate failure, not that every
assertion in the suite is non-vacuous. The two assertion-presence follow-ups
remain open intentionally under the audit's mutation-proven-only repair rule.
