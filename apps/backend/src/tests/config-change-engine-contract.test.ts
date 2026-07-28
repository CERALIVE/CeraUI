/*
 * The two halves of the apply-now/engine contract that only a real board could
 * disprove (device-quality-wave3 todo 12 board proof).
 *
 * Both defects below were green across the whole automated suite and failed on
 * the first live transaction, because the fake engine the other suites drive
 * accepts whatever CeraUI sends and rejects only when a test tells it to. So
 * these cases assert the WIRE VALUE and the ERROR CLASS rather than a fake's
 * cooperation.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	CerastreamConnectionError,
	CerastreamRpcError,
} from "@ceralive/cerastream";
import {
	CONFIG_CHANGE_REASON_ENGINE_LOST,
	CONFIG_CHANGE_REASON_REJECTED,
	RESOLUTION_ENGINE_DIMS,
} from "@ceraui/rpc/schemas";

import { cerastreamBackend } from "../modules/streaming/cerastream-backend.ts";
import {
	changeEngineRuntimeConfig,
	classifyConfigChangeDispatchError,
} from "../modules/streaming/config-change-bridge.ts";

type ChangeConfigParams = Parameters<typeof cerastreamBackend.changeConfig>[0];

const original = cerastreamBackend.changeConfig;

function captureDispatch(): { params: ChangeConfigParams[] } {
	const params: ChangeConfigParams[] = [];
	cerastreamBackend.changeConfig = mock(async (next: ChangeConfigParams) => {
		params.push(next);
		return { attempt_id: "engine-1", phase: "applied" as const };
	}) as typeof cerastreamBackend.changeConfig;
	return { params };
}

afterEach(() => {
	cerastreamBackend.changeConfig = original;
});

describe("apply-now dispatch speaks the engine's resolution form", () => {
	test("every ladder rung is sent as WxH pixels, never the UI rung token", async () => {
		// Given the engine, which answers a rung token with
		// `invalid params: unsupported resolution '720p' (expected pixel form WxH
		// matching a supported preset)` — observed on the board.
		const dispatch = captureDispatch();

		// When each rung the operator can pick is applied now.
		for (const rung of Object.keys(RESOLUTION_ENGINE_DIMS)) {
			await changeEngineRuntimeConfig({ resolution: rung }, `attempt-${rung}`);
		}

		// Then every dispatched value is the pixel pair, matching the START path.
		expect(dispatch.params.map((entry) => entry.resolution)).toEqual(
			Object.values(RESOLUTION_ENGINE_DIMS),
		);
	});

	test("the other axes ride through untouched and an absent axis is omitted", async () => {
		const dispatch = captureDispatch();

		await changeEngineRuntimeConfig(
			{ resolution: "1080p", framerate: 30, video_codec: "h265" },
			"attempt-axes",
		);
		await changeEngineRuntimeConfig({ framerate: 60 }, "attempt-fps-only");

		expect(dispatch.params[0]).toEqual({
			resolution: "1920x1080",
			framerate: 30,
			codec: "h265",
		});
		// A resolution-less change must not invent one.
		expect(dispatch.params[1]).toEqual({ framerate: 60 });
	});

	test("a token outside the ladder is forwarded verbatim, never dropped", async () => {
		// The engine is the authority on what it supports; silently omitting the
		// axis would apply a change the operator did not ask for.
		const dispatch = captureDispatch();

		await changeEngineRuntimeConfig({ resolution: "8k" }, "attempt-unknown");

		expect(dispatch.params[0]?.resolution).toBe("8k");
	});
});

describe("a refused transaction is not a failed rollback", () => {
	test("a structured engine rejection reverts — the old config is still on air", () => {
		// Given the exact error the board produced mid-stream while the engine
		// kept encoding without a dropped frame.
		const rejected = new CerastreamRpcError(
			"invalid params: unsupported resolution '720p'",
			-32602,
		);

		const outcome = classifyConfigChangeDispatchError(rejected);

		expect(outcome).toEqual({
			phase: "reverted",
			reason: CONFIG_CHANGE_REASON_REJECTED,
		});
	});

	test("a lost control connection stays rollback_failed — engine state is unprovable", () => {
		const lost = new CerastreamConnectionError(
			"control connection is not open",
		);

		expect(classifyConfigChangeDispatchError(lost)).toEqual({
			phase: "rollback_failed",
			reason: CONFIG_CHANGE_REASON_ENGINE_LOST,
		});
	});

	test("an UNRECOGNISED failure fails safe — it never claims the stream is fine", () => {
		for (const error of [new Error("boom"), "boom", undefined, null]) {
			expect(classifyConfigChangeDispatchError(error)).toEqual({
				phase: "rollback_failed",
				reason: CONFIG_CHANGE_REASON_ENGINE_LOST,
			});
		}
	});
});
