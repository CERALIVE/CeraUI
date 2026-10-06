<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## STRUCTURE

```
src/
├── index.ts            # package root: re-exports sender/ + telemetry/ (NOT control/)
├── sender/index.ts     # argv builder, option schema, exec resolution, spawn/HUP helpers
├── telemetry/
│   ├── index.ts        # ADR-001/002/003 Zod schemas + readTelemetry
│   └── watch.ts        # watchTelemetry polling handle + its update/handle types
└── control/index.ts    # LEGACY dialect, TODO(41), excluded from the build
tests/
├── fixtures/*.json     # 8 Rust-producer documents, byte-frozen (see below)
└── telemetry-{reader,fixtures,roundtrip}.test.ts
```

