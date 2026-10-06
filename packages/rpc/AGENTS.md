# @ceraui/rpc — Agent Knowledge Base

Parent: [Workspace rules](https://github.com/CERALIVE/ceralive/blob/master/AGENTS.md).

## ROLE

Shared browser-safe RPC contracts, Zod schemas and capability logic for backend and frontend.

## STRUCTURE

```text
src/ — contracts, schemas and capability helpers
docs/ — routed contracts
```

## COMMANDS

Run from the CeraUI checkout root:

```bash
bun run --filter @ceraui/rpc check
bun run --filter @ceraui/rpc test
bunx biome check packages/rpc
```

## WHERE TO LOOK

| Task / code scope | Contract |
|---|---|
| Before changing anything else here, open docs/agents/README.md and read the contract for the subsystem you touch | [Contract index](docs/agents/README.md) |
| Preamble | [Contract 1](docs/agents/overview.md) |
| OVERVIEW | [Contract 2](docs/agents/overview-2.md) |
| STRUCTURE | [Contract 3](docs/agents/structure.md) |
| WHERE TO LOOK | [Contract 4](docs/agents/where-to-look.md) |
| IMPORT PATHS | [Contract 5](docs/agents/import-paths.md) |
| UPLINK STEERING WIRE STATE IS SHARED | [Contract 6](docs/agents/uplink-steering-wire-state-is-shared.md) |
| AN UPLINK ROW CARRIES A NAME, NOT A SECOND IDENTITY | [Contract 7](docs/agents/an-uplink-row-carries-a-name-not-a-second-identity.md) |
| DEVICE-TOKEN CLAIM CONTRACT (canonical, single source) | [Contract 8](docs/agents/device-token-claim-contract-canonical-single-source.md) |
| THE EXACT-CAPABILITY RULE LIVES HERE, ONCE | [Contract 9](docs/agents/the-exact-capability-rule-lives-here-once.md) |
| THE CHANGE-CONFIG BOUND IS MIRRORED HERE, WITH ITS… | [Contract 10](docs/agents/the-change-config-bound-is-mirrored-here-with-its-derivat.md) |
| A MODEM IS CORRELATED BY `stable_key`, AND BY NOTHING… | [Contract 11](docs/agents/a-modem-is-correlated-by-stable-key-and-by-nothing-else.md) |
| AN ABSENT READING STILL SAYS SOMETHING | [Contract 12](docs/agents/an-absent-reading-still-says-something.md) |
| AN UNIDENTIFIABLE LINK SAYS SO, RATHER THAN BEING… | [Contract 13](docs/agents/an-unidentifiable-link-says-so-rather-than-being-renamed.md) |
| THE MUTATION-SAFETY VOCABULARY IS SHARED, NOT… | [Contract 14](docs/agents/the-mutation-safety-vocabulary-is-shared-not-per-procedur.md) |
| AN OPERATION'S OWN WORDS SURVIVE THE BOUNDARY | [Contract 15](docs/agents/an-operation-s-own-words-survive-the-boundary.md) |
| THE SMS INBOX SCHEMAS ARE READ-ONLY BY DESIGN | [Contract 16](docs/agents/the-sms-inbox-schemas-are-read-only-by-design.md) |
| THE CAPABILITY FEATURE-GATE FRAMEWORK LIVES HERE, ONCE | [Contract 17](docs/agents/the-capability-feature-gate-framework-lives-here-once.md) |
| THE BLUETOOTH DOMAIN REUSES THE LADDER WITHOUT JOINING… | [Contract 18](docs/agents/the-bluetooth-domain-reuses-the-ladder-without-joining-th.md) |
| CONVENTIONS | [Contract 19](docs/agents/conventions.md) |
| ADD-ON `versionId` TRANSITION CONTRACT | [Contract 20](docs/agents/add-on-versionid-transition-contract.md) |
| ANTI-PATTERNS | [Contract 21](docs/agents/anti-patterns.md) |

## HARD RULES

- This package owns the shared RPC contract and Zod schemas; both consumers import it, never duplicate contracts under apps/.
- Producer wire types and schemas come from published producer exports; never replace them with a local interface or z.object().
- Device-mode ladders are producer truth; never invent modes or union media-type ladders, and never fork per-consumer capability logic.
- Modem correlation uses stable_key; link identity is not conn_id; displayName never keys or joins an uplink row.
- Transient uplink-flows-reset events are never persisted or replayed; replace persistent snapshots wholesale.
- Keep device-token claims aligned with ADR-0006 and both consumers; never expose credentials through output schemas.
- The change-config bound is a derivation, not a literal; preserve wire-stable refusal reasons and shared mutation-safety vocabulary.
- SMS inbox schemas stay read-only; capability gates must preserve unknown/unsupported distinctions and the Bluetooth domain boundary.
