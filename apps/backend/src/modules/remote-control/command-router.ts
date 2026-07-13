/**
 * Remote Control Plane v2.0 — inbound command routing (hub → device).
 *
 * This is the device half of the spec §5 "Command Registry" / §6 "Result Frame"
 * flow: an inbound `kind:command` frame on the dedicated control channel is
 * dispatched to the matching existing oRPC procedure, and the device replies with
 * a best-effort `kind:result` frame echoing the command's `cid`.
 *
 * Reuse, not reinvention: every registered command maps to a procedure that
 * already implements the real validation/clamp/persist logic (the same handlers
 * the local UI socket drives). We invoke them through oRPC's `call()` with a
 * synthesized authenticated context, so there is exactly one code path for "apply
 * a streaming change" regardless of whether it arrived locally or over the hub.
 *
 * Authority model (spec §12): the control channel is authenticated at the
 * transport layer (PASETO, Task 7) and the connection `role` is hub-stamped. The
 * device trusts the verified channel + role claim and executes only `owner`
 * frames. Never-remote ops (spec §5) are rejected defensively even if a malformed
 * hub forwards one — they are NEVER invoked here.
 *
 * Self_fencing ops (the brick-risk connectivity/lifecycle commands) are handled
 * by the commit-confirm watchdog via `handleSelfFencingOp` and
 * `handleSelfFencingConfirm`, fully implemented and wired below.
 */

import { logger } from "../../helpers/logger.ts";
import type { RPCContext } from "../../rpc/types.ts";
import { sendFrame } from "./channel.ts";
import {
	getSharedSeenCidStore,
	type SeenCidStore,
} from "./command-idempotency.ts";
import { buildControlContext } from "./control-context.ts";
import { routeInternalCommand } from "./internal-command-router.ts";
import {
	COMMAND_REGISTRY,
	type Command,
	type DeliveryAck,
	isInternalCommand,
	NEVER_REMOTE,
	PROTOCOL_VERSION,
	type Result,
	type ResultPayload,
	SELF_FENCING_TYPES,
} from "./protocol.ts";
import {
	handleSelfFencingConfirm,
	handleSelfFencingOp,
	type SelfFencingDeps,
} from "./self-fencing.ts";
import {
	type ProcedureDispatcher,
	STREAMING_DISPATCH,
} from "./streaming-command-dispatch.ts";

/**
 * The five connectivity/lifecycle ops that route through the self_fencing
 * commit-confirm watchdog (Task 16). The `self_fencing.confirm` acknowledgement is
 * handled separately (it resolves a pending op by `cid` rather than starting one).
 */
const SELF_FENCING_TYPES_SET: ReadonlySet<string> = new Set(SELF_FENCING_TYPES);

const COMMAND_REGISTRY_SET: ReadonlySet<string> = new Set(COMMAND_REGISTRY);
const NEVER_REMOTE_SET: ReadonlySet<string> = new Set(NEVER_REMOTE);

/**
 * Injectable collaborators (same DI posture as `channel.ts`). Defaults wire the
 * live channel `sendFrame`, the real procedure dispatch, and a synthesized
 * authenticated context; tests override `sendResult` to capture emitted frames.
 */
export interface CommandRouterDeps {
	/** Best-effort result-frame sink (spec §6). Defaults to the live channel. */
	sendResult: (frame: Result) => boolean;
	/** Best-effort delivery-ack sink (spec §6.1). Defaults to the live channel. */
	sendDeliveryAck: (frame: DeliveryAck) => boolean;
	/** Seen-cid store backing command idempotency (spec §6.1 de-dup of replays). */
	seenCids: SeenCidStore;
	/** Command-type → procedure dispatch table. */
	dispatch: Record<string, ProcedureDispatcher>;
	/** Authenticated context the device trusts for hub-stamped owner frames. */
	context: RPCContext;
	/** Self_fencing watchdog overrides (Task 16), forwarded to handleSelfFencingOp. */
	selfFencing: Partial<SelfFencingDeps>;
}

function defaultDeps(): CommandRouterDeps {
	return {
		sendResult: sendFrame,
		sendDeliveryAck: sendFrame,
		seenCids: getSharedSeenCidStore(),
		dispatch: STREAMING_DISPATCH,
		context: buildControlContext(),
		selfFencing: {},
	};
}

/**
 * Build a `delivery.ack` frame echoing the command's `type` + `cid` (spec §6.1).
 * `role` is only echoed when present (exactOptionalPropertyTypes).
 */
function buildDeliveryAck(frame: Command): DeliveryAck {
	return {
		v: PROTOCOL_VERSION,
		kind: "delivery.ack",
		type: frame.type,
		cid: frame.cid,
		...(frame.role !== undefined ? { role: frame.role } : {}),
	};
}

/**
 * Map an RPC procedure's return onto the control-plane result payload (spec §6).
 * The existing `{ success, applied }` setter convention becomes `{ ok, applied }`;
 * read-only procedures (getConfig/getPipelines/setBitrate) carry no `success`
 * field, so their whole return is the applied state.
 */
function toResultPayload(result: unknown): ResultPayload {
	if (result !== null && typeof result === "object" && "success" in result) {
		const r = result as {
			success: boolean;
			applied?: unknown;
			error?: unknown;
		};
		if (r.success) {
			return { ok: true, applied: r.applied ?? null };
		}
		return {
			ok: false,
			applied: null,
			...(typeof r.error === "string" ? { error: r.error } : {}),
		};
	}
	return { ok: true, applied: result ?? null };
}

/**
 * Build a `kind:result` frame echoing the command's `cid` (spec §6). `role` is
 * only echoed when present (exactOptionalPropertyTypes: never set it to
 * `undefined`).
 */
function buildResult(frame: Command, payload: ResultPayload): Result {
	return {
		v: PROTOCOL_VERSION,
		kind: "result",
		type: frame.type,
		cid: frame.cid,
		...(frame.role !== undefined ? { role: frame.role } : {}),
		payload,
	};
}

function emit(
	deps: CommandRouterDeps,
	frame: Command,
	payload: ResultPayload,
): void {
	deps.sendResult(buildResult(frame, payload));
}

/**
 * Route a single inbound `command` frame to the matching procedure and emit a
 * best-effort `result` frame echoing its `cid` (spec §5, §6). Never throws — a
 * rejected or failing command becomes an `ok:false` result, not an exception.
 */
export async function routeCommand(
	frame: Command,
	overrides: Partial<CommandRouterDeps> = {},
): Promise<void> {
	const deps: CommandRouterDeps = { ...defaultDeps(), ...overrides };

	// 1. Never-remote ops are rejected defensively (spec §5) — NEVER executed,
	//    even if a malformed hub forwards one.
	if (NEVER_REMOTE_SET.has(frame.type)) {
		emit(deps, frame, {
			ok: false,
			applied: null,
			error: "not_remote_invokable",
		});
		return;
	}

	// 2. Only registered command types are invocable (spec §5 closed registry).
	if (!COMMAND_REGISTRY_SET.has(frame.type)) {
		emit(deps, frame, { ok: false, applied: null, error: "unknown_command" });
		return;
	}

	// 3. Confirm receipt (spec §6.1) BEFORE applying — the hub bounds its delivery
	//    retries on this ack. `type` is now known to be in the registry so the ack
	//    is valid platform-side. Emitted for replays too, so the hub stops retrying
	//    even when an earlier `result` never confirmed.
	deps.sendDeliveryAck(buildDeliveryAck(frame));

	// 4. INTERNAL commands (spec §5) are platform-originated downstream data pushes
	//    (e.g. ingest.slots, T18), NOT operator control actions — so they apply
	//    BEFORE the owner-only gate (no human operator originates them) and need no
	//    idempotency guard (each push replaces the full set). A malformed payload is
	//    ignored (store unchanged) and surfaced as an ok:false result, never a crash.
	if (isInternalCommand(frame.type)) {
		await routeInternalCommand(frame, { sendResult: deps.sendResult });
		return;
	}

	// 5. Authority derives from the hub-stamped role (spec §12). v2.0 is
	//    owner-only: only `owner` frames execute.
	if (frame.role !== "owner") {
		emit(deps, frame, { ok: false, applied: null, error: "unauthorized" });
		return;
	}

	// 5. A `self_fencing.confirm` resolves a pending op by `cid` (Task 16). It
	//    deliberately REUSES the original command's `cid`, so it is handled BEFORE
	//    the idempotency gate — otherwise the matching original cid would swallow it.
	if (frame.type === "self_fencing.confirm") {
		await handleSelfFencingConfirm(frame.cid);
		return;
	}

	// 6. Idempotency (spec §6.1): a replayed `cid` was acknowledged above but MUST
	//    NOT execute twice. The first sighting records the cid; a repeat returns here.
	if (deps.seenCids.checkAndRemember(frame.cid)) {
		return;
	}

	// 7. Self_fencing ops route through the commit-confirm watchdog (Task 16): the
	//    five connectivity/lifecycle ops apply behind the watchdog (revertible) or
	//    gate behind a pre-confirm (non-revertible). Results use the same sink.
	if (SELF_FENCING_TYPES_SET.has(frame.type)) {
		await handleSelfFencingOp(frame, {
			sendResult: deps.sendResult,
			...deps.selfFencing,
		});
		return;
	}

	// 8. Dispatch to the matching RPC procedure and echo its applied state.
	const dispatcher = deps.dispatch[frame.type];
	if (dispatcher === undefined) {
		emit(deps, frame, { ok: false, applied: null, error: "unknown_command" });
		return;
	}

	try {
		const result = await dispatcher(frame, deps.context);
		emit(deps, frame, toResultPayload(result));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn(`control-command: ${frame.type} failed: ${message}`);
		emit(deps, frame, { ok: false, applied: null, error: message });
	}
}
