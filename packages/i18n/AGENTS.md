# @ceraui/i18n — Agent Knowledge Base

Parent: [`../../AGENTS.md`](../../AGENTS.md)

## OVERVIEW

`typesafe-i18n` package with 10 locales and a custom Svelte 5 runes adapter. Codegen runs at install time via `postinstall`. Never hand-edit generated files.

## STRUCTURE

```
src/
├── en/index.ts             # Base locale — source of truth for all keys
├── {locale}/index.ts       # ar, de, es, fr, hi, ja, ko, pt-BR, zh
├── i18n-types.ts           # GENERATED — Locales union, Translation type
├── i18n-util*.ts           # GENERATED — don't edit
├── i18n-svelte5.svelte.ts  # Custom Svelte 5 runes adapter ($state/$derived)
├── i18n-node.ts            # Node/backend adapter
├── formatters.ts           # Locale-aware formatters (currently stubbed)
└── branding.ts             # Brand names — not translated, kept separate
```

## IMPORT PATHS

```typescript
import { LL, locale, setLocale } from '@ceraui/i18n/svelte';  // frontend (Svelte 5)
import { i18nNode } from '@ceraui/i18n/node';                  // backend
import type { Locales, Translation } from '@ceraui/i18n';      // types only
```

## LOCALES + CODEGEN

10 locales: `en` (base), `ar`, `de`, `es`, `fr`, `hi`, `ja`, `ko`, `pt-BR`, `zh`. Add one: create `src/{locale}/index.ts` satisfying `Translation`, then run codegen.

```bash
bun run --filter @ceraui/i18n typesafe-i18n   # regenerate; also runs via postinstall
```

Generated: `i18n-types.ts`, `i18n-util*.ts` — overwritten on next run, don't edit.

## CONVENTIONS + ANTI-PATTERNS

- New keys go into `en/index.ts` first. Other locales follow.
- `branding.ts` holds brand names that don't get translated — import from there, not locale files.
- `formatters.ts` is for locale-aware number/date formatters. Currently stubbed.
- Svelte 5 adapter uses `$state`/`$derived` runes — don't convert to stores.
- Don't edit generated `i18n-util*.ts` or `i18n-types.ts` by hand.
- Don't import locale files directly — use the typed `LL` proxy from the adapter.
- Don't use the node adapter in frontend code or the svelte adapter in backend code.
