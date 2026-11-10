import { afterEach, expect, test } from "bun:test";
import { wifiStatusSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import {
	getMockState,
	initMockService,
	resetMockState,
	setMockWifiConnection,
	stopMockService,
} from "../mocks/mock-service.ts";
import { getMockHotspotConfig } from "../mocks/providers/wifi.ts";
import { getMockWifiIncarnation } from "../mocks/providers/wifi-incarnation.ts";
import { broadcastWifiState, wifiBuildMsg } from "../modules/wifi/wifi.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { devRebindWifiProcedure } from "../rpc/procedures/dev.procedure.ts";
import { getWifiStatusProcedure } from "../rpc/procedures/wifi.procedure.ts";
import { wifiProtocolContext } from "./helpers/wifi-protocol-context.ts";

const originalMode = process.env.MOCK_MODE;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
	resetMockState();
	stopMockService();
	if (originalMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = originalMode;
	if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = originalNodeEnv;
});

test("mock status and local status bytes retain only the additive incarnation field", async () => {
	process.env.MOCK_MODE = "true";
	initMockService("multi-modem-wifi");
	const received: string[] = [];
	const context = wifiProtocolContext((frame) => received.push(frame));
	const before = wifiBuildMsg();
	expect(wifiStatusSchema.parse(before)).toStrictEqual(before);
	expect(
		await call(getWifiStatusProcedure, undefined, { context }),
	).toStrictEqual(before);
	addClient(context.ws);
	try {
		broadcastWifiState();
	} finally {
		removeClient(context.ws);
	}
	expect(received).toHaveLength(1);
	const frame = JSON.parse(received[0] ?? "");
	expect(received[0]).toBe(
		JSON.stringify({ status: { wifi: before }, seq: frame.seq }),
	);
	for (const row of Object.values(before)) {
		expect(row.incarnation).toEqual(expect.any(String));
		const { incarnation, ...legacy } = row;
		expect(
			Buffer.byteLength(JSON.stringify(row)) -
				Buffer.byteLength(JSON.stringify(legacy)),
		).toBe(53);
		expect(incarnation).toHaveLength(36);
	}
});

test("mock tokens survive connection and mode changes; rebind rotates only the selected token", async () => {
	process.env.MOCK_MODE = "true";
	initMockService("multi-modem-wifi");
	const context = wifiProtocolContext();
	const first = wifiBuildMsg();
	setMockWifiConnection("wlan0", { activeNetwork: "Office_Secure" });
	getMockState().wifiModes.wlan0 = "hotspot";
	expect(wifiBuildMsg()[0]?.incarnation).toBe(first[0]?.incarnation);
	const before = wifiBuildMsg();
	const credentials = structuredClone(getMockHotspotConfig("wlan0"));
	expect(
		await call(devRebindWifiProcedure, { device: "0" }, { context }),
	).toEqual({ success: true });
	const after = wifiBuildMsg();
	expect(after[0]?.incarnation).not.toBe(before[0]?.incarnation);
	expect(after[1]).toStrictEqual(before[1]);
	const { incarnation: _old, ...oldRow } = before[0] ?? {};
	const { incarnation: _new, ...newRow } = after[0] ?? {};
	expect(newRow).toStrictEqual(oldRow);
	expect(getMockHotspotConfig("wlan0")).toStrictEqual(credentials);
	resetMockState();
	expect(after[0]?.incarnation).not.toBe(getMockWifiIncarnation("wlan0"));
});

for (const production of [false, true]) {
	test(`mock rebind refuses invalid devices and production=${production}`, async () => {
		process.env.MOCK_MODE = "true";
		initMockService("multi-modem-wifi");
		const before = wifiBuildMsg();
		const context = wifiProtocolContext();
		if (production) process.env.NODE_ENV = "production";
		else {
			process.env.NODE_ENV = "test";
			process.env.MOCK_MODE = "false";
		}
		expect(
			await call(devRebindWifiProcedure, { device: "0" }, { context }),
		).toEqual({ success: false });
		expect(before[0]?.incarnation).toBe(getMockWifiIncarnation("wlan0"));
		process.env.MOCK_MODE = "true";
		expect(
			await call(devRebindWifiProcedure, { device: "missing" }, { context }),
		).toEqual({ success: false });
	});
}
