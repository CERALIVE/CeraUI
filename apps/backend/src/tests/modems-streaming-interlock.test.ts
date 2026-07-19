/**
 * Phase B, T5.5 — LifecycleInterlock wiring across the REAL procedures.
 *
 * Proves the interlock is consulted end-to-end: `modems.setUsbMode` refuses with
 * `streaming_active` while a stream is being ADMITTED (interlock held) OR is LIVE
 * (`getIsStreaming()`), and `streaming.start` refuses pre-engine with
 * `MODEM_TRANSITION_ACTIVE` while a modem transition holds the interlock — and the
 * admission `finally` releases the interlock on both its failure and success paths.
 * The primitive's race-order + no-deadlock proofs live in
 * `cellular-lifecycle-interlock.test.ts`.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { SetUsbModeInput } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import {
	initMockService,
	resetMockState,
	setStreamingState,
	stopMockService,
} from "../mocks/mock-service.ts";
import { injectMockStreamError } from "../mocks/providers/streaming.ts";
import { resetCellularStack } from "../modules/cellular/cellular-stack.ts";
import { getConfig } from "../modules/config.ts";
import {
	isLifecycleHeld,
	resetLifecycleInterlock,
	tryAcquireLifecycle,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	getIsStreaming,
	updateStatus,
} from "../modules/streaming/streaming.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import { resetBootReadiness } from "../modules/system/readiness.ts";
import { setUsbModeProcedure } from "../rpc/procedures/modems.procedure.ts";
import { streamingStartProcedure } from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

const VALID_USB_MODE: SetUsbModeInput = {
	device: "0",
	mode: "mbim",
	confirm: true,
};

describe("streaming ↔ modem-transition interlock (real procedures)", () => {
	let priorPipeline: string | undefined;
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;

	beforeAll(() => {
		process.env.MOCK_MODE = "true";
		initMockService("multi-modem-wifi");
	});
	beforeEach(() => {
		resetLifecycleInterlock();
		resetCellularStack();
		resetBootReadiness();
		priorPipeline = getConfig().pipeline;
		getConfig().pipeline = undefined;
		getConfig().modem_provisioning = undefined;
		setStreamingState(false);
		updateStatus(false);
	});
	afterEach(() => {
		resetLifecycleInterlock();
		resetCellularStack();
		resetBootReadiness();
		getConfig().pipeline = priorPipeline;
		getConfig().modem_provisioning = undefined;
		setStreamingState(false);
		updateStatus(false);
		resetMockState();
	});
	afterAll(() => {
		stopMockService();
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
	});

	test("setUsbMode is refused (streaming_active) while a streaming admission holds the interlock", async () => {
		getConfig().modem_provisioning = true;
		const admission = tryAcquireLifecycle("streaming");
		expect(admission).not.toBeNull();
		try {
			let result: unknown;
			await withDeviceType("real", async () => {
				result = await call(setUsbModeProcedure, VALID_USB_MODE, {
					context: makeContext(),
				});
			});
			expect(result).toEqual({ success: false, error: "streaming_active" });
		} finally {
			admission?.release();
		}
	});

	test("setUsbMode is refused (streaming_active) while a stream is LIVE — admitted-start covers is_streaming too", async () => {
		getConfig().modem_provisioning = true;
		updateStatus(true);
		expect(isLifecycleHeld()).toBe(false);
		let result: unknown;
		await withDeviceType("real", async () => {
			result = await call(setUsbModeProcedure, VALID_USB_MODE, {
				context: makeContext(),
			});
		});
		expect(result).toEqual({ success: false, error: "streaming_active" });
	});

	test("streaming.start is refused pre-engine (MODEM_TRANSITION_ACTIVE) while a modem transition holds the interlock", async () => {
		const transition = tryAcquireLifecycle("modem-transition");
		expect(transition).not.toBeNull();
		try {
			const result = await call(
				streamingStartProcedure,
				{},
				{ context: makeContext() },
			);
			expect(result).toEqual({
				success: false,
				is_streaming: false,
				error: "MODEM_TRANSITION_ACTIVE",
			});
			expect(getIsStreaming()).toBe(false);
		} finally {
			transition?.release();
		}
	});

	test("streaming.start releases the interlock on its failure path — a subsequent transition can acquire", async () => {
		injectMockStreamError("srt_connect_failed");
		const result = await call(
			streamingStartProcedure,
			{},
			{ context: makeContext() },
		);
		expect(result.success).toBe(false);
		expect(isLifecycleHeld()).toBe(false);
		const after = tryAcquireLifecycle("modem-transition");
		expect(after).not.toBeNull();
		after?.release();
	});

	test("streaming.start releases the interlock on success, then the LIVE guard blocks a transition (no gap)", async () => {
		const result = await call(
			streamingStartProcedure,
			{},
			{ context: makeContext() },
		);
		expect(result.success).toBe(true);
		expect(isLifecycleHeld()).toBe(false);
		expect(getIsStreaming()).toBe(true);

		getConfig().modem_provisioning = true;
		let usbResult: unknown;
		await withDeviceType("real", async () => {
			usbResult = await call(setUsbModeProcedure, VALID_USB_MODE, {
				context: makeContext(),
			});
		});
		expect(usbResult).toEqual({ success: false, error: "streaming_active" });
	});
});
