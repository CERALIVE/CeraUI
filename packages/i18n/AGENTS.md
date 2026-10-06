# @ceraui/i18n — Agent Knowledge Base

Parent: [Workspace rules](https://github.com/CERALIVE/ceralive/blob/master/AGENTS.md).

## ROLE

Ten-locale Paraglide catalogs, generated registry, Svelte facade and runtime-free formatters.

## STRUCTURE

```text
messages/ — hand-edited catalogs
project.inlang/ — compiler settings
src/ — runtime and formatters
generated/ — generated registry
scripts/ — generation
tests/ — parity and frozen oracles
docs/ — routed contracts
```

## COMMANDS

Run from the CeraUI checkout root:

```bash
bun run --filter @ceraui/i18n generate:i18n
bun run --filter @ceraui/i18n check
bun run --filter @ceraui/i18n test
bunx biome check packages/i18n
```

## WHERE TO LOOK

| Task / code scope | Contract |
|---|---|
| Before changing anything else here, open docs/agents/README.md and read the contract for the subsystem you touch | [Contract index](docs/agents/README.md) |
| Preamble | [Contract 1](docs/agents/overview.md) |
| OVERVIEW | [Contract 2](docs/agents/overview-2.md) |
| STRUCTURE | [Contract 3](docs/agents/structure.md) |
| IMPORT PATHS | [Contract 4](docs/agents/import-paths.md) |
| GENERATE | [Contract 5](docs/agents/generate.md) |
| CONVENTIONS + ANTI-PATTERNS | [Contract 6](docs/agents/conventions-anti-patterns.md) |

## HARD RULES

- Spanish strings are neutral LATAM (tú); docs.ceralive.tv quotes es.json verbatim, so a label change needs a docs update (Rule G)
- messages/en.json is the hand-edited base locale; maintain identical key sets across all locales.
- Never hand-edit generated/ or src/paraglide/; generate:i18n runs before consumers, never as an install-time hook.
- Never write tests/fixtures/*.rendered.json; deliberate copy changes re-freeze the immutable oracle in a separately reviewed PR.
- Use the m facade, never compiled messages or the Paraglide umbrella; backend imports only runtime-free formatters/constants.
- Keep every namespace lazy and EAGER_NAMESPACES empty; /eager is for federation/harnesses, never app code.
- App namespace activation owns the boot set; ensureAllNamespaces() is not a boot path.
- RTL_LANGUAGES owns direction; app persistence owns locale storage; keep Svelte ambient types for the rune module.
