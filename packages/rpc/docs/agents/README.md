# Archived agent contracts

Read the contract for the subsystem you touch before making changes. Every original section remains here.

| Original heading | Contract | Governed paths / scope |
|---|---|---|
| Preamble | [overview.md](overview.md) | `../../AGENTS.md` |
| OVERVIEW | [overview-2.md](overview-2.md) | OVERVIEW |
| STRUCTURE | [structure.md](structure.md) | STRUCTURE |
| WHERE TO LOOK | [where-to-look.md](where-to-look.md) | `contracts/{domain}.contract.ts`, `contracts/index.ts`, `schemas/{domain}.schema.ts`, `schemas/network.schema.ts`, `schemas/modems.schema.ts`, `schemas/status.schema.ts`, `schemas/capability-modules.schema.ts`, `capabilities/capability-matrix.ts` |
| IMPORT PATHS | [import-paths.md](import-paths.md) | `dist/session-switch.js`, `docs/ENCODER-LOAD.md` |
| UPLINK STEERING WIRE STATE IS SHARED [EXISTS] | [uplink-steering-wire-state-is-shared.md](uplink-steering-wire-state-is-shared.md) | `schemas/network.schema.ts`, `apps/` |
| AN UPLINK ROW CARRIES A NAME, NOT A SECOND IDENTITY [EXISTS] | [an-uplink-row-carries-a-name-not-a-second-identity.md](an-uplink-row-carries-a-name-not-a-second-identity.md) | `apps/backend/AGENTS.md` |
| DEVICE-TOKEN CLAIM CONTRACT (canonical, single source) | [device-token-claim-contract-canonical-single-source.md](device-token-claim-contract-canonical-single-source.md) | `src/schemas/pairing.schema.ts`, `apps/backend/src/modules/pairing/device-token.ts`, `ceralive-platform/apps/api/lib/claim.ts` |
| THE EXACT-CAPABILITY RULE LIVES HERE, ONCE | [the-exact-capability-rule-lives-here-once.md](the-exact-capability-rule-lives-here-once.md) | `@ceralive/cerastream`, `dist/messages.js`, `capabilities/device-mode-truth.ts` |
| THE CHANGE-CONFIG BOUND IS MIRRORED HERE, WITH ITS DERIVATION | [the-change-config-bound-is-mirrored-here-with-its-derivat.md](the-change-config-bound-is-mirrored-here-with-its-derivat.md) | `schemas/config-change.schema.ts`, `@ceralive/cerastream`, `cerastream/docs/adr/schema.md` |
| A MODEM IS CORRELATED BY `stable_key`, AND BY NOTHING ELSE [EXISTS] | [a-modem-is-correlated-by-stable-key-and-by-nothing-else.md](a-modem-is-correlated-by-stable-key-and-by-nothing-else.md) | `schemas/modems.schema.ts`, `/sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.4/1-1.4.1`, `schemas/streaming.schema.ts`, `helpers/logger.ts`, `@ceralive/modem-control@0.2.0`, `schemas/modems.schema.test.ts` |
| AN ABSENT READING STILL SAYS SOMETHING [EXISTS] | [an-absent-reading-still-says-something.md](an-absent-reading-still-says-something.md) | `@ceralive/modem-control@1.3.0`, `apps/backend/AGENTS.md` |
| AN UNIDENTIFIABLE LINK SAYS SO, RATHER THAN BEING RENAMED | [an-unidentifiable-link-says-so-rather-than-being-renamed.md](an-unidentifiable-link-says-so-rather-than-being-renamed.md) | AN UNIDENTIFIABLE LINK SAYS SO, RATHER THAN BEING RENAMED |
| THE MUTATION-SAFETY VOCABULARY IS SHARED, NOT PER-PROCEDURE | [the-mutation-safety-vocabulary-is-shared-not-per-procedur.md](the-mutation-safety-vocabulary-is-shared-not-per-procedur.md) | `apps/backend/AGENTS.md` |
| AN OPERATION'S OWN WORDS SURVIVE THE BOUNDARY [EXISTS] | [an-operation-s-own-words-survive-the-boundary.md](an-operation-s-own-words-survive-the-boundary.md) | `@ceralive/modem-control`, `schemas/modems.schema.ts`, `control/src/domain/operation.ts`, `control/src/providers/modem-manager/errors.ts`, `apps/backend/AGENTS.md` |
| THE SMS INBOX SCHEMAS ARE READ-ONLY BY DESIGN | [the-sms-inbox-schemas-are-read-only-by-design.md](the-sms-inbox-schemas-are-read-only-by-design.md) | `schemas/modems.schema.test.ts` |
| THE CAPABILITY FEATURE-GATE FRAMEWORK LIVES HERE, ONCE | [the-capability-feature-gate-framework-lives-here-once.md](the-capability-feature-gate-framework-lives-here-once.md) | `schemas/capability-modules.schema.ts`, `capabilities/capability-matrix.ts`, `apps/backend/AGENTS.md`, `../../AGENTS.md` |
| THE BLUETOOTH DOMAIN REUSES THE LADDER WITHOUT JOINING THE REGISTRY [EXISTS] | [the-bluetooth-domain-reuses-the-ladder-without-joining-th.md](the-bluetooth-domain-reuses-the-ladder-without-joining-th.md) | `schemas/bluetooth.schema.ts`, `contracts/bluetooth.contract.ts`, `apps/backend/src/modules/bluetooth/`, `schemas/bluetooth.schema.test.ts`, `apps/backend/AGENTS.md` |
| CONVENTIONS | [conventions.md](conventions.md) | CONVENTIONS |
| ADD-ON `versionId` TRANSITION CONTRACT [EXISTS] | [add-on-versionid-transition-contract.md](add-on-versionid-transition-contract.md) | `/etc/os-release`, `@orpc/contract`, `zod/v4`, `contracts/index.ts` |
| ANTI-PATTERNS | [anti-patterns.md](anti-patterns.md) | `@ceraui/rpc`, `apps/backend/src/`, `apps/`, `@ceralive/modem-control` |
