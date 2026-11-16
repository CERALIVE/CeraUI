import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	CerastreamRpcError,
	type CompositionConfig,
} from "@ceralive/cerastream";
import {
	getMockState,
	initMockService,
	stopMockService,
} from "../mocks/mock-service.ts";
import { startMockStreaming } from "../mocks/providers/streaming.ts";
import { cerastreamBackend } from "../modules/streaming/cerastream-backend.ts";
import { changeEngineRuntimeConfig } from "../modules/streaming/config-change-bridge.ts";
import { forcedLegacy } from "./helpers/forced-legacy.ts";

/**
 * Under mocks, a live layout change reaches the mock engine (as set-audio-mix
 * does), so the mock stack can move the second input while streaming. Any
 * other live change keeps going to the engine client.
 */

const savedMode = process.env.MOCK_MODE;
const running: CompositionConfig = {
	secondary_input_id: "usb2",
	layout: "pip-top-right",
};
const placed: CompositionConfig = {
	secondary_input_id: "usb2",
	layout: "custom",
	rect: { x: 0.05, y: 0.45, width: 0.5, height: 0.5 },
};

beforeEach(() => {
	process.env.MOCK_MODE = "true";
	initMockService("caps-full");
	startMockStreaming({
		...forcedLegacy,
		input_id: "usb",
		video_passthrough: "off",
		composition: running,
	});
});
afterEach(() => {
	stopMockService();
	if (savedMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = savedMode;
});

test("a live layout change is applied by the mock engine, which keeps the new rectangle", async () => {
	expect(
		await changeEngineRuntimeConfig({ composition: placed }, "mock-layout"),
	).toEqual({
		phase: "applied",
	});
	expect(getMockState().engineStart?.composition).toEqual(placed);
});

test("a rectangle the mock engine refuses never starts the change", async () => {
	const outside = {
		...placed,
		rect: { x: 0.9, y: 0, width: 0.5, height: 0.5 },
	};
	await expect(
		changeEngineRuntimeConfig({ composition: outside }, "mock-layout"),
	).rejects.toBeInstanceOf(CerastreamRpcError);
	expect(getMockState().engineStart?.composition).toEqual(running);
});

test("a change that is not layout-only still goes to the engine client", async () => {
	const dispatch = spyOn(cerastreamBackend, "changeConfig").mockResolvedValue({
		attempt_id: "engine",
		phase: "applied",
		state: "streaming",
	});
	try {
		await changeEngineRuntimeConfig(
			{ composition: placed, framerate: 30 },
			"mock-layout",
		);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(getMockState().engineStart?.composition).toEqual(running);
	} finally {
		dispatch.mockRestore();
	}
});
