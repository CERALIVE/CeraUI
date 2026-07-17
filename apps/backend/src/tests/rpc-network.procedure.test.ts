import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { wifiMessageSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { updateNetif } from "../modules/network/network-interfaces.ts";
import { withDeviceLock } from "../modules/network/state/device-lock.ts";
import {
	addWifiInterface,
	getWifiInterfaceByMacAddress,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import type { WifiInterface } from "../modules/wifi/wifi-interfaces.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { configureModemProcedure } from "../rpc/procedures/modems.procedure.ts";
import { configureNetworkInterfaceProcedure } from "../rpc/procedures/network.procedure.ts";
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

describe("network.configure — mock immediate netif broadcast (Issue 2)", () => {
	// The mock ifconfig lists wlan0, so updateNetif() schedules a detached
	// setTimeout(wifiUpdateDevices, 1000) that registers this adapter into the
	// process-wide interface registry ~1s later. Drain + evict it in afterAll (see
	// below) so it can't fire inside a LATER mock suite and leak into every
	// following file's shared registry.
	const MOCK_WIFI_MAC = "dc:a6:32:12:34:57";
	let priorMockMode: string | undefined;

	beforeAll(() => {
		priorMockMode = process.env.MOCK_MODE;
		process.env.MOCK_MODE = "true";
		initMockService("multi-modem-wifi");
		// Seed the legacy netif map from the mock ifconfig so netIfBuildMsg has
		// eth0 to overlay the mock enabled flag onto.
		updateNetif();
	});

	afterAll(async () => {
		// Let the pending wifiUpdateDevices timer fire while mocks are still on,
		// then evict the adapter it registered before restoring the environment.
		for (let i = 0; i < 80; i++) {
			if (getWifiInterfaceByMacAddress(MOCK_WIFI_MAC)) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		removeWifiInterface(MOCK_WIFI_MAC);
		stopMockService();
		if (priorMockMode === undefined) {
			delete process.env.MOCK_MODE;
		} else {
			process.env.MOCK_MODE = priorMockMode;
		}
	});

	test("disabling a netif interface broadcasts the overlaid state at once, not on the 5s poll", async () => {
		const received: string[] = [];
		const client = captureClient(received);
		addClient(client);

		try {
			await call(
				configureNetworkInterfaceProcedure,
				{ name: "eth0", enabled: false },
				{ context: makeContext() },
			);

			const netifPayloads = received
				.map((raw) => JSON.parse(raw))
				.filter(
					(obj): obj is { netif: Record<string, { enabled?: boolean }> } =>
						!!obj && typeof obj === "object" && "netif" in obj,
				)
				.map((obj) => obj.netif);

			// Without the fix, handleNetif's IP-match guard early-returns in mock
			// mode and no netif frame fires during the call — the toggle would only
			// surface on the next poll.
			expect(netifPayloads.length).toBeGreaterThan(0);
			expect(netifPayloads[netifPayloads.length - 1]?.eth0?.enabled).toBe(
				false,
			);
		} finally {
			removeClient(client);
		}
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
