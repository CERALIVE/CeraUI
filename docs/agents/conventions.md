<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## CONVENTIONS

- Linting/formatting: Biome 2.6.6 via published `@ceralive/biome-config` 2026.11.0. The root and frontend explicitly extend the registry canon. Frontend configuration is `apps/frontend/biome.jsonc` so its staged-adoption rationale can use a valid comment block; `biome.json` rejects comments. Other nested configurations retain their existing scope. Frontend JavaScript keeps double quotes and 80 columns. Root fixture exclusions remain unchanged.
- Svelte: all 14 canonical Svelte rules and both unused-symbol checks run. `root: false` alone did not inherit the canon; direct canon inheritance fixes the 2,440 template-usage false positives. All six reported bindings in `custom/AppliesNextStart.svelte` are recognized, and the scratch `$inspect(x)` negative control fails with `nursery/noSvelteInspect` at error severity.
- Svelte formatting held: biomejs/biome#12994; open human PR #438 touches Svelte files. Keep `formatter.enabled: false` for `**/*.svelte`.
- Zero-warning compiler/build gates remain: frontend `check` runs `svelte-check --fail-on-warnings`, and frontend `build` runs `scripts/ci/build-warnings-gate.mjs`. Biome's staged warnings are separate: baseline 0 errors / 33 warnings / 4 infos; adopted configuration 0 errors / 116 warnings / 3 infos. No new suppression or ignore was added.

### Staged frontend lint adoption (2026-11)

The frontend did not previously inherit the canon, so these existing findings were
not enforced. The orchestrator approved staging the following exact rules at
`warn` for this dependency refresh. Debt owner follow-up for every row: **fix then
promote to error**, with source, unit, accessibility and visual evidence as needed.
Rules with no remaining findings were not downgraded.

| Rule | Before staging | After staging | Follow-up |
| --- | ---: | ---: | --- |
| a11y/useSemanticElements | 36 errors | 36 warnings | Fix then promote to error. |
| a11y/useAriaPropsSupportedByRole | 10 errors | 10 warnings | Fix then promote to error. |
| nursery/useSvelteRequireEachKey | 14 errors | 14 warnings | Preserve item identity/lifetimes; fix then promote to error. |
| nursery/useSvelteReactiveClasses | 4 errors | 4 warnings | Review immutable sets and imperative subscriber/toast bookkeeping; fix then promote to error. |
| a11y/useValidAnchor | 1 error | 1 warning | Fix then promote to error. |
| a11y/useFocusableInteractive | 1 error | 1 warning | Fix then promote to error. |
| a11y/useKeyWithClickEvents | 1 error | 1 warning | Fix then promote to error. |
| a11y/noNoninteractiveTabindex | 1 error | 1 warning | Fix then promote to error. |
| suspicious/noExportsInTest | 4 errors | 4 warnings | Preserve shared test-helper contracts; fix then promote to error. |
| suspicious/noConsole | 2 errors | 2 warnings | DevTools deliberately exercises console.log/table; fix then promote to error without changing that tool's behavior. |

Six findings in four CLI-managed primitives require a sanctioned generator/source
change, not hand edits: breadcrumb-link.svelte (useValidAnchor),
breadcrumb-page.svelte (useFocusableInteractive and useSemanticElements),
input-group-addon.svelte (useKeyWithClickEvents and useSemanticElements), and
input-group.svelte (useSemanticElements). Current upstream generator payloads retain
these patterns; regenerating input-group also changes its dimensions. No managed
markup or accessibility behavior was changed in this refresh.

| Fixed finding | Before | After | Proof |
| --- | ---: | ---: | --- |
| nursery/noSvelteLegacyConst | 161 errors | 0 | Pinned Svelte 5.57.0 emits identical client JavaScript and CSS across all 44 components. |
| nursery/noSvelteUselessDerivedBy | 3 errors | 0 | Identical compiled JavaScript and CSS for both affected components. |
| nursery/noFloatingPromises | 24 test errors | 0 | Await Testing Library events; assertions unchanged. |
| assist/source/organizeImports | 52 initial + 3 after parser activation | 0 | Import bindings retained except the two independently proved unused symbols below. |
| style/useImportType | 2 warnings | 0 | LocaleCode emits identical output; the unused bits-ui type namespace is erased. bits-ui declares sideEffects:false and remains a runtime dependency of the rendered alert primitives. |
| correctness/noUnusedImports (new Svelte findings) | 2 warnings | 0 | Remove unused isApRadio and type CapabilityView; neither is used in script or markup. |
| suspicious/noEmptyBlockStatements | 1 error | 0 | Disabled Start callback still returns undefined without effects. |
| a11y/useButtonType | 6 errors | 0 | Navigation/retry buttons have no form ancestor or submit role; unused mobile-link and the test stub also have no form use. |

Unchanged baseline warnings: noConfusingVoidType 1, noUnusedImports 1,
noUnusedVariables 2, useAwait 29. Newly exposed noGlobalIsFinite remains at its
existing warning severity (9); Number.isFinite would change coercion semantics.
Staging adds 74 warnings, so total warnings rise by 83 to 116. The remaining infos
are useTemplate 1 and useLiteralKeys 2; the schema-version deserialize info is gone.

References actually checked:
[Biome monorepo inheritance](https://biomejs.dev/guides/big-projects/),
[HTML/Svelte support](https://biomejs.dev/internals/language-support/),
[biomejs/biome#8590](https://github.com/biomejs/biome/issues/8590) (cross-language
tracking), [#11215](https://github.com/biomejs/biome/issues/11215) (generics/directive
shorthands), [PR #12246](https://github.com/biomejs/biome/pull/12246) (class/style
shorthands), and [PR #12280](https://github.com/biomejs/biome/pull/12280) ($store
imports). [PR #11093](https://github.com/biomejs/biome/pull/11093) is a branch rollup.
[#12994](https://github.com/biomejs/biome/issues/12994) is only the formatter issue;
it is not the unused-symbol diagnosis. No unused-symbol exception remains.

- Strict TS: `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` are enabled in `tsconfig.json` (root), `apps/backend`, and `packages/rpc`. The frontend app (`apps/frontend/tsconfig.app.json`) and `tsconfig.node.json` enable `strict` + `noUncheckedIndexedAccess`; `exactOptionalPropertyTypes` is intentionally omitted there because it is incompatible with bits-ui v2 / shadcn-svelte and vite-plugin-pwa types (unfixable "union too complex" errors in CLI-managed components). The e2e tsconfig stays at baseline `strict` (ungated Playwright test code).
- Mock hardware in dev via `MOCK_SCENARIO` env var (`multi-modem-wifi` default). Use `shouldUseMocks()` — never raw `isDevelopment()` — to gate mock paths.
- `LOG_LEVEL` env var overrides the Winston transport level for ALL transports (console + file). Unset = per-transport defaults (dev console `info`, prod console `warn`, file `debug`). Set `LOG_LEVEL=debug` to enable per-RPC trace lines.
- Backend binary compiled with `bun build --compile`; target set by `BUILD_ARCH`.
- Frontend is a PWA — service worker via `vite-plugin-pwa`.
- Validation constants live in `packages/rpc/src/schemas/`; the frontend reads them via `ValidationAdapter.ts` — never add inline numeric literals to dialog components.
- All config dialogs compose `AppDialog.svelte` (desktop Dialog / mobile Sheet via `MediaQuery` from `svelte/reactivity`).
- E2E Testing: REQUIRED reading before writing E2E tests → [`apps/frontend/tests/e2e/PLAYBOOK.md`](../../apps/frontend/tests/e2e/PLAYBOOK.md)
- Technical debt: every debt this overhaul introduces is tracked in the machine-checkable register `docs/TECHNICAL_DEBT.md`, enforced by `scripts/check-tech-debt.mjs` (the `check:tech-debt` script, **blocking** in the `test` CI job). Any source `data-debt-id="TD-NNN"`, `coming-soon`, or in-source `[PARTIAL]` marker MUST point at an `open` register entry — an orphan marker or a malformed entry fails CI. It extends the `image-building-pipeline/v2/docs/DEFERRED.md` ledger pattern and does NOT duplicate the root status-label system (`docs/CONVENTIONS.md`). Full contract: `docs/CONVENTIONS.md` → Technical-Debt Register.

