<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## GATE

```bash
bun run --filter @ceraui/srtla-send test     # bun test
bun run --filter @ceraui/srtla-send check    # tsc --noEmit via scripts/tsc.mjs
bunx biome check packages/srtla-send         # lint/format (root config + this one)
```

Changing anything the backend imports additionally requires
`bun run --filter backend test` — `srtla-send-bindings-skew.test.ts` is the guard
that turns an export rename here into a loud failure there rather than a silent
one on a device.

