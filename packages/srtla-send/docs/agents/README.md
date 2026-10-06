# Archived agent contracts

Read the contract for the subsystem you touch before making changes. Every original section remains here.

| Original heading | Contract | Governed paths / scope |
|---|---|---|
| Preamble | [overview.md](overview.md) | `../../AGENTS.md` |
| OVERVIEW | [overview-2.md](overview-2.md) | `apps/backend`, `"@ceraui/srtla-send": "workspace:*"`, `/usr/bin/srtla_send` |
| STRUCTURE | [structure.md](structure.md) | STRUCTURE |
| `--conn-timeout-ms 15000` IS UNCONDITIONAL | [conn-timeout-ms-15000-is-unconditional.md](conn-timeout-ms-15000-is-unconditional.md) | `irlserver/srtla_send`, `apps/backend/src/tests/srtla-send-bindings-skew.test.ts` |
| UPSTREAM DEFAULTS ARE ACCEPTED; THE OPT-OUTS ARE PASSTHROUGH ONLY | [upstream-defaults-are-accepted-the-opt-outs-are-passthrou.md](upstream-defaults-are-accepted-the-opt-outs-are-passthrou.md) | UPSTREAM DEFAULTS ARE ACCEPTED; THE OPT-OUTS ARE PASSTHROUGH ONLY |
| FIELD ORDER IS LOAD-BEARING, AND THE FIXTURES ARE FROZEN BYTES | [field-order-is-load-bearing-and-the-fixtures-are-frozen-b.md](field-order-is-load-bearing-and-the-fixtures-are-frozen-b.md) | `tests/fixtures/*.json`, `!tests/fixtures`, `!packages/srtla-send/tests/fixtures` |
| `control/` SPEAKS THE HARD-FORKED SENDER'S DIALECT | [control-speaks-the-hard-forked-sender-s-dialect.md](control-speaks-the-hard-forked-sender-s-dialect.md) | `control/`, `src/control/index.ts`, `src/control.rs`, `src/index.ts`, `src/subscriptions.rs::publish`, `src/stats.rs`, `src/telemetry_doc.rs`, `tests/control-client.test.ts` |
| GATE | [gate.md](gate.md) | GATE |
| ANTI-PATTERNS | [anti-patterns.md](anti-patterns.md) | `control/` |
