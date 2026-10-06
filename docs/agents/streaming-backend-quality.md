<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## STREAMING BACKEND QUALITY [EXISTS]

The OPi composition lifecycle repairs cover explicit apply-now disable, failed-stop
completion, reconciliation before restoration and composition-free snapshot restore.
The companion engine must preserve a null clear delta and accept pre-videorate
allocation cadence. Publication/merge boundaries and hardware receipts:
[`docs/COMPOSITION-LIFECYCLE.md`](../COMPOSITION-LIFECYCLE.md).

Quality improvements landed in `chore/backend-quality` (Tasks 5–7, 13–14).

### streamloop module split

Public stream start/stop admission now routes through
`apps/backend/src/modules/streaming/stream-session-orchestrator.ts`. It owns the
single lifecycle state machine for UI, autostart, remote control, and set-profile,
uses generation-scoped cancellation for stop-during-start, and reconciles the
actual cerastream state at boot/reconnect. Query/subscription failure or a
transitional/contradictory status remains `reconciling` until the heal path retries.
After a successful status subscription, a full 2.5-second window with no event is
authoritative idle because active streams emit a 2-second heartbeat; late events
from that closed probe are fenced. `status.stream_lifecycle` is additive;
legacy `is_streaming` flips true only after engine confirmation. The bounded retry
runner retries only connect-phase transient classes, after transactional rollback,
and stop cancels a pending backoff without notification.

`apps/backend/src/modules/streaming/streamloop.ts` is now a 5-line barrel re-exporting
from `streamloop/index.ts`. The 10 public exports are unchanged — all caller import paths
are unmodified.

```
modules/streaming/streamloop/
├── exec-paths.ts    # srtlaSendExec constant
├── process-runner.ts # mutable streamingProcesses list + spawnStreamingLoop/stopProcess/stopAll/getStreamingProcesses
├── start-stream.ts  # startStream — spawns srtla_send, wires telemetry, starts the engine session over the seam
├── session.ts       # start / stop + removeNetworkInterfacesChangeListener module-state
├── autostart.ts     # AUTOSTART_CHECK_FILE / setAutostart / checkAutoStartStream / autoStartStream backoff
└── index.ts         # named re-export barrel (exactly the 8 public exports)
```

**Locked public API surface (8 exports):** `AUTOSTART_CHECK_FILE`, `autoStartStream`,
`checkAutoStartStream`, `setAutostart`, `srtlaSendExec`, `start`, `startStream`, `stop`.
Adding or removing any of these is a breaking change.

### Transactional start/stop lifecycle

The Todo-25 start taxonomy is wired through one Todo-26 session orchestrator and
the Todo-27 launch transaction. Initial IP-list preparation is awaited before
sender spawn. Sender, telemetry, control client, subscription, and accepted
engine start register cleanup immediately; failure unwinds them in reverse order
and leaves lifecycle/status idle. The start response is emitted only after the
engine confirms PLAYING. A direct start reply with `state: "streaming"` is an
authoritative confirmation; every other schema-valid reply (including
`state: "starting"`) remains in `playing-wait` until a subscribed status heartbeat
reports the concordant pair `state: "streaming"` plus `streaming: true`. If that
heartbeat misses the 5-second phase deadline, start returns typed
`start_timeout` and rolls back. Connect/subscription cleanup is attached to each
acquisition promise before its deadline race, so a resource delivered after
rollback is closed immediately and cannot become backend-owned.

Connect and hello share the published binding's combined operation and are
classified by machine-readable error shape; CeraUI does not simulate a separate
hello I/O wait. Subscribe, start-RPC, PLAYING validation, and stop have explicit
bounds. Stop confirms engine/process cleanup or returns typed `stop_failed` after
12 seconds. Full contract and timeout values: `docs/START-LIFECYCLE.md`.

Todo 28 adds a 5-attempt/60-second exponential retry bound around that transaction.
Each individual launch is also capped at 10 seconds; expiry cancels that launch's
generation, awaits bounded cleanup, and classifies the attempt as a retriable
connect-phase `start_timeout` so a hung engine call cannot hold the lifecycle slot.
The prior launch must settle after cleanup before backoff is armed; if it does not
settle within the cleanup bound, `start_cleanup_timeout` is terminal and no later
attempt is launched.
Cerastream stop is the deliberate exception to the backend IPC queue: it opens a
fresh control connection and dispatches `stop` there before closing the session
client. The engine serves only one request at a time per connection, so reusing the
session client can leave `stop` unread behind `list-devices` or an in-flight start;
closing that socket then discards the queued stop while the engine keeps streaming.
The fresh connection lets CeraUI close the old client to interrupt local pending
work without withdrawing the engine request. `onStopped` fires only after that
request answers `state: "idle"`. The connect-plus-acknowledgement budget is derived
as 6.5 seconds, reserving 5 seconds for cleanup and a 0.5-second scheduling margin
inside the unchanged 12-second outer bound. A connection resolving after that
request deadline is closed without dispatching `stop`; a pending stop connection
is closed and cannot invoke the callback. An already-dispatched request may still
settle in the engine, so timeout leaves engine state unknown and reconciliation
adopts its eventual truth after typed `stop_failed`.
Suppression reads only existing update, engine capability, and boot-uptime signals;
suppressed attempts remain `starting` and emit no error toast. Structured retry and
terminal records carry attempt id, phase, class, optional engine code, and retry
state. User copy is keyed across all 10 locales, and terminal copy points at the
in-app log viewer (Settings → System Logs) — never at `journalctl`, a systemd unit
name, or any other shell command, and never at the engine's raw diagnostic string;
that detail rides the structured record into the log the dialog downloads.
Autostart's no-link loop is capped at five checks; permanent
configuration/engine failures stop immediately with a visible reason.

**A bounded pre-engine gate DEFERS the per-attempt deadline — it never loses to it.**
The 10 s launch cap bounds engine work, but the audio-source probe
(`AUDIO_PROBE_TIMEOUT_MS`, 15 s) runs BEFORE any engine IPC and deliberately waits
longer, so the generic deadline used to fire first and report a permanently-absent
audio device as a retriable connect-phase `start_timeout` — five rounds of
"Streaming engine did not answer in time" for an engine that was never contacted
(found live on a board). `runStartWithRetry` therefore takes a
`pendingGateRemainingMs` seam: when the deadline fires while a bounded pre-engine
gate still has grace left, it RESCHEDULES itself past that grace (plus a small
slack) instead of timing out. The production orchestrator wires it to
`asrcProbeRemainingMs()` (`modules/streaming/audio.ts`). The seam's contract is
that the value MUST be bounded by the gate's own hard timeout — an unbounded
implementation disables the attempt deadline entirely. Do NOT "fix" a future
instance of this by shortening the gate or lengthening `attemptTimeoutMs`
globally: the first weakens a real grace window, the second halves the retry
count available to a genuine engine-restart race.

**`audio_source_unavailable` is the probe's own terminal class.** It is
non-retriable on every phase (`START_FAILURE_RETRIABILITY`): the probe ALREADY
spent its grace window waiting, so retrying re-runs the same wait against the same
absent hardware. `startStream` returns it on the failure result as `failureClass`,
and the three launch wrappers (`streaming.procedure.ts`, `streamloop/autostart.ts`,
`remote-control/set-profile-wiring.ts`) pass it through `typedStartFailure()`
rather than re-deriving a class from the opaque `error` string. The legacy
`error: "audio_source_probe_failed"` wire value is unchanged, so the existing
`live.startFailed.audio_source_probe_failed` copy still resolves.

### timing-constants.ts

`apps/backend/src/modules/streaming/timing-constants.ts` centralizes all hardcoded
timeout/retry values. Import from here — never add inline numeric literals to streaming
modules.

| Constant | Value | Used in |
|----------|-------|---------|
| `AUTOSTART_RETRY_DELAY` | 1000ms | `streamloop/autostart.ts` |
| `AUDIO_SOURCE_POLL_DELAY` | 1000ms | `audio.ts` |

### Logger (`apps/backend/src/helpers/logger.ts`) [EXISTS]

All `console.*` calls in streaming and ingest/rpc modules are replaced with the Winston
logger. Empty catches now log via `logger.debug`/`logger.warn` before suppressing. No
`console.*` calls remain in `modules/ingest/` or `modules/streaming/` (verified by grep
gate).

**Dev console (TTY-gated colorized pretty-print):**
`formatConsoleEntry(info, useColor)` emits `HH:MM:SS.mmm LEVEL message` with 2-space-indented
JSON metadata on subsequent lines. Color is raw ANSI (no chalk/picocolors dep) — error=red,
warn=yellow, info=green, debug=dim. `shouldColorizeConsole()` gates on
`isDevelopment() && process.stdout.isTTY`, evaluated per-record so CI/piped/prod never emit
ANSI escapes.

**Prod JSON schema (file transport + prod console):**
`formatProdEntry(info)` serializes to a single-line JSON record with a fixed shape:
```ts
{ ts: string, level: string, msg: string, module?: string, meta?: Record<string, unknown> }
```
`ts` is ISO-8601 UTC; `module` is promoted to top-level (not buried in `meta`); all other
non-reserved fields fold under `meta`. `jsonReplacer` surfaces `Error` objects as
`{name, message, stack}` rather than `{}`. Both the file transport and the production
console use this same schema so log shippers parse one format.

**`LOG_LEVEL` env override:**
`resolveLogLevel(defaultLevel)` reads `process.env.LOG_LEVEL` (non-empty, trimmed) and
applies it to EVERY transport when set. Defaults: dev console `info`, prod console `warn`,
file `debug`. Set `LOG_LEVEL=debug` to enable per-RPC trace lines in production.

**Per-RPC call tracing (`rpc/rpc-logging.ts`):**
`instrumentRpcCall` wraps every oRPC procedure dispatch with a debug-level trace line
carrying `{ procedure, cid, latency_ms, ok }`. Gated on `isRpcTraceEnabled()` (dev or
`LOG_LEVEL=debug`) so a shipped device never pays the per-call cost. Auth procedures
(`auth.*`) have their args omitted entirely — not even redacted-partial. All other
procedure args pass through `logRedact()` before logging.

**Adapter diagnostics (T3):**
`extractValidationDetails(error)` (exported from `apps/backend/src/rpc/error-enrichment.ts`)
turns an opaque oRPC/Zod validation failure into a structured `ValidationDetails` shape:
`{ phase: "input" | "output" | "unknown", issues: ValidationIssueDetail[] }`. The WS
adapter calls it in its catch block and attaches the result as a `validation` field on
the `RpcCallTrace` log record. These adapter diagnostics let you see exactly which
schema field failed and whether it was an input or output validation error. Phase is
classified from the oRPC wrapper message ("Input/Output validation failed") then the
error code as a fallback. Issue paths are schema field names (safe); messages are
scrubbed through `logRedact` before logging. Returns `undefined` when the error has no
issue list, so callers omit the field rather than log an empty record. See
`apps/backend/AGENTS.md` → DEV MOCK SEAMS for the full contract.

**Boot banner + per-phase markers (`helpers/boot-banner.ts`):**
`buildBootBanner(info)` emits a one-line startup banner: `🎬 CeraUI vX · env=… · scenario=…`.
`createBootTimer()` tracks per-phase deltas (injectable clock for tests). `main.ts` emits
7 phase markers (🔧 config / 🔌 pipelines / 🖥️ hardware / 🌐 network / 🎵 audio & devices /
🚀 server / ▶️ autostart & reconciler) and a final `✅ CeraUI ready on port N in Xms` line.

**Secret redaction (all transports):**
`redact()` format scrubs every record before it reaches any transport. Keys matching
`/pin|password|token|secret|paseto|bcrp|auth/i` are replaced with `[REDACTED]`. Value-shaped
secrets (PASETO `v4.public.*`, JWT `eyJ…`, Bearer credentials) are also scrubbed from string
values. The `logRedact(value)` helper is exported for call sites building metadata objects.

**Loop visibility:**
Streaming and ingest loop modules log entry/exit and error paths via `logger.debug`/`logger.warn`
so the boot sequence and per-tick activity are visible in dev without noise in prod.

