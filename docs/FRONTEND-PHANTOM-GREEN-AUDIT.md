# Frontend phantom-green audit

Status: [PARTIAL] — local investigation complete; hosted mutation receipt and
final two-run verification pending. No backend or board changes.

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
The latter reports existing unnecessary async functions, including promise-shaped
mocks. Making it an error would require editing files outside this audit's
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

Pending hosted receipt. Selection is fixed in
`test-results/phantom-green/{components,pure}-selection.txt` using `shuf -n 5`
over existing single-line assertions in each classifier project. No seed or
hand-picked replacement was used. Five assertions per project, ten total;
two component selections are in different cases of `SharingSection.test.ts`.
Inversion must preserve the original expression and matcher; a compile error
or a different failure is not a kill receipt.
