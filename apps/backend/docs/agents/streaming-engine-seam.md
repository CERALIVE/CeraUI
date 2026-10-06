<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## STREAMING ENGINE SEAM [EXISTS]

`stream-session-orchestrator.ts` is the sole owner of public start/stop state.
UI, autostart, remote control, and set-profile restarts enter the same synchronous
admission boundary; only one launch can move `idle → starting`, and stop during
start cancels that generation before a later launch can be admitted. The legacy
`is_streaming` flag changes only after the awaited engine start confirms success.
At boot and after an engine reconnect, `reconcileRuntimeState()` subscribes to the
engine's actual status and adopts an engine-held session. Only concordant
`streaming` or `idle` status is authoritative. A successful subscription that sees
no event for 2.5 seconds resolves idle because an active stream emits status every
2 seconds; query/subscription failure, transitional state, or contradictory fields
remain `reconciling`, and late events from a completed probe are fenced. The additive
`status.stream_lifecycle` field exposes `idle | starting | streaming | stopping |
stop_failed | reconciling`; `is_streaming` remains backward compatible.

The launch transaction owns rollback and phase deadlines. The retry runner starts
the next connect attempt only after rollback resolves, caps attempts and elapsed
time, and exposes a cancellable timer to the same generation. Reporting suppresses
transient toasts only during existing update/restart/boot windows; terminal
failures are never suppressed and carry keyed 10-locale copy plus journal guidance.

The `StreamingBackend` interface (`modules/streaming/streaming-backend.ts`) has
**one** implementation behind the seam (the legacy ceracoder engine is fully
retired):

- `CerastreamBackend` (`cerastream-backend.ts`, Task 32) — the Rust `cerastream`:
  every op is a structured JSON-RPC call over the control socket via the
  `@ceralive/cerastream` npm package (NOT a sibling `link:` — see below). Config
  is the unified config serialized by the binding + pushed over IPC (no INI);
  errors arrive as **structured** Tier-2 events mapped onto Task-7's code table by
  `cerastream-error-mapping.ts` (zero stderr regex on this path); telemetry /
  device / status events are bridged into the existing `status` broadcast, and the
  engine telemetry snapshot is surfaced through the optional `getTelemetry()`
  hook. cerastream is systemd-owned (ADR-0005) — CeraUI connects, never spawns, so
  `start`/`stop` drive the pipeline over IPC. Additive cerastream-only RPC
  passthroughs (`switchInput`, `listDevices`) live on the concrete class, off the
  frozen seam. All effectful collaborators are injected (`CerastreamBackendDeps`)
  so the contract suite drives a real backend against an in-memory fake client.

**Engine selection** is the `engine` flag in `setup.json` (`"cerastream"` only,
schema in `helpers/config-schemas.ts`; a persisted legacy value is coerced to
`"cerastream"` at parse time with one warning — boot never crashes on it). Every
streaming call site still routes through `getStreamingBackend()`
(`streaming-engine.ts`) so a future engine can slot in behind the same seam.

**`@ceralive/cerastream` is a public-npm registry dependency** (`@ceralive` scope on
npmjs.org, pinned to a CalVer version — `2026.6.1` at time of writing) — NOT a
sibling `link:` like srtla and no longer a vendored `file:` tarball (cerastream
ARCHITECTURE §7 / ADR-0002 Decision 13: it ships to CeraUI as a published npm
package, so the backend builds standalone with no sibling checkout).
`tests/cerastream-bindings-skew.test.ts` guards the exact imported surface against
drift on a version bump.

Contract coverage: `tests/streaming-backend-contract.test.ts` runs the
structural contract over the production singleton + the cerastream behavioural
contract, error-mapping, status-bridge, passthroughs, engine-crash, and engine
selection.

