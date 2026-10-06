<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## STRUCTURE

```
src/
├── contracts/     # oRPC oc.router() defs — auth, streaming, modems, wifi, network, system, status, notifications
│   └── index.ts   # appContract root router + AppContract type
├── schemas/       # Zod v4 schemas mirroring contracts/ + common.schema.ts, relay.schema.ts
└── capabilities/  # pure, browser-safe capability helpers (intersectCaps, device-mode-truth)
```

