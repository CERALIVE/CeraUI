<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## GENERATE

```bash
bun run --filter @ceraui/i18n generate:i18n   # paraglide compile + registry generation
bun run --filter @ceraui/i18n test            # runs generate:i18n first, then bun test
```

Runs as the first step of this package's own `check` / `test` and of the frontend
`check` / `test` / `build` / `build:federation` chains, so a clean worktree never
fails on the gitignored generated modules. There is no install-time generation:
each gate is independently runnable from `bun install` alone.

