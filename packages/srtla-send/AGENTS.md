# @ceraui/srtla-send — Agent Knowledge Base

Parent: [Workspace rules](https://github.com/CERALIVE/ceralive/blob/master/AGENTS.md).

## ROLE

Private sender helper: argument builder, telemetry reader/watcher and sender control-socket client.

## STRUCTURE

```text
src/ — sender, telemetry and control helpers
tests/ — frozen producer fixtures and parity tests
docs/ — routed contracts
```

## COMMANDS

Run from the CeraUI checkout root:

```bash
bun run --filter @ceraui/srtla-send check
bun run --filter @ceraui/srtla-send test
bunx biome check packages/srtla-send
bun run --filter backend test
```

## WHERE TO LOOK

| Task / code scope | Contract |
|---|---|
| Before changing anything else here, open docs/agents/README.md and read the contract for the subsystem you touch | [Contract index](docs/agents/README.md) |
| Preamble | [Contract 1](docs/agents/overview.md) |
| OVERVIEW | [Contract 2](docs/agents/overview-2.md) |
| STRUCTURE | [Contract 3](docs/agents/structure.md) |
| `--conn-timeout-ms 15000` IS UNCONDITIONAL | [Contract 4](docs/agents/conn-timeout-ms-15000-is-unconditional.md) |
| UPSTREAM DEFAULTS ARE ACCEPTED; THE OPT-OUTS ARE… | [Contract 5](docs/agents/upstream-defaults-are-accepted-the-opt-outs-are-passthrou.md) |
| FIELD ORDER IS LOAD-BEARING, AND THE FIXTURES ARE… | [Contract 6](docs/agents/field-order-is-load-bearing-and-the-fixtures-are-frozen-b.md) |
| `control/` SPEAKS THE HARD-FORKED SENDER'S DIALECT | [Contract 7](docs/agents/control-speaks-the-hard-forked-sender-s-dialect.md) |
| GATE | [Contract 8](docs/agents/gate.md) |
| ANTI-PATTERNS | [Contract 9](docs/agents/anti-patterns.md) |

## HARD RULES

- Keep this helper private and workspace-consumed; never publish it, add a registry pin or restore it to PRODUCER_PACKAGE_NAMES.
- Every spawn emits --conn-timeout-ms 15000; change only in lockstep with the receiver; preserve the four positional arguments.
- Accept upstream re-home/stall-deselect defaults; emit opt-out flags only when explicitly set.
- Telemetry schema key order and producer fixtures are frozen bytes; never format fixtures or weaken byte-parity assertions.
- Never regenerate telemetry-legacy-producer.json; preserve the drift manifest schema probe.
- Control uses get_capabilities, topic subscriptions and StatsSnapshot projection, not hello/subscribe-events or ADR-001 stats replies.
- Never shadow exported types; backend import changes also require the backend tests and binding-skew guard.
