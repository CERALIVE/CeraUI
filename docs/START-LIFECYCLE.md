# Start-Lifecycle Contract

> **Status: RUNTIME THROUGH BOUNDED RETRY** (device-quality-wave2 Todos 25-28).
> The typed contract, unified session orchestrator, cleanup transaction, phase
> deadlines, bounded stop, retry/suppression, and truthful notification
> diagnostics are wired. Frontend generation fencing/rendering remains Todo 29.

The streaming **start** is a multi-phase pipeline that can fail at any of several
sites, in several ways, with very different correct responses (retry vs. surface
vs. prompt-for-update vs. stay-calm). Today those failures are handled
inconsistently: some become `void` notifications, some a bare `{success:false}`,
some an untyped log line. This contract replaces that with ONE typed taxonomy so
every later fix (unified lock, transactional launch, bounded retry, truthful
copy, frontend watchdog) speaks the same language.

Typed modules:

| Concern | Module |
|---------|--------|
| Wire contract (`StartResult`, `StartFailure`, `StopResult`, state set, transitions, retriability) | `packages/rpc/src/schemas/streaming-lifecycle.schema.ts` |
| Mapping table + attempt-id + retry policy + suppression predicate | `apps/backend/src/modules/streaming/start-failure-taxonomy.ts` |
| Bounded retry runner + cancellation | `apps/backend/src/modules/streaming/stream-start-retry.ts` |
| Suppression signals + keyed notifications/logs | `apps/backend/src/modules/streaming/stream-start-retry-reporting.ts` |
| Contract tests (schema) | `packages/rpc/src/schemas/streaming-lifecycle.schema.test.ts` |
| Contract tests (table-driven mapping) | `apps/backend/src/tests/start-failure-taxonomy.test.ts` |

The wire schema is browser-safe (pure Zod, no Node/Bun deps) so the backend
producer (Todos 26-28) and the frontend renderer (Todo 29) consume the identical
types. The mapping table is backend-only because it consumes the external
`@ceralive/cerastream` error classes.

---

## (a) The wire RESULT UNION

```
StartResult = started | busy | cancelled | failed(StartFailure)
```

Every variant is a discriminated wire object on the `result` field, and **every
variant echoes `attemptId`** — Todo 29 fences a stale response from an older
attempt on it.

| Variant | Shape | Meaning |
|---------|-------|---------|
| `started` | `{ result:'started', attemptId }` | The engine confirmed the stream reached PLAYING. |
| `busy` | `{ result:'busy', attemptId }` | A concurrent start was already in flight (Todo 26 returns this for concurrent entry). |
| `cancelled` | `{ result:'cancelled', attemptId }` | A stop arrived during start and cleanly cancelled this attempt (Todo 26). |
| `failed` | `{ result:'failed', attemptId, failure: StartFailure }` | The attempt failed; `failure` carries the taxonomy. |

**`busy` and `cancelled` are FIRST-CLASS results, not failure classes.** They are
normal, expected outcomes of concurrency, not errors.

**There is NO `superseded` failure class.** An attempt superseded/cancelled by a
stop terminates as the first-class `cancelled` result — one concept, one
representation. Introducing a `superseded` failure would be a second way to say
the same thing.

For the `failed` variant, the top-level `attemptId` **equals** `failure.attemptId`
(a locked invariant — the schema test asserts it). Both are present because the
plan requires every variant to echo `attemptId` at the variant level, and the
`StartFailure` type independently carries it for standalone logging.

### `StartFailure`

```ts
StartFailure = {
  attemptId: string;                 // REQUIRED — Todo 29 fences on it
  phase: 'params' | 'spawn-sender' | 'connect' | 'hello'
       | 'subscribe' | 'start-rpc' | 'playing-wait';
  class: 'engine_unavailable' | 'engine_restarting' | 'protocol_incompatible'
       | 'start_invalid' | 'engine_internal' | 'start_timeout';
  code?: number | string;            // engine JSON-RPC numeric code, or its string data-code
  retriable: boolean;                // materialized verdict for THIS (class, phase)
}
```

`phase` mirrors the real start pipeline; `class` is a small, behaviour-oriented
bucket (retry vs. surface vs. update-prompt), NOT a 1:1 mirror of every engine
code. `code`, when present, is the **canonical numeric JSON-RPC code** (the stable
machine identity the taxonomy enumerates); the human-readable string data-code
stays on the raw error for logs.

### The stop-result union

```
StopResult = stopping | stopped | stop_failed(reason)
```

| Variant | Shape |
|---------|-------|
| `stopping` | `{ result:'stopping' }` |
| `stopped` | `{ result:'stopped' }` |
| `stop_failed` | `{ result:'stop_failed', reason }` |

A stop that cancels an in-flight start produces a first-class **`cancelled`
StartResult** for that attempt (above); the stop call itself returns a
`StopResult`. Todo 27 makes stop return a bounded `stopping → stopped | stop_failed`.

---

## The failure-site mapping table (cross-check)

Every failure site found by searching the codebase (and the pinned external
`@ceralive/cerastream@2026.7.2` client, which owns the ENOENT/refused wrapping,
the hello/subscribe/request timeouts, and the JSON-RPC codes) is mapped to
exactly one taxonomy class. This is the checklist the acceptance criteria
require — each row is a site that was found and mapped.

| # | Failure site (searched for) | Location | Phase | Class | Retriable |
|---|-----------------------------|----------|-------|-------|-----------|
| 1 | oRPC input validation (Zod) | `packages/rpc/src/contracts/streaming.contract.ts:38` (input schema) | `params` | `start_invalid` | no |
| 2 | `validateConfig` `safeParse` | `apps/backend/src/modules/streaming/streaming.ts:126-136` | `params` | `start_invalid` | no |
| 3 | `startParamsWithAudioModeSchema.parse` | `cerastream-backend.ts:824-833` | `params` | `start_invalid` | no |
| 4 | plain validation `Error`s (delay/pipeline/codec/bitrate/latency) | `streaming.ts:140-190` | `params` | `start_invalid` | no |
| 5 | connect **ENOENT** (engine socket absent) → `CerastreamConnectionError` | client `client.js:52`; surfaced at `cerastream-backend.ts:447` | `connect` | `engine_unavailable` | **yes** |
| 6 | connect **ECONNREFUSED** (engine down) → `CerastreamConnectionError` | client; surfaced at `cerastream-backend.ts:447` | `connect` | `engine_unavailable` | **yes** |
| 7 | **transport-connect wrap** (generic `CerastreamConnectionError`) | `cerastream-backend.ts:384-387`, `729-744` | `connect` | `engine_unavailable` | **yes** |
| 8 | connect **timeout** (`CerastreamTimeoutError`) | client `requestTimeoutMs: 10_000`, `client.js:9,133` | `connect` | `start_timeout` | **yes** |
| 9 | **hello** protocol-major mismatch (`-32000` / `unsupported_version`) | `cerastream-backend.ts:366-375`; codes `errors.js:74` | `hello` | `protocol_incompatible` | no |
| 10 | **hello** result-shape `ZodError` (`helloResultSchema.parse`) | client `client.js:61`; classified `cerastream-backend.ts:355-363` | `hello` | `protocol_incompatible` | no |
| 11 | **hello** connection **close** (`CerastreamConnectionError`) | `cerastream-backend.ts:383-387` | `hello` | `engine_unavailable` | **yes** |
| 12 | **hello** timeout (`CerastreamTimeoutError`) | client `client.js:131-134` | `hello` | `start_timeout` | no |
| 13 | **subscribe** timeout (`CerastreamTimeoutError`) | `cerastream-backend.ts:449-451` (`subscribeEvents`) | `subscribe` | `start_timeout` | no |
| 14 | **subscribe** connection lost (`CerastreamConnectionError`) | `cerastream-backend.ts:449-451` | `subscribe` | `engine_unavailable` | no |
| 15 | start-RPC `-32000` unsupported_version | `errors.js:74` | `start-rpc` | `protocol_incompatible` | no |
| 16 | start-RPC `-32602` params.invalid | `errors.js:75` | `start-rpc` | `start_invalid` | no |
| 17 | start-RPC `-32002` already_streaming | `errors.js:77` | `start-rpc` | `engine_internal` | no |
| 18 | start-RPC `-32003` device.not_found | `errors.js:78` | `start-rpc` | `start_invalid` | no |
| 19 | start-RPC `-32603` internal | `errors.js:82` | `start-rpc` | `engine_internal` | no |
| 20 | client **request timeout** (10s) on the `start` RPC | client `client.js:9` (`requestTimeoutMs: 10_000`) | `start-rpc` | `start_timeout` | no |
| 21 | **PLAYING wait** timeout | (see note) | `playing-wait` | `start_timeout` | no |
| 22 | any **unmapped/opaque** shape | fallback in `classifyStartFailure` | *(caller phase)* | `engine_internal` | no |

**Notes on sites the plan assumed but the codebase does NOT currently have as
literal code:**

- **PLAYING confirmation (row 21).** CeraUI parses the binding's `start` result
  inside the 5s `playing-wait` deadline. A direct `state: "streaming"` result
  completes the phase. A valid transitional result such as `state: "starting"`
  keeps the phase pending until the existing event subscription receives a
  concordant runtime status (`state: "streaming"`, `streaming: true`). No polling
  loop or second engine operation is introduced.
- **`spawn-sender` phase.** A local sender spawn/setup failure maps here. Any
  later engine-phase failure unwinds the exact sender handle.
- **`-32001` (not_streaming), `-32004` (bitrate), `-32005` (preview),
  `-32006` (audio device)** exist in the client's `RPC_ERROR_NUMERIC`
  (`errors.js:76-81`) but are not START-path outcomes (they belong to stop /
  setBitrate / preview / audio-switch); an unexpected one at start falls through
  to `engine_internal` (row 22) rather than being silently dropped.

The mapping is realized by `classifyStartFailure(phase, error, attemptId)`, which
**never throws**: an unmapped/opaque shape is bucketed as `engine_internal` and a
warning is emitted so the drop-through is observable (asserted in the mapping
tests).

---

## (b) Attempt-ID generation

`newAttemptId()` (in `start-failure-taxonomy.ts`) mints one id at the **public
`start` boundary** — a time-sortable prefix plus random entropy
(`att_<base36 time>_<rand>`). It is carried through the queue, the logs, the
notification detail, and every `StartResult` variant. Todo 26 generates it once
per public start entry; Todo 29 uses it to fence stale responses.

---

## (c) Suppression window

A transient (retriable) failure inside a KNOWN window should show a calm "engine
starting…" state, not an error notification. `shouldSuppressTransientFailure(ctx)`
is the pure predicate; each input is sourced from an **existing** backend signal
(Todo 28 binding):

| Window | `SuppressionContext` field | Existing signal source |
|--------|----------------------------|------------------------|
| Software update active | `softwareUpdateActive` | `isUpdating()` (software-updates module) |
| Known engine restart (systemd `RestartSec=5`) | `engineRestartWindow` | a prior capability snapshot plus the current retriable connect failure (the engine was reachable this run and is now absent/refused) |
| Boot window | `bootWindow` | initial `engineStarting` capability or process uptime within the 60-second start budget |
| Cancelled by stop | `cancelledByStop` | the attempt ended as the first-class `cancelled` result — it notifies nothing |

A **real terminal** failure (budget exhausted, or a non-retriable class) is NEVER
suppressed — that gating lives in the retry loop (Todo 28), not in this predicate.

---

## (d) Retry policy

Bounded exponential backoff, for **retriable classes only**, with a max-attempts
AND a total-time budget (`DEFAULT_START_RETRY_POLICY`: 5 attempts / 60s budget /
2s base / 16s ceiling — chosen against the supervision windows: systemd
`RestartSec=5`, crash-loop 5/60s).

- `nextBackoffDelayMs(attempt, policy)` — `base·2^attempt`, capped at `maxDelayMs`.
- `shouldRetryStart(failure, {attempts, elapsedMs}, policy)` — retries iff the
  failure is `retriable` AND both budgets remain.
- Every failed launch finishes its transactional rollback before the backoff timer
  is armed. Stop cancels that timer by generation and produces `cancelled` with no
  notification.
- A scheduled retry logs `attemptId`, phase, class, engine code when present, and
  retry state. It emits a class-keyed localized warning only outside a suppression
  window. Terminal exhaustion/non-retriable failure emits exactly one keyed error
  with attempt count and `journalctl -u cerastream.service`.

Retriability is **phase-scoped** (see the retriability table below): only failures
in the connection-establishment phases (`connect`, and `hello` for the
availability classes) are retriable, because a failure BEFORE the engine accepts
the start is a boot/restart race a clean re-dial resolves, whereas a failure AFTER
(`subscribe`/`start-rpc`/`playing-wait`) means the engine accepted us then
faltered mid-start — a blind retry there would stack a duplicate/half-applied
start, so Todo 27 rolls back and escalates instead.

### Retriability table (every class marked, with a one-line WHY)

| Class | Retriable phases | Why |
|-------|------------------|-----|
| `engine_unavailable` | `connect`, `hello` | The engine is not answering yet (ENOENT/refused/dropped while connecting); a bounded retry across the boot/restart window reconnects with no operator action — but only before the start is accepted. |
| `engine_restarting` | `connect`, `hello` | A known systemd `RestartSec=5` restart is in flight; retrying across the restart window reaches the fresh engine — only while still establishing the connection. |
| `start_timeout` | `connect` | A connect-phase timeout is a slow-boot race and retries cleanly; a timeout AFTER connect means a half-applied start on a wedged engine, so a retry would stack a duplicate start — escalate instead. |
| `protocol_incompatible` | *(none)* | An engine/bindings protocol-major mismatch is deterministic — the same binaries never negotiate on retry, so surface an update prompt instead of looping. |
| `start_invalid` | *(none)* | Invalid params/config are deterministic — an identical retry fails identically, so the operator (or cloud) must fix the input first. |
| `engine_internal` | *(none)* | A deterministic engine-side fault or state conflict (e.g. already_streaming / -32603); retrying masks a real bug and can orphan resources — surface with a journal pointer. |

---

## (e) Lifecycle state set + legal transitions

State set: `idle | starting | streaming | stopping | stop_failed | reconciling`.

- `starting` is **distinct** from `streaming` (Todo 26: `is_streaming=true` only
  after engine confirmation).
- `reconciling` is the boot/reconnect state where the backend queries the
  engine's actual runtime state and adopts it (the engine may be streaming while
  CeraUI restarted).
- `stop_failed` is a terminal-until-retried state a stop can land in.

Legal transitions (anything else is an invariant violation → structured recovery,
Todo 26 — never a silent state stomp; a self-loop is never a transition):

```
idle        → starting      (start requested)
idle        → reconciling   (boot / reconnect entry)
starting    → streaming     (engine confirmed PLAYING)
starting    → idle          (terminal start failure, or cancelled-and-cleaned)
starting    → stopping      (an explicit stop arrived mid-start)
starting    → reconciling   (backend reconnect mid-start)
streaming   → stopping      (stop requested)
streaming   → reconciling   (backend reconnect while streaming)
stopping    → idle          (stopped)
stopping    → stop_failed   (stop did not settle within the bound)
stop_failed → stopping      (retry the stop)
stop_failed → idle          (reconciled / abandoned to idle)
reconciling → streaming     (engine was streaming — adopt)
reconciling → idle          (engine was idle — adopt)
```

`isLegalLifecycleTransition(from, to)` is the pure guard over
`LEGAL_LIFECYCLE_TRANSITIONS`.

---

## What this unblocks

| Todo | Uses from this contract |
|------|-------------------------|
| 26 (unified lock + boot reconciliation) | `busy`/`cancelled` results, `attemptId`, the state set + transitions, `reconciling` |
| 27 (implemented) | idempotent LIFO rollback, per-phase `start_timeout`, bounded `StopResult` |
| 28 (implemented) | bounded retry, suppression binding, keyed copy, diagnostic payloads, bounded autostart |
| 29 (frontend watchdog + generation identity + typed rendering) | `attemptId` fencing, `phase`+`class` → i18n rendering |

---

## Transactional runtime (Todo 27)

Each acquired launch resource registers cleanup immediately. Failure unwinds in
strict reverse order: engine stop, event subscription, control client, link
telemetry, then the exact `srtla_send` process. Rollback is idempotent; one
cleanup failure is logged and cannot prevent the remaining entries from running.

The public binding's `connect()` combines the UDS connect and mandatory hello
request, so CeraUI does not simulate a separate hello I/O operation.
Machine-readable classification is:

| Binding failure | Reported phase |
|---|---|
| `CerastreamConnectionError` (`absent`/`refused`/`unreachable`) | `connect` |
| hello RPC error, hello-response Zod error, or hello request timeout | `hello` |
| outer combined-operation deadline without a binding error | `connect` |

Application-owned awaits stay separate and bounded: subscribe (10s), start RPC
(10s), and PLAYING confirmation (5s). The direct start reply is authoritative
only when it reports `state: "streaming"`; any other valid state, including
`state: "starting"`, waits for a subscribed status heartbeat whose state is
`streaming` and whose `streaming` flag is true. Missing that confirmation returns
typed `start_timeout` in `playing-wait`. Stop is bounded at 12s and returns
`stop_failed(reason: "stop_timeout")` when cleanup does not settle. Sender
termination retains the existing 10s SIGTERM-to-SIGKILL policy.

Connect and subscription are acquisition phases: their cleanup is registered on
the acquisition promise before it enters the deadline race. If either promise
resolves after timeout and rollback, transaction registration observes the
rolled-back state and closes the late resource immediately. The race retains a
rejection observer as well, so a late failed acquisition cannot become an
unhandled rejection.

IP-list preparation completes before sender launch. Initial read/write or
no-interface failures are launch-critical typed failures. Network-change refresh
failures after launch are logged separately and cannot rewrite the start result.
