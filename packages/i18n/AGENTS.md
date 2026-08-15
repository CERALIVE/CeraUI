# @ceraui/i18n — Agent Knowledge Base

Parent: [`../../AGENTS.md`](../../AGENTS.md)
Operator/contributor guide: [`README.md`](README.md) — export map, add-a-key/add-a-locale workflow, generated-code contract.

## OVERVIEW

Ten locales, full RTL. **Mid-migration**: Paraglide is the runtime the frontend is
moving onto; the legacy `typesafe-i18n` adapter still ships beside it (its codegen
still runs at install time via `postinstall`) until the call-site codemod and the
generator retirement land. Never hand-edit generated files.

## STRUCTURE

```
messages/{locale}.json      # inlang catalogs — 1472 verbatim dotted keys per locale
project.inlang/             # inlang project (settings.json committed; cache gitignored)
generated/                  # GENERATED, GITIGNORED — per-namespace barrels + message registry
src/paraglide/              # GENERATED, GITIGNORED — Paraglide runtime, one module per message
src/
├── locale-lifecycle.ts     # LOCALES / RTL_LANGUAGES / startup priority — pure, rune-free
├── svelte.svelte.ts        # `/svelte` — Paraglide runes store + the `m` facade
├── formatters.ts           # standalone Intl formatters (untouched by the migration)
├── branding.ts             # brand names — not translated, kept separate
├── en/index.ts             # LEGACY base locale — still the conversion source
├── {locale}/index.ts       # LEGACY — ar, de, es, fr, hi, ja, ko, pt-BR, zh
├── i18n-svelte5.svelte.ts  # LEGACY typesafe-i18n Svelte 5 adapter
├── i18n-node.ts            # LEGACY node adapter (subpath retired; `loadLocale` kept for tests)
└── i18n-types.ts, i18n-util*.ts   # LEGACY GENERATED — don't edit
scripts/
├── compile-messages.ts     # paraglide compile (outputStructure: "message-modules")
├── generate-registry.ts    # post-compile barrels + registry generator
└── convert-catalog.ts      # LEGACY dictionaries -> messages/*.json (retires with them)
```

## IMPORT PATHS

```typescript
import { m, setLocale, getLocale } from '@ceraui/i18n/svelte';    // frontend — the facade
import { formatBytes } from '@ceraui/i18n/formatters';             // anywhere
import { LOCALES, RTL_LANGUAGES } from '@ceraui/i18n';             // locale constants
import { LL } from '@ceraui/i18n/i18n-svelte5';                    // LEGACY, being codemodded away
```

`m` is keyed on the **verbatim dotted key**: `m["live.setup.title"]()`. There is no
`/node` subpath — nothing imported it.

## GENERATE

```bash
bun run --filter @ceraui/i18n generate:i18n   # paraglide compile + registry generation
bun run --filter @ceraui/i18n test            # runs generate:i18n first, then bun test
```

Runs as the first step of the frontend `check` / `test` / `build` /
`build:federation` chains, so a clean worktree never fails on the gitignored
generated modules. The legacy generator still runs separately via `typesafe-i18n`
(`postinstall`).

## CONVENTIONS + ANTI-PATTERNS

- New keys go into `en` first (legacy `en/index.ts` while it is still the conversion
  source). Other locales follow; the parity gate fails on a differing key set.
- **The test suite reads `messages/*.json` and the frozen fixtures, not the legacy
  runtime.** Shared readers live in `tests/helpers/catalog.ts`. The only files still
  importing the legacy dictionaries are the three CONVERSION-proof gates
  (`paraglide-catalog-gate`, `paraglide-reverse-render-gate`, `rendered-oracle-gate`)
  and the conversion scripts — all of which retire together with that runtime. Do not
  repoint those three: comparing the catalog against the dictionary IS what they prove.
- `branding.ts` holds brand names that don't get translated — import from there.
- Svelte 5 store uses runes — don't convert to stores.
- Don't hand-edit anything under `generated/`, `src/paraglide/`, `i18n-util*.ts`, or
  `i18n-types.ts`.
- **Don't import Paraglide's umbrella `paraglide/messages.js`** — it re-exports every
  message eagerly, which collapses the whole catalog into one chunk and makes
  `ensureNamespace()` structurally incapable of splitting anything. Import the facade.
  A test gate fails the build if anything reaches past it.
- Don't switch `<html dir>` to Paraglide's `getTextDirection()` — `RTL_LANGUAGES` is
  the direction source the e2e locale-parity spec is written against.
- Don't add locale persistence here — the app's `$persist` store owns it, under an
  unchanged key; `initLocale()` takes the saved code as an argument.
- Don't import locale files directly — use `m` (or the legacy `LL` proxy).
- Don't use a node adapter in frontend code, or the svelte store in backend code.
