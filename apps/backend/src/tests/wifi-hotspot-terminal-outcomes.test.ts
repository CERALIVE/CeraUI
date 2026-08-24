/*
    F-03 + F-07 — a hotspot start/stop never claims success before NetworkManager
    has confirmed it, and EVERY exit path ends in a terminal `wifi` frame.

    Before the fix `hotspotStartProcedure` dispatched with `void` inside its own
    `runGuarded` and answered `{success:true}` unconditionally. That was wrong
    twice over: the reply was fabricated, and — because the RPC layer and the
    transaction acquire the SAME canonical adapter key — the outer lock was still
    held when the transaction reached `withDeviceLock`, so on a real device every
    start refused ITSELF with DEVICE_BUSY underneath a success reply.

    The frames matter as much as the replies: an outcome that resolves after the
    reply (the bounded NM confirmation) has no reply left to carry it, so without
    a terminal frame the operator's keyed op could only expire on its TTL.
*/

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { wifiMessageSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { withDeviceLock } from "../modules/network/state/device-lock.ts";
import {
	getWifiState,
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import { handleWifi, setWifiJoinNmcliRunner } from "../modules/wifi/wifi.ts";
import { wifiAdapterLockKey } from "../modules/wifi/wifi-adapter-lock.ts";
import { addWifiInterface } from "../modules/wifi/wifi-connections.ts";
import { wifiHotspotStart } from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	type HotspotStopDeps,
	wifiHotspotStop,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { handleWifiMonitorEvent } from "../modules/wifi/wifi-hotspot-monitor.ts";
import type {
	HotspotOutcomeKind,
	HotspotToggleOutcome,
} from "../modules/wifi/wifi-hotspot-outcome.ts";
import type {
	HotspotActivationDeps,
	WifiInterfaceWithHotspot,
} from "../modules/wifi/wifi-hotspot-types.ts";
import {
	getWifiIdToMacAddress,
	type WifiInterface,
} from "../modules/wifi/wifi-interfaces.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { hotspotStartProcedure } from "../rpc/procedures/wifi.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const MAC = "dc:a6:32:7e:01:01";
const DEVICE_ID = "0";

type PublishedOutcome = {
	kind: HotspotOutcomeKind;
	device: number | string;
	outcome: HotspotToggleOutcome;
};

/** Every terminal frame the transaction published, in order. */
let published: PublishedOutcome[] = [];

const capture = (
	kind: HotspotOutcomeKind,
	device: number | string,
	outcome: HotspotToggleOutcome,
) => {
	published.push({ kind, device, outcome });
};

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

function makeHotspotIface(ifname = "wlan0"): WifiInterfaceWithHotspot {
	return {
		id: 0,
		ifname,
		conn: null,
		hw: "Realtek RTL8852BE",
		available: new Map(),
		saved: {},
		savedAll: {},
		hotspot: { availableChannels: ["auto"], warnings: {} },
	};
}

function makeStartDeps(
	over: Partial<HotspotActivationDeps>,
): HotspotActivationDeps {
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
		publishOutcome: capture,
		...over,
	};
}

function makeStopDeps(over: Partial<HotspotStopDeps>): HotspotStopDeps {
	return {
		nmConnSetFields: async () => true,
		nmDisconnect: async () => true,
		releaseConcurrentInterface: async () => {},
		broadcastState: () => {},
		setDupIpSuppression: () => {},
		rescan: async () => true,
		publishOutcome: capture,
		...over,
	};
}

let inherited: ReturnType<typeof isolateWifiRegistry> = [];

function seed(iface: WifiInterface): void {
	addWifiInterface(MAC, iface);
	getWifiIdToMacAddress()[0] = MAC;
	setWifiState({ [MAC]: { ...iface, mode: "station" } });
}

beforeEach(() => {
	inherited = isolateWifiRegistry();
	published = [];
	onWifiChange(() => {});
});

afterEach(() => {
	setWifiJoinNmcliRunner(null);
	delete getWifiIdToMacAddress()[0];
	setWifiState({});
	restoreWifiRegistry(inherited);
});

describe("hotspot start — a failure is typed, and every path is terminal", () => {
	test("an NM activation failure returns `activation-failed` AND publishes it", async () => {
		const iface = makeHotspotIface();
		seed(iface);

		const result = await wifiHotspotStart(
			{ device: 0 },
			makeStartDeps({ nmHotspot: async () => undefined }),
		);

		expect(result).toEqual({ success: false, error: "activation-failed" });
		expect(published).toEqual([
			{
				kind: "start",
				device: 0,
				outcome: { success: false, error: "activation-failed" },
			},
		]);
		// The rollback really ran: the adapter is still a station.
		expect(iface.hotspot.transition).toBeUndefined();
		expect(getWifiState()[MAC]?.mode).toBe("station");
	});

	test("a capability refusal is typed `unsupported`, not a silent success", async () => {
		seed({
			id: 0,
			ifname: "wlan0",
			conn: null,
			hw: "No-AP Adapter",
			available: new Map(),
			saved: {},
			savedAll: {},
		} as unknown as WifiInterface);

		const nmCalls: string[] = [];
		const result = await wifiHotspotStart(
			{ device: 0 },
			makeStartDeps({
				nmHotspot: async () => {
					nmCalls.push("nmHotspot");
					return "hotspot-uuid";
				},
			}),
		);

		expect(result).toEqual({ success: false, error: "unsupported" });
		expect(published).toEqual([
			{
				kind: "start",
				device: 0,
				outcome: { success: false, error: "unsupported" },
			},
		]);
		// A refusal must dispatch nothing at the radio.
		expect(nmCalls).toEqual([]);
	});

	test("an unresolvable adapter is typed `no-device`", async () => {
		const result = await wifiHotspotStart({ device: 7 }, makeStartDeps({}));

		expect(result).toEqual({ success: false, error: "no-device" });
		expect(published).toEqual([
			{
				kind: "start",
				device: 7,
				outcome: { success: false, error: "no-device" },
			},
		]);
	});

	test("a held adapter is typed DEVICE_BUSY", async () => {
		seed(makeHotspotIface());

		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const held = withDeviceLock(wifiAdapterLockKey(MAC), () => gate);

		try {
			const result = await wifiHotspotStart({ device: 0 }, makeStartDeps({}));
			expect(result).toEqual({ success: false, error: "DEVICE_BUSY" });
			expect(published).toEqual([
				{
					kind: "start",
					device: 0,
					outcome: { success: false, error: "DEVICE_BUSY" },
				},
			]);
		} finally {
			release();
			await held;
		}
	});
});

describe("hotspot start — the accepted path is settled by a LATER frame", () => {
	test("an activation NM never confirms publishes `not-confirmed`", async () => {
		const iface = makeHotspotIface("wlan1");
		seed(iface);

		// Collapse the bounded confirmation backoff so the whole window elapses
		// inside the test, standing in for "advance time ~12s".
		const realSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void) => {
			fn();
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof globalThis.setTimeout;

		try {
			const result = await wifiHotspotStart(
				{ device: 0 },
				makeStartDeps({
					wifiUpdateSavedConns: async () => {
						iface.hotspot.conn = "hotspot-uuid";
					},
					pollHotspotActive: async () => false,
				}),
			);

			// Admitted, NOT confirmed — and deliberately not published yet.
			expect(result).toEqual({ success: true });
			expect(published).toEqual([]);

			await Promise.resolve();
			await Promise.resolve();
			await new Promise((r) => realSetTimeout(r, 0));

			expect(published).toEqual([
				{
					kind: "start",
					device: 0,
					outcome: { success: false, error: "not-confirmed" },
				},
			]);
			expect(getWifiState()[MAC]?.mode).toBe("station");
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}
	});

	test("an NM-confirmed activation publishes success exactly once", async () => {
		const iface = makeHotspotIface("wlan2");
		seed(iface);

		const result = await wifiHotspotStart(
			{ device: 0 },
			makeStartDeps({
				wifiUpdateSavedConns: async () => {
					iface.hotspot.conn = "hotspot-uuid";
				},
			}),
		);
		expect(result).toEqual({ success: true });
		expect(published).toEqual([]);

		handleWifiMonitorEvent({
			type: "connection-state",
			connection: iface.hotspot.name ?? "",
			state: "activated",
		});

		expect(published).toEqual([
			{ kind: "start", device: 0, outcome: { success: true } },
		]);
		expect(getWifiState()[MAC]?.mode).toBe("hotspot");
	});
});

describe("hotspot stop — typed outcomes", () => {
	test("NetworkManager refusing the disconnect is `deactivation-failed`", async () => {
		const iface = makeHotspotIface("wlan3");
		iface.hotspot.conn = "hotspot-uuid";
		iface.conn = "hotspot-uuid";
		seed(iface);

		const result = await wifiHotspotStop(
			{ device: 0 },
			makeStopDeps({ nmDisconnect: async () => false }),
		);

		expect(result).toEqual({ success: false, error: "deactivation-failed" });
		expect(published).toEqual([
			{
				kind: "stop",
				device: 0,
				outcome: { success: false, error: "deactivation-failed" },
			},
		]);
	});

	test("a radio already in station mode is an idempotent success", async () => {
		seed(makeHotspotIface("wlan4"));

		const disconnects: string[] = [];
		const result = await wifiHotspotStop(
			{ device: 0 },
			makeStopDeps({
				nmDisconnect: async (uuid: string) => {
					disconnects.push(uuid);
					return true;
				},
			}),
		);

		expect(result).toEqual({ success: true });
		expect(published).toEqual([
			{ kind: "stop", device: 0, outcome: { success: true } },
		]);
		expect(disconnects).toEqual([]);
	});
});

describe("the RPC caller receives the typed outcome (F-03)", () => {
	test("hotspotStart no longer fabricates success over a refusal", async () => {
		seed({
			id: 0,
			ifname: "wlan0",
			conn: null,
			hw: "No-AP Adapter",
			available: new Map(),
			saved: {},
			savedAll: {},
		} as unknown as WifiInterface);

		const received: string[] = [];
		const client = captureClient(received);
		addClient(client);

		try {
			const result = await call(
				hotspotStartProcedure,
				{ device: DEVICE_ID },
				{ context: makeContext() },
			);
			expect(result).toEqual({ success: false, error: "unsupported" });

			const frames = received
				.map((raw) => JSON.parse(raw) as { wifi?: unknown })
				.filter((obj) => obj.wifi !== undefined)
				.map((obj) => obj.wifi);

			const parsed = wifiMessageSchema.safeParse(frames[frames.length - 1]);
			expect(parsed.success).toBe(true);
			// Keyed on the NUMERIC adapter id, exactly as the transaction's own
			// frames are — the wire string is a transport detail of the request.
			expect(frames).toContainEqual({
				hotspot: { start: { device: 0, error: "unsupported" } },
			});
		} finally {
			removeClient(client);
		}
	});
});

describe("a station join that resolves no connection is terminal (F-07)", () => {
	test("`runWifiNew` emits an `ambiguous` frame instead of returning in silence", async () => {
		seed(makeHotspotIface());

		// nmcli exits 0 and prints nothing a uuid can be read out of — the exact
		// `ok: true, uuid: undefined` shape that used to log and return.
		setWifiJoinNmcliRunner(async () => ({
			stdout: "",
			stderr: "",
			exitCode: 0,
		}));

		const sent: string[] = [];
		const conn = {
			data: { isAuthenticated: true, lastActive: Date.now() },
			send: (message: string) => sent.push(message),
		} as unknown as AppWebSocket;

		handleWifi(conn, {
			new: { device: 0, ssid: "CeraNet", password: "supersecret" },
		});
		for (let i = 0; i < 20; i++) await Promise.resolve();

		const frames = sent
			.map((raw) => JSON.parse(raw) as { wifi?: unknown })
			.filter((obj) => obj.wifi !== undefined)
			.map((obj) => obj.wifi);

		expect(frames).toContainEqual({
			new: { error: "ambiguous", device: 0 },
		});
		expect(wifiMessageSchema.safeParse(frames[0]).success).toBe(true);
	});

	test("an unresolvable adapter answers rather than going quiet", async () => {
		const sent: string[] = [];
		const conn = {
			data: { isAuthenticated: true, lastActive: Date.now() },
			send: (message: string) => sent.push(message),
		} as unknown as AppWebSocket;

		handleWifi(conn, {
			new: { device: 9, ssid: "CeraNet", password: "supersecret" },
		});
		for (let i = 0; i < 20; i++) await Promise.resolve();

		const frames = sent
			.map((raw) => JSON.parse(raw) as { wifi?: unknown })
			.filter((obj) => obj.wifi !== undefined)
			.map((obj) => obj.wifi);

		expect(frames).toContainEqual({ new: { error: "generic", device: 9 } });
	});
});
