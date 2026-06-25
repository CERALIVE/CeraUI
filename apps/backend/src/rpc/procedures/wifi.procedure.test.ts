import { afterEach, describe, expect, test } from "bun:test";

import { call } from "@orpc/server";

import { withDeviceLock } from "../../modules/network/state/device-lock.ts";
import {
	addWifiInterface,
	removeWifiInterface,
} from "../../modules/wifi/wifi-connections.ts";
import type { WifiInterface } from "../../modules/wifi/wifi-interfaces.ts";
import type { AppWebSocket, RPCContext } from "../types.ts";
import { hotspotConfigureProcedure } from "./wifi.procedure.ts";

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

function seedInterface(mac: string): void {
	addWifiInterface(mac, {
		id: 0,
		ifname: "wlan0",
		conn: null,
		hw: "Test Adapter",
		available: new Map(),
		saved: {},
		hotspot: { availableChannels: ["auto"], warnings: {} },
	} as unknown as WifiInterface);
}

const validConfig = {
	device: "0",
	name: "CERALIVE_TEST",
	password: "supersecret",
	channel: "auto",
};

describe("wifi.hotspotConfigure — device lock (S5)", () => {
	let seededMac: string | undefined;

	afterEach(() => {
		if (seededMac) removeWifiInterface(seededMac);
		seededMac = undefined;
	});

	test("returns DEVICE_BUSY while the interface lock is held by another op", async () => {
		const mac = "dc:a6:32:de:ad:01";
		seededMac = mac;
		seedInterface(mac);

		// A concurrent op holds the per-interface lock until we release the gate.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const held = withDeviceLock(mac, () => gate);

		try {
			const result = await call(hotspotConfigureProcedure, validConfig, {
				context: makeContext(),
			});
			expect(result.success).toBe(false);
			expect(result.error).toBe("DEVICE_BUSY");
		} finally {
			release();
			await held;
		}
	});

	test("acquires the lock and succeeds once the prior op releases it", async () => {
		const mac = "dc:a6:32:de:ad:02";
		seededMac = mac;
		seedInterface(mac);

		const result = await call(hotspotConfigureProcedure, validConfig, {
			context: makeContext(),
		});
		expect(result.success).toBe(true);
	});
});
