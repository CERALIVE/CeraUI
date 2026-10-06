<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## CONVENTIONS + ANTI-PATTERNS

- New keys go into `messages/en.json` first — it is the base locale and the SOURCE
  OF TRUTH, edited by hand. Other locales follow; the parity gate fails on a
  differing key set.
- **The test suite reads `messages/*.json` and the frozen fixtures, and imports no
  message runtime.** Shared readers live in `tests/helpers/catalog.ts`.
- **Nothing may write `tests/fixtures/*.rendered.json`.** It is the immutable
  pre-migration oracle; the generator that captured it retired with the runtime it
  rendered through, and regenerating it from paraglide would overwrite the oracle
  with the very thing it exists to falsify. A deliberate copy change re-freezes it
  in its own separately-reviewed PR.
- `branding.ts` holds brand names that don't get translated — import from there.
- Svelte 5 store uses runes — don't convert to stores.
- Don't hand-edit anything under `generated/` or `src/paraglide/`.
- Namespace barrels import each compiled message by its verbatim dotted export
  name and place the function directly in the registry object. Do not spread
  module namespace objects: that forces an export-getter wrapper per message into
  the bundle. Direct bindings preserve every key, locale and message function
  while keeping the SPA and precache within their unchanged budgets.
- **Every namespace is LAZY, and `EAGER_NAMESPACES` (in `scripts/generate-registry.ts`)
  is empty on purpose.** A compiled Paraglide message inlines all ten locales, so an
  all-eager catalog is one indivisible blob; under rolldown a statically-reachable
  chunk cannot be split by naming it, so a dynamic import is the only lever. Measured:
  entry chunk 842 892 -> 438 997 B gzip, total SPA JS+CSS 909 347 -> 866 755 B gzip.
  Flipping one back to eager is a regression on both axes —
  `tests/message-registry.test.ts` fails if any namespace stops being lazy.
- **`EAGER_NAMESPACES` is NOT the boot set, and must not be used as one.** Which
  namespaces the SPA awaits before mount is an APP concern, owned by
  `apps/frontend/src/lib/i18n/namespace-activation.ts`: the boot set is every
  namespace first paint can read (shell + the DEFAULT `live` destination), and the
  remainder is claimed by the destination that reads it. Moving a namespace into
  `EAGER_NAMESPACES` to make it load at boot would fuse it into the entry chunk —
  the measured regression above — where adding it to the boot set costs nothing
  extra in bytes, only one more parallel chunk fetch.
- **`ensureAllNamespaces()` is not a boot path.** It stays for harnesses and
  full-catalog consumers; calling it before mount re-serialises first paint behind
  all 31 namespaces, which is exactly what the boot/destination split removed.
- **Don't import Paraglide's umbrella `paraglide/messages.js`** — it re-exports every
  message eagerly, which collapses the whole catalog into one chunk and makes
  `ensureNamespace()` structurally incapable of splitting anything. Import the facade.
  A test gate fails the build if anything reaches past it.
- Don't switch `<html dir>` to Paraglide's `getTextDirection()` — `RTL_LANGUAGES` is
  the direction source the e2e locale-parity spec is written against.
- Don't add locale persistence here — the app's `$persist` store owns it, under an
  unchanged key; `initLocale()` takes the saved code as an argument.
- Don't import a compiled message module directly — use `m`.
- Don't import the svelte store in backend code; `@ceraui/i18n/formatters` and the
  root locale constants are the two runtime-free surfaces that are safe there.
- **`src/svelte.svelte.ts` is a rune module under a plain `tsc` gate**, so
  `tsconfig.json` carries `"types": ["svelte"]` for the ambient `$state` declaration.
  Drop it and every rune reads as TS2304 `Cannot find name '$state'`.
