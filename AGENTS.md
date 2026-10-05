# CeraUI — Agent Knowledge Base

Parent: [Workspace rules](https://github.com/CERALIVE/ceralive/blob/master/AGENTS.md).

<!-- workspace-hard-rules:begin -->
## Workspace hard rules (identical in every CeraLive AGENTS.md)
- Commits and PRs carry the human author only: no Co-authored-by, no AI attribution.
- Start from the updated canonical branch; rebase to update; never `reset --hard` or discard others' work.
- One focused PR per repo, opened against CERALIVE/<repo>; the root policy PR merges first.
- A repo is self-contained: no path above its root; consume @ceralive packages from the registry, never link:/file:.
- Never delete, skip or weaken a test; every behavior change ships with a test.
- A user-visible change updates docs.ceralive.tv in English and Spanish (es-419), and any ceralive.tv claim it touches, in the same release.
- AGENTS.md holds rules and routing only, within budget; contracts and history live in docs/agents/.
- Full canon: https://github.com/CERALIVE/ceralive/blob/master/AGENTS.md
<!-- workspace-hard-rules:end -->

## ROLE

On-device control plane: Bun monorepo with backend, Svelte frontend and shared RPC/i18n/sender helpers.

## STRUCTURE

```text
apps/ — device backend and frontend
packages/ — shared contracts and helpers
scripts/ — build, CI and release tooling
deployment/ — device payload
docs/ — engineering contracts
.github/ — CI and review policy
```

## COMMANDS

Run from the CeraUI checkout root:

```bash
bun install --frozen-lockfile
bun run lint
bun run test
bun run check:tech-debt
bun run test:e2e
bun run build
bun run test:release-package-contracts
```

## WHERE TO LOOK

| Task / code scope | Contract |
|---|---|
| Before changing anything else here, open docs/agents/README.md and read the contract for the subsystem you touch | [Contract index](docs/agents/README.md) |
| Preamble / ROLE IN THE GROUP | [Contract 1](docs/agents/overview.md); [Contract 2](docs/agents/role-in-the-group.md) |
| A REGISTRY PIN IS A VERSION BOUNDARY, AND THE GATE IS… / STRUCTURE | [Contract 3](docs/agents/a-registry-pin-is-a-version-boundary-and-the-gate-is-the.md); [Contract 4](docs/agents/structure.md) |
| WHERE TO LOOK / COMMANDS | [Contract 5](docs/agents/where-to-look.md); [Contract 6](docs/agents/commands.md) |
| ADD-ON SUBSYSTEM / DEVICE HEALTH PANEL | [Contract 7](docs/agents/add-on-subsystem.md); [Contract 8](docs/agents/device-health-panel.md) |
| MOCK SUBSYSTEM / DEVICE STATS | [Contract 9](docs/agents/mock-subsystem.md); [Contract 10](docs/agents/device-stats.md) |
| HARDWARE PREVIEW ENCODE / DEVICE DETECTION + KIOSK EMULATION SAFETY | [Contract 11](docs/agents/hardware-preview-encode.md); [Contract 12](docs/agents/device-detection-kiosk-emulation-safety.md) |
| DEP BASELINE (as of 2026-08) / LOCAL DEV: CONTROL-CHANNEL OVERRIDE | [Contract 13](docs/agents/dep-baseline-as-of-2026-08.md); [Contract 14](docs/agents/local-dev-control-channel-override.md) |
| CONVENTIONS / Release & CI rules | [Contract 15](docs/agents/conventions.md); [Contract 16](docs/agents/release-ci-rules.md) |
| BUN-NATIVE CONVENTIONS (as of 2026-06) / CAPABILITY CONSUMER | [Contract 17](docs/agents/bun-native-conventions-as-of-2026-06.md); [Contract 18](docs/agents/capability-consumer.md) |
| THE GATES HAVE AN OPERATOR SURFACE / HOTSPOT QR SURFACE — ONE QR, AND IT IS ESCAPED | [Contract 19](docs/agents/the-gates-have-an-operator-surface.md); [Contract 20](docs/agents/hotspot-qr-surface-one-qr-and-it-is-escaped.md) |
| STREAMING BACKEND QUALITY / INGEST HARDENING | [Contract 21](docs/agents/streaming-backend-quality.md); [Contract 22](docs/agents/ingest-hardening.md) |
| FEDERATION PRODUCER PIPELINE / APPLY-NOW CONFIG CHANGE (frontend half) | [Contract 23](docs/agents/federation-producer-pipeline.md); [Contract 24](docs/agents/apply-now-config-change-frontend-half.md) |
| RECEIVER COHERENCE — v2 destination/transport/latency… / RECEIVER CAPABILITY RECONCILIATION | [Contract 25](docs/agents/receiver-coherence-v2-destination-transport-latency-model.md); [Contract 26](docs/agents/receiver-capability-reconciliation.md) |
| NETWORK-INGEST GATEWAY (LAN RTMP/SRT) / NETWORK COLLISION SURFACING + POLICY-ROUTE SELF-CHECK | [Contract 27](docs/agents/network-ingest-gateway-lan-rtmp-srt.md); [Contract 28](docs/agents/network-collision-surfacing-policy-route-self-check.md) |
| AUTH-STATE + CONNECTION STORE CONSOLIDATION / CAPABILITY-TRUTHFULNESS REGRESSION GATE | [Contract 29](docs/agents/auth-state-connection-store-consolidation.md); [Contract 30](docs/agents/capability-truthfulness-regression-gate.md) |
| DEVICE-FIRST SOURCE MODEL + GO LIVE CARD / LIVE-CORRECTNESS-PASS FIXES | [Contract 31](docs/agents/device-first-source-model-go-live-card.md); [Contract 32](docs/agents/live-correctness-pass-fixes.md) |
| THE WI-FI OFFERING IS DERIVED FROM THE RADIO / THE BLUETOOTH FOUNDATION | [Contract 33](docs/agents/the-wi-fi-offering-is-derived-from-the-radio.md); [Contract 34](docs/agents/the-bluetooth-foundation.md) |
| THE BT MICROPHONE IS A SOURCE, NOT A SPECIAL CASE / ANTI-PATTERNS | [Contract 35](docs/agents/the-bt-microphone-is-a-source-not-a-special-case.md); [Contract 36](docs/agents/anti-patterns.md) |
| UVC package identity | [Contract 37](docs/agents/uvc-package-identity.md) |

## HARD RULES

- R1: Every commit passes lint, typecheck and Tier-1 unit tests (DB-free); PRs add integration, Playwright e2e and backend tests.
- R1: check:tech-debt is CeraUI-only; platform PRs also run bun run build. Tier-3 is release/manual, not a PR gate; never weaken tests.
- R2: One integration branch and one PR per repo; merge root policy -> ceralive-platform -> CeraUI. Rebase between waves; stop on conflicts.
- Federation: bun run build:federation, GPG-sign via bun run sign:federation, then publish-federation; serve signed bundles for 6 months.
- No shadow producer wire types: import published producer types and schemas; publish binding changes before consumers may merge.
- Use registry dependencies, never sibling link: or file: paths; a registry version is a schema boundary, not just a path boundary.
- cerastream is the sole engine; preserve typed capture/start/preview failures and never invent hardware capabilities or fallback support.
- Update behavior/structure docs in the same change; user-visible labels and claims require coordinated user-doc updates (Rule G).
- Never expose device credentials, bypass authentication, force a reboot during streaming, or replace an explicit unknown with success.
