<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## OVERVIEW

Ten locales, full RTL. **Paraglide is the sole i18n runtime** — the legacy
generator, its Svelte 5 adapter, its plural resolver, and the TypeScript locale
dictionaries are all deleted. `messages/*.json` are the canonical, hand-editable
catalogs; `generated/` and `src/paraglide/` are build outputs. Never hand-edit a
generated file, and never install an install-time hook here: everything is built
by `generate:i18n`, which runs ahead of every consumer.

