<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## CONVENTIONS

- Linting/formatting: Biome 2.6.6 via published `@ceralive/biome-config` 2026.11.0. The root and frontend explicitly extend the registry canon. Frontend configuration is `apps/frontend/biome.jsonc`; its JavaScript keeps double quotes and 80 columns. Root fixture exclusions remain unchanged.
- Svelte: all 14 canonical Svelte rules and both unused-symbol checks run. `root: false` alone did not inherit the canon; direct canon inheritance fixes the 2,440 template-usage false positives. No unused-symbol exception remains.
- Svelte formatting held: biomejs/biome#12994. Keep `formatter.enabled: false` for `**/*.svelte`.
- Zero-warning compiler/build gates remain: frontend `check` runs `svelte-check --fail-on-warnings`, and frontend `build` runs `scripts/ci/build-warnings-gate.mjs`.

### Frontend lint enforcement (2026-11)

All ten rule families exposed by canonical inheritance now use error severity.
The previous 74 warnings are resolved with source fixes, the
site exceptions below, and six exact-file exceptions for managed primitives.
All nine global finite checks now use `Number.isFinite`: every argument is
`progress`, `total`, or `progressPercentage`, derived from explicit numeric
conversion or arithmetic. String inputs are still converted at the same boundary.
Biome reports **0 errors / 33 warnings / 3 infos**, down from 0 / 116 / 3.
The unchanged 33 warnings are noConfusingVoidType 1, noUnusedImports 1,
noUnusedVariables 2, and useAwait 29; infos remain useTemplate 1 and useLiteralKeys 2.

Stable each-block keys use hardware enum values, locale codes, toast type tokens,
swatch tokens, link identity numbers, or fixture field names. These are unique
within each corresponding list; no loop-position key is used. The preview link
`index` fields are fixed link identities (1 through 6), not iteration indexes.
Shared scanner and catalog helpers moved beside their tests; assertions are unchanged.

The generator-managed shadcn files remain byte-identical. Four exact-path
`overrides` entries disable only their six reported rules: breadcrumb-link.svelte
(useValidAnchor), breadcrumb-page.svelte (useFocusableInteractive and
useSemanticElements), input-group-addon.svelte (useKeyWithClickEvents and
useSemanticElements), and input-group.svelte (useSemanticElements). Upstream
generator output retains these patterns; regenerating input-group also changes
its dimensions. No directory-wide or rule-wide exception is introduced.

There are **37 added site suppression lines**, so the repository matching-line
total grows **170 -> 207**. Every new site and its reason is listed below;
paths are relative to `apps/frontend/src/`. The four Set/Map sites deliberately
remain non-reactive: field classification is immutable, subscriptions are
imperative, and toast deduplication must not subscribe its effect to its own writes.
Semantic exceptions preserve existing native button activation, custom meter
tracks, or group sizing where a native replacement cannot be shown equivalent.
Telemetry lists use native ul/li with identical classes; the explicit list roles
preserve Safari semantics when Tailwind removes markers. Named block regions use
section with identical classes. No dimensions, classes, layout rules, test
snapshots, visual baselines, or frozen catalog renderings change.

Pull-to-refresh cancellation uses a native button that is disabled and hidden
from assistive technology while inactive. During a pending refresh, Tab reaches
it and Enter/Space dismiss the indicator through its existing click handler.
The touch gesture and callback script is unchanged. Its classes, inline styles,
content geometry, fonts and colors match the earlier surrogate at desktop/mobile
widths in both themes. The real-browser component test
`tests/e2e/pull-to-refresh.component.spec.ts` owns the keyboard contract with a
pending callback; cancellation does not alter that callback's promise lifecycle.

| Site | Rule | Specific reason |
| --- | --- | --- |
| `lib/components/custom/IngestStats.svelte:364` | `a11y/noRedundantRoles` | The session-rollup contribution list needs its explicit list role for Safari when Tailwind removes list markers. |
| `lib/components/custom/IngestStats.svelte:465` | `a11y/noRedundantRoles` | The live per-link telemetry list needs its explicit list role for Safari when Tailwind removes list markers. |
| `lib/components/custom/LinkIndicator.svelte:136` | `a11y/useAriaPropsSupportedByRole` | The dynamic role is img whenever linkAriaLabel is present; otherwise this decoration is aria-hidden. |
| `lib/components/custom/SourceSection.svelte:1020` | `a11y/useSemanticElements` | Input-mode buttons select option.inputMode and lock for streaming or rowDisabled; native radios need separate labels and change their focus model. |
| `lib/components/preview/AudioLevelMeter.svelte:65` | `a11y/useSemanticElements` | This read-only audio group is not a form fieldset; retain its existing block layout and named grouping. |
| `lib/components/preview/AudioLevelMeter.svelte:92` | `a11y/useSemanticElements` | The meter draws separate RMS and peak child tracks; a native meter does not render these custom child tracks. |
| `lib/rpc/field-sync-state.svelte.ts:74` | `nursery/useSvelteReactiveClasses` | This immutable ReadonlySet is a field classification table, not reactive state. |
| `lib/stores/auth-status.svelte.ts:23` | `nursery/useSvelteReactiveClasses` | Imperative subscriptions notify synchronously; tracking Set reads would subscribe effects to listener registration. |
| `lib/stores/display-refresh.svelte.ts:25` | `nursery/useSvelteReactiveClasses` | Listener registration must not trigger reactive consumers; requestDisplayRefresh owns the explicit notification and reactive nonce. |
| `main/dialogs/EncoderDialog.svelte:652` | `a11y/useSemanticElements` | Auto codec clears localCodec to undefined through this text button; a native radio needs a separate label and changes its focus/activation contract. |
| `main/dialogs/EncoderDialog.svelte:666` | `a11y/useSemanticElements` | The H.264 button selects localCodec and disables when h264Supported is false; native radio/label markup changes its hit target and focus model. |
| `main/dialogs/EncoderDialog.svelte:686` | `a11y/useSemanticElements` | The H.265 button selects localCodec and disables when h265Supported is false; native radio/label markup changes its hit target and focus model. |
| `main/dialogs/EncoderDialog.svelte:733` | `a11y/useSemanticElements` | Passthrough Auto stages localPassthrough as auto through this text button; native radio grouping changes its independent Tab stop and label markup. |
| `main/dialogs/EncoderDialog.svelte:747` | `a11y/useSemanticElements` | Passthrough Force stages localPassthrough as force through this text button; native radio grouping changes its independent Tab stop and label markup. |
| `main/dialogs/EncoderDialog.svelte:761` | `a11y/useSemanticElements` | Passthrough Off stages localPassthrough as off through this text button; native radio grouping changes its independent Tab stop and label markup. |
| `main/dialogs/EncoderDialog.svelte:820` | `a11y/useSemanticElements` | The offered Retime choice stages localFailoverPolicy as retime; a native radio needs separate label markup and changes this button focus model. |
| `main/dialogs/EncoderDialog.svelte:834` | `a11y/useSemanticElements` | The offered Adapt choice stages localFailoverPolicy as adapt; a native radio needs separate label markup and changes this button focus model. |
| `main/dialogs/HotspotDialog.svelte:368` | `a11y/useSemanticElements` | This named wrapper groups the existing WiFi mode widget; a fieldset introduces intrinsic sizing and form-group layout. |
| `main/dialogs/ModemConfigDialog.svelte:1784` | `a11y/useSemanticElements` | The wrapping band picker uses a flex row; a fieldset introduces an anonymous content box and intrinsic sizing. |
| `main/dialogs/ModemConfigDialog.svelte:1795` | `a11y/useSemanticElements` | This band toggle keeps button content and click-driven selection; a native checkbox changes its activation and content model. |
| `main/dialogs/ModemConfigDialog.svelte:1912` | `a11y/useSemanticElements` | The 5G choice has title/description/active children and no-SIM, applying and selected gates; a native radio cannot contain that content. |
| `main/dialogs/ModemConfigDialog.svelte:2732` | `a11y/useSemanticElements` | The USB-target button stages usbSelected and may show recommendation text; native radio/label markup changes that staged-selection surface. |
| `main/dialogs/ModemLockSection.svelte:321` | `a11y/useSemanticElements` | The clear-saved-dongle-sign-in confirmation groups its warning and actions; a fieldset introduces different sizing and an anonymous content box. |
| `main/dialogs/RouterDongleDialog.svelte:847` | `a11y/useSemanticElements` | This confirmation panel groups the subnet warning and actions; a fieldset introduces form-group sizing and an anonymous content box. |
| `main/dialogs/audio/AudioDialogContent.svelte:165` | `a11y/useSemanticElements` | Backend choices retain button activation and pending/selected disabled gates; native radios change that interaction contract. |
| `main/dialogs/device-health/MediaLoadPanel.svelte:19` | `a11y/noNoninteractiveTabindex` | Keyboard users need to focus this named read-only region to scroll the dialog body. |
| `main/dialogs/server/DestinationSection.svelte:83` | `a11y/useSemanticElements` | Managed-destination cards include provider icon, label and hint with managedDisabled(choice); a native radio needs different card/label markup. |
| `main/dialogs/server/DestinationSection.svelte:101` | `a11y/useSemanticElements` | The Custom destination card includes its plug icon, label and hint and locks while streaming; a native radio needs different card/label markup. |
| `main/dialogs/server/ServerIngestSlots.svelte:48` | `a11y/useSemanticElements` | Ingest cards contain formatted account labels and badges; native radio inputs cannot preserve that content model. |
| `main/dialogs/updates/UpdateCredentialsRow.svelte:67` | `a11y/useSemanticElements` | This is a read-only credential summary, not a form fieldset; retain its named group and block layout. |
| `main/layout/LayoutToastHost.svelte:30` | `nursery/useSvelteReactiveClasses` | The effect reads and writes this deduplication ledger; making it reactive would subscribe the effect to its own bookkeeping instead of only getActive(). |
| `main/live/CompositionCard.svelte:298` | `a11y/useSemanticElements` | Layout choices use button click actions and explicit save/lock gates; native radios change their activation contract. |
| `main/network/EthernetRoleSelector.svelte:98` | `a11y/useSemanticElements` | Role choices contain nested descriptions and dispatch staged button selections; native radios cannot preserve that content model. |
| `main/network/HotspotActivationConfirm.svelte:137` | `a11y/useSemanticElements` | This warning and confirmation panel is a named action group; a fieldset introduces form-group sizing and an anonymous content box. |
| `main/network/WifiModeSelector.svelte:156` | `a11y/useSemanticElements` | Mode choices contain pending and unavailable glyphs with gated button activation; native radios change the content and activation model. |
| `main/tabs/DevTools.svelte:99` | `suspicious/noConsole` | This DevTools control deliberately tests console.log output. |
| `main/tabs/DevTools.svelte:134` | `suspicious/noConsole` | This DevTools control deliberately tests console.table formatting. |

- Strict TS: `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` are enabled in `tsconfig.json` (root), `apps/backend`, and `packages/rpc`. The frontend app (`apps/frontend/tsconfig.app.json`) and `tsconfig.node.json` enable `strict` + `noUncheckedIndexedAccess`; `exactOptionalPropertyTypes` is intentionally omitted there because it is incompatible with bits-ui v2 / shadcn-svelte and vite-plugin-pwa types (unfixable "union too complex" errors in CLI-managed components). The e2e tsconfig stays at baseline `strict` (ungated Playwright test code).
- Mock hardware in dev via `MOCK_SCENARIO` env var (`multi-modem-wifi` default). Use `shouldUseMocks()` — never raw `isDevelopment()` — to gate mock paths.
- `LOG_LEVEL` env var overrides the Winston transport level for ALL transports (console + file). Unset = per-transport defaults (dev console `info`, prod console `warn`, file `debug`). Set `LOG_LEVEL=debug` to enable per-RPC trace lines.
- Backend binary compiled with `bun build --compile`; target set by `BUILD_ARCH`.
- Frontend is a PWA — service worker via `vite-plugin-pwa`.
- Validation constants live in `packages/rpc/src/schemas/`; the frontend reads them via `ValidationAdapter.ts` — never add inline numeric literals to dialog components.
- All config dialogs compose `AppDialog.svelte` (desktop Dialog / mobile Sheet via `MediaQuery` from `svelte/reactivity`).
- E2E Testing: REQUIRED reading before writing E2E tests → [`apps/frontend/tests/e2e/PLAYBOOK.md`](../../apps/frontend/tests/e2e/PLAYBOOK.md)
- Technical debt: every debt this overhaul introduces is tracked in the machine-checkable register `docs/TECHNICAL_DEBT.md`, enforced by `scripts/check-tech-debt.mjs` (the `check:tech-debt` script, **blocking** in the `test` CI job). Any source `data-debt-id="TD-NNN"`, `coming-soon`, or in-source `[PARTIAL]` marker MUST point at an `open` register entry — an orphan marker or a malformed entry fails CI. It extends the `image-building-pipeline/v2/docs/DEFERRED.md` ledger pattern and does NOT duplicate the root status-label system (`docs/CONVENTIONS.md`). Full contract: `docs/CONVENTIONS.md` → Technical-Debt Register.

