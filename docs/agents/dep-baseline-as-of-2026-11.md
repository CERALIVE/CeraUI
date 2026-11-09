# Dependency holds (2026-11)

The dependency refresh preserves these versions under its no-regression condition.
Manifest range styles remain unchanged except for the required exact Svelte hold.

| Package | Retained version | Reason |
| --- | --- | --- |
| `svelte` (frontend and i18n) | exact `5.57.0` | `sveltejs/svelte#18919` remains open on November 8, 2026; latest `5.57.3` includes the reported reactivity regression. |
| `bits-ui` (frontend) | `^2.19.2`, lock resolves `2.19.2` | Latest `2.20.6` fails the unchanged disabled-codec accessibility assertion in `AudioDialog.test.ts:256` and closed-dialog removal assertion in `SimUnlockDialog.nested.test.ts:188`. Both persist with one Vitest worker; replacing only bits-ui with `2.19.2` passes all 19 tests in those files. Keep the retained lock resolution until these compatibility failures are resolved without weakening assertions. |
| `svelte-persistent-runes` (frontend) | `^2.1.0`, lock resolves `2.1.0` | Latest `2.2.0` changes emitted code from `load`/`save` to `createPersistence`/`track`, which CeraUI's runtime substitute does not export. The built federation ABI fails 26 tests with an undefined function call; replacing only this package with `2.1.0` passes all 38 ABI tests. Keep the retained lock resolution until the runtime substitute supports the new ABI and its changed storage semantics are reviewed. |
| `@axe-core/playwright` (frontend) | `^4.13.0`, lock resolves `4.13.0` | Latest `4.14.0` reports the existing HUD trigger's visible-content/name mismatch (`HudBar.svelte:324`) in 14 functional cases. All 14 persist serially and pass on the previous commit; replacing only the adapter with `4.13.0` also passes all 14 on the upgraded candidate. Hold the checker upgrade until the HUD accessibility issue is fixed without changing the test's allowed-rule baseline. |
| `typescript` (catalog) | `^6.0.3`, lock resolves `6.0.3` | TypeScript 7 is outside the approved refresh scope. |
| `vaul-svelte` (frontend) | exact `1.0.0-next.7` | Registry `latest` is `0.3.2`, a downgrade. |

The oRPC packages remain exact `2.0.0-beta.49`; their separate upgrade is complete.
Paraglide is exact `3.2.1` in frontend and i18n, with message-format `4.6.0`
and m-function-matcher `2.4.3`. Both compiler layouts preserve byte-identical
rendering across all ten locales. Explicit message-modules for the SPA and
locale-modules for federation retain the existing registry and runtime paths.
No catalog key requires Paraglide 3's reserved-name allocation.

Tailwind-variants, Vitest, jsdom, vite-plugin-pwa and the Biome toolchain
remain owned by later dependency-refresh steps.
