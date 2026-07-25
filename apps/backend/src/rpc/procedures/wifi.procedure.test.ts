import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { call } from "@orpc/server";

import { withDeviceLock } from "../../modules/network/state/device-lock.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
} from "../../modules/wifi/wifi-connections.ts";
import type { WifiInterface } from "../../modules/wifi/wifi-interfaces.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "../../tests/helpers/wifi-registry.ts";
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
	// An id-0 interface left in the shared registry by an earlier test file makes
	// `device: "0"` resolve to a MAC this test never locked, so the lock below
	// would guard a free device and the call would read as success.
	let inherited: ReturnType<typeof isolateWifiRegistry> = [];

	beforeEach(() => {
		inherited = isolateWifiRegistry();
	});

	afterEach(() => {
		restoreWifiRegistry(inherited);
	});

	test("returns DEVICE_BUSY while the interface lock is held by another op", async () => {
		const mac = "dc:a6:32:de:ad:01";
		seedInterface(mac);
		expect(Object.keys(getWifiInterfacesByMacAddress())).toEqual([mac]);

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
		seedInterface(mac);
		expect(Object.keys(getWifiInterfacesByMacAddress())).toEqual([mac]);

		const result = await call(hotspotConfigureProcedure, validConfig, {
			context: makeContext(),
		});
		expect(result.success).toBe(true);
	});
});
