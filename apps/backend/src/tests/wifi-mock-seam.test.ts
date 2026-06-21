/*
 * T9 — WiFi mock-seam fault knobs (ceraui-os-interaction-ux).
 *
 * Proves the deterministic fault injection in providers/wifi.ts drives the REAL
 * wifi RPC procedures down the WifiSelectorDialog's operation-phase paths without
 * any hardware:
 *   - default (no faults): a saved connect succeeds AND marks the target active
 *     (the existing happy path is preserved).
 *   - deviceBusy: every mutating WiFi op returns { success:false, error:"DEVICE_BUSY" }.
 *   - savedConnectFails: connect emits the failing result frame { connect:false, device }.
 *   - connectNewAuthFails: connectNew emits the wrong-password frame { new:{ error:"auth", device } }.
 *   - suppressConfirm: a connect is accepted but never marks the target active, so
 *     the frontend op never confirms (it later times out).
 *   - resetMockState() clears every knob (no cross-test bleed).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import { call } from "@orpc/server";

import {
	getMockState,
	initMockService,
	mockWifiUuidForSsid,
	resetMockState,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	getMockWifiFaults,
	resetMockWifiFaults,
	setMockWifiFaults,
} from "../mocks/providers/wifi.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import {
	wifiConnectNewProcedure,
	wifiConnectProcedure,
	wifiDisconnectProcedure,
	wifiForgetProcedure,
	wifiScanProcedure,
} from "../rpc/procedures/wifi.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const SCENARIO = "multi-modem-wifi";
const ORIGINAL_MOCK_MODE = process.env.MOCK_MODE;
const MOCK_WIFI_DEVICE = "wlan0";
const SAVED_SSID = "Office_Secure";
const SAVED_UUID = mockWifiUuidForSsid(SAVED_SSID);

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

/** Run `fn` while a broadcast-capturing client is attached; returns parsed `wifi` payloads. */
async function withWifiCapture(
	fn: () => Promise<unknown>,
): Promise<Array<Record<string, unknown>>> {
	const received: string[] = [];
	const client = {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (message: string) => received.push(message),
	} as unknown as AppWebSocket;
	addClient(client);
	try {
		await fn();
	} finally {
		removeClient(client);
	}
	return received
		.map((raw) => JSON.parse(raw) as Record<string, unknown>)
		.filter((obj) => obj && typeof obj === "object" && "wifi" in obj)
		.map((obj) => obj.wifi as Record<string, unknown>);
}

function activeNetwork(): string | undefined {
	return getMockState().wifiConnections.get(MOCK_WIFI_DEVICE)?.activeNetwork;
}

beforeAll(() => {
	// shouldUseMocks() gates the seam on isDevelopment(); MOCK_MODE flips that on
	// without depending on NODE_ENV.
	process.env.MOCK_MODE = "true";
	initMockService(SCENARIO);
});

afterEach(() => resetMockState());

afterAll(() => {
	stopMockService();
	if (ORIGINAL_MOCK_MODE === undefined) {
		delete process.env.MOCK_MODE;
	} else {
		process.env.MOCK_MODE = ORIGINAL_MOCK_MODE;
	}
});

describe("wifi mock-seam — default (no faults)", () => {
	it("a saved connect succeeds and marks the target network active", async () => {
		const result = await call(
			wifiConnectProcedure,
			{ uuid: SAVED_UUID },
			{ context: makeContext() },
		);
		expect(result).toEqual({ success: true });
		expect(activeNetwork()).toBe(SAVED_SSID);
	});
});

describe("wifi mock-seam — deviceBusy", () => {
	it("makes every mutating WiFi op return DEVICE_BUSY without mutating state", async () => {
		setMockWifiFaults({ deviceBusy: true });
		const before = activeNetwork();
		const ctx = { context: makeContext() };

		expect(await call(wifiConnectProcedure, { uuid: SAVED_UUID }, ctx)).toEqual(
			{
				success: false,
				error: "DEVICE_BUSY",
			},
		);
		expect(
			await call(wifiDisconnectProcedure, { uuid: SAVED_UUID }, ctx),
		).toEqual({ success: false, error: "DEVICE_BUSY" });
		expect(await call(wifiForgetProcedure, { uuid: SAVED_UUID }, ctx)).toEqual({
			success: false,
			error: "DEVICE_BUSY",
		});
		expect(await call(wifiScanProcedure, { device: "0" }, ctx)).toEqual({
			success: false,
			error: "DEVICE_BUSY",
		});
		expect(
			await call(
				wifiConnectNewProcedure,
				{ device: "0", ssid: "NewNet", password: "password1" },
				ctx,
			),
		).toEqual({ success: false, error: "DEVICE_BUSY" });

		// A busy op never touches the active connection.
		expect(activeNetwork()).toBe(before);
	});
});

describe("wifi mock-seam — savedConnectFails", () => {
	it("emits the failing { connect:false, device } frame and leaves the active network untouched", async () => {
		setMockWifiFaults({ savedConnectFails: true });
		const before = activeNetwork();

		const payloads = await withWifiCapture(() =>
			call(
				wifiConnectProcedure,
				{ uuid: SAVED_UUID },
				{ context: makeContext() },
			),
		);

		expect(payloads).toContainEqual({ connect: false, device: "0" });
		// The failing connect must NOT optimistically mark the target active.
		expect(activeNetwork()).toBe(before);
	});
});

describe("wifi mock-seam — connectNewAuthFails", () => {
	it("emits the wrong-password { new:{ error:'auth', device } } frame", async () => {
		setMockWifiFaults({ connectNewAuthFails: true });

		const payloads = await withWifiCapture(() =>
			call(
				wifiConnectNewProcedure,
				{ device: "0", ssid: "BrandNew", password: "wrongpass1" },
				{ context: makeContext() },
			),
		);

		expect(payloads).toContainEqual({
			new: { error: "auth", device: "0" },
		});
		// Auth failure must not add the network to the active/saved mock state.
		expect(activeNetwork()).not.toBe("BrandNew");
	});
});

describe("wifi mock-seam — suppressConfirm", () => {
	it("accepts a connect but never marks the target active (drives timed_out)", async () => {
		setMockWifiFaults({ suppressConfirm: true });
		const before = activeNetwork();

		const result = await call(
			wifiConnectProcedure,
			{ uuid: SAVED_UUID },
			{ context: makeContext() },
		);

		expect(result).toEqual({ success: true });
		// No confirming snapshot: the target never becomes active, so the frontend
		// op stays pending until its TTL valve flips it to timed_out.
		expect(activeNetwork()).toBe(before);
	});
});

describe("wifi mock-seam — reset semantics", () => {
	it("resetMockWifiFaults clears every knob", () => {
		setMockWifiFaults({
			deviceBusy: true,
			savedConnectFails: true,
			connectNewAuthFails: true,
			suppressConfirm: true,
		});
		resetMockWifiFaults();
		expect(getMockWifiFaults()).toEqual({
			savedConnectFails: false,
			connectNewAuthFails: false,
			deviceBusy: false,
			suppressConfirm: false,
		});
	});

	it("resetMockState restores the happy path after a fault run", async () => {
		setMockWifiFaults({ deviceBusy: true });
		resetMockState();

		const result = await call(
			wifiConnectProcedure,
			{ uuid: SAVED_UUID },
			{ context: makeContext() },
		);
		expect(result).toEqual({ success: true });
		expect(activeNetwork()).toBe(SAVED_SSID);
	});
});
