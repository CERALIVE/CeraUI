<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## DEP BASELINE (as of 2026-08)

**Two rows in this table were moved by the experience-stability effort and are current
as written: `vitest` is stable `5.0.0` (the earlier `5.0.0-rc.4` target was tentative and
is superseded), and `@orpc/server`/`@orpc/contract` stay EXACT at `2.0.0-beta.32` —
checked live against the registry, nothing past beta.32 exists.** Both remain exact pins
for the reasons stated below the table; do not soften either to a caret.

**Where a change here also moves a WORKSPACE-ROOT document — the root `AGENTS.md`, the
root `ARCHITECTURE.md`, `docs/COMPLETENESS-MATRIX.md`, `docs/RELIABILITY-FINDINGS.md`, or
the root `versions.yaml` pin — that edit is NOT made from this repo.** Root truth is owned
by todo 49 of the `ceraui-experience-stability` plan, on its own docs-only branch and PR,
so a CeraUI PR that also edits the parent tree is a Rule-D violation wearing a
documentation hat. Reference the root row here; let todo 49 write it there.

| Package | Version |
|---------|---------|
| `@orpc/server` (backend), `@orpc/contract` (packages/rpc) | 2.0.0-beta.32 — EXACT pin, see below |
| Bun pin (`.bun-version`) | 1.4.2 — and so are `package.json` `packageManager`, every workflow's `bun-version`, and `scripts/tsc.mjs`'s resolution note. **`mise.toml` is the one surface still reading `1.4.0`**, recorded here rather than quietly bumped: `oven-sh/setup-bun` reads `packageManager`, so CI is on the canon regardless, and only a developer whose shell resolves Bun through `mise` gets the older runtime. It is a residual from the workspace-wide Bun canon sweep, whose verification grep matched `bun-version:` / `bun@` / `bun:` / a bare `1.4.2` line but not `mise.toml`'s `bun = "1.4.0"` form — the blind spot is worth knowing before trusting that grep again. |
| `svelte` | 5.56.10 |
| `vitest` | 5.0.0 — EXACT stable pin (see the note below the table) |
| `vite` | 8.2.2 |
| `jsdom` | 30.0.1 (requires Node ≥ 24.15; satisfied by the Node 26 pin) |
| Node | **26 wherever Node runs at all** — REQUIRED baseline, not a canary. `build-check.yml`, `publish-deb.yml`, and `publish-release.yml` all pin `NODE_VERSION: "26"`; `mise.toml` and both `volta.node` fields (root + `apps/frontend`) match. No cache key is keyed on the version, so the flip needs no cache bust. The `test-fe` shards, `merge-fe-reports`, and `guardrails` are the jobs with NO `setup-node` step — every command in them is Bun (see the Vitest note below). |
| `tailwindcss` (+ `@tailwindcss/vite`/`@tailwindcss/postcss`) | 4.3.3 |
| `@biomejs/biome` (via the `@ceralive/biome-config` canon) | 2.5.9 — the config dep stays the range `^2026.8.0`; canon `2026.8.1` is committed in the root repo but NOT yet published, and a `^2026.8.1` pin would fail `bun install --frozen-lockfile` today. The caret absorbs it the moment the `biome-config-v2026.8.1` tag publishes. |
| `bits-ui` | 2.19.0 |
| `@playwright/test` | 1.62.1 |
| `@lucide/svelte` | 1.33.0 |
| `@inlang/paraglide-js` | 2.24.1 — EXACT pin (root `packages/i18n` + `apps/frontend`, kept in lockstep) |
| `svelte-check` | 4.7.6 |
| `@sveltejs/vite-plugin-svelte` | 7.3.0 |
| `@axe-core/playwright` | 4.13.0 |
| `@types/node` | 26.2.0 (matches the Node 26 runtime baseline) |
| `zod` | 4.4.3 (workspace catalog) |
| `winston` | 3.19.0 |
| `vite-plugin-pwa` | 1.3.0 |
| `vaul-svelte` | 1.0.0-next.7 — pinned EXACT; the "stable" 0.3.2 is a DOWNGRADE, never bump to it |

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
**This table row is the ONE place the count is maintained.** Three other paragraphs quote a
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
bun / `1.4.2` after it. A caret would range forward into stable 5.0.0 unreviewed, so the pin is
exact; when 5.0 ships stable this pin moves, but the runtime does not have to move with it.

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
wall-time slices. Full table: `docs/FRONTEND-SETUP-COST.md`; the frontend's own
`AGENTS.md` carries the current DEP BASELINE. The components project's 50 ms
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
Bun 1.4.2 like every other command in it. That job's own step ORDER is a separate, documented
contract (vitest must stay immediately after `bun install`) and is untouched.

**oRPC is pinned EXACT on a 2.0 beta.** `^2.0.0-beta.32` would range forward across betas and into stable
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

### TypeScript: one catalog

The workspace catalog is the single source of truth for **TypeScript 6.0.3**.
Every workspace package declares `"typescript": "catalog:"`, including the
backend, RPC, and i18n packages. This makes each package's declared compiler
equal the version Bun resolves rather than leaving an unsatisfied direct range.

TypeScript 7 remains a separate major-version migration. Do not change the
catalog until `svelte-check` supports its peer/API surface and the migration has
an explicit owner decision and full gate run.

Never invoke a bare `tsc`; every typecheck goes through
[`scripts/tsc.mjs`](../../scripts/tsc.mjs), which resolves the compiler from the
invoking package's dependency graph. `bun tsc` remains banned: only the wrapper
guarantees package-local compiler selection (oven-sh/bun#37152).

Fast-reload development loop (dev-sync / dev-push): [`image-building-pipeline/v2/docs/fast-reload.md`](https://github.com/CERALIVE/CeraUI/blob/main/image-building-pipeline/v2/docs/fast-reload.md)

