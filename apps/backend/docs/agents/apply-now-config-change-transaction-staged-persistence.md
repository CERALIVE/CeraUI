<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## APPLY-NOW CONFIG CHANGE — TRANSACTION + STAGED PERSISTENCE [EXISTS]

Composition now follows the same staging/dispatch/outcome path, including explicit
null. Both consumers now pin the verified published `@ceralive/cerastream@2026.11.2`,
whose exported `ChangeConfigParams` and schema preserve null. Nullable
capture-selection clears, including combined composition clears, use the binding's
validated `changeConfig`. Composition-only clears retain their established raw
request and producer-owned result parsing. No local wire type is introduced.
`composition-binding-contract.test.ts` fails
against the former pin and guards the installed producer contract directly.
The device engine separately needs the merged cerastream #170 correction.
See [`docs/COMPOSITION-LIFECYCLE.md`](../../../../docs/COMPOSITION-LIFECYCLE.md).

Resolution, framerate, codec and source are baked into the engine graph at build
time, so changing one mid-stream means REPLACING the session. cerastream's
`change-config` (engine schema `0.10.0`) makes that replacement recoverable;
this is the CeraUI half.

**The operator always chooses.** `streaming.setConfig` takes an additive
`apply_now` DIRECTIVE (`streamingSetConfigInputSchema` — deliberately NOT a
member of `streamingConfigInputSchema`, because it is never persisted and never
echoed in `applied`). Absent/false is the unchanged apply-on-next-start path, so
no existing caller changes behaviour and a save can never restart a live
broadcast by itself. `apply_now` degrades to an ordinary save — it never
dispatches a transaction — only while the session is settled `idle`. Every
other lifecycle state (`starting`, `streaming`, `reconfiguring`, `stopping`,
`stop_failed`, `reconciling`) is a stream on air, an engine transaction in
flight or a session not yet settled, so the save keeps its restart fields back
and goes to admission, which applies it only while `streaming` and answers
`busy` otherwise (`createApplyNowGate` in `config-change-bridge.ts`, an
exhaustive switch over the state type, so a new state must choose a side).
Saving it as a next-start edit there would acknowledge values the engine was
never asked to run.

Balancer settings and `video_codec: null` persist for the next start even with
`apply_now`. The producer change-config contract accepts only a concrete codec,
so the null clear is kept out of the staged candidate and engine delta. Concrete
codec choices retain the transaction described below.

**Everything routes through the orchestrator seam.** `changeStreamSessionConfig`
→ `stream-session-orchestrator.ts` → `config-change-bridge.ts` → the pinned
`@ceralive/cerastream` `changeConfig()`. There is NO direct streamloop
manipulation on this path, and `cerastream-backend.ts` gains only the additive
`changeConfig` passthrough beside `switchInput`/`listDevices`.

**`reconfiguring` is its own lifecycle state, and its deadline is DERIVED.**
`RECONFIGURE_DEADLINE_MS` (`start-lifecycle-timing.ts`) =
`CHANGE_CONFIG_WORST_CASE_BOUND_MS` (65 000, `@ceraui/rpc`
`config-change.schema.ts`) + `STOP_DEADLINE_MS` (12 000) = **77 000 ms**. The
65 000 is NOT typed as a literal: `config-change.schema.ts` reproduces cerastream
`docs/adr/schema.md` §11's phase table (`3 × teardown + 2 × start`) and a test
asserts the total, so shrinking a phase budget fails the build instead of
silently invalidating the published bound. It is **not 60 000** — the intuitive
`attempt × 2` reading, which a healthy transaction can legitimately exceed.

**A stop during `reconfiguring` is QUEUED, never raced.** The ~12 s stop deadline
is ~5× shorter than a legitimate worst-case change, so applying it to a
transaction reports healthy hardware as `stop_failed`. `stop()` therefore returns
a deferred promise while `reconfiguring` and is answered against whatever state
the transaction settled into. Concurrent stops share one queued resolution.

**But QUEUED is not UNBOUNDED, and it is never silent.** Only a settling
transaction releases a parked stop, so a transaction that breaks its own contract
strands the operator's Stop with nothing left to answer it. Measured on a Rock
5B+ (2026-07-31): a stop fired 0.7 s into an apply-now change sat **3.5–4.4 s**
unanswered while `stream_lifecycle` stayed frozen on `reconfiguring`, an
independent probe RPC on the same socket answered in 2–5 ms throughout, and
`journalctl -u ceralive` carried **not one line** about the stop for the whole
window — the exact "RPC never answered, nothing logged, event loop fine"
signature a previous investigation could not place. Unbounded, that silence had
no ceiling at all.

`parkStop()` therefore gives the wait its own deadline of
`RECONFIGURE_DEADLINE_MS + STOP_DEADLINE_MS` (89 s). That total is DERIVED, not
tuned: it is the transaction's full declared bound plus the one stop bound the
released stop still gets afterwards, i.e. by construction the latest instant a
healthy queued stop can answer — so it can only ever fire on a transaction that
already broke its contract, never on slow-but-working hardware. On expiry the
orchestrator logs, transitions `reconfiguring → reconciling` and adopts the
engine's truth (the same rule `settleConfigChangeState` applies to the
transaction's own deadline — the engine's state is unknown, so ask rather than
assert), and answers `stop_failed` with the distinct
`RECONFIGURE_STOP_TIMEOUT_REASON` (`reconfigure_stop_timeout`) — distinct from
`stop_timeout`, which means the engine WAS asked and did not finish.

Parking is announced at `warn` with the attempt id and the budget, and a release
cancels the deadline so a late tick can never overwrite the honest answer. `warn`
is deliberate: the production console transport runs at `warn`, so an `info` line
reaches the log FILE but never the journal the in-app Logs dialog downloads — an
`info` here would have been invisible in exactly the investigation that needed it.
The ordinary stop's `stop_failed` catch logs for the same reason; a 12 s
`stop_timeout` used to produce zero journal output.

**The BUS settles the transaction, not only the RPC.** When the engine publishes
`rollback_failed{teardown_timeout}` and then exits, the in-flight RPC rejects on
a dead control socket. `noteStreamSessionConfigChangePhase` (fed from
`handleEvent`'s `config-change` case) settles the transaction with the HONEST bus
reason, which wins the race against the dead-socket rejection. Both are fenced on
`attemptId`, so a phase from a superseded transaction can never settle the
current one. Every outcome LEAVES `reconfiguring` — `applied`/`reverted` →
`streaming`, `rollback_failed` → `idle`, deadline → `reconciling` (adopt the
engine's truth) — so there is no stuck `applying` state.

**THE ENGINE SPEAKS PIXELS, AND A REFUSAL IS NOT A FAILED ROLLBACK.** Both halves
of this paragraph were green across the whole automated suite and failed on the
first live transaction, because the fake engine the suite drives accepts whatever
CeraUI sends. Only a board could disprove them.

- **`config-change-bridge.ts` maps `resolution` through `toEngineResolution`.**
  `cerastream-backend.ts` has always done this on the START path; the bridge
  forwarded the UI rung verbatim, so EVERY apply-now resolution change was
  rejected with `invalid params: unsupported resolution '720p' (expected pixel
  form WxH matching a supported preset)`. The two paths now encode the axis
  through the ONE map. A token outside the ladder is forwarded VERBATIM rather
  than dropped — the engine is the authority on what it supports, and silently
  omitting an axis would apply a change the operator did not request.
- **A structured engine rejection settles as `reverted`, never
  `rollback_failed`.** The engine returns a JSON-RPC error ONLY when the
  transaction never began, so a `CerastreamRpcError` proves the live session was
  never touched — nothing was torn down, so there was no rollback to fail.
  `classifyConfigChangeDispatchError` splits it out; every OTHER rejection (dead
  socket, timeout, unknown fault) leaves the engine's state unprovable and keeps
  `rollback_failed{engine_connection_lost}` as the fail-safe DEFAULT. Collapsing
  both told the operator their broadcast may be dead while the engine kept
  encoding without a dropped frame. The reason is the typed
  `CONFIG_CHANGE_REASON_REJECTED` (`change_rejected`), keyed to operator copy in
  all 10 locales — the raw engine string is never rendered.

Coverage: `tests/config-change-engine-contract.test.ts` (the wire value per
ladder rung, the untouched sibling axes, the verbatim unknown token, and the
three classification branches) + the orchestrator's
`a REFUSED transaction reverts and keeps streaming` case, which asserts the
lifecycle stays `streaming` and `stopRuntime` is never called.

**STAGED PERSISTENCE — `config.json` describes what the ENGINE IS RUNNING.**
`config-change-staging.ts` holds the apply-now candidate in memory plus an
on-disk marker (`config.inflight.json`, atomic write). The candidate holds the
restart-requiring fields AND what routing derives from them: the capture mode
the save lands on (`null` when a switch to another camera clears it) and the
pipeline the source or mode routes to. Every field the candidate holds is
deleted from `input`, and the derived mode write is skipped, so the existing
merge block saves none of them (ONE write path, no parallel one to drift).
Before this, a busy or reverted capture-mode switch still saved its derived
`input_mode` and `pipeline`. `config-change-candidate.ts` owns this split.
The engine delta carries a
pipeline only for a source switch. Non-restart fields in the same save persist
immediately, unchanged. `config.json` is written ONLY on `applied`
(`commitStagedConfigChange`); `reverted`/`rollback_failed`/`busy`/`rejected` all
leave the persisted values byte-identical, because those values are still the
ones the engine is running.

The same candidate owns the **source-derived override residue**. A switch to a
non-override ingest pipeline makes the running source's saved
`resolution`/`framerate` residue (`unsupportedPipelineOverrides`), and the
candidate carries them as `null` clears. `null` here is a LOCAL storage clear:
the engine delta omits it, so the producer never sees a null geometry. A marker
whose candidate carries one is undecided from ANY running-engine snapshot —
including one that matches the previous geometry, because an ingest publisher
can report exactly what the old source ran. Recovery keeps the marker instead
of retiring it on the candidate OR previous branch; only a stopped engine's
authoritative retain-previous, or the transaction's own applied/abandoned
outcome, ends it. That is the deliberate limit: a crash during a clear-carrying
source switch stays deferred across reconnects rather than persisting or
discarding an outcome the snapshot cannot prove. Only `applied` deletes the
fields; the ordinary idle/next-start save and its own residue cleanup are
unchanged. Before this, a busy or reverted source switch deleted the running
source's saved geometry before admission could refuse it.

**A SOURCE COMMIT INCLUDES ITS SELECTION METADATA.** The candidate captures
`selected_video_input` and `source_stable_id` from the operator's resolved source
snapshot before dispatch. `resolveSelectionAnchor` remains the identity resolver;
neither commit nor recovery guesses an anchor from a later discovery view.
Explicit local nulls clear the previous capture input or anchor; omitted fields
remain unknown and leave existing metadata alone. An explicit capture-input
clear becomes producer `input_id: null` after capability negotiation.

Legacy markers can state a source and capture input without a captured anchor.
That source label cannot identify the intended hardware, even when it matches
the previous label: a different camera may now hold the same node. While the
engine runs, recovery retains such markers undecided before either outcome
match, without writing selection metadata or advancing its token. It never
reconstructs the missing anchor from later discovery. A stopped engine remains
authoritative to retain the previous config; legacy geometry-only markers keep
their existing recovery rules.

The existing `noteSourceSelectionWrite` owner accepts that captured anchor at
commit and recovery, writes or clears it, and advances the selection token before
the atomic config save. A probe requested before that write remains stale.
Busy and reverted changes call neither the selection owner nor its writer.
A failed config save releases the stage but retains the complete marker and
in-memory selection for recovery, as for the other staged fields.

A local capture-input clear, like a geometry clear, is not proven by a running
snapshot. Its guard runs before both outcome matches: unknown or retained live
input cannot confirm the clear or discard the marker. A stopped engine retains
the previous configuration. Concrete capture-input changes still reconcile
through their reported active input. This does not add mode/pipeline evidence
to the snapshot.
Coverage: `applied-source-selection.test.ts` and
`applied-source-selection-recovery.test.ts`, through the real procedure,
production admission, marker, config writer and persisted-selection router.

**CAPTURE CLEARS REQUIRE THE RUNNING ENGINE'S CAPABILITY [EXISTS].**
The published schema 0.24.0 `ChangeConfigParams` owns nullable `input_mode` and
`input_id`: omission retains, a concrete value replaces, and null clears.
`StreamConfigChangeDelta` indexes those producer fields directly. The procedure
forwards a staged mode clear and a non-capture selection's input clear through
the existing orchestrator and bridge to the binding's validated `changeConfig`.
Geometry clears remain local and are omitted from dispatch; START is unchanged.

Before any config mutation, a clear-needing apply-now request requires a live
capability snapshot whose features include the imported
`CAPTURE_SELECTION_CLEAR_FEATURE`. Absent features, `input-mode` alone, and
cached/unavailable snapshots cannot authorize it. Unsupported requests return
the existing `rejected/change_config_unsupported` outcome with saved config,
selection token and any other attempt's marker untouched. The production
apply-now gate repeats negotiation at admission after asynchronous save work.
Installing bindings does not upgrade a device engine.

That live evidence belongs to the current engine connection. The existing
capability owner tags accepted reads with its connection generation;
`getCurrentCapabilities` requires that tag as well as availability. Acquiring or
adopting a client revokes clear authorization without changing legacy START wire
traffic or its display cache. Proven session connection loss also marks retained
display data unavailable immediately.

A clear-needing candidate prepares current-client capabilities through the
existing apply-now gate before any config mutation or stage acquisition. The
borrowed client remains open and unqueried device discovery stays unknown.
Late successful or failed reads from a superseded generation cannot replace
current evidence. There is no TTL or parallel feature cache. Missing current
evidence or a failed read refuses the clear; a known current engine without the
token is not queried repeatedly. `capture-engine-replacement.test.ts` drives real
SDK/UDS connections, proven loss, fresh START, the procedure/bridge/orchestrator
and config/marker bytes.

`capture-selection-clears.test.ts` covers supported applied/busy/reverted
camera and test/RTMP/SRT switches, unsupported and unavailable-engine refusal,
explicit/absent/unrelated controls and capture through non-capture back to capture.
It drives the real procedure, source builder, gate, orchestrator, bridge and file
writer, checking deltas with the installed producer `changeConfigParamsSchema`.
Producer cerastream #245 separately proves actual wire deserialization, merge,
capture-default resolution, ownership barriers and rollback; consumer fake replies
do not qualify those engine operations or hardware.

**THE STAGE BELONGS TO ONE ATTEMPT.** Each apply-now save builds its marker with
its own `attemptId` and stages it only at dispatch, after every await in
`setConfig` and in the same synchronous stretch as the orchestrator's admission.
`stageConfigChange` refuses (returns `false`, writing nothing) while another
attempt holds the stage, and `setConfig` answers that save `busy`, exactly as
admission would. `commitStagedConfigChange(attemptId)` and
`abandonStagedConfigChange(attemptId)` retire only that attempt, and a dispatch
that throws still releases it. Before this, two overlapping saves (one parked on
the Bluetooth refresh an `audio_backend` change awaits) shared one stage: the
later save replaced the earlier candidate and marker, and the busy loser's
abandon then removed the winner's, so an `applied` change was never persisted.
A save that arrives after the other change was admitted takes the same path:
`reconfiguring` is not idle, so the save holds its restart fields back and is
refused at the stage. Before this, it was treated as idle, saved those fields as
a next-start edit and reported success, leaving them on disk if the running
change reverted, or overwritten if it applied the same field.

**A FINISHED ATTEMPT NEVER KEEPS THE STAGE, EVEN WHEN ITS WRITE FAILS.** If
`config.json` cannot be written after `applied`, the error still reaches the
caller, but `commitStagedConfigChange` first releases the in-memory stage
(`releaseStagedConfigChange`) and leaves the marker on disk. The engine runs the
candidate and the in-memory config already holds it, so the next successful
config write of any kind persists it. Until then the marker is recovery evidence
that no running change owns, so the next boot or engine reconnect judges it like
a crash leftover and completes the write. The next apply-now save is admitted
normally; its own marker replaces the old one, and its commit writes the whole
in-memory config, the earlier candidate included.

**CRASH-WINDOW RECONCILIATION IS MARKER-ONLY.** `reconcileInflightConfigChange`
does nothing at all without the marker. A bare params-vs-config mismatch WITHOUT
a marker is a legitimate "apply on next start" the operator chose, and
reconciling it would silently overwrite their intent on every boot. With the
marker present, `judgeInflightMarker` (PURE) has THREE outcomes: engine live on
the CANDIDATE + outcome gate satisfied (`pipeline_playing` and frames advancing)
⇒ persist the candidate; engine on the PREVIOUS params or idle ⇒ retain the old
values; transitional/unreachable/neither ⇒ write NOTHING and KEEP the marker for
the next reconnect. Guessing in either direction persists a config the operator
never got or discards one they did. A marker whose `attemptId` is the one this
process has staged belongs to a change still running, not to a crash: it is
never judged (`no_marker`), and a judged marker is removed alone, never the
stage of a change running now.

**A LIVE MATCH MUST DISTINGUISH BOTH SIDES.** The judge compares only the
candidate's transaction axes against each side's recorded values. An unrelated
saved next-start codec is not evidence that the previous session was replaced.
Missing runtime measurements and omitted previous values remain unknown; a
decisive live verdict requires one side to match and the other to contradict the
same observations. Identical compared facts defer in either direction.

The published `@ceralive/cerastream@2026.11.2` status has no exact capture-mode or
routed-pipeline measurement. Its output codec, incoming `input_codec`, geometry
and active input cannot establish those request fields. If the candidate changes
`input_mode` or `pipeline`, including a local mode clear, recovery therefore keeps
the config and marker bytes unchanged until decisive evidence is available.
Unchanged capture settings still permit proven geometry, codec or input recovery.
The local nullable geometry clears remain storage intent, never engine
measurements; their existing deferral gate precedes both live verdicts.
Authoritative idle still retains the previous config and retires the marker.

**AND IT IS ARMED — `config-change-reconcile-wiring.ts` is what calls it.** For
one wave the paragraph above described behaviour that could not happen: the only
importer of `reconcileInflightConfigChange` was its own unit test, so a marker
left by a process that died mid transaction was never judged, the staged
candidate was lost, and the marker file leaked. The reconciler was correct and
simply unreachable, which is why the regression lock is on the CALL SITES.

There are TWO seams, and both are needed:

- **boot** (`main.ts`, immediately after `reconcileStreamSession()`) — the first
  moment the persisted config and the engine's own session are both known; and
- **engine reconnect** (`engine-reconnect.ts` `buildDefaultBroadcastEngineState`,
  after the same call) — where a marker that DEFERRED at boot is re-judged.

Four properties are load-bearing:

- **Marker-only is enforced BY CONSTRUCTION, not by convention.** The runner
  reads the marker FIRST and, finding none, returns `no_marker` without ever
  asking the engine anything. That is asserted directly (`h.asked === 0`) — a
  behavioural test, not a comment.
- **The snapshot speaks CONFIG space.** `judgeInflightMarker` compares
  `config.json` values with `===`, and the engine speaks PIXELS (`"3840x2160"`)
  and exact rates (`29.97`) — the read-side twin of the apply-now dispatch bug in
  "THE ENGINE SPEAKS PIXELS". `buildEngineEncodeSnapshot` normalizes at the one
  seam that knows it is talking to the engine, and `judgeInflightMarker` folds
  BOTH sides onto the rung ladder as a backstop (so a persisted `"4k"` matches a
  reported `"3840x2160"`), literal equality first so an unplaceable token never
  widens silently.
- **A NON-ANSWER IS NOT "NOT STREAMING".** The lifecycle comes from the
  orchestrator, never the bare `is_streaming` flag — that flag is false both for a
  genuinely idle engine AND for one reconciliation has not reached yet. Only
  `idle` is decisive; `reconciling`/`starting`/`stopping` yield `undefined`, which
  the judge answers with `wait`. Reading the flag would retain the previous values
  off a non-answer, discarding a change the operator DID get.
- **Bounded, and idempotent two ways.** With a marker it polls
  `INFLIGHT_RECONCILE_DEADLINE_MS` (15 s) at `INFLIGHT_RECONCILE_POLL_MS` (1 s),
  because the frame evidence (`frames_emitted` / `pipeline_playing`) rides the raw
  `active_encode` bridge, whose first status frame lands a second or two after
  boot reaches this point. Expiry defers, which KEEPS the marker. A decisive
  verdict retires the marker, so a repeat call is a plain no-op; and concurrent
  callers (boot racing a heal) share ONE in-flight run rather than judging in
  parallel. Both hooks are fire-and-forget and the runner never throws, so neither
  boot nor the heal broadcast can be delayed or broken by it.

Coverage: `tests/config-change-reconcile-wiring.test.ts` (a REAL on-disk marker
through the REAL writer and REAL `config.json`: persist-candidate, retain-previous,
the undecided-then-decisive re-ask, the never-decisive defer that keeps the marker,
the no-marker zero-side-effect case, double-apply, the overlapping-run join, the
config-space normalization table, the two call-site locks, and a running change's
stage surviving both hooks; real-file capture-mode/pipeline ambiguity in both
directions, mode clears, unknown previous values, unchanged saved next-start
intent, and idle/transitional controls),
`tests/config-change-orchestrator.test.ts` (admission, the four typed
outcomes, stop-during-applying, stop-during-rollback, the teardown_timeout →
engine-exit escalation chain, attempt fencing, deadline reconcile, and the
deadline-sizing assertion), `tests/config-change-staging.test.ts` (the pure
marker/judgement table and the one-attempt stage),
`tests/config-change-persistence.test.ts` (the REAL procedure:
applied-writes vs reverted/rollback_failed-don't, the delta contents, both
apply-now fallbacks, a throwing dispatch releasing the stage, a `config.json`
write failing after `applied` (next save admitted, marker kept and later
judged), a save in each lifecycle state (one row per state of the type), two
overlapping saves through the production gate and the real orchestrator
admission (the second arriving before and after the first is admitted), and
marker-present vs marker-absent reconciliation).

