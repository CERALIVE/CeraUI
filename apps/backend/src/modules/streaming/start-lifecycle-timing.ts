import {
	CHANGE_CONFIG_WORST_CASE_BOUND_MS,
	type StartFailurePhase,
} from "@ceraui/rpc/schemas";

export type StartDeadlinePhase = Exclude<
	StartFailurePhase,
	"params" | "spawn-sender"
>;

export const START_PHASE_DEADLINES_MS: Readonly<
	Record<StartDeadlinePhase, number>
> = {
	connect: 10_000,
	hello: 10_000,
	subscribe: 10_000,
	"start-rpc": 10_000,
	"playing-wait": 5_000,
};

export const STOP_DEADLINE_MS = 12_000;

/**
 * Bound on the engine control-socket `close()` the stop path awaits. An engine
 * still handing `/dev/videoN` back to `uvcvideo` can leave that close pending
 * forever, and the callback that clears the session runs in its `finally` — so
 * unbounded, one such stop never completes. Kept well inside `STOP_DEADLINE_MS`
 * so a slow-but-alive engine still stops normally rather than `stop_failed`.
 */
export const ENGINE_CLOSE_DEADLINE_MS = 5_000;

export const ENGINE_STOP_DEADLINE_MARGIN_MS = 500;

/**
 * Shared budget for opening the independent stop connection and receiving the
 * engine's Idle acknowledgement. The remaining stop budget covers bounded
 * socket cleanup plus an explicit scheduling margin, so internal timers settle
 * ahead of the orchestrator's outer deadline.
 */
export const ENGINE_STOP_REQUEST_DEADLINE_MS =
	STOP_DEADLINE_MS - ENGINE_CLOSE_DEADLINE_MS - ENGINE_STOP_DEADLINE_MARGIN_MS;

/**
 * Outer bound on `reconfiguring`: the engine's declared worst-case transaction
 * PLUS one stop bound, because a stop requested mid-transaction queues behind it
 * and must still get its own full deadline afterwards. Never apply
 * `STOP_DEADLINE_MS` to a change — at 12 s it is ~5× shorter than a legitimate
 * worst case, so racing them reports healthy hardware as `stop_failed`.
 */
export const RECONFIGURE_DEADLINE_MS =
	CHANGE_CONFIG_WORST_CASE_BOUND_MS + STOP_DEADLINE_MS;
