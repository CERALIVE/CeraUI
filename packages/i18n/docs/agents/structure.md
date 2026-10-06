<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

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

