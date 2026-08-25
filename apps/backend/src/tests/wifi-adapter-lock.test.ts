/*
    F-01 + F-02 + F-10 — every WiFi mutation is serialized under ONE per-adapter
    lock, and the two layers derive that lock's key from the same function.

    Before the fix the RPC layer keyed on the adapter's registry MAC while the
    hotspot activation/stop/reconfigure transactions keyed on
    `wifiInterface.ifname` (F-02), and `wifiConnectNewProcedure` took no lock at
    all (F-01) — so an NM activation in flight and a station join could run
    concurrently against one radio with nothing refusing either.
*/

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { call } from "@orpc/server";

import { withDeviceLock } from "../modules/network/state/device-lock.ts";
import {
	getWifiState,
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import { setWifiJoinNmcliRunner } from "../modules/wifi/wifi.ts";
import {
	wifiAdapterLockKey,
	wifiAdapterLockKeyForDeviceId,
} from "../modules/wifi/wifi-adapter-lock.ts";
import { addWifiInterface } from "../modules/wifi/wifi-connections.ts";
import { startHotspotForInterface } from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	type HotspotActivationDeps,
	isHotspot,
	type WifiInterfaceWithHotspot,
} from "../modules/wifi/wifi-hotspot-types.ts";
import { getWifiIdToMacAddress } from "../modules/wifi/wifi-interfaces.ts";
import {
	hotspotStartProcedure,
	wifiConnectNewProcedure,
} from "../rpc/procedures/wifi.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const MAC = "dc:a6:32:5e:11:01";
const IFNAME = "wlan0";
const DEVICE_ID = "0";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

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

function makeInterface(): WifiInterfaceWithHotspot {
	return {
		id: 0,
		ifname: IFNAME,
		conn: null,
		hw: "Realtek RTL8852BE",
		available: new Map(),
		saved: {},
		savedAll: {},
		hotspot: { availableChannels: ["auto"], warnings: {} },
	};
}

function makeDeps(over: Partial<HotspotActivationDeps>): HotspotActivationDeps {
	return {
		nmConnect: async () => true,
		nmConnSetFields: async () => true,
		nmHotspot: async () => "hotspot-uuid",
		wifiUpdateSavedConns: async () => {},
		broadcastState: () => {},
		setDupIpSuppression: () => {},
		credentials: { get: () => undefined, remember: () => {} },
		findHotspotConn: async () => undefined,
		pruneHotspotConns: async () => {},
		...over,
	};
}

/** Every nmcli argv the station-join leg dispatched. Empty ⇒ nothing ran. */
let joinCalls: string[][] = [];
let inherited: ReturnType<typeof isolateWifiRegistry> = [];
let iface: WifiInterfaceWithHotspot;

/** `wifiNew` dispatches with `void`; let its microtask chain settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
	inherited = isolateWifiRegistry();
	iface = makeInterface();
	addWifiInterface(MAC, iface);
	getWifiIdToMacAddress()[0] = MAC;
	setWifiState({ [MAC]: { ...iface, mode: "station" } });
	onWifiChange(() => {});
	joinCalls = [];
	setWifiJoinNmcliRunner(async (args) => {
		joinCalls.push(args);
		return { stdout: "", stderr: "", exitCode: 0 };
	});
});

afterEach(() => {
	setWifiJoinNmcliRunner(null);
	delete getWifiIdToMacAddress()[0];
	setWifiState({});
	restoreWifiRegistry(inherited);
});

describe("the canonical per-adapter WiFi lock (F-02)", () => {
	test("the RPC layer and the hotspot activation layer resolve the IDENTICAL key", async () => {
		const rpcKey = wifiAdapterLockKeyForDeviceId(DEVICE_ID);
		const activationKey = wifiAdapterLockKey(MAC);

		expect(rpcKey).toBe(activationKey);
		expect(rpcKey).toBe(MAC);
		// The retired activation key was the interface name — a DIFFERENT string
		// for the same radio, which is exactly what made the guard vacuous.
		expect(rpcKey).not.toBe(iface.ifname);

		// …and BOTH CALL SITES really contend on that one key: hold it from
		// outside and each layer must refuse without touching state.
		const gate = deferred<void>();
		const held = withDeviceLock(activationKey, () => gate.promise);
		try {
			const viaRpc = await call(
				hotspotStartProcedure,
				{ device: DEVICE_ID },
				{ context: makeContext() },
			);
			expect(viaRpc).toEqual({ success: false, error: "DEVICE_BUSY" });

			const viaActivation = await startHotspotForInterface(
				MAC,
				iface,
				makeDeps({}),
			);
			expect(viaActivation).toEqual({ success: false, error: "DEVICE_BUSY" });
		} finally {
			gate.resolve();
			await held;
		}

		expect(iface.hotspot.transition).toBeUndefined();
		expect(isHotspot(iface)).toBe(false);
	});
});

describe("connectNew races a hotspot start on ONE adapter (F-01 + F-10)", () => {
	test("the second op observes the first op's terminal state, never interleaved", async () => {
		const gate = deferred<string | undefined>();
		const first = startHotspotForInterface(
			MAC,
			iface,
			makeDeps({ nmHotspot: () => gate.promise }),
		);

		// The hotspot transaction now holds the adapter. A station join dispatched
		// against the SAME radio must be refused with ZERO nmcli work.
		const refused = await call(
			wifiConnectNewProcedure,
			{ device: DEVICE_ID, ssid: "CeraNet", password: "supersecret" },
			{ context: makeContext() },
		);
		await settle();
		expect(refused).toEqual({ success: false, error: "DEVICE_BUSY" });
		expect(joinCalls).toEqual([]);

		// Let the hotspot transaction reach its terminal state (activation fails,
		// so it rolls the adapter back to station and releases the lock).
		gate.resolve(undefined);
		const firstResult = await first;
		expect(firstResult).toEqual({
			success: false,
			error: "activation-failed",
		});

		const admitted = await call(
			wifiConnectNewProcedure,
			{ device: DEVICE_ID, ssid: "CeraNet", password: "supersecret" },
			{ context: makeContext() },
		);
		await settle();
		expect(admitted).toEqual({ success: true });
		expect(joinCalls.length).toBeGreaterThan(0);

		// The second op ran strictly AFTER the first settled: the rollback is
		// fully applied and no transition is left mid-flight.
		expect(iface.hotspot.transition).toBeUndefined();
		expect(iface.conn).toBeNull();
		expect(isHotspot(iface)).toBe(false);
		expect(getWifiState()[MAC]?.mode).toBe("station");
	});
});
