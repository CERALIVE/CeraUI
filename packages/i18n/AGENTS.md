# @ceraui/i18n — Agent Knowledge Base

Parent: [`../../AGENTS.md`](../../AGENTS.md)
Operator/contributor guide: [`README.md`](README.md) — export map, add-a-key/add-a-locale workflow, generated-code contract.

## OVERVIEW

Ten locales, full RTL. **Paraglide is the sole i18n runtime** — the legacy
generator, its Svelte 5 adapter, its plural resolver, and the TypeScript locale
dictionaries are all deleted. `messages/*.json` are the canonical, hand-editable
catalogs; `generated/` and `src/paraglide/` are build outputs. Never hand-edit a
generated file, and never install an install-time hook here: everything is built
by `generate:i18n`, which runs ahead of every consumer.

## STRUCTURE

```
messages/{locale}.json      # inlang catalogs — 1472 verbatim dotted keys per locale
project.inlang/             # inlang project (settings.json committed; cache gitignored)
generated/                  # GENERATED, GITIGNORED — per-namespace barrels + message registry
src/paraglide/              # GENERATED, GITIGNORED — Paraglide runtime, one module per message
src/
├── locale-lifecycle.ts     # LOCALES / RTL_LANGUAGES / startup priority — pure, rune-free
├── svelte.svelte.ts        # `/svelte` — Paraglide runes store + the `m` facade
├── formatters.ts           # standalone Intl formatters — imports NO i18n runtime
└── branding.ts             # brand names — not translated, kept separate
tests/fixtures/             # IMMUTABLE rendered oracle — not generated, not free-form copy
scripts/
├── compile-messages.ts     # paraglide compile (outputStructure: "message-modules")
├── generate-registry.ts    # post-compile barrels + registry generator
└── module-id.ts            # paraglide safe-module-id mirror + collision pre-flight
```

## IMPORT PATHS

```typescript
import { m, setLocale, getLocale } from '@ceraui/i18n/svelte';    // frontend — the facade
import { formatBytes } from '@ceraui/i18n/formatters';             // anywhere
import { LOCALES, RTL_LANGUAGES } from '@ceraui/i18n';             // locale constants
```

`m` is keyed on the **verbatim dotted key**: `m["live.setup.title"]()`. Those three
are the whole export map — there is no `/node` subpath and no legacy adapter subpath.

## GENERATE

```bash
bun run --filter @ceraui/i18n generate:i18n   # paraglide compile + registry generation
bun run --filter @ceraui/i18n test            # runs generate:i18n first, then bun test
```

Runs as the first step of this package's own `check` / `test` and of the frontend
`check` / `test` / `build` / `build:federation` chains, so a clean worktree never
fails on the gitignored generated modules. There is no install-time generation:
each gate is independently runnable from `bun install` alone.

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
