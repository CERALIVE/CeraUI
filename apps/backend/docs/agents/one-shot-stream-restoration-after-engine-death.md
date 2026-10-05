<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## ONE-SHOT STREAM RESTORATION AFTER ENGINE DEATH [EXISTS]

Failed stop IPC now completes through an optional failure callback. Local sender
and listener cleanup runs on both outcomes, but a failure never publishes a false
idle acknowledgement. Restoration queries through the orchestrator's reconciliation
seam, so authoritative engine idle retires `stop_failed` before new admission.
Its snapshot cannot inherit persisted composition, and successful recovery retracts
an earlier recovery-failed notification. Hardware and mutation evidence are in
[`docs/COMPOSITION-LIFECYCLE.md`](../../../../docs/COMPOSITION-LIFECYCLE.md).

`noteConnectionLoss` retires a session whose control connection died (see SESSION
CONTROL CONNECTION above) and, until now, that was the end of it: systemd
restarted `cerastream`, nothing tried again, and wave3 measured **0/6**
stream-level resumptions after a SIGKILL. `modules/streaming/armed-stream-marker.ts`
(the durable state + the PURE gate table) and `modules/streaming/stream-restoration.ts`
(the wiring + the runner) close that, with a deliberately narrow guarantee:
**exactly one restart attempt, scoped to the current boot.**

**The ARMED-STREAM MARKER is `stream.armed.json`**, written at the orchestrator's
`transition("streaming")` outcome gate — the SAME commit point todo 22's
`noteStreamedSourceCommitted` hooks, through a second dep (`onStreamArmed`)
rather than more work inside the first, because the two answer different
questions and each has to be provable alone. It carries the stream-defining
config snapshot plus the current `boot_id`, and nothing else that matters.

- **The snapshot is the RUNNING config, not `config.json`.** A save with no
  `apply_now` persists a restart-requiring field while the live session keeps
  encoding the previous one, so restoring from disk would apply an edit the
  operator explicitly deferred to their next start. `startStream` therefore takes
  an optional `configOverride` (absent for every other caller — byte-identical
  behaviour) and restoration passes the snapshot.
- **It is schema-parsed on WRITE, not only on read.** The snapshot is built by
  copying from the runtime config, which also holds `password_hash`, `ssh_pass`
  and `remote_key`; Zod strips everything outside the declared shape so a future
  copy-loop mistake cannot put a credential on disk. Do NOT "simplify" the
  write-path `parse()` away — it is the credential barrier, and a test asserts it.
- **The engine session id is DIAGNOSTIC ONLY and can never be a gate.** Four
  facts, each re-verified against current code rather than inherited: the
  adoption seam answers `"streaming" | "idle" | "unknown"` and nothing else
  (`streaming-backend.ts` `EngineRuntimeState`); `CerastreamBackend.start()`
  parses the engine's `StartResult` for its `state` alone and drops the
  `session_id` it really does carry (`grep session_id` across the backend hits
  test fixtures only); the engine's `Event::Status` carries no session identity
  (only the unrelated `Event::Preview` does); and the engine's ids are
  process-local counters (`format!("cs-{}", inner.counter)`), so a restarted
  engine re-issues `cs-1` for a DIFFERENT session — comparing them would be worse
  than not comparing them.

**ADOPTION WINS, UNCONDITIONALLY AND FIRST.** The runtime-state check runs ahead
of every marker gate and short-circuits: if the engine reports ANY streaming
session it is adopted via the existing `reconcile()` path and restoration does
not happen. This is what makes a backend-only restart safe — a marker survives a
backend restart exactly as it survives an engine death, and only the engine can
say which occurred. Asking about the marker first is how a device ends up with
two sessions.

**Restoration fires only when ALL of these hold**, and each is independently
blocking (one test per condition, each proven load-bearing by neutering it):
marker present ∧ engine authoritatively IDLE ∧ `marker.bootId === current boot_id`
∧ not cleared by an operator stop ∧ no planned-shutdown stamp ∧ no prior attempt.

**STOP-CAUSE PLUMBING.** The engine-loss path calls the SAME
`stopStreamSession()` as an operator Stop, so the stop now carries an explicit
`StreamStopCause` and the orchestrator reports it from the INTENT, ahead of the
outcome (an operator who pressed Stop meant it whether or not the engine
answered, and a stop parked behind a config-change transaction must not leave the
marker armed for the minute it waits). `operator` CLEARS the marker;
`engine_loss` and `reconfigure` PRESERVE it. A parked stop replays its own
recorded cause on release.

**`boot_id` fails CLOSED.** An unreadable `/proc/sys/kernel/random/boot_id` is
treated exactly like a mismatch, and a start that cannot read one arms nothing at
all. Failing closed costs a restoration; failing open auto-restarts a stream
across a power cycle, which is a separate product decision and out of scope.

**The planned-shutdown flag is stamped ONTO the marker**, not kept as a
standalone file, so it can never outlive what it suppresses: no armed stream
means nothing to write, and the next armed stream starts from a clean marker. A
separate flag needs its own clearing rule, and getting that wrong disables
restoration permanently and silently. The update continuation writes it only
AFTER direct cache cleanup and space admission succeed, immediately BEFORE the
detached transaction launch; `startSoftwareUpdate()` stays synchronous and writes
no marker. A preflight refusal preserves the marker and atomically publishes
`updating: null` with `update_preflight_failed`. The `system.reboot`/`system.poweroff`
procedures retain their existing stamp timing. The update case is the real one: an
apt update restarts `ceralive` WITHOUT changing the boot id, so a stream armed
before an engine crash earlier in the same boot would otherwise be restored by
the post-update backend.

**`unknown` triggers NEITHER, with a declared sub-deadline.** The engine answers
`unknown` both while it is down and while a probe is transitional, so the runner
polls at `RESTORATION_POLL_MS` (1 s) for up to `RESTORATION_UNKNOWN_DEADLINE_MS`
(10 s). Resolving to `idle` proceeds to eligibility, resolving to `streaming`
adopts, and expiry writes a terminal `stream_recovery_failed{runtime_state_unknown}`
that does NOT re-arm on a later restart. A busy LIFECYCLE (a config-change
transaction settling, a stop finishing) waits the same way rather than racing it.

**ONE-SHOT IS THE FEATURE.** Both outcomes write a terminal attempted-state onto
the marker, so the answer to "what happens on the next backend restart" is always
"nothing". There is no retry and no backoff; a device that cannot restore lands in
an honest `idle` with a published reason. Typed events:
`stream_recovered` / `stream_recovery_failed` (keyed operator copy in all 10
locales; the machine-readable `reason` rides `params` and is never interpolated
into operator text).

**DECLARED RESTORATION BOUND: 30 s** (`RESTORATION_BOUND_MS`) from the reconnect
event, RECORDED per attempt (`elapsedMs` + `withinBound`) rather than enforced as
a second deadline — the launch already owns its own bounded retry machinery, and
racing a competing timer against it would report a healthy-but-slow start as a
failure.

**THREE TRIGGERS, ONE SELF-SERIALISING RUN**: the engine-loss retirement
(`cerastream-backend.ts` — the only seam that sees a SIGKILLed engine come back,
because `engine-reconnect.ts` settles at boot and never re-arms), backend boot
(`main.ts`, immediately AFTER `reconcileStreamSession()` so adoption has already
happened), and the engine-reconnect heal. A second caller JOINS the in-flight run.

**It does NOT move todo 22's `last_streamed_source` slot.** Restoration re-runs
the configuration that was already live, and `noteStreamedSourceCommitted` is
idempotent on the same source — so the slot is untouched by construction rather
than by a special case. Restoration deliberately goes through the ordinary commit
hook so that stays true.

**The two markers coexist and neither reads the other.** `config.inflight.json`
(apply-now transaction) and `stream.armed.json` (a stream was live) are different
files with different lifetimes; an engine that died mid-transaction legitimately
leaves both, and each is judged on its own.

Coverage: `tests/stream-restoration.test.ts` — the pure gate table with one case
per independently-blocking condition, the adopt/restore/neither discrimination
table driven through the REAL runner against REAL on-disk markers, the stop-cause
table, one-attempt-only in both outcome directions, planned-shutdown suppression,
boot_id mismatch, the credential-barrier assertion, the two-marker coexistence
pair, and the orchestrator commit/stop seams.

