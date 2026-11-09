<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam; renamed from the 2026-08 baseline and rewritten for the November 2026 refresh -->

## DEP BASELINE (as of 2026-11)

This table records what the November 2026 dependency refresh delivered. Every
version below was read from the manifests and `bun.lock`; a row's range style is
the one its manifest uses. Packages the refresh deliberately kept behind the
registry are in **Held back**, each with its reason and the condition that
releases it.

Evidence for this baseline is host/CI only; no board has run it.

**Where a change here also moves a WORKSPACE-ROOT document — the root `AGENTS.md`, the
root `ARCHITECTURE.md`, `docs/COMPLETENESS-MATRIX.md`, `docs/RELIABILITY-FINDINGS.md`, or
the root `versions.yaml` pin — that edit is NOT made from this repo.** Root truth is owned
by todo 49 of the `ceraui-experience-stability` plan, on its own docs-only branch and PR,
so a CeraUI PR that also edits the parent tree is a Rule-D violation wearing a
documentation hat. Reference the root row here; let todo 49 write it there.

| Package | Version |
|---------|---------|
| `@orpc/server` (backend), `@orpc/contract` (packages/rpc) | 2.0.0-beta.49, EXACT pin; see "oRPC" below |
| Bun pin (`.bun-version`) | 1.4.4; exact in `package.json` `packageManager`, `mise.toml` and every workflow's `bun-version`; `@types/bun` resolves 1.4.4 with each package's existing range style. Historical measurements below retain their original runtime versions. |
| `svelte` (frontend, i18n) | 5.57.0; EXACT, held back (see below) |
| `vitest` | 5.1.0; EXACT. Current suite: **442 files / 7,432 tests, 0 failures** locally (measured on the held-dependency retry, November 9, 2026, Bun 1.4.4) |
| `vite` | ^8.3.6, lock 8.3.6 |
| `jsdom` | ^31.0.0, lock 31.0.0 (engines `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0`; satisfied by the Node 26 pin) |
| Node | **26 wherever Node runs at all** — REQUIRED baseline, not a canary. `build-check.yml`, `publish-deb.yml`, and `publish-release.yml` all pin `NODE_VERSION: "26"`; `mise.toml` and both `volta.node` fields (root + `apps/frontend`) match. No cache key is keyed on the version, so the flip needs no cache bust. The `test-fe` shards, `merge-fe-reports`, and `guardrails` are the jobs with NO `setup-node` step — every command in them is Bun (see the Vitest note below). |
| `tailwindcss` (+ `@tailwindcss/vite`/`@tailwindcss/postcss`) | ^4.3.5, lock 4.3.5 |
| `@biomejs/biome` | 2.6.6; EXACT, via `@ceralive/biome-config` `^2026.11.0` (lock 2026.11.0, published) |
| `bits-ui` | ^2.20.4, lock 2.20.4; dialog adaptations below; newer patches held |
| `@playwright/test` | ^1.65.0, lock 1.65.0 |
| `@lucide/svelte` | ^1.70.0, lock 1.70.0 |
| `@inlang/paraglide-js` | 3.2.1; EXACT (`packages/i18n` + `apps/frontend`, kept in lockstep) |
| `svelte-check` | ^4.7.8, lock 4.7.8 |
| `@sveltejs/vite-plugin-svelte` | ^7.3.1, lock 7.3.1 |
| `@axe-core/playwright` | ^4.14.0, lock 4.14.0; HUD label-in-name defect corrected |
| `@types/node` | ^26.6.6, lock 26.6.6 (matches the Node 26 runtime baseline) |
| `zod` | ^4.6.7 (workspace catalog), lock 4.6.7 |
| `winston` | ^3.19.0, lock 3.19.0 |
| `vite-plugin-pwa` | ^2.0.0, lock 2.0.0 |
| `tailwind-variants` | ^4.0.1, lock 4.0.1 |
| `svelte-persistent-runes` | ^2.1.0, lock 2.1.0; held back (see below) |
| `typescript` | ^6.0.3 (workspace catalog), lock 6.0.3; held back by owner decision (see "TypeScript") |
| `vaul-svelte` | 1.0.0-next.7 — pinned EXACT; the "stable" 0.3.2 is a DOWNGRADE, never bump to it |

### Held back

These versions stay behind the registry under the refresh's no-regression
condition. Manifest range styles stay unchanged except for the exact Svelte hold.
Release each one only when its condition holds and the full gate is green.

| Package | Retained version | Reason |
| --- | --- | --- |
| `svelte` (frontend and i18n) | exact `5.57.0` | Rechecked November 9, 2026: `sveltejs/svelte#18919` is OPEN, with no closure or fix comment; registry latest remains `5.57.3`. Retain the exact pin until the issue closes or a released fix is evidenced. |
| `bits-ui` (frontend) | `^2.20.4`, lock resolves `2.20.4` | Rechecked November 9, 2026 after the canonical localization merge: `2.20.6` with the product fixes produces a 1,159.28 kB devtools chunk and fails the unchanged 1,159 kB build-warning gate. The earlier matched `2.20.5` control also fails at 1,159.10 kB. `2.20.4` with the final fixes builds successfully at 1,158.75 kB. Retain the newest passing patch until newer releases fit the build gate without widening its limit. |
| `svelte-persistent-runes` (frontend) | `^2.1.0`, lock resolves `2.1.0` | Rechecked November 9, 2026 against published `2.2.0`: the same `$persist` input emits `createPersistence`/`track` instead of `load`/`save`; the exact runtime substitute exports only the old pair, and the preprocessor offers no legacy mode. JSON bytes still match, but stored `null` now restores as `null` instead of the initial value, and assigning `undefined` removes an existing key instead of preserving it. The isolated retry fails 26 of the unchanged 38 federation assertions with an undefined function call. Keep the hold until an explicit runtime migration preserves the required storage semantics and all 38 unchanged federation assertions pass. |
| `typescript` (catalog) | `^6.0.3`, lock resolves `6.0.3` | TypeScript 7 is outside the approved refresh scope. |
| `vaul-svelte` (frontend) | exact `1.0.0-next.7` | Registry `latest` is `0.3.2`, a downgrade. |


Svelte's status was re-read on 2026-11-09: `sveltejs/svelte#18919` ("Major
performance regression when computing reactivity") is still OPEN, and registry
`latest` is `5.57.3`. Lift the exact `5.57.0` pin once that issue closes and a
release carries the fix, or a released fix is independently evidenced while the
issue remains open.

The November 9 held-package retry corrects product accessibility gaps:

- **HUD label in name:** the trigger takes its accessible name from its visible
  lifecycle, health and telemetry content. The existing "Expand details" action
  is a visually hidden, instance-specific `aria-describedby` description,
  rather than an `aria-label` that replaces those visible labels. Three component
  cases cover Idle, Live and Offline. Axe 4.14.0's allowed-rule baseline is unchanged.
- **Disabled codec semantics:** `AudioDialogContent` explicitly supplies
  `aria-disabled` alongside `disabled`. Bits-ui 2.20.0 PR #2227 makes a synthetic
  click open the real options; the old test's no-options fallback had hidden this
  omission, which is also present in the old Select implementation. The test now
  requires real role-based Opus/AAC options and preserves the original DOM
  assertions. The underlying transport helper still has direct AAC/Opus coverage
  for SRTLA, SRT and RIST in the RPC schema tests. The standalone SIM test retains
  its exact DOM-removal assertion inside bounded `waitFor`, respecting PR #2199's
  presence-frame completion timing instead of the old jsdom-only immediate path.
  Managed shadcn primitives, visual baselines and persisted-state ABI are unchanged.
- **Audio-source combobox name:** PR #2216 gives `Select.Trigger` the combobox
  role, whose name must be supplied explicitly. `SourceSection` associates the
  trigger with its existing visible selection text, including the unavailable
  selection branch. A component case locks its accessible name; no visual content
  or test allowlist changes.

### What the refresh delivered

- **Bun 1.4.4.** Pins and lockfile moved from 1.4.3. A runtime re-audit of the
  1.4.2 to 1.4.4 range found the Linux pidfd failure-path change (oven-sh/bun
  commit `f86be9d`, PR #40080: kill then reap, instead of waiting). It's already
  present in Bun 1.4.3, so the add-on helper classification stays unchanged.
- **oRPC 2.0.0-beta.49, exact.** See "oRPC" below for why registry `latest`
  isn't taken and what the beta.36 to beta.49 audit found.
- **Minor and patch sweep.** Seven unused backend packages are gone:
  `http-proxy`, `finalhandler`, `serve-static`, `npm-run-all2`,
  `@types/http-proxy`, `@types/finalhandler` and `@types/serve-static`.
- **Paraglide 3.2.1, exact,** in frontend and i18n, with message-format `4.6.0`
  and m-function-matcher `2.4.3`. Both compiler layouts keep byte-identical
  rendering across all ten locales. Explicit message-modules for the SPA and
  locale-modules for federation keep the existing registry and runtime paths.
  No catalog key needs Paraglide 3's reserved-name allocation.
- **tailwind-variants 4.0.1.** Class strings match `3.3.1` for all 107 variant
  combinations of the six `tv()` recipes. Its default entry bundles its own merge
  engine beside the `tailwind-merge` that the local `cn` uses: the SPA `devtools`
  chunk grows by 9,281 B gzip and federation `toast-host.js`, already over its
  budget, by 5,841 B gzip. Sharing one engine through `tailwind-variants/lite`
  with `tailwind-merge` injected would edit the CLI-managed primitives, so it
  needs an owner decision.
- **Vitest 5.1.0 and jsdom 31.** The test and shard commands keep
  `bun --bun vitest`; the executable's Node shebang still selects Node without
  the explicit flag. Jsdom 31 reports a visible document as focused, and the two
  overlay-test RPC doubles now include the `rpc.ui.heartbeat` method that Layout
  calls. Their assertions are unchanged.
- **vite-plugin-pwa 2.0.0.** Its installed runtime output is byte-identical to
  `1.3.0`; the optional assets-generator peer is unused. The production service
  worker keeps all 94 precache entries and identical registration, immediate
  activation, cache cleanup, navigation and runtime-cache behavior. The web
  manifest is byte-identical. Only the app version timestamp and what follows
  from it (entry-chunk hash, HTML reference, precache revisions) change between
  builds. Federation still excludes the PWA plugin.
- **Biome 2.6.6 via canon 2026.11.0.** The frontend now extends the registry
  canon explicitly in `apps/frontend/biome.jsonc`, so its Svelte parser and rules
  actually run. Adoption is staged: 74 existing findings stay at warning severity,
  beside nine newly exposed `noGlobalIsFinite` warnings and the original 33.
  Biome reports 0 errors, 116 warnings and 3 infos. Svelte formatting is held
  (biomejs/biome#12994; open human PR #438 touches Svelte files). The staged rule
  list, exact counts, the managed shadcn primitives note and the promotion
  criteria live in [conventions.md](conventions.md).

### Known issues carried by this baseline

- **Federation bundle budgets are exceeded, and no CI job enforces them.** The
  `toast-host.js` and `audio.js` gzip ceilings in `scripts/ci/bundle-report.mjs`
  are 674,809 B and 7,709 B. Both were already over before this refresh:
  678,669 / 7,724 B at the oRPC commit, 686,902 / 7,746 B after the minor sweep,
  and 693,110 / 7,750 B after Biome. `build-check.yml` runs the report after
  `build:frontend` only, so the federation half reports "absent, skipped".
  `publish-release.yml` builds federation but never runs the report. Tracked
  under `TD-federation-i18n-catalog-size` in `docs/TECHNICAL_DEBT.md`.
- **Hosted functional E2E covers functionality; no hosted visual job exists.**
  `build-check.yml` runs functional E2E with `@visual` excluded. The dependency
  refresh's qualified visual parity assessment comes from the base-versus-merged
  comparison of `116cba73` and `3c669487`: **239/45/144** versus **240/46/142**
  pass/fail/skip. No persistent introduced regression was reproduced. The only
  original pass-to-fail case, `task-1-switch`, fails identically on both trees
  when run alone. The Sharing degraded captures differ by 6–17 pixels at a
  maximum channel delta of 1/255; the cause remains unproven, so exact raster
  parity remains unresolved. The retained dependency-refresh visual comparison
  records the full results and serial controls; hosted CI does not establish
  visual parity.
- **tailwind-variants bundles a second merge engine** (see above) until the
  owner decides on the `lite` entry.

**`vitest` reached stable 5.0.0 during this effort and remains pinned exact, after earning
that move by flipping a runtime verdict.** Under `vitest@4.1.10` the
frontend suite could not be collected under Bun at all — 110 of 281 files died on a shared
`undefined is not an object (evaluating 'z.enum')` in the Zod schema import graph — and that is
why the frontend suite ran on Node for as long as it did. Under `5.0.0` Bun runs the
current suite at **378 files / 6,271 tests, 0 failures locally** — re-confirmed 2026-09-08 on
merged `main` at `4ba8a774`, one clean `bun run --filter frontend test` in 145.68 s with the
phase split `import 30% / tests 30% / transform 29% / environment 8% / setup 4%` (the
rc.3→stable pin move itself was proven at parity on the then-current
**361 files / 5,957 tests**, and every count since has only grown with new tests).
**The `vitest` row of the table above is the ONE place the current count is maintained;** the 378 / 6,271 figure in this paragraph is the 2026-09-08 measurement. Three other paragraphs quote a
file count for a specific historical proof and each says so in place; when this number moves,
move it here and leave those alone. The 4% setup share is the measured result of the native
i18n loading change, not an aspiration.
The rc.2→rc.3 successor path needed no source or config change here, and Vitest then reached
stable 5.0.0 during this effort. Nothing in the rc.3→5.0.0 release notes needed a source or
config change here:
`clearMocks` now defaults to `true` and the suite is unaffected, and the repo uses none of the
removed surfaces (`test.sequential`, `vitest/reporters`/`vitest/coverage`/`vitest/suite`, `bench`
at module scope, `VITEST_WORKER_ID`, `populateGlobal`, unawaited `.resolves`). **The frontend
`test` script therefore invokes `bun --bun vitest run`, and `test-fe` has no `setup-node` step.
That one command now runs TWO Vitest `projects` — `pure` (Node, `isolate:false`) and
`components` (jsdom, `isolate:true`) — assigned by the import-graph classifier in
`scripts/ci/vitest-classify.mjs`, so `test.projects` (never the removed `workspace` key) is
where runner settings are split; see `apps/frontend/README.md` → "Unit-test projects".**
The explicit `--bun` is load-bearing: `node_modules/.bin/vitest` carries a `#!/usr/bin/env node`
shebang, so a bare `vitest run` under `bun run` still executes on Node — measured, a probe test
reported `process.execPath` = node and `process.versions.bun` = `undefined` before the flip, and
bun / `1.4.2` after it. The prerelease was pinned exact to prevent an unreviewed move into
stable 5.0.0; that pin move did not require a runtime change.

The frontend Vitest config keeps a global `testTimeout` of **20 seconds**. The
worker pool is capped at `min(16, availableParallelism())`, not a fixed16 workers.
PR345's first hosted run exposed resource starvation despite the local results
below; a constrained shard reproduces it at16 workers and clears it at the runtime
budget with no timeout or isolation change. The new full local run after merging
#342/#344 passes378files/6,271tests on four CPUs; hosted acceptance is a separate
required gate recorded in `docs/FRONTEND-SETUP-COST.md`. The
2026-09-08 setup-cost measurements passed **375 files / 6,234 tests** three times
at **132.286 / 131.299 / 124.110 seconds wall clock** (mean **129.232 seconds**;
Vitest Duration **124.62 / 125.91 / 118.60 seconds**). The same-main baseline
averaged **662.827 seconds**, so the full command is **80.50% faster locally**.
Only already-compiled i18n ESM is loaded natively; its registry and locale runtime
stay in one graph, while Svelte and app code remain transformed and isolated.
Setup's aggregate phase share falls from 84% to 3–4%. These are LOCAL workstation
measurements, not hosted-CI timings; phase shares are aggregate worker time, not
wall-time slices. Full table: `docs/FRONTEND-SETUP-COST.md`; this file carries the current
DEP BASELINE. The components project's 50 ms
`afterAll` remains once per FILE, not per test, and is retained deliberately:
`bits-ui`'s body-scroll-lock arms a 24 ms WALL-CLOCK timer inside
Testing Library's own auto-`afterEach`, so no macrotask drain and no fake-timer install can
clear it. Across two CI
runs, three unrelated async-rendering tests (`PowerDialog.async-state`,
`ModemConfigDialog.usbmode`, and `ModemConfigDialog.apn`) each exhausted the default 5-second
budget while every other test passed. The varying victim and identical boundary establish
runner-load starvation rather than three independent hangs. Twenty seconds is deliberate:
four times the default provides scheduler headroom without turning the timeout into the
60-second-or-longer non-safety-net that would conceal a genuine stuck test. Do not accumulate
per-test overrides for this load class; reserve explicit longer limits for tests whose own
documented operation genuinely exceeds the suite-wide budget.

The same flip reaches `publish-release.yml`'s `frontend-tests` job for free, because it calls the
same `bun run --filter frontend test` script — and that job never had a `setup-node` step, so
before the flip it was running Vitest on whatever Node the runner shipped. It is now pinned to
Bun 1.4.4 like every other command in it. That job's own step ORDER is a separate, documented
contract (vitest must stay immediately after `bun install`) and is untouched.

**oRPC is pinned EXACT on a 2.0 beta.** `^2.0.0-beta.49` would range forward across betas and into stable
2.0.0, which is not acceptable for a device runtime. CeraUI is insulated from v2's biggest break — the RPC
serializer / error-body wire-format change — because `apps/backend/src/rpc/adapter.ts` speaks its own Bun
WebSocket `{id, path, input}` protocol and calls oRPC's `call()` directly; there is no `RPCHandler` or
`RPCLink` here. v2 removed `.route()`/`.prefix()`/`.tag()` from the builder (OpenAPI routing moved to
`openapi()` metadata in `@orpc/openapi`), so the push-only subscription entries in `packages/rpc/src/contracts/`
are declared as a bare `oc`. Do not reintroduce route metadata — CeraUI serves no OpenAPI surface.
Reserved router keys in v2 (`then`, `bind`, `valueOf`, `toString`, `toJSON`) must never be used as a
procedure or child-router key.

Beta.31's breaking change remains outside CeraUI's surface: it changes only
`CORSHandlerPlugin`'s HTTP response default from reflected origin to `*` and permits async
`origin`/`timingOrigin` resolvers. Beta.32 adds the prototype-pollution protection handler plugin,
changes standard-handler interceptor plumbing (including CSRF refusal through `ORPCError`), and
adds a response-compression content-type resolver; none is used by CeraUI. CeraUI instantiates no
handler or CORS plugin; the Bun WebSocket adapter navigates the router and invokes `call()` directly.
The `call()`, `oc.router()`, `oc.input()`/`oc.output()`, and error-code lookup exports used here are
unchanged; no `adapter.ts` compatibility edit is required.

**Why registry `latest` isn't taken.** On 2026-11-08 the registry's `beta` tag
was `2.0.0-beta.49` and `latest` was `1.16.2`; no stable 2.x exists. Taking
`latest` would be a major downgrade, so both packages stay exact on beta.49, and
`bun.lock` carries exactly one entry each for `@orpc/client`, `@orpc/contract`,
`@orpc/server` and `@orpc/shared`.

**The beta.36 to beta.49 audit.** The release notes and the v1 migration guide
list these changes: beta.37 removes adapter interceptors and plugins and RegExp
serialization; beta.44 changes malformed transport responses; beta.45 changes
retry, the error-status map and adapter options; beta.46 trims internal exports
(`call` stays); beta.49 changes option shapes. CeraUI touches none of them. The
installed beta.49 still exports `call`, still raises `ORPCError` `BAD_REQUEST`
for input validation and `INTERNAL_SERVER_ERROR` for output validation, keeps
`.code`, and keeps `['~orpc'].inputSchemas` on contract procedures. No production
code or test assertion changed.

### TypeScript: one catalog

The workspace catalog is the single source of truth for **TypeScript 6.0.3**.
Every workspace package declares `"typescript": "catalog:"`, including the
backend, RPC, and i18n packages. This makes each package's declared compiler
equal the version Bun resolves rather than leaving an unsatisfied direct range.

TypeScript 7 remains a separate major-version migration. Do not change the
catalog until `svelte-check` supports its peer/API surface and the migration has
an explicit owner decision and full gate run.

Owner decision 2026-11-08: stay on 6.0.3; TS 7.0 has no compiler API.

Never invoke a bare `tsc`; every typecheck goes through
[`scripts/tsc.mjs`](../../scripts/tsc.mjs), which resolves the compiler from the
invoking package's dependency graph. `bun tsc` remains banned: only the wrapper
guarantees package-local compiler selection (oven-sh/bun#37152).

Fast-reload development loop (dev-sync / dev-push): [`image-building-pipeline/v2/docs/fast-reload.md`](https://github.com/CERALIVE/image-building-pipeline/blob/master/docs/fast-reload.md)
