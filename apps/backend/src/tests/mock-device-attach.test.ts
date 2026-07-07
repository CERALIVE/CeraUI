/*
 * C7 — single-device unplug/replug mock seam + gate parity.
 *
 * `setMockDeviceAttached(inputId, attached)` marks ONE scenario capture device
 * detached/attached, re-folds the fresh device list into the engine-device cache,
 * and rebroadcasts `sources` + legacy `devices` in one combined transition. A
 * detached, session-seen device surfaces as a `lost` row (todo 11 path, driven
 * through the SEAM — not by poking buildSources), and the SHARED start gate
 * refuses the configured lost source with `source_lost` (todo 12 mock/real
 * parity — no mock-specific gate). Cleared by resetMockState(); a no-op in prod.
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
import { call } from "@orpc/server";

import {
	getMockState,
	initMockService,
	resetMockState,
	setStreamingState,
	shouldUseMocks,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	getMockEngineCapabilities,
	getMockEngineDevices,
	setMockDeviceAttached,
} from "../mocks/providers/streaming.ts";
import { getConfig } from "../modules/config.ts";
import {
	clearCapabilitiesCache,
	getCapabilities,
} from "../modules/streaming/capabilities.ts";
import {
	getSourcesMessage,
	refreshEngineDeviceCache,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { streamingStartProcedure } from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

// The default dev scenario advertises an HDMI-RX + a UVC/USB (uvc_h264) capture
// device; `usb` bridges to the `libuvch264` coarse entry, so a detached `usb`
// synthesizes a lost row against a still-offered coarse slot.
const USB_INPUT_ID = "usb";
const USB_DISPLAY_NAME = "RØDE HDMI to USB-C: RØDE HDMI";

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

// Mirror the boot seed: resolve caps through getCapabilities, then seed the
// engine-device cache (records the session snapshot for every observed device).
async function seedCapsAndDevices(): Promise<void> {
	clearCapabilitiesCache();
	await getCapabilities({
		fetchEngineCapabilities: async () => getMockEngineCapabilities(),
		fetchEngineDevices: async () => getMockEngineDevices(),
	});
	await refreshEngineDeviceCache({
		fetchEngineDevices: async () => getMockEngineDevices(),
	});
}

describe("setMockDeviceAttached seam (C7)", () => {
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;

	beforeAll(() => {
		process.env.MOCK_MODE = "true";
		initMockService("multi-modem-wifi");
	});
	beforeEach(async () => {
		resetEngineDeviceCache();
		getConfig().last_seen_devices = [];
		delete getConfig().source;
		await seedCapsAndDevices();
	});
	afterEach(() => {
		setStreamingState(false);
		updateStatus(false);
		resetEngineDeviceCache();
		getConfig().last_seen_devices = [];
		delete getConfig().source;
		resetMockState();
	});
	afterAll(() => {
		stopMockService();
		clearCapabilitiesCache();
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
	});

	test("seeded usb is a live capture source before any detach", () => {
		const row = getSourcesMessage().sources.find((s) => s.id === USB_INPUT_ID);
		expect(row?.origin).toBe("capture");
		expect(row?.available).toBe(true);
		expect(row?.lost).toBeUndefined();
	});

	test("detach → getSourcesMessage() shows the lost row; reattach → live row", () => {
		setMockDeviceAttached(USB_INPUT_ID, false);

		const lost = getSourcesMessage().sources.find((s) => s.id === USB_INPUT_ID);
		expect(lost?.origin).toBe("capture");
		expect(lost?.lost).toBe(true);
		expect(lost?.available).toBe(false);
		if (lost?.origin === "capture") {
			expect(lost.displayName).toBe(USB_DISPLAY_NAME);
		}
		// the hdmi sibling is untouched by the usb detach.
		expect(
			getSourcesMessage().sources.find((s) => s.id === "hdmi")?.available,
		).toBe(true);

		setMockDeviceAttached(USB_INPUT_ID, true);

		const live = getSourcesMessage().sources.find((s) => s.id === USB_INPUT_ID);
		expect(live?.origin).toBe("capture");
		expect(live?.available).toBe(true);
		expect(live?.lost).toBeUndefined();
	});

	test("detach rebroadcasts BOTH devices and sources (combined transition)", () => {
		const sink: string[] = [];
		const client = {
			data: { isAuthenticated: true, lastActive: Date.now() },
			send: (message: string) => sink.push(message),
		} as unknown as AppWebSocket;
		addClient(client);
		try {
			setMockDeviceAttached(USB_INPUT_ID, false);
		} finally {
			removeClient(client);
		}

		const frames = sink.map(
			(raw) => JSON.parse(raw) as Record<string, unknown>,
		);
		expect(frames.some((f) => "devices" in f)).toBe(true);
		const sourcesFrame = frames.find((f) => "sources" in f);
		expect(sourcesFrame).toBeDefined();
		const sources = (
			sourcesFrame?.sources as { sources: Array<Record<string, unknown>> }
		).sources;
		expect(sources.find((s) => s.id === USB_INPUT_ID)?.lost).toBe(true);
	});

	test("resetMockState() restores attachment", () => {
		setMockDeviceAttached(USB_INPUT_ID, false);
		expect(getMockState().detachedSources[USB_INPUT_ID]).toBe(true);

		resetMockState();

		expect(getMockState().detachedSources).toEqual({});
		expect(
			getMockEngineDevices().devices.some((d) => d.input_id === USB_INPUT_ID),
		).toBe(true);
	});

	test("mock start with a seam-detached configured source → source_lost (parity), config.source preserved", async () => {
		getConfig().source = USB_INPUT_ID;
		setMockDeviceAttached(USB_INPUT_ID, false);

		const result = await call(
			streamingStartProcedure,
			{},
			{ context: makeContext() },
		);

		expect(result).toEqual({
			success: false,
			is_streaming: false,
			error: "source_lost",
			reason: "source_lost",
		});
		expect(getConfig().source).toBe(USB_INPUT_ID);
	});
});

describe("setMockDeviceAttached — production isolation", () => {
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;

	afterEach(() => {
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
	});

	test("shouldUseMocks() false → the seam is a no-op (no broadcast, no state change)", () => {
		stopMockService();
		delete process.env.MOCK_MODE;
		process.env.NODE_ENV = "production";
		expect(shouldUseMocks()).toBe(false);

		const sink: string[] = [];
		const client = {
			data: { isAuthenticated: true, lastActive: Date.now() },
			send: (message: string) => sink.push(message),
		} as unknown as AppWebSocket;
		addClient(client);
		try {
			setMockDeviceAttached(USB_INPUT_ID, false);
		} finally {
			removeClient(client);
		}

		expect(sink).toHaveLength(0);
		expect(getMockState().detachedSources[USB_INPUT_ID]).toBeUndefined();
	});
});
