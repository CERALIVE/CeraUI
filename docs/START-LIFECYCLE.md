# Start-Lifecycle Contract

> **Status: FULLY WIRED** (device-quality-wave2 Todos 25-29). The typed contract,
> unified session orchestrator, cleanup transaction, phase deadlines, bounded stop,
> retry/suppression, truthful notification diagnostics, and the frontend start
> watchdog + attempt generations + typed failure rendering (Todo 29) are all wired.

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
  // Closed enum — see streaming-lifecycle.schema.ts `START_FAILURE_CLASSES`
  // for the full, current list (audio/modem/capture classes added later,
  // `update_in_progress` added by Todo 37, are not all repeated here).
  class: 'engine_unavailable' | 'engine_restarting' | 'protocol_incompatible'
       | 'start_invalid' | 'engine_internal' | 'start_timeout'
       | 'update_in_progress';
  code?: number | string;            // engine JSON-RPC numeric code, or its string data-code
  // Present ONLY on `update_in_progress` (Todo 37). A probe-only refusal
  // reports fixed committing/0/0 while the orchestrator stays downloading.
  updatePhase?: 'idle' | 'checking' | 'available' | 'downloading' | 'awaiting-idle'
       | 'committing' | 'restarting-services' | 'settled' | 'os-available'
       | 'os-staging' | 'os-staged' | 'os-activation-armed' | 'os-verifying'
       | 'sync-eligible' | 'syncing' | 'synced' | 'quarantined' | 'failed';
  updatePercent?: number;
  updateEtaSeconds?: number;
  retriable: boolean;                // materialized verdict for THIS (class, phase)
}
```

### `update_in_progress` (Todo 37)

`typedUpdateInProgressFailure()` builds this refusal at `phase: 'params'` with
`retriable: false`. Wait for the refusing condition to clear, not an automatic
retry; `settled` is not required.

Probe, stop and OTA-marker semantics are in the
[DEVICE-UPDATES D8 section](./DEVICE-UPDATES.md#d8-stream-admission);
see the root AGENTS.md D8 Known gaps for launch and post-admission limits.

Treat `updateEtaSeconds: 0` as unknown, not as "done". Other launch and
post-admission gaps are in "D8 stream/update admission:
what it does NOT cover" under Known gaps in the root
[`AGENTS.md`](../AGENTS.md).

The orchestrator's phases, the full D8 table and what is proven are in
[DEVICE-UPDATES.md](./DEVICE-UPDATES.md).

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

The generation is registered as `starting` before awaiting D8 admission, including
on an idle update runtime. Stop invalidates that pending generation before any
sender/engine launch or OTA marking. An allowed admission arriving afterward
returns `cancelled`, never resurrects the start, and releases its lifecycle lease.
Refusal or observer failure unwinds the pending generation; refusal payloads
(`update_in_progress`, phase, percent and ETA) are unchanged.

Restoration intent and physical OTA liveness are separate. Every Stop caller
reports intent before joining/parking shared work. Operator intent requests
marker removal and immediately revokes pending commitment and delayed arming
authority, even while Stop is parked. Cancellation settlement waits for that
parked Stop before cleanup, retaining engine-mutex ordering and physical protection.
Successful marker removal prevents fresh-factory restoration; marker I/O and
corruption are separate recovery limitations. Engine-loss/reconfigure retains intent. Joining
operator cause is preserved for cancelled launch settlement and parked Stop
release. Restoration reads intent after its runtime observation, so an operator
disarm during that await cannot resurrect the stream.
An import-free operator-intent token fences default restoration preparation and
settlement, Start commitment and delayed hooks, as well as pre-generation waits.
It never supplies positive engine evidence or removes physical protection.
Profile reconnect captures intent before its machine Stop await and checks it
before replacement Start; a joining operator cancels that restart flight.
`/run/ceralive/streaming` remains while a stop is
parked, rejected, timed out or unknown. Confirmed stop/cleanup or authoritative
idle reconciliation removes it; authoritative streaming reconciliation sets it
for a session surviving a backend restart. Unknown reconciliation preserves it.
These cancellation and marker transitions are host-tested, not board-qualified.

### Session ownership state machine [EXISTS; host proof, board qualification owed]

`stream-session-ownership.ts` owns state, generation, an operation epoch and the
OTA projection. `stream-session-cleanup.ts` owns submitted cleanup. The factory
retains admission, retry and configuration orchestration; wire/stored schemas,
D8 origins, refusal payloads and timing policy are unchanged.

The owner seeds the lifecycle projection at composition before hydration, without
broadcast or an engine-query wait before server bind. Retained protection seeds
`reconciling`; absent/unprotected boot seeds `idle`. The first safe transition
still broadcasts, including same-state reconciliation. Runtime evidence carries its producing client/epoch
predicate separately from presentation telemetry. New Start, client acquisition
and Start acknowledgement invalidate it; previous idle or subscription replay
from before Start cannot establish current idle. No fresh evidence is UNKNOWN.

| State | Admitted operation / transition | Liveness evidence |
|---|---|---|
| `idle` | Start → `starting`; query → `reconciling` | Positive idle or an unprotected admission baseline at any generation; production requires current sentinel absence, not new engine evidence from silence |
| `starting` | confirmed launch → `streaming`; rolled-back failure/refusal → `idle`; Stop → `stopping`; unknown cleanup → `reconciling` | Unknown once launch is submitted |
| `streaming` | Stop → `stopping`; query → `reconciling`; config → `reconfiguring` | Last confirmed live |
| `reconfiguring` | applied/reverted → `streaming`; engine-confirmed rollback idle → `idle`; deadline/socket loss → `reconciling` | Live until positive contrary evidence |
| `stopping` | acknowledged cleanup → `idle`; timeout/rejection → `stop_failed` | Unknown; last confirmed status retained |
| `stop_failed` | retry → `stopping`; authoritative query → `reconciling` | Unknown |
| `reconciling` | authoritative idle/live → `idle`/`streaming`; unknown → remain | Unknown; last confirmed status retained |

Every async continuation captures a generation/flight token and rechecks it before
changing **any** session state: lifecycle, active attempt, status, marker or lease.
The transition guard and its projection are one operation: rejection runs no
setters. Lease release uses the interlock's own token in the admission `finally`;
an old release cannot release a later holder. Unknown is never normalized to idle
from the legacy boolean status flag.
An externally cleared legacy flag may request authoritative reconciliation of an
otherwise settled streaming session; it is never itself idle evidence. Mock-mode
reconciliation reads the independent fake engine model, not that legacy flag.

`stream-launch-ownership.ts` carries that same factory cancellation predicate
through asynchronous launch setup using a per-async-context binding. Session setup
and sender-launch boundaries check it after awaits; a network-refresh callback
also checks its captured resource generation before restarting the sender.
Deferred source-commit/restoration-arm imports receive a current-owner predicate.
Runtime probes carry their observation owner to the engine event callback and
client-adoption boundary, so an obsolete probe cannot publish status before the
factory discards its answer. Session event listeners also check their client and
launch owner. No locally owned client is **not** idle evidence: `stop-evidence.ts`
queries state, stops an adopted live engine, and retains protection on unknown.
An explicit operator Stop may additionally send a fresh Stop to confirm an unowned
engine; automatic reconciliation cannot use that effectful path. A positive idle
event may settle an otherwise unowned running
session, but never runs through outstanding launch/cleanup ownership.
No new producer or wire field is needed. Launch config and resource-invariant
reporting have small, separately routed streamloop modules.

Stop reserves one flight **synchronously, before any await**. Duplicate Stops join
its answer; a configuration/capture-parked Stop joins the existing parked answer.
Reconciliation cannot adopt idle/live while cleanup owns the engine. A timeout
ends the caller's wait, not submitted cleanup's ownership: no new launch can enter
until that raw cleanup settles. Late acknowledgement retires only its own flight;
it cannot publish idle. A cancelled launch remains fenced until its continuation
settles and final cleanup establishes idle; an outstanding old launch also blocks
new admission even if an idle observation arrives.

**OTA invariant:** the owner requests `/run/ceralive/streaming` whenever a live or
possibly-effectful session requires protection, not for a silent observation of an
unprotected baseline. A failed write cannot establish physical protection: the latch
remains unconfirmed and the next current streaming status or protection call retries. It is cleared only by
positive idle evidence (including acknowledged transactional rollback Stop), never
local rollback completion, Stop intent, `start_cleanup_timeout`,
deadline expiry, or synthesized `rollback_failed / engine_connection_lost`.
Failed clearance remains UNKNOWN and retries on the next affirmative idle status
or acknowledged operator Stop. The leaf cannot report idle beside present/unreadable
sentinel evidence. Protected unknown outcomes
keep the generation and last confirmed live status, and block a fresh Start.
Restoration intent remains separate: operator Stop requests marker disarm and
revokes pending commitment/arming; machine Stop retains it. Marker I/O is not
proof of removal, and Stop intent itself never proves engine idle.

The internal `StreamStartFailure.liveness` carries rollback certainty without a
wire/schema change or replacing the original failure class/code. A possibly-effectful
Start whose rollback Stop is not acknowledged stays UNKNOWN; retries and replacement
Starts are refused. Acquisition continuations recheck ownership after connect and
subscribe, before assigning resources and immediately before dispatching Start.
Temporary probe and adopted-session event authority are separate. Every deferred
status-routing continuation checks its current client predicate before publication.

`streamLiveness()` is the consumer admission accessor: `streaming | idle | unknown`.
Its leaf module is `apps/backend/src/modules/streaming/stream-liveness.ts`; the
composition root binds the factory reader without a runtime import back-edge.
It is UNKNOWN during pending launch/cleanup, unresolved engine truth or failed
physical protection. UNKNOWN preserves generation, sentinel and last confirmed
legacy status. A silent 2.5-second subscribed probe is UNKNOWN for protected sessions;
its completion restores an unprotected baseline without creating a sentinel. Affirmative paths are current concordant idle
status and operator Stop acknowledgement. Stop on an idle engine is harmless.

Fresh boot with absent `/run` sentinel and no surviving/adopted session is an
unprotected admission baseline, not an engine-idle observation. Start and package/OTA
consumers remain admitted there. A probe gates only while in flight; silence cannot
create a standing block when nothing requires protection. The sentinel absence is
rechecked after observation; unreadable or newly present evidence stays UNKNOWN.
Launch, adoption and unconfirmed rollback irreversibly leave this empty baseline
until a current affirmative idle outcome releases their protection.
Confirmed Stop/rollback restores it regardless of generation. Cancellation retains
the launch's settled rollback certainty and cancelling Stop's cause/acknowledgement;
acknowledged operator cancellation plus a safely settled launch does not need a blind
second Stop. A non-adopting probe has no authority to advance the live client's epoch.
Contradictory/transitional current status is not silence: it retains UNKNOWN protection.
Reboot clears the tmpfs sentinel and permits that empty admission baseline; it
does not upgrade a silent probe to an affirmative engine-idle observation.
The existing update reason/catalog keys now offer
the honest Stop-confirmation hint; downstream disruptive consumers are migrated in
the separately assigned consumer lane.

**Follow-up — engine status snapshot [GREENFIELD; not done].** Passive idle proof
needs an additive current-status subscribe reply/hydration or read-only `get_status`
method, producer-owned exported types and a published/tagged binding before any
consumer reference. The engine release is owner-gated, cross-repo and out of scope.
Host fake-engine regressions and the independent delivered-evidence matrix do not
qualify real engine scheduling, media, power loss, activation or either board.

The real-factory interleaving harness uses boundary gates and the real lifecycle
lease, enumerating enabled event orderings to depth five, plus the six-event
reconciliation/old-stop regression. It checks launch exclusion, conservative OTA
projection, stale completion rejection, lease release at quiescence, side-effect-free
rejection and Stop joining. This is bounded host model coverage, not proof of every
unbounded history, real engine scheduling, filesystem writes or board media.

### Bounded subprocess completion [EXISTS; host tested]

`bounded-spawn.ts` separates process completion from output drainage. The command
deadline also bounds inherited-open pipes. A live child gets TERM, a 100 ms
grace timer, KILL if still live, a 100 ms reap timer and 50 ms drainage timer. The existing
30-second default command budget and supervised-worker shutdown policy do not change.
Output collected before the bound is retained; further reads are cancelled without
an unbounded join. A zero exit established **before** termination remains independent
positive CLI evidence even when drainage is cut short; a TERM-induced zero never
becomes success or invokes positive `onExit`. Kernel-uninterruptible retirement is
not proven by the runnable real-child tests. Timeout fixture clocks fire only after
explicit readiness, so delayed child scheduling is not mistaken for lost output.
The deterministic hard-bound proof manually advances the injected clock and
requires deadline → TERM → 100 ms grace → KILL → 100 ms reap → 50 ms drain →
timeout rejection with neither exit nor pipe drainage available. A separate real
TERM-ignoring child has no natural exit; after rejection it must be SIGKILLed,
joined through `child.exited`, and absent from `/proc`. Its 10-second safety
deadline detects a stuck fixture/reaper, not a retirement-latency guarantee.
Signal-exit classification fixtures also control cleanup clocks. The inherited-pipe
fixture establishes actual zero exit while a test-owned descendant holds output
open indefinitely, then fires its deadline and joins cleanup. No child startup
must complete within a sub-second wall-clock window. Host oversubscription can
delay real timer delivery/reaping; real-time retirement latency under that load
and kernel-uninterruptible children remain unqualified. The original PID-visible
failure has no captured process state; later observed Z state supports a zombie
explanation only as an inference, not a retrospective hardware/process receipt.

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

Bounded exponential backoff, for **retriable classes only**, with a max-attempts,
per-attempt launch deadline, AND a total-time budget
(`DEFAULT_START_RETRY_POLICY`: 5 attempts / 10s launch deadline / 60s budget /
2s base / 16s ceiling — chosen against the supervision windows: systemd
`RestartSec=5`, crash-loop 5/60s).

- `nextBackoffDelayMs(attempt, policy)` — `base·2^attempt`, capped at `maxDelayMs`.
- `shouldRetryStart(failure, {attempts, elapsedMs}, policy)` — retries iff the
  failure is `retriable` AND both budgets remain.
- Every failed launch finishes its transactional rollback before the backoff timer
  is armed. Stop cancels that timer by generation and produces `cancelled` with no
  notification.
- A launch that remains in flight for 10 seconds has its generation cancelled and
  bounded cleanup awaited before it becomes a retriable connect-phase
  `start_timeout`. The launch itself must then settle before backoff is armed. If
  cleanup cannot make it settle within the stop bound, the result is terminal
  `start_cleanup_timeout` and no next attempt launches. A late completion remains
  fenced to that cancelled launch and cannot declare the session started.
- Engine stop bypasses `CerastreamBackend`'s ordinary IPC queue and opens a fresh
  control connection. The engine accepts one in-flight request per connection, so
  sending stop on the session client can queue it behind `list-devices` or start;
  closing that client would then discard the unread request. CeraUI dispatches stop
  on the fresh connection first, closes the session client to settle its pending
  work, and reports `stopped` only after the independent request answers
  `state: "idle"`. The fresh connect plus acknowledgement has a derived
  6.5-second budget, reserving 5 seconds for socket cleanup and 0.5 seconds for
  scheduling inside the unchanged 12-second outer bound. If that request budget
  expires, a connection that resolves later is closed without dispatching `stop`;
  a pending stop connection is also closed and cannot invoke the completion
  callback. An already-dispatched request may still settle inside the engine after
  its client is closed, so its outcome is deliberately UNKNOWN: the caller gets
  `stop_failed` and reconciliation adopts the engine's eventual truth.
- A scheduled retry logs `attemptId`, phase, class, engine code when present, and
  retry state. It emits a class-keyed localized warning only outside a suppression
  window. Terminal exhaustion/non-retriable failure emits exactly one keyed error
  with attempt count and a pointer at the in-app log viewer (Settings → System
  Logs). Operator-facing copy never names a shell command or a systemd unit —
  CeraLive operators have no console; the raw journal stays the support channel,
  reachable from that dialog.

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
| `update_in_progress` | *(none)* | A cached refusing phase, fresh wire read or positive/fail-closed probe blocked admission. Wait for that condition to clear; automatic retry is not authorized. |

---

## (e) Lifecycle state set + legal transitions

State set: `idle | starting | streaming | stopping | stop_failed | reconciling`.

- `starting` is **distinct** from `streaming` (Todo 26: `is_streaming=true` only
  after engine confirmation).
- `reconciling` is the boot/reconnect state where the backend queries the
  engine's actual runtime state and adopts it (the engine may be streaming while
  CeraUI restarted). A successfully subscribed probe observes status for 2.5
  seconds: concordant streaming/idle is adopted immediately, silence remains
  UNKNOWN even though live sessions heartbeat every 2 seconds, and query failure or a
  contradictory/transitional event remains unknown. Events arriving after the
  probe closes are fenced.
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

---

## Frontend consumption (Todo 29)

The frontend closes the loop with three pieces, all in `apps/frontend/src/lib/rpc/`:

- **Attempt generations** (`streaming-optimism.svelte.ts`). The optimism store
  carries a monotonic `generation`, bumped on every `transitionToStarting`. A
  revert (`revertWithReason`/`revertWithFailure`) that carries an OLDER generation
  is a stale response from a superseded attempt and is IGNORED — so a delayed
  reply from attempt N cannot clobber attempt N+1's state. `LiveView.handleStart`
  captures the generation right after `startStreamingOptimism()` and passes it back
  on revert. The authoritative-status precedence rule is unchanged: a
  contradicting `is_streaming` push during `starting` is still ignored (no flicker)
  — the fencing applies only to the explicit typed/legacy revert path.

- **Start watchdog** (`streaming-start-watchdog.ts`, the sibling of the stop
  watchdog). Armed on `transitionToStarting`; if `starting` persists past
  `START_WATCHDOG_TIMEOUT_MS` (90s — above the retry budget) it PULLS authoritative
  status via `rpc.status.getStatus` and reconciles: streaming → confirm
  `starting`→`idle` (a lost success push), NOT streaming → revert with
  `start_timeout` (a lost failure reply / wedged attempt). This is the "no infinite
  spinner" guarantee.

- **Typed failure rendering** (`LiveView.svelte`). The `failed` RPC result echoes
  the typed `StartFailure` (phase + class + retriable + attemptId, exposed on
  `streamingStartOutputSchemaExtended`). `LiveView` maps `class` → the
  `live.startFailure.class.*` i18n message and appends a retry-state suffix
  (`retriedThenFailed` for retriable classes, `notRetriable` for deterministic
  ones); a legacy code-string reason is the fallback. The terminal failure reverts
  the UI to idle with the reason shown.

- **Client-call timeout contract** (`client.ts` `PROCEDURE_TIMEOUT_MS`). Because
  `streaming.start` now awaits the bounded connect-retry (up to a 60s budget), the
  RPC client's 30s default `call` timeout would reject a still-valid in-flight start
  and drop the terminal typed `failure`. The proxy raises `streaming.start` to 75s
  (above the retry budget, below the 90s watchdog), so the awaited reply stays the
  primary signal and the watchdog is only the lost-signal backstop. Every other
  procedure keeps the 30s default.

The authoritative `is_streaming=false` broadcast the Todo-27 rollback emits (on a
terminal failure that HAD reached streaming) is consumed by `subscriptions.svelte`
and drives `getIsStreaming()` — proven through the WS layer by
`streaming-status-broadcast.integration.test.ts`.

### Operator escape from an unconfirmed state [EXISTS; host-tested, board drill owed]

`stop_failed` and `reconciling` commit UNKNOWN liveness: the backend keeps the OTA
sentinel and refuses a fresh Start (and, through the update and disruptive-action
gates, update Check/Install and reboot/power) until positive engine evidence or an
acknowledged operator Stop. The operator's `streaming.stop` is the only Stop that
may confirm an unknown engine. Neither state moves `is_streaming`, so a device
whose last confirmed value was `false` showed the idle cockpit, which has no Stop.

`apps/frontend/src/main/live/UnconfirmedStreamBand.svelte` closes that gap with
the field already on the wire, `status.stream_lifecycle`; no RPC, wire field or
schema changed. `LiveView` mounts it above both cockpits, because the post-stream
summary window can still hold a Stop-less `LiveCockpit` when a silent reconcile
follows an engine-loss stop. It renders an amber band and a Stop exactly when
`showUnconfirmedStreamStop` holds:

| `stream_lifecycle` | `is_streaming` | band's own Stop | Band + Stop |
|---|---|---|---|
| `reconciling` or `stop_failed` | `false` | any | yes, whatever the local optimism |
| `stopping` | `false` | pending | yes, as one continuous "Stopping..." |
| any, including `stopping` retained after a lost reply, or absent | `false` | unresolved (pressed, not settled by the device) | yes: failure or "not confirmed yet" copy and an enabled Stop (FIX-16-FRONT3) |
| `reconciling` or `stop_failed` | `true` | any | no: the live cockpit's Stop is on screen |
| `idle`, `starting`, `streaming`, `reconfiguring`, absent; `stopping` with no pending Stop | any | none unresolved | no: unchanged |

Local optimism never hides it (FIX-16-C3). The optimistic live cockpit that a
local `starting` keeps on screen shows a DISABLED "Starting...", not a Stop, and a
start whose reply a connection reset swallowed keeps `starting` on every
`is_streaming:false` frame for up to the 90 s start watchdog. So `LiveView` also
settles that stale `starting` (generation-fenced, no failure reason, start
watchdog cleared) the moment the device's own lifecycle supersedes it
(`startOptimismSuperseded`): at once on `reconciling`/`stop_failed` with
`is_streaming` false (the backend refuses a start there and its own start can only
have ended there), and, after a lost start reply, on an `idle` lifecycle
DELIVERED after the loss over the link that is current now
(`session-epoch` `lifecycleDeliveredSince`, FIX-16-FRONT3 R1). A restored
session is not that evidence: re-authentication can succeed while the status
hydrate fails, and the store then still holds the pre-reset snapshot. Nor is a
status push that does not carry the field, because the merge keeps the old
value. The subscription store stamps a delivery only when a frame carries
`stream_lifecycle` or a full snapshot establishes its absence. A failed
hydrate, a hydrate that says `starting` and an absent lifecycle (older backend)
keep `starting` with today's watchdog bound. The lost-reply record lives in
`lib/streaming/unresolved-stream-actions.svelte.ts`, not in LiveView, because
NavigationRenderer replaces the destination on navigation while the optimism it
qualifies is app-wide.

A full pulled status (`ingestPulledStatus`: the reconnect hydrate and the stop
watchdog's pull) is a SNAPSHOT: a lifecycle it omits is absent now, so it
replaces the held value. A partial push that omits the field merges as before
(R4).

The Live header withholds its "Not streaming" chip whenever the band shows,
because the band below it says the device cannot confirm.

The band says the device cannot confirm whether a stream is running and that
Start and updates are paused until it can; it never says the stream is or is not
live. Its Stop calls `rpc.streaming.stop()` through `osCommand` under the key
`stream-stop-unconfirmed`. Only device evidence confirms it
(`stopConfirmedByDevice`): the `idle` lifecycle commit, which the backend
publishes before it replies `stopped`. The band leaving the screen is NOT
evidence: the backend enters `stopping` before the engine answers and commits
`stop_failed` if it never does, and an operation already `confirmed` cannot turn
`failed` (C2 confirmed on `!visible` and so swallowed exactly that failure). A
reply is not evidence either (a `stopped` answer can come while a pending launch
keeps the lifecycle `reconciling`), nor is an absent lifecycle field. Until the
idle commit arrives the operation stays pending, a `stop_failed` reply or a
thrown call shows an inline failure with Stop enabled again, and the shared
async-operation TTL turns a silent device into "not confirmed yet" with Stop
enabled again. It does not drive the optimism overlay and does not clear
notifications.

The operator's Stop is a CLAIM, separate from the shared operation's phase
(FIX-16-FRONT3 R2; the registry itself is unchanged). A reset after `stopping`
fails the operation while the store keeps `stopping`; C3 then hid the band and
left only Start. The claim keeps the band, its copy and an enabled Stop until
the device settles it: an idle commit delivered after the press over the
current link, or an acknowledged `{ success: true, result: "stopped" }` for
THAT press (D207). A failure, a reconnect, a failed hydrate, a lapsed TTL,
`stopping`, `starting` and an absent lifecycle do not end it, and it survives
LiveView being mounted anew. Nothing is dispatched automatically.

Each press owns its claim (FIX-16-F4, PRE4-C C4-1/C4-2).
`claimOperatorStop()` returns an owner token; the press's reply settles only
the claim that token names, so the delayed `stopped` of a first Stop that
outlived the 15 s valve cannot clear a retry's claim, in either reply order.
An acknowledgement closes its claim but keeps its delivery mark, so the same
press's pending operation is still confirmed by the idle commit that follows.
And the PENDING operation is confirmed only by the same evidence as the claim:
an idle delivered after the latest press over the current link. A retry
pressed over an idle that a failed hydrate retained from an older link stays
pending, and its `stop_failed` reply still fails it. The shared registry is
unchanged; an older reply can still move a newer operation's phase through
the shared key (the registry's documented backlog), which changes the copy but
never the claim, so the band and its Stop stay.

"Delivered after the press" distinguishes pushes from replies (FIX-16-F6).
A push needs current-link receipt after the claim. A reply additionally needs
a request DISPATCHED after the claim, and after the newest applied status
observation. Receipt orders browser arrival, not device computation or causal
effect; ingestion is only consumption of that evidence. The status RPC exports
no comparable producer revision, so a request sent before a newer observation
cannot overwrite that observation even when its reply arrives afterward.

F5's independent config/status consumption and carried receipt remain: config
failure cannot withhold successful status, and a buffered early answer cannot
be restamped as new evidence. `pullStatusEvidence` carries dispatch and receipt
on one monotonic evidence clock. Start/Stop intent and a lost Start reply mark
that clock. A superseded pull is rejected; its caller may make ONE fresh read,
never a recursive loop. If that read is superseded too, or fails, nothing
settles. Restoration still waits for config and the bounded status path to
settle, then triggers the dialog's details/settings/capabilities rereads.

Both watchdog cycles also belong to one optimism action lifetime. Confirmation,
replacement, revert, supersession and teardown invalidate it even while a read
is awaited. Every continuation and effect port checks that captured lifetime:
an old Stop cycle cannot dispatch Stop against the next session, and an old
Start cycle cannot reconcile or revert the next attempt. An unknown current
Stop read offers the existing retry banner without redispatching; only positive
streaming evidence for the still-current operator Stop permits its one existing
redispatch. Unknown Start evidence does not fake idle or timeout failure.
Acknowledging the band's claim and confirming the cockpit optimism are distinct:
the former accepts its own `stopped` reply; the latter waits for authoritative
status so the lost-stop-push recovery remains possible. These are host carrier
proofs, not integrated-backend, browser-scheduling or hardware qualification.

Not covered: `starting` and `stopping` seen from a client that did not start
them have no Stop, but each is bounded and settles into `idle`, `streaming` or a
row above. An `idle` lifecycle whose sentinel removal failed is invisible on the
wire; surfacing it needs a new field and an owner decision under D154. The HUD's
state chip still reads "Idle" while unconfirmed (it hosts no Stop; a third chip
state is a design change owed with rendered QA). No board or browser has
exercised this path: the rows above are host-tested with the real cockpits,
band, header and stores (`LiveView.unconfirmed-real-stop.test.ts`,
`LiveView.unconfirmed-real-reach.test.ts`), and over the REAL subscription
store, reconnect hydrate and session epoch (`LiveView.real-store-start.test.ts`,
including the real NavigationRenderer, and `LiveView.real-store-stop.test.ts`),
and over the real `rpc` proxy and `RPCClient` on a scripted socket, each reply
delivered by its own request id (`LiveView.real-socket-stop.test.ts`, which
also replays both hydrate reply orders, a push between them, a failed status
answer, a late-consumed pulled answer and the stop watchdog's pull against a
push in both orders; the pure hydrate ordering is in `lib/rpc/reconnect.test.ts`).
## Composition lifecycle follow-up (2026-09-17)

Failed stop IPC must complete the session cleanup promise with its error, not
leave it waiting for an acknowledgement that cannot arrive. Restoration must
reconcile the lifecycle through the same owner that admits starts; querying engine
idle alone does not clear `stop_failed`. See
[the traced failures, fixes and hardware evidence](COMPOSITION-LIFECYCLE.md).

## Disruptive-action gate [PARTIAL — host-tested, board re-drill owed]

Reboot, power-off, the SSH start/stop/persist mutations and the remote
`system.reboot` / `device.factoryReset` commands, add-on install/enable/update/remove,
kiosk start/stop and post-boot/SIGUSR1 add-on refresh share one gate:
`apps/backend/src/modules/system/disruptive-action-gate.ts`. It runs only on
confirmed idle stream evidence with no interruptible update work. Anything else is
refused with a typed reason (`streaming`, `stream_liveness_unknown` or
`update_in_progress`): the RPC answers `{success:false, error}`, the local power
and SSH handlers broadcast `notifications.disruptiveActionRefused`, and the remote path
answers `ok:false` with the reason. A remote confirm is the owner's intent, not
idle evidence, so the gate is read on receipt and again at confirm. A remote
reboot/factory-reset command that exits nonzero answers `ok:false` with its status.
Local power likewise reports a failed native submission instead of starting the
browser's success countdown. SSH maps these machine refusals to that same translated
explanation rather than generic operation-failed text.

Admission is not a stored permission: after awaited preparation, final current
evidence is checked and an in-process disruptive reservation is acquired in the
same synchronous step as effect submission. Local/remote power, factory reset,
legacy completion reboot and timed `armOs(true)` keep this reservation through
pending shutdown. Successful command return does not prove shutdown completed.
The shared D8 admission hook refuses every stream-start origin with its existing
`update_in_progress` result while held, including after its awaited preparation;
package launch, final legacy APT preflight, OS stage/arm and competing disruptive
requests also refuse. The one escape is an explicit re-submission of the SAME
pending power action: it supersedes that hold only after the final synchronous
stream and current-update recheck. Live/unknown streams and OS/package fences
still refuse. A failed retry restores the prior possibly accepted shutdown hold;
it cannot disprove the first submission. No stream is automatically stopped.

SSH service/persistence and eligible stale-service restarts hold a transient
reservation until positive blocking command completion. Stale restarts no longer
use `--no-block`; their own settled `restarting-services` owner is exempt from
that one phase reason, not from stream/unknown/durability or other current work.
Positive nonzero/spawn failure permits retry. A timeout or ambiguous completion
starts a bounded read-only systemd resolver: `Job`, `ActiveState` and `SubState`
must show no queued/running job and a coherent settled lifecycle before service
exclusion releases. Unreachable/malformed systemd stays unknown, with 2/4/8/16/30 s
backoff capped at 30 s. Shutdown cancels observation and fences late replies;
cancellation alone never releases. The original operation remains failed/uncertain,
not retroactively successful. No timer, notification expiry or countdown releases it.

Timed activation uses the same resolver on `ceralive-rauc-arm@now.service`, with
terminal `ExecMainCode`, `ExecMainStatus` and `Result` evidence in addition. Positive
arm failure releases; positive arm success retains shutdown exclusion and permits
the same explicit reboot retry. Unknown terminal outcome keeps observation.

### Reservation state table and owner seam

| State/event | Transition and evidence |
|---|---|
| Set | Final synchronous allowed decision acquires before invoking the effect |
| Held | Other owners/Go Live/update work refuse; same active service owner may nest |
| Uncertain | Client timeout/untyped failure retains its depth and starts the resolver |
| Resolved | No job + settled service state releases that depth; arm success retains shutdown; arm failure releases |
| Released | Last service depth settles; repeated releases are inert and the old owner is retired |
| Superseded | Same power action passes every safety fence; successful retry replaces the hold, positive retry failure restores it |
| Restart | Process-local state resets; installed shutdown ordering is NOT proven by host tests |

The add-on/kiosk integration calls `reserveDisruptiveAction(decision, "service",
owner: symbol)` and `getDisruptiveActionDecision({ heldBy: owner })`. A fresh symbol
belongs to ONE operation lifetime. Nested same-owner reserves count depth;
`releaseAfterCompletion()`/`releaseAfterFailure()` release only their own depth,
and only the last settlement opens admission. `heldBy` ignores only that active
owner's hold, never liveness/update evidence. Released or uncertain owners refuse,
including timer descendants whose symbols survived completion.

`withServiceReservation(fn, scope, probe?)` is the shared exception/settlement seam.
Scope carries `unit`, a synchronous `decision` callback and optional `owner`;
the optional probe supports an arbitrary operation-owned unit/job description
through its closure. The default probe must name the unit actually owning the
effect, not an unrelated idle unit. A direct helper process requires its own
positive settlement probe. Callbacks must have bounded command completion/error
semantics; a never-settling arbitrary promise cannot prove completion.

Legacy package completion retains one deferred reboot continuation when admission
refuses. Each capped-backoff wakeup rechecks current evidence, never reboots while
live/unknown, and is cancelled on shutdown. It emits no operator-refusal notice for
this automatic action. Local pending-action broadcasts reuse `network.os.deviceBusy`;
the unchanged wire `update_in_progress` still leaves update-specific Go Live/SSH
reply copy as a presentation limitation, not proof that a package is installing.
Console/physical power remains the last resort if systemd cannot settle or shut down.

Add-on/kiosk entry admission precedes downloads, intent writes, unit operations
and refresh. These paths resolve the runtime adapter lazily to avoid extending
the modem/config/streaming initialization graph with an eager update-runtime edge.
Add-on install checks before accepting an operation-scoped userConfig draft, and kiosk
checks before its synchronous intent prelude. The manager re-reads after free-space
observation and before staging/activation or teardown refresh; the privileged
helper wrapper re-reads after device detection immediately before sudo submission.
A pre-activation late refusal restores persisted add-on/kiosk intent, live phase
and a terminal add-on frame and is returned as the same
typed refusal, not install failure or disabled success. Add-on and kiosk controls
render the existing localized `notifications.disruptiveActionRefused` text and
revert the toggle. No catalog, wire schema or stored format is changed.

Manager preparation publishes into the helper cache, not the sysext scan directory;
the unchanged privileged enable helper publishes verified bytes only after its
admitted submission. The reconciler prepares in a private cache directory, then
revalidates intent under the per-ID mutation lock before admitted scan publication
and refresh. Refusal before refresh rolls that publication back. Pending/deferred
raw presence is not proof of refresh. Typed helper refusals preserve deferral;
boot never waits for idle. Every unit start/unmask/stop/mask is individually fenced.
After completed activation, refusal in the unit tail records the actual new version
as pending rather than restoring an obsolete active receipt.
RPC does not restore a second full baseline after manager settlement. Only settled,
error-free active descriptor-version/current-OS metadata can skip refresh; a failed
submitted helper leaves activation unknown even if scan bytes are present.
Terminal persistence failure cannot prevent terminal wire publication: shared
settlement emits an existing error token, retains its live unresolved snapshot,
and retries persistence on the next mutation/startup/hydration. No new durable
journal or successful filesystem/service claim is created.
Kiosk/manager/reconciler share mutation serialization and an in-process intent
revision. Removed, auto-disabled or superseded intent cannot be republished by a
held pass. Initial authenticated hydration supplies disabled known-ID entries to
correct retained busy frames under the existing partial-map subscription merge.
Initial hydration and default boot reconciliation settle predecessor installing/
disabling phases without live owners into non-busy unresolved pending/error;
enabled intent must retry through fresh admitted refresh. A real live operation's
transitional frame is retained rather than mistaken for crash residue.
Boot kiosk initialization only seeds/polls state and does not start or refresh an
add-on. The closed remote-control registry contains no add-on/kiosk commands:
unknown entries are rejected before dispatch, including a supplied dispatch port.
Remote reboot continues to consume the same adapter as these local entries.

This is cooperative admission, not an atomic exclusion lease with stream launch.
All add-on/kiosk disruptive steps pass through `addons/disruptive-sysext-step.ts`;
nested awaited calls retain one active operation identity. Tokens are lifetime-
scoped and retired in finally; recurring kiosk polling registers outside those
contexts and must acquire a fresh same-ID owner. The seam takes one service-lifetime
reservation owned by the active operation; nested steps re-enter by identity and the
outer hold lasts until positive completion/failure evidence. Direct unit steps keep
their unit job/steady-state evidence. Helper enable/disable/refresh uses ordinary Bun
spawn of checked `/usr/bin/setsid -w -- /usr/bin/bash -c '<launcher>' ceralive-addon-launch
<pidfile> /usr/bin/ceralive-addon-helper action [id]`, no
sudo, PTY, detached or `-f`: PID=PGID=SID. Root is required; fixed PATH/locale excludes
BASH_ENV, SHELLOPTS and CERALIVE_* overrides. Status retains its existing sudo path.
With a returned handle, success and every possibly-effectful failure (exit 1 included) require actual child
exit plus ESRCH from `kill(-ownedPGID, 0)` with integer PGID > 1. A successful probe
means present; all other errno, including EPERM, remain UNKNOWN. Retirement is latched;
then enable/disable polls the baked descriptor's deduplicated unmask→enable→start union.
Typed none/started/unknown dispatch evidence, not errno spelling, governs the helper's
pre-effect exception: the runner's own pre-spawn checks/preparation/abort, or a Bun Error
tagged `socketpair`, `fcntl` or `posix_spawn`, proves no dispatch and releases immediately
with the original error, no group/unit probes
and no wakeup. Once a handle exists, even abort racing assignment is started; unknown
dispatch retains evidence. Bun 1.4.2 can exec, fail `pidfd_open`, block in `wait4`, reap the
leader and throw without a handle. The launcher writes `$$` with builtin printf BEFORE
exec and exits125 on write failure, so the helper cannot run without recorded identity.
One UUID file is exclusively precreated under root-owned0700 `/run/ceralive/addon-launch/`;
its FD remains until no-dispatch or group retirement. Only handle-less recovery reads
its bounded bytes; whole integer2..2147483647 feeds the same negative-group predicate
and latch before descriptor units. Early unlink cannot erase the retained inode.
Invalid/unreadable identity stays UNKNOWN; invalid nonempty bytes never become absence
clearance. Empty pidfd identity proves no helper exec under the fixed-Bun1.4.2 assumption
that every naturally reachable post-exec throw reaps first (spawn_process.rs:552–568,
991–1002 at bun-v1.4.2; ordinary ECHILD means already gone). Untagged/future/non-Error
absence gets cancellable100/200/400ms re-reads (700ms total), still relying on that
assumption, never on elapsed-time death. Reaudit before changing options/runtime.
Cleanup is best-effort, inode-checked, and never completion authority. First-use sweep
precedes this backend's active files; crash residue is not adopted, cannot affect another
UUID request, and reboot clears tmpfs. The tag proof depends on the fixed Bun 1.4.2 spawn shape
and does not change other callers' default policy or enable/disable failure tokens.
Cancellation/retirement fences retry scheduling even when the first observation rejects.
Child-only collector TERM/KILL, timeout
failure and original partial output/137/143 are preserved. TERM-induced zero is failure.
Fork/exec/double-fork/reparented descendants retain membership; zombies hold until reaped.
The generic outer census remains separate, never helper completion authority.

Groups do not cover a descendant calling setsid/setpgid (adding one triggers scope
replacement), already-submitted PID-1 jobs, PID-1/other-daemon work, manager Reload
(enable/disable and sysext metadata), or unacknowledged requests from a killed client.
Another connection's descriptor read does not prove all delegated work drained.
Manager's independent systemctl tails keep their own unit evidence, not group ownership.
Installed tools/init/delegation remain a board gate, including `/usr/bin/bash`, private
`/run` creation under the unit sandbox, and pid-file write/removal per step. Forcing
post-exec pidfd failure there requires privilege; host seccomp is not board proof. A signal-derived
client exit (status >= 128 or a signal name) is uncertain, never a failure verdict.

**What a stuck hold means for the operator.** Service holds have no supersede path.
Only an explicit re-submission of the SAME pending power action supersedes a shutdown
hold, so a remote factory reset that exits 0 without rebooting leaves a shutdown hold
that a LOCAL reboot cannot supersede (the actions differ). Natural causes (the 30 s
helper timeout, a slow unit) may resolve on positive observation, but there is no
application-level total deadline on manager preparation/download; a stalled kiosk
Start can naturally retain exclusion indefinitely. Unreadable proc evidence and
unsettled helper/unit work also keep the hold. The
escape for a stuck service hold is restarting `ceralive.service` or a power cycle,
which clears this process-local state, not proof that surviving helper or delegated
manager work completed. The group remains in the service cgroup and is subject to
`KillMode=mixed`'s final kill phase. No new override primitive exists (D249); any
product-level clearance is an owner decision.

A timed arm can leave a SHUTDOWN hold despite a positively pre-submission CONTROL
refusal: the holder dies between checks, the producer throws
`rauc_recovery_unproven` before spawning systemctl, and the never-executed arm unit's
`ExecMainCode=0` is not terminal exit proof for the generic resolver. That unchanged
evidence cannot auto-settle. An explicit SAME-action reboot submission after current
fences pass, or backend restart/device power cycle, is the existing escape. The reason
also describes effectful failures, so it grants no generic clearance. D257 is docs-only;
no typed pre-effect primitive is added.

The completion reboot after a legacy
package update uses the same shared `getDisruptiveActionDecision()` gate (stream,
orchestrator, package install, recovery, maintenance) and only retries while refused.
Work already submitted while idle cannot be revoked: earlier unit effects or a
submitted helper's partial execution may survive refusal/failure. A stream or privileged actor can still change state
after final observation/dispatch; the external root helper is not governed by a
backend-only decision. Installed setsid/environment, real helper descendants,
orphan retirement under the installed init, queued descriptor jobs, signal/output
mapping, service restart and a real launcher failure leaving no hold on BOTH boards need board
drills, plus post-exec pidfd failure retaining exclusion. Forcing that installed-image fault
requires privileged instrumentation; unprivileged host seccomp is not board proof.
No hardware or uninterrupted-transaction proof is claimed.

Stream liveness is tri-state. `stream-liveness-source.ts` is the synchronous,
side-effect-free composition consumers read. It imports only the
`stream-liveness.ts` leaf, never the heavy orchestrator re-export. The leaf owns
current physical sentinel evidence; the adapter performs no independent `lstat`.
Idle requires that the leaf reports idle, boot reconciliation has returned
(`stream-reconciliation-latch.ts`, closed until `main.ts` sees
`reconcileStreamSession()` return), no positive legacy live flag, and the owner's
published lifecycle is idle. The publication is seeded/written by that same
session owner, not another source of permission; disagreement only withholds
idle. Leaf streaming or positive legacy live reports streaming; unknown leaf,
unfinished reconciliation, or a non-idle publication cannot grant idle.

The same `isStreamConfirmedIdle()` reading replaces the false-default live flag in
the update orchestrator's `isStreamLive` default (package install, OS staging
admission, timed activation), idle-schedule detection, the legacy package
start/check/size paths, and the OS-stage token and runner block check.
Add-on refresh additionally reads the whole disruptive-action gate above.
Unknown liveness therefore defers those effects; their
existing refusal reasons (`streaming`/`stream_active`, add-on
`stream`-deferral) cover "not confirmed idle" without a wire change.

Update work that refuses power: orchestrator phases `downloading`, `committing`,
`restarting-services`, `os-staging` and `syncing`; an OS stage in process; an
in-flight `armOs` activation call; a package success retained before its durable
acknowledgement; pending OS settlement durability or replay; legacy package
progress; an inconclusive legacy recovery; invalid current recovery authority;
and maintenance for which validated startup/settlement has not established a
safe baseline. The historical `update-orchestrator-maintenance` health entry
remains recorded, but no longer refuses power once current startup/authority and
durability are positively settled. Unknown authority remains refused; there is
no operator clear API and no deletion of the update fences. A settled
`os-staged` / `os-activation-armed` receipt is not by itself a refusal: clean idle
shutdown is its activation path. `armOs(false)` only arms that future path and
does not reserve an immediate reboot lifetime.

The reservation is deliberately process-local. A backend restart clears it;
startup still requires reconciled stream evidence, but this is not durable
proof against a previously queued shutdown. Board qualification must establish
accepted reboot → attempted Go Live, remote confirm racing Go Live in both orders,
timed activation's arm-to-reboot window, and backend restart during pending shutdown
(no restored/autostart stream or new update reaching the installed shutdown job).
If a restarted backend can admit work before that job completes, the image/systemd
handover requires an owner decision rather than a claimed host-test pass.

These are host proofs on the real handler bodies (local procedures and the remote
router's confirm flow); the physical effects on a board are inferred, not
exercised.
