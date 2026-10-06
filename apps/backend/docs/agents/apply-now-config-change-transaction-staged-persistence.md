<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## APPLY-NOW CONFIG CHANGE — TRANSACTION + STAGED PERSISTENCE [EXISTS]

Composition now follows the same staging/dispatch/outcome path, including explicit
null. Both consumers now pin the verified published `@ceralive/cerastream@2026.9.11`,
whose exported `ChangeConfigParams` and schema preserve null. The already-verified
adapter retains its narrow raw-request path and producer-owned result validation;
no local wire type is introduced. `composition-binding-contract.test.ts` fails
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
broadcast by itself. `apply_now` while NOT streaming degrades to an ordinary
save — it never dispatches a transaction.

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
on-disk marker (`config.inflight.json`, atomic write); the restart-requiring
fields are deleted from `input` so the existing merge block skips them (ONE write
path, no parallel one to drift). Non-restart fields in the same save persist
immediately, unchanged. `config.json` is written ONLY on `applied`
(`commitStagedConfigChange`); `reverted`/`rollback_failed`/`busy`/`rejected` all
leave the persisted values byte-identical, because those values are still the
ones the engine is running.

**CRASH-WINDOW RECONCILIATION IS MARKER-ONLY.** `reconcileInflightConfigChange`
does nothing at all without the marker. A bare params-vs-config mismatch WITHOUT
a marker is a legitimate "apply on next start" the operator chose, and
reconciling it would silently overwrite their intent on every boot. With the
marker present, `judgeInflightMarker` (PURE) has THREE outcomes: engine live on
the CANDIDATE + outcome gate satisfied (`pipeline_playing` and frames advancing)
⇒ persist the candidate; engine on the PREVIOUS params or idle ⇒ retain the old
values; transitional/unreachable/neither ⇒ write NOTHING and KEEP the marker for
the next reconnect. Guessing in either direction persists a config the operator
never got or discards one they did.

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
config-space normalization table, and the two call-site locks),
`tests/config-change-orchestrator.test.ts` (admission, the four typed
outcomes, stop-during-applying, stop-during-rollback, the teardown_timeout →
engine-exit escalation chain, attempt fencing, deadline reconcile, and the
deadline-sizing assertion), `tests/config-change-staging.test.ts` (the pure
marker/judgement table), `tests/config-change-persistence.test.ts` (the REAL
procedure: applied-writes vs reverted/rollback_failed-don't, the delta contents,
both apply-now fallbacks, and marker-present vs marker-absent reconciliation).

