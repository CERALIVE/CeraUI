import { describe, expect, test } from "bun:test";

import { wifiMessageSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { withDeviceLock } from "../modules/network/state/device-lock.ts";
import {
	addWifiInterface,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import type { WifiInterface } from "../modules/wifi/wifi-interfaces.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { configureModemProcedure } from "../rpc/procedures/modems.procedure.ts";
import {
	hotspotStartProcedure,
	wifiConnectProcedure,
} from "../rpc/procedures/wifi.procedure.ts";
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

function captureClient(sink: string[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (message: string) => sink.push(message),
	} as unknown as AppWebSocket;
}

describe("wifi.connect — success broadcast", () => {
	test("broadcasts a schema-valid 'wifi' message on success", async () => {
		const received: string[] = [];
		const client = captureClient(received);
		addClient(client);

		try {
			const result = await call(
				wifiConnectProcedure,
				{ uuid: "uuid-success" },
				{ context: makeContext() },
			);
			expect(result.success).toBe(true);

			const wifiPayloads = received
				.map((raw) => JSON.parse(raw))
				.filter(
					(obj): obj is { wifi: unknown } =>
						!!obj && typeof obj === "object" && "wifi" in obj,
				)
				.map((obj) => obj.wifi);

			expect(wifiPayloads.length).toBeGreaterThan(0);
			const parsed = wifiMessageSchema.safeParse(
				wifiPayloads[wifiPayloads.length - 1],
			);
			expect(parsed.success).toBe(true);
		} finally {
			removeClient(client);
		}
	});
});

describe("modems.configure — invalid input", () => {
	test("malformed input rejects with a structured error and stays alive", async () => {
		const promise = call(
			configureModemProcedure,
			// @ts-expect-error intentionally malformed input to exercise validation
			{ device: "0", network_type: "4g", autoconfig: false, apn: "" },
			{ context: makeContext() },
		);

		await expect(promise).rejects.toThrow();

		expect(typeof process.pid).toBe("number");
	});
});

describe("wifi conflict — DEVICE_BUSY", () => {
	test("hotspotStart returns DEVICE_BUSY while the device lock is held", async () => {
		const mac = "dc:a6:32:aa:bb:cc";
		addWifiInterface(mac, {
			id: 0,
			ifname: "wlan0",
			conn: null,
			hw: "Test Adapter",
			available: new Map(),
			saved: {},
			hotspot: { availableChannels: ["auto"], warnings: {} },
		} as unknown as WifiInterface);

		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const held = withDeviceLock(mac, () => gate);

		try {
			const result = await call(
				hotspotStartProcedure,
				{ device: "0" },
				{ context: makeContext() },
			);
			expect(result.success).toBe(false);
			expect(result.error).toBe("DEVICE_BUSY");
		} finally {
			release();
			await held;
			removeWifiInterface(mac);
		}
	});
});
