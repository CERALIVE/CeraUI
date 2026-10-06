# CeraUI Frontend — Agent Knowledge Base

Parent: [Workspace rules](https://github.com/CERALIVE/ceralive/blob/master/AGENTS.md).

## ROLE

Svelte device control UI, subscription state, operator dialogs and signed federation bundles.

## STRUCTURE

```text
src/ — UI and subscription state
tests/ — E2E suites
scripts/ — build guards
docs/ — routed contracts
```

## COMMANDS

Run from the CeraUI checkout root:

```bash
bun run --filter frontend check
bun run --filter frontend lint
bun run --filter frontend test
bun run test:e2e
bun run build:frontend
bun run test:federation-abi
```

## WHERE TO LOOK

| Task / code scope | Contract |
|---|---|
| Before changing anything else here, open docs/agents/README.md and read the contract for the subsystem you touch | [Contract index](docs/agents/README.md) |
| Preamble / ROLE | [Contract 1](docs/agents/overview.md); [Contract 2](docs/agents/role.md) |
| STRUCTURE / CRITICAL: initSubscriptions() must be called at startup | [Contract 3](docs/agents/structure.md); [Contract 4](docs/agents/critical-initsubscriptions-must-be-called-at-startup.md) |
| NETWORK VIEW STRUCTURE / RPC PATTERN | [Contract 5](docs/agents/network-view-structure.md); [Contract 6](docs/agents/rpc-pattern.md) |
| COMMANDS / FEDERATION LIB BUILD (Task 39) | [Contract 7](docs/agents/commands.md); [Contract 8](docs/agents/federation-lib-build-task-39.md) |
| FEDERATION SIGNING (Task 40) / FEDERATION PUBLISH (Task 41) | [Contract 9](docs/agents/federation-signing-task-40.md); [Contract 10](docs/agents/federation-publish-task-41.md) |
| CONVENTIONS / THE AUDIO BACKEND IS OFFERED ONLY WHERE THE ENGINE… | [Contract 11](docs/agents/conventions.md); [Contract 12](docs/agents/the-audio-backend-is-offered-only-where-the-engine-advert.md) |
| A SIM-LESS LINK CANNOT BE TOGGLED INTO THE BOND, ON… / A DONGLE'S OWN WEB UI IS NOW REACHABLE, AND THE LINK… | [Contract 13](docs/agents/a-sim-less-link-cannot-be-toggled-into-the-bond-on-either.md); [Contract 14](docs/agents/a-dongle-s-own-web-ui-is-now-reachable-and-the-link-carri.md) |
| THE CAPABILITY GATES ARE A SETTINGS SURFACE, NOT A… / A SIM LOCK IS REACHED FROM ITS OWN ROW, NEVER BY… | [Contract 15](docs/agents/the-capability-gates-are-a-settings-surface-not-a-modem-s.md); [Contract 16](docs/agents/a-sim-lock-is-reached-from-its-own-row-never-by-intercept.md) |
| A USB-MODE SWITCH IS CONFIRMED BY THE DEVICE, NOT BY… / THE MODEM DIALOG IS THE ADVANCED SURFACE, AND EVERY… | [Contract 17](docs/agents/a-usb-mode-switch-is-confirmed-by-the-device-not-by-the-r.md); [Contract 18](docs/agents/the-modem-dialog-is-the-advanced-surface-and-every-card-v.md) |
| THE SIM'S OWN NUMBER IS HIDDEN BY DEFAULT / THE SMS INBOX IS A FOLDED, PERMANENTLY READ-ONLY CARD… | [Contract 19](docs/agents/the-sim-s-own-number-is-hidden-by-default.md); [Contract 20](docs/agents/the-sms-inbox-is-a-folded-permanently-read-only-card-mode.md) |
| USSD IS A SESSION, SO IT CARRIES A SECOND MACHINE / THE DONGLE LOGIN IS TYPED HERE, AND THE CAPABILITY… | [Contract 21](docs/agents/ussd-is-a-session-so-it-carries-a-second-machine.md); [Contract 22](docs/agents/the-dongle-login-is-typed-here-and-the-capability-expansi.md) |
| THE ROUTER ACTION SURFACE — THREE OPERATIONS, THREE… / A MUTATION OUTCOME IS PERSISTENT, ANNOUNCED, AND… | [Contract 23](docs/agents/the-router-action-surface-three-operations-three-differen.md); [Contract 24](docs/agents/a-mutation-outcome-is-persistent-announced-and-bounded-ui.md) |
| SSH PERSISTENCE IS A SECOND, INDEPENDENT CONTROL / A PERSISTENT NOTICE IS NOT A TOAST | [Contract 25](docs/agents/ssh-persistence-is-a-second-independent-control.md); [Contract 26](docs/agents/a-persistent-notice-is-not-a-toast.md) |
| CONNECTION RELIABILITY / ANTI-PATTERNS | [Contract 27](docs/agents/connection-reliability.md); [Contract 28](docs/agents/anti-patterns.md) |
| EVERY REFUSAL AN OPERATOR CAN TRIGGER HAS ITS OWN… / A CLIPPED DISCLOSURE MUST BE HIDDEN, NOT MERELY… | [Contract 29](docs/agents/every-refusal-an-operator-can-trigger-has-its-own-message.md); [Contract 30](docs/agents/a-clipped-disclosure-must-be-hidden-not-merely-unpainted.md) |
| AN UNCHANGED TICK MUST BE A NO-OP | [Contract 31](docs/agents/an-unchanged-tick-must-be-a-no-op.md) |

## HARD RULES

- Call initSubscriptions() before mount; its handlers feed every subscription getter. Never create a second socket consumer.
- Import wire contracts from @ceraui/rpc and producer exports; never shadow a wire type or fabricate an advertised mode.
- Unknown, absent and explicit unsupported are distinct states; render typed refusals through keyed localized copy, never raw tokens.
- Preserve authentication ownership, lazy dialog loading and bounded persistent notifications; read the routed subsystem before editing.
- Use the Paraglide facade; namespace activation owns boot/destination loading. Never import /eager in app code.
- Never hand-edit CLI-managed shadcn primitives; retain accessibility, focus and clipped-disclosure behavior.
- Federation builds/signatures/publish must agree with the hosted bundle graph and support window; read all three federation contracts.
