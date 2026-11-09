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
| `vitest` | 5.1.0; EXACT. Current suite: **443 files / 7,435 tests, 0 failures** locally (measured on the reviewed held-dependency retry, November 9, 2026, Bun 1.4.4) |
| `vite` | ^8.3.6, lock 8.3.6 |
| `jsdom` | ^31.0.0, lock 31.0.0 (engines `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0`; satisfied by the Node 26 pin) |
| Node | **26 wherever Node runs at all** — REQUIRED baseline, not a canary. `build-check.yml`, `publish-deb.yml`, and `publish-release.yml` all pin `NODE_VERSION: "26"`; `mise.toml` and both `volta.node` fields (root + `apps/frontend`) match. No cache key is keyed on the version, so the flip needs no cache bust. The `test-fe` shards, `merge-fe-reports`, and `guardrails` are the jobs with NO `setup-node` step — every command in them is Bun (see the Vitest note below). |
| `tailwindcss` (+ `@tailwindcss/vite`/`@tailwindcss/postcss`) | ^4.3.5, lock 4.3.5 |
| `@biomejs/biome` | 2.6.6; EXACT, via `@ceralive/biome-config` `^2026.11.0` (lock 2026.11.0, published) |
| `bits-ui` | ^2.20.6, lock 2.20.6; reviewed control-name and dialog adaptations below |
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
| `svelte-persistent-runes` (frontend) | `^2.1.0`, lock resolves `2.1.0` | Rechecked November 9, 2026 against published `2.2.0`: the same `$persist` input emits `createPersistence`/`track` instead of `load`/`save`; the exact runtime substitute exports only the old pair, and the preprocessor offers no legacy mode. JSON bytes still match, but stored `null` now restores as `null` instead of the initial value, and assigning `undefined` removes an existing key instead of preserving it. The isolated retry fails 26 of the unchanged 38 federation assertions with an undefined function call. Keep the hold until an explicit runtime migration preserves the required storage semantics and all 38 unchanged federation assertions pass. |
| `typescript` (catalog) | `^6.0.3`, lock resolves `6.0.3` | TypeScript 7 is outside the approved refresh scope. |
| `vaul-svelte` (frontend) | exact `1.0.0-next.7` | Registry `latest` is `0.3.2`, a downgrade. |


Svelte's status was re-read on 2026-11-09: `sveltejs/svelte#18919` ("Major
performance regression when computing reactivity") is still OPEN, and registry
`latest` is `5.57.3`. Lift the exact `5.57.0` pin once that issue closes and a
release carries the fix, or a released fix is independently evidenced while the
issue remains open.

The November 9 held-package retry corrects product accessibility gaps:

- **HUD label in name:** a native full-row label activates the details button.
  That button references the visible lifecycle and distinct health words through
  `aria-labelledby`; duplicate Idle is omitted from its name. Telemetry and the
  health reason remain separately accessible in the unchanged row layout.
  "Expand details" remains the localized `aria-describedby` action hint.
  Exact-name cases cover Idle, Live and Offline; a six-link idle case requires
  the single-word name Idle and all six accessible link readings. Axe 4.14.0's
  allowed-rule baseline is unchanged.
- **Disabled codec semantics:** `AudioDialogContent` explicitly supplies
  `aria-disabled` alongside `disabled`. Bits-ui 2.20.0 PR #2227 makes a synthetic
  click open the real options; the old test's no-options fallback had hidden this
  omission, which is also present in the old Select implementation. The test now
  requires real role-based Opus/AAC options and preserves all original DOM and
  helper assertions unconditionally. The transport helper also retains direct AAC/Opus coverage
  for SRTLA, SRT and RIST in the RPC schema tests. The standalone SIM test retains
  its exact DOM-removal assertion inside bounded `waitFor`, respecting PR #2199's
  presence-frame completion timing instead of the old jsdom-only immediate path.
  Managed shadcn primitives, visual baselines and persisted-state ABI are unchanged.
- **Audio-source combobox name:** PR #2216 gives `Select.Trigger` the combobox
  role, whose name must be supplied explicitly. `SourceSection` associates the
  trigger with its existing visible selection text, including the unavailable
  selection branch. A component case locks its accessible name; no visual content
  or test allowlist changes.
- **Conditional selector names:** all 16 product Select triggers were audited.
  The roaming-network and developer hardware-profile selectors now associate
  their existing visible labels with their controls. Mounted exact-name tests
  cover both, and the roaming browser case covers desktop and mobile widths.
- **Released bits-ui hold:** after the canonical shared-merge-engine and budget
  changes, 2.20.6 passes the ordered full build, federation assets and bundle
  report. Toast-host is **681,359 B / 688,543 B** and audio is **7,733 B / 7,881 B**
  gzip. No ceiling was raised by this retry.

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
  combinations of the six `tv()` recipes. The original default entry added
  9,281 B gzip to the SPA `devtools` chunk and 5,841 B to federation toast-host.
  The November 9 follow-up shares `cn`'s `tailwind-merge` through
  `createTV({ twMerge })` from `tailwind-variants/lite`. An exact bundler alias
  reaches a local module in the SPA, federation and both Vitest configs;
  svelte-check resolves that same module through its paths configuration.
  No CLI-managed primitive changes. All 107 raw, `cn`, caller-override and
  repeated-call outputs match both 3.3.1 and default 4.0.1 byte for byte, including
  an explicit conflict-resolution example. Unknown recipe/default and call-site
  variant keys still fail svelte-check.
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

- **The federation catalog remains oversized.** The prior budget breaches are
  now explicitly rebaselined and enforced before publication, as detailed below.
  `TD-federation-i18n-catalog-size` in `docs/TECHNICAL_DEBT.md` remains open.
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

### Federation budgets and size analysis

Measured on November 9, 2026 with Bun 1.4.4 after rebasing onto main `85d2b20a`
(PR #438's update-check/image/hotspot changes and the merged notice/Spanish fixes).
Each measurement ran `bun run build`, then `bun run test:federation`, then
`bun scripts/ci/bundle-report.mjs`. The report saw both outputs. Both default and
optimized toast-host measurements still exceed the historical 674,809 B ceiling.

| Metric | Default v4 | Shared lite merger | Delta |
| --- | ---: | ---: | ---: |
| SPA total JS+CSS gzip | 1,084,575 B | 1,073,990 B | -10,585 B |
| SPA largest chunk gzip | 323,839 B | 313,287 B | -10,552 B |
| Federation toast-host gzip | 694,717 B | 680,351 B | -14,366 B |
| Federation toast-host raw | 2,863,836 B | 2,831,065 B | -32,771 B |
| Federation audio gzip | 7,753 B | 7,753 B | 0 B |

All four emitted SPA stylesheets and federation CSS are byte-identical. Small
non-toast gzip changes reflect changed chunk references; raw audio bytes have
the same length. Build timestamps and absolute Svelte source paths can affect
hashes, so these are measured comparisons rather than reproducible-byte promises.

The old baselines came from `e3f17c2a`: toast-host **613,463 B** and audio
**7,009 B**, with a 10% allowance yielding **674,809 B / 7,709 B** ceilings.
Both were already exceeded at the oRPC refresh (**678,669 / 7,724 B**),
before the later dependency changes. This follow-up accepts the existing static
catalog footprint after removing duplicate merging; it does not resolve that debt.

| Asset | Previous baseline | Measured new baseline | Allowance | Previous ceiling | New ceiling |
| --- | ---: | ---: | ---: | ---: | ---: |
| toast-host.js | 613,463 B | 680,351 B | 8,192 B | 674,809 B | 688,543 B |
| audio.js | 7,009 B | 7,753 B | 128 B | 7,709 B | 7,881 B |

The first experiment on `6e0d23db` measured 679,064 B / 7,754 B with lite;
those provisional baselines were superseded before commit. PR #438 adds six
catalog keys across ten locales, revises update copy and extends the RPC schema;
that intermediate `b7403580` tree measured 680,713 B / 7,752 B with lite.
The final constants above also include `85d2b20a`'s notice and Spanish fixes.

Both still retain the smaller of the 10% ratio and the stated absolute allowance.
The toast allowance is about 1.2%, audio about 1.7%; each covers small build/hash
variation without restoring a fresh 10% growth allowance. Every other SPA and
federation budget remains unchanged. The report prints the displaced 2026-08-15
baselines and the original 223,579 B toast-host measurement on every applicable run.

`publish-release.yml` now runs `bundle-report.mjs --federation-only` immediately
after its existing federation build, before signing and R2 upload. This is cheaper
than adding another federation build to every PR: it adds only the measurement
command to a job already producing those exact assets. Build Check keeps its
existing SPA budget gate. The publication mode requires the complete build graph,
entries and CSS, and rejects missing output, partial output, unbaselined assets and
gzip breaches. Workflow-shape and isolated CLI tests run in Build Check's existing
guardrail command; the original federation budget/hash tests remain intact.

A scratch sourcemap analysis on `6e0d23db`, before the subsequent six-key update
addition, attributed final minified toast-host bytes:

| Contributor | Raw attributed bytes, default v4 |
| --- | ---: |
| Static catalog dispatch plus all ten locales | 2,242,362 |
| i18n namespace facade and registry | 105,449 |
| Zod | 100,104 |
| bits-ui | 84,558 |
| Svelte runtime | 54,945 |
| tailwind-variants | 49,128 |
| tailwind-merge | 27,563 |
| Lucide icons | 3,300 |

The analyzer build adds a source-map comment (48 raw bytes); the size table above
uses normal publishable output. Attributed group gzip is not additive. Catalog
code accounts for about 78.5% of toast-host raw bytes. There is one Svelte 5.57.0
runtime and one Zod 4.6.7 graph, not duplicate versions. Only 32 used Lucide icon
modules survive across all federation chunks, not the entire set. No developer UI
component survives. Two small Svelte helpers under its `dev` directory remain
partially retained (2,028 pre-minification bytes); their location alone does not
establish that removing them would preserve runtime semantics.

The accidental duplication was the default variant entry's compiled merge tables.
After the alias, only the lite core and the existing tailwind-merge remain;
tailwind-variants attribution falls to 16,532 raw bytes. No other cheap,
behavior-preserving removal was established.

Larger proposals remain unimplemented: a reviewed federation-only catalog subset
could save roughly **400-500 KiB gzip** from the catalog group's isolated
507 KiB gzip footprint, but changes the current full-catalog contract and needs
all-locale/ABI proof. A compact shared dispatch/registry representation retaining
every key could plausibly save **20-60 KiB gzip**; its basis is the dispatch and
facade's isolated compressed size, not a demonstrated optimized build. These
estimates overlap and must not be added together. Both require a separate i18n
design and parity work; no catalog, frozen fixture, locale, signing graph or ABI
was changed here.

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
