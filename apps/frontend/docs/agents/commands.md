<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## COMMANDS

### Media-load hint and detail [EXISTS]

`EncoderStatus.svelte` is the single entry point at Device Stats, Device Health,
and the Live telemetry strip. Non-empty `EncoderLoad.blocks` selects
`MediaLoadHint.svelte`; absent/empty blocks select `LegacyEncoderStatus.svelte`,
the previous renderer with its percent / active / unavailable vocabulary intact.
The historical dual-core layout notes below describe that **legacy** arm only.

- The hint groups encode, decode, JPEG and RGA from the published block set and
  counts the rows it actually receives. MPP load and utilization are independent
  numbers, not bars and never clamped. RGA's hint shows load only.
- `MediaLoadDialog.svelte` is lazy-loaded on the explicit **Media details** action;
  its `device-health/MediaLoadPanel.svelte` reads props only and exposes all core
  identities, block sources, the sample timestamp and every bound PID/index.
  Null owners mean **Unknown**, an empty array means **No bound sessions**, and
  RGA utilization/owners say **Not published by this driver**. The ownership note
  appears before the data: PID is the creating task, not proven process/TGID or
  executing-core attribution; no preview/program ownership is inferred.
- The widget owns the open state outside its block/legacy branch, so a snapshot
  dropping blocks clears all owners and updates an already-open detail dialog to
  the legacy reading. Nothing merges or retains retired identities.
- `EncoderLoadReading` is a readonly projection of the shared RPC type, not a
  shadow wire interface. The encoder's qualitative verdict prefers the encoder
  block alone, never decoder/RGA activity or session presence. An incomplete
  all-zero block is unknown rather than a confident idle.
- Block surfaces share the existing refcounted health clock. Disconnected or
  older-than-six-second readings retain numbers with muted styling and a visible
  last-reading notice; no telemetry gates a stream (MNH-37).
- Device Health widens only with block telemetry, making room for four groups on
  the short desktop/kiosk layout. The legacy shell width remains unchanged.
- `?health-mock=island` adds illustrative nine-core data, with above-100% values,
  empty/unknown owners and independent RGA nulls. It stays dev-only and subordinate
  to a real snapshot. Existing vendor/mainline/unavailable fixtures are unchanged.

Coverage: `src/tests/media-load{,-ui}.test.ts`, existing encoder/status/health
suites, and `tests/e2e/media-load.spec.ts` (real socket ingestion, keyboard open,
focus return, and block-to-legacy retraction). Copy: `settings.mediaLoad.*` in all
ten locales. **Board visual QA remains outstanding on both boards**; dev-browser
evidence is not hardware evidence. Full contract: `docs/ENCODER-LOAD.md` at repo root.

### Vitest project topology [EXISTS]

Unhandled errors are never filtered: `dangerouslyIgnoreUnhandledErrors: false`
and a rethrowing `onUnhandledError` apply to the ordinary suite and its shards.
Test-only Biome overrides enforce `nursery/noFloatingPromises` as an error and
report `suspicious/useAwait` warnings; both ship in 2.5.9, but floating promises
is not a `suspicious` rule in that version. No custom equivalent guard exists.
GPS live-region mocks use the exported RPC reply types so an acquiring state
cannot omit its `since`/`deadline` and schedule a NaN timeout. The timer regression
is in `ModemConfigDialog.liveRegions.test.ts`. Audit evidence and limitations:
[`../../docs/FRONTEND-PHANTOM-GREEN-AUDIT.md`](../../../../docs/FRONTEND-PHANTOM-GREEN-AUDIT.md).

`vitest.config.ts` uses stable Vitest 5's `test.projects`, with inline
`extends: true` projects inheriting plugins, defines, aliases, and runner bounds.
`scripts/ci/vitest-classify.mjs` walks source-test import graphs at config load:
browser/Svelte-reaching tests use isolated `components`/jsdom; rune-free tests
use `pure`/Node with `isolate: false`. An explicit no-window assertion or Node
environment directive takes precedence, preserving the TTL fallback contract.
NavigationHelper uses jsdom with the setup's inert `matchMedia` default.

The former monolithic setup is split: `vitest.storage.setup.ts` installs fresh
Storage for every file and clears it before every test in BOTH projects;
`vitest.components.setup.ts` registers the catalog and retains the 50 ms bits-ui
teardown wait in jsdom ONLY. The federation config explicitly loads both files.
The Storage history below refers to that former setup; its replacement retains
both jobs. Never infer the project at runtime or enable `fsModuleCache` without
a new measured decision. The classifier's Bun tests pin disjoint, complete
coverage and both mixed-topology cases.

Already-compiled i18n `.js` files under `packages/i18n/generated/` and
`packages/i18n/src/paraglide/` load natively in the ordinary suite. Keep BOTH
the registry and locale runtime on that boundary: splitting their module
identities leaves the facade reading an empty registry or the wrong locale.
The reactive Svelte facade, Svelte itself, app code and independently generated
test registries stay transformed. Eager registration is memoized per module
instance after success, never by a process-global flag. Full catalog coverage,
Storage isolation, the 50 ms teardown wait and both project policies stay intact.
See `docs/FRONTEND-SETUP-COST.md` at repo root for the measured alternatives.

### DEP BASELINE — measured 2026-09-08 [EXISTS]

**Hosted reliability correction:** the following timings are the original
local-only measurements, not hosted acceptance. PR345 run34177597851 failed
three component tests and reported worker-shutdown timeouts. `maxWorkers` now
uses `min(16, availableParallelism())`; the obsolete, ignored `minWorkers` setting
is removed. The runtime API observes affinity and cgroup CPU quotas, unlike
`os.cpus().length`. CI logs its selected budget. A constrained full-shard toggle
reproduces the timeout/shutdown class at16 workers and removes it at the runtime
budget without altering native loading, isolation, assertions or any timeout.
The three named failures had their own existing `vi.setConfig({testTimeout:15000})`
overrides; they were not default-timeout or project-inheritance failures. Those
overrides remain unchanged. Full evidence and hosted acceptance status:
`docs/FRONTEND-SETUP-COST.md` at repo root.

Bun 1.4.2 / Vitest 5.0.0: **375 files / 6,234 tests, zero failures in three
consecutive full `bun run --filter frontend test` runs**, identical to the
then-current-main baseline (`ca5b0b20`). That pair of numbers is the SETUP-COST
EXPERIMENT'S OWN before/after control and is frozen at its base commit — the
point was that native loading changed the clock and not the counts. The
suite has since absorbed PRs #342/#344 and stands at **378 files / 6,271
tests** on merged `main`; `../../AGENTS.md` → DEP BASELINE is the single place
that figure is maintained, and this paragraph must not be re-synced to it. Final wall times: **132.286 / 131.299 /
124.110 seconds**, mean **129.232 seconds**; Vitest Duration: **124.62 / 125.91 /
118.60 seconds**, setup **3 / 3 / 4%** of aggregate phase time. Baseline wall
times were **656.451 / 669.204 seconds**, mean **662.827 seconds**, with setup
84% in both. The full command is **80.50% faster locally**; these are workstation
measurements, not CI timings. Adopted: native loading of the compiled catalog
and module-scoped eager-registration memoization. Rejected/not selected: broad
optimizer, filesystem cache, shared components, pure-isolation flip and heuristic
per-file namespace selection. Storage, full catalog and the teardown wait remain.

```bash
bun run dev / build / check / test       # Vite :6173 / dist/ / svelte-check / vitest
bun run build:federation                  # Vite lib-mode → dist/federation/<ceraui-version>/{encoder,audio,server}.js
bun run sign:federation                    # (root) SRI + GPG bundle sigs + signed manifest.json (Task 40)
bun run test:federation-abi                # (root) build + mount the BUILT bundles against host-contract.ts
# Linting is Biome-only, run from the workspace root: `biome check .` (or `bun run lint`)
```

