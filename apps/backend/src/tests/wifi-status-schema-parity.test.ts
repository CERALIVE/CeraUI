/*
 * T4 — wifi.getStatus output-validation parity (ceraui-dev-parity-ux-pass).
 *
 * Locks the fix for the reproduced "Output validation failed" warning on
 * wifi.getStatus / status.getStatus: the mock scan rows carry nmcli-style
 * SECURITY tokens ("WPA2-Personal", "Open", "WPA2-Enterprise", …) that the old
 * z.enum(['WEP','WPA','WPA2','WPA3']) rejected. The output schema is now the
 * free-form string the backend actually emits, so the real procedure output
 * validates. Reverting wifiSecuritySchema to the enum makes both tests fail.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { wifiStatusSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { getWifiStatusProcedure } from "../rpc/procedures/wifi.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const SCENARIO = "multi-modem-wifi";
const ORIGINAL_MOCK_MODE = process.env.MOCK_MODE;

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

beforeAll(() => {
	process.env.MOCK_MODE = "true";
	initMockService(SCENARIO);
});

afterAll(() => {
	stopMockService();
	if (ORIGINAL_MOCK_MODE === undefined) {
		delete process.env.MOCK_MODE;
	} else {
		process.env.MOCK_MODE = ORIGINAL_MOCK_MODE;
	}
});

describe("wifi.getStatus output-validation parity", () => {
	it("returns a payload that passes its own output schema (no Output validation failed)", async () => {
		const result = await call(getWifiStatusProcedure, undefined, {
			context: makeContext(),
		});

		const parsed = wifiStatusSchema.safeParse(result);
		expect(parsed.success).toBe(true);
	});

	it("accepts the nmcli-style security tokens the mock scan emits", () => {
		for (const security of ["WPA2-Personal", "Open", "WPA2-Enterprise", ""]) {
			const network = {
				"0": {
					ifname: "wlan0",
					conn: "",
					hw: "AA:BB:CC:DD:EE:00",
					saved: {},
					supports_hotspot: true,
					available: [
						{ active: false, ssid: "Net", signal: 60, security, freq: 5180 },
					],
				},
			};
			expect(wifiStatusSchema.safeParse(network).success).toBe(true);
		}
	});
});
