import { CerastreamRpcError } from "@ceralive/cerastream";
import {
	CONFIG_CHANGE_EVENT,
	CONFIG_CHANGE_REASON_ENGINE_LOST,
	CONFIG_CHANGE_REASON_REJECTED,
	type ConfigChangePhase,
	type ConfigChangeResult,
	type Resolution,
	resolutionSchema,
	toEngineResolution,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { broadcastMsg } from "../../rpc/compat.ts";
import {
	type ConfigChangePhaseEvent,
	changeStreamSessionConfig,
	type EngineConfigChangeOutcome,
	getStreamSessionSnapshot,
	type StreamConfigChangeDelta,
} from "./stream-session-orchestrator.ts";
import { getStreamingBackend } from "./streaming-engine.ts";

type ChangeConfigCapableBackend = {
	changeConfig?: (params: {
		resolution?: string;
		framerate?: number;
		codec?: string;
		input_id?: string;
		pipeline?: string;
		input_mode?: string;
	}) => Promise<{
		attempt_id: string;
		phase: ConfigChangePhase;
		reason?: string;
	}>;
};

/**
 * The engine speaks PIXELS (`"1280x720"`), never the UI's rung token (`"720p"`).
 *
 * `cerastream-backend.ts` has always mapped `config.resolution` through
 * `toEngineResolution` on the START path; this bridge forwarded the raw token,
 * so EVERY apply-now resolution change was rejected by the engine with
 * `invalid params: unsupported resolution '720p' (expected pixel form WxH
 * matching a supported preset)`. Found on the live board — no unit test could
 * see it, because the fake engine the suite drives accepts whatever CeraUI
 * sends. The two paths now encode the axis identically, through the one map.
 *
 * A token outside the ladder is forwarded VERBATIM rather than dropped: the
 * engine is the authority on what it supports, and silently omitting an axis the
 * operator asked for would apply a change they did not request.
 */
function encodeResolutionForEngine(token: string): string {
	const parsed = resolutionSchema.safeParse(token);
	return parsed.success ? toEngineResolution(parsed.data as Resolution) : token;
}

/**
 * Dispatch one `change-config` transaction to the engine.
 *
 * The engine answers `Ok` for EVERY phase it actually reached — including
 * `rollback_failed` — and errors ONLY when the transaction never started. So a
 * resolved reply is a real outcome to render, not a success, and a rejection
 * genuinely means nothing happened.
 */
export async function changeEngineRuntimeConfig(
	delta: StreamConfigChangeDelta,
	attemptId: string,
): Promise<EngineConfigChangeOutcome> {
	const backend =
		getStreamingBackend() as unknown as ChangeConfigCapableBackend;
	const dispatch = backend.changeConfig;
	if (dispatch === undefined)
		throw new Error("engine does not support change-config");

	const result = await dispatch.call(backend, {
		...(delta.resolution === undefined
			? {}
			: { resolution: encodeResolutionForEngine(delta.resolution) }),
		...(delta.framerate === undefined ? {} : { framerate: delta.framerate }),
		...(delta.video_codec === undefined ? {} : { codec: delta.video_codec }),
		...(delta.input_id === undefined ? {} : { input_id: delta.input_id }),
		...(delta.pipeline === undefined ? {} : { pipeline: delta.pipeline }),
		...(delta.input_mode === undefined ? {} : { input_mode: delta.input_mode }),
	});

	logger.info("config change transaction settled", {
		module: "streaming",
		attemptId,
		engineAttemptId: result.attempt_id,
		phase: result.phase,
		reason: result.reason,
	});

	return result.reason === undefined
		? { phase: result.phase }
		: { phase: result.phase, reason: result.reason };
}

/**
 * Two failure modes hide behind one rejected dispatch and they mean OPPOSITE
 * things to an operator. The engine returns a JSON-RPC error ONLY when the
 * transaction never began, so a `CerastreamRpcError` proves the live session was
 * never touched and the previous config is still on air — `reverted`, because
 * nothing was torn down and there was no rollback to fail. Every other rejection
 * (dead socket, timeout, unknown fault) leaves the engine's state unprovable, so
 * `rollback_failed` stays the DEFAULT and an unrecognised failure can never
 * claim the stream is fine.
 */
export function classifyConfigChangeDispatchError(
	error: unknown,
): EngineConfigChangeOutcome {
	if (error instanceof CerastreamRpcError)
		return { phase: "reverted", reason: CONFIG_CHANGE_REASON_REJECTED };
	return { phase: "rollback_failed", reason: CONFIG_CHANGE_REASON_ENGINE_LOST };
}

export type ApplyNowGate = {
	readonly isStreamLive: () => boolean;
	readonly dispatch: (
		delta: StreamConfigChangeDelta,
	) => Promise<ConfigChangeResult>;
};

const productionGate: ApplyNowGate = {
	isStreamLive: () => getStreamSessionSnapshot().state === "streaming",
	dispatch: (delta) => changeStreamSessionConfig(delta),
};

let activeGate: ApplyNowGate = productionGate;

export function getApplyNowGate(): ApplyNowGate {
	return activeGate;
}

export function setApplyNowGateForTest(gate: ApplyNowGate | null): void {
	activeGate = gate ?? productionGate;
}

export function broadcastConfigChangePhase(
	event: ConfigChangePhaseEvent,
): void {
	broadcastMsg(CONFIG_CHANGE_EVENT, {
		attemptId: event.attemptId,
		phase: event.phase,
		...(event.reason === undefined ? {} : { reason: event.reason }),
	});
}
