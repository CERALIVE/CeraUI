import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import * as runner from "../helpers/run.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	getNetworkInterfaces,
	handleNetifMonitorEvent,
	parseIpAddrShow,
	processIfconfigOutput,
	resetNetifSnapshotForTest,
} from "../modules/network/network-interfaces.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { UplinkSteeringApplier } from "../modules/network/uplink-steering/applier.ts";
import type { UplinkFlowsResetEvent } from "../modules/network/uplink-steering/contracts.ts";
import { UplinkSteeringCoordinator } from "../modules/network/uplink-steering/coordinator.ts";
import * as routes from "../modules/network/uplink-steering/route-manager.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";
import { readDesiredSteeringState } from "../modules/network/uplink-steering/state-builder.ts";
import {
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import {
	resetWifiCapabilitiesForTest,
	setWifiCapabilityDepsForTest,
} from "../modules/wifi/wifi-capabilities.ts";
import {
	concurrentApIfname,
	wifiInterfaceReaders,
} from "../modules/wifi/wifi-concurrent-interface.ts";
import {
	addWifiInterface,
	clearWifiInterfacesForTest,
	getWifiInterfaceByMacAddress,
	getWifiInterfacesByMacAddress,
	wifiCancelScanRefresh,
} from "../modules/wifi/wifi-connections.ts";
import * as hotspotDiscovery from "../modules/wifi/wifi-hotspot-discovery.ts";
import {
	resetWifiConnectionModeCache,
	resetWifiInterfaceDiscoveryForTest,
	wifiUpdateDevices,
	wifiZonesReady,
} from "../modules/wifi/wifi-interfaces.ts";
import { setPermanentMacReaderForTest } from "../modules/wifi/wifi-permanent-mac.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
import * as compat from "../rpc/compat.ts";
import { constructedTwinDeps } from "./helpers/constructed-usb-twins.ts";

const mac = "02:00:00:00:00:01";
const ap = "test-ap-profile";
const wifiIfnames = ["wlan0", "wlx020000000001", "wlp1s0"] as const;
const snapshot = [
	"wlan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>",
	"        inet 10.42.0.1  netmask 255.255.255.0",
	`        ether ${mac}`,
	"",
	"wwu1c2: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>",
	"        inet 100.64.1.2  netmask 255.255.255.0",
].join("\n");
let coordinator: UplinkSteeringCoordinator | undefined;

beforeEach(async () => {
	spyOn(wifiInterfaceReaders, "pathExists").mockReturnValue(false);
	jest.useFakeTimers();
	jest.setSystemTime(0);
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	wifiRadioObservation.reopenForTest();
	resetWifiInterfaceDiscoveryForTest();
	resetWifiConnectionModeCache();
	await wifiRadioIdentity.discover([]);
	clearWifiInterfacesForTest();
	resetUsbNetMarkers();
	processIfconfigOutput(snapshot);
	await refreshUsbNetMarkers(["wlan0", "wwu1c2"], constructedTwinDeps());
	addWifiInterface(mac, {
		id: 0,
		ifname: "wlan0",
		conn: null,
		hw: "Test radio",
		available: new Map(),
		saved: {},
		savedAll: {},
		hotspot: { warnings: {}, availableChannels: ["auto"] },
	});
	onWifiChange(() => undefined);
	setWifiState({});
	setPermanentMacReaderForTest(async () => mac);
	spyOn(nm, "nmDevices").mockResolvedValue([`wlan0:wifi:connected:${ap}`]);
	spyOn(nm, "nmConnGetFields").mockResolvedValue(["ap"]);
	spyOn(hotspotDiscovery, "handleHotspotConn").mockResolvedValue(undefined);
	spyOn(nm, "nmScanResults").mockResolvedValue([""]);
	spyOn(nm, "nmConnsGet").mockResolvedValue([""]);
	spyOn(runner, "run").mockRejectedValue(
		new Error("Unfaked readiness command"),
	);
	spyOn(compat, "broadcastMsg").mockImplementation(() => undefined);
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) =>
		path.endsWith("/ifindex") ? "3" : path.endsWith("/index") ? "0" : mac,
	);
	spyOn(radioIdentityReaders, "realpath").mockResolvedValue(
		"/sys/devices/radio/phy0",
	);
	setWifiCapabilityDepsForTest({
		runIw: async () => "",
		readPhyName: async () => undefined,
		pathExists: async () => false,
		readNmcliWifiProperties: async () => new Map(),
		now: () => Date.now(),
	});
});

afterEach(async () => {
	coordinator?.stop();
	coordinator = undefined;
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	wifiCancelScanRefresh();
	resetWifiInterfaceDiscoveryForTest();
	resetWifiConnectionModeCache();
	resetWifiCapabilitiesForTest();
	setPermanentMacReaderForTest(null);
	await wifiRadioIdentity.discover([]);
	clearWifiInterfacesForTest();
	resetUsbNetMarkers();
	processIfconfigOutput("");
	resetNetifSnapshotForTest();
	jest.restoreAllMocks();
	jest.useRealTimers();
});

async function useWifiIfname(ifname: string) {
	const wifi = getWifiInterfaceByMacAddress(mac);
	if (!wifi) throw new Error("Missing fixture radio");
	wifi.ifname = ifname;
	processIfconfigOutput(snapshot.replace("wlan0", ifname));
	await refreshUsbNetMarkers([ifname, "wwu1c2"], constructedTwinDeps());
	spyOn(nm, "nmDevices").mockResolvedValue([`${ifname}:wifi:connected:${ap}`]);
}

function recovered() {
	const identity = resolveModemPhysicalIdentity("wwu1c2").identityKey;
	const effects: string[] = [];
	const deadlines: Array<() => Promise<void>> = [];
	const canceled: boolean[] = [];
	const applier = new UplinkSteeringApplier({
		discoverRoutes: async () => [
			{
				identity,
				mark: stableUplinkMark(identity),
				ifname: "wwu1c2",
				sourceAddress: "100.64.1.2",
				table: "30001",
				managed: false,
			},
		],
		ensureRoute: async (route) => ({ route, changed: false }),
		rollbackRoute: async () => {
			effects.push("rollback");
		},
		removeRoute: async () => {
			effects.push("remove");
		},
		applyRuleset: async () => {
			effects.push("ruleset");
		},
		deactivateSharing: async () => {
			effects.push("deactivate");
		},
		flushConntrack: async () => {
			effects.push("flush");
		},
		setIpForwarding: async () => {},
		publishFlowsReset: () => {},
	});
	spyOn(routes, "planUplinkRoute").mockImplementation(async (candidate) => ({
		...candidate,
		table: "30001",
		managed: false,
	}));
	const controller = new UplinkSteeringCoordinator({
		readDesiredState: (context) => readDesiredSteeringState(undefined, context),
		apply: (previous, next) => applier.apply(previous, next),
		retryCleanup: () => applier.retryPendingCleanup(),
		publishAvailability: () => {},
		now: () => Date.now(),
		schedule: (fire, delay) => {
			expect(delay).toBe(15_000);
			const index = deadlines.length;
			canceled.push(false);
			deadlines.push(async () => {
				if (!canceled[index]) await fire();
			});
			return () => {
				canceled[index] = true;
			};
		},
	});
	coordinator = controller;
	const warn = spyOn(logger, "warn");
	const bypassWarnings = () =>
		warn.mock.calls.filter(
			(args) =>
				String(args[0]) ===
				"uplink steering Wi-Fi zones readiness deadline expired; bypassing classification",
		);
	return { controller, effects, deadlines, bypassWarnings };
}

test.each(
	wifiIfnames.flatMap((ifname) =>
		(
			[
				"nmcli failure",
				"unknown AP mode",
				"skipped device",
				"per-device error",
			] as const
		).map((failure) => ({ ifname, failure })),
	),
)(
	"$ifname recovered sharing survives $failure until the single 15 second bypass",
	async ({ ifname, failure }) => {
		await useWifiIfname(ifname);
		if (failure === "nmcli failure")
			spyOn(nm, "nmDevices").mockResolvedValue(undefined);
		if (failure === "unknown AP mode")
			spyOn(nm, "nmConnGetFields").mockResolvedValue(undefined);
		if (failure === "skipped device")
			spyOn(nm, "nmDevices").mockResolvedValue([]);
		if (failure === "per-device error")
			spyOn(nm, "nmConnGetFields").mockRejectedValue(
				new Error("mode read failed"),
			);
		const h = recovered();
		await h.controller.requestReconcile();
		await wifiUpdateDevices();
		expect(wifiZonesReady()).toBe(false);
		jest.advanceTimersByTime(14_900);
		await h.controller.requestReconcile();
		expect(h.effects).toEqual([]);
		expect(h.bypassWarnings()).toHaveLength(0);
		jest.advanceTimersByTime(100);
		await h.deadlines[0]?.();
		expect(h.bypassWarnings()).toHaveLength(1);
		expect(h.effects).toEqual(["deactivate", "flush", "remove"]);
		await h.controller.requestReconcile();
		expect(h.bypassWarnings()).toHaveLength(1);
	},
);

test.each(wifiIfnames)(
	"%s failed first refresh followed by a classified AP keeps matching routes without a bypass warning",
	async (ifname) => {
		await useWifiIfname(ifname);
		const devices = spyOn(nm, "nmDevices").mockResolvedValue(undefined);
		const h = recovered();
		await h.controller.requestReconcile();
		await wifiUpdateDevices();
		await h.controller.requestReconcile();
		devices.mockResolvedValue([`${ifname}:wifi:connected:${ap}`]);
		jest.advanceTimersByTime(10_000);
		await wifiUpdateDevices();
		expect(wifiZonesReady()).toBe(true);
		await h.controller.requestReconcile();
		expect(h.effects).toEqual(["ruleset"]);
		expect(h.controller.appliedState()?.uplinks[0]?.identity).toStartWith(
			"id-path:",
		);
		jest.advanceTimersByTime(5_000);
		await h.deadlines[0]?.();
		expect(h.bypassWarnings()).toHaveLength(0);
	},
);

test("a promise-gated Wi-Fi refresh cannot publish an empty sharing state before AP classification", async () => {
	const gate = Promise.withResolvers<string[]>();
	spyOn(nm, "nmDevices").mockReturnValue(gate.promise);
	const h = recovered();
	const refreshing = wifiUpdateDevices();
	await h.controller.requestReconcile();
	expect(h.effects).toEqual([]);
	expect(getNetworkInterfaces().wlan0?.error).toBe(0);
	gate.resolve([`wlan0:wifi:connected:${ap}`]);
	await refreshing;
	await h.controller.requestReconcile();
	expect(h.effects).toEqual(["ruleset"]);
	expect(h.bypassWarnings()).toHaveLength(0);
});

test("a completed refresh with no active connection classifies the Wi-Fi device", async () => {
	spyOn(nm, "nmDevices").mockResolvedValue(["wlan0:wifi:disconnected:"]);
	await wifiUpdateDevices();
	expect(wifiZonesReady()).toBe(true);
});

test.each(wifiIfnames)(
	"%s unclassified parent waits while its clap AP remains a client zone after the bypass",
	async (ifname) => {
		await useWifiIfname(ifname);
		const virtualIfname = concurrentApIfname(ifname);
		processIfconfigOutput(
			[
				snapshot
					.replace("wlan0", ifname)
					.replace("        inet 10.42.0.1  netmask 255.255.255.0", ""),
				`${virtualIfname}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>\n        inet 10.42.0.1  netmask 255.255.255.0`,
			].join("\n\n"),
		);
		spyOn(nm, "nmDevices").mockResolvedValue(undefined);
		const h = recovered();
		await wifiUpdateDevices();
		await h.controller.requestReconcile();
		expect(wifiZonesReady()).toBe(false);
		expect(h.effects).toEqual([]);
		jest.advanceTimersByTime(15_000);
		await h.deadlines[0]?.();
		expect(h.effects).toEqual(["ruleset"]);
		expect(h.controller.appliedState()?.clientZones).toEqual([
			{ ifname: virtualIfname, ipv4Cidr: "10.42.0.0/24" },
		]);
		expect(h.bypassWarnings()).toHaveLength(1);
	},
);

test("a clap AP without a parent netif needs no station classification and retains recovered sharing", async () => {
	const virtualIfname = concurrentApIfname("wlp1s0");
	processIfconfigOutput(snapshot.replace("wlan0", virtualIfname));
	spyOn(nm, "nmDevices").mockResolvedValue(undefined);
	await wifiUpdateDevices();
	const h = recovered();
	await h.controller.requestReconcile();
	expect(wifiZonesReady()).toBe(true);
	expect(h.effects).toEqual(["ruleset"]);
	expect(h.controller.appliedState()?.clientZones).toEqual([
		{ ifname: virtualIfname, ipv4Cidr: "10.42.0.0/24" },
	]);
	expect(h.bypassWarnings()).toHaveLength(0);
});

test.each([
	{ ifname: "wlwg0", type: "wireguard" },
	{ ifname: "wlvendor0", type: "ethernet" },
	{ ifname: "wlp1s0.10", type: "vlan" },
])(
	"$ifname classified as $type does not delay a known AP and recovered modem route",
	async ({ ifname, type }) => {
		processIfconfigOutput(
			`${snapshot}\n\n${ifname}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>\n        inet 172.22.0.2  netmask 255.255.255.0\n        ether 02:00:00:00:00:02`,
		);
		spyOn(nm, "nmDevices").mockResolvedValue([
			`wlan0:wifi:connected:${ap}`,
			`${ifname}:${type}:connected:other-profile`,
		]);
		const h = recovered();
		await wifiUpdateDevices();
		expect(wifiZonesReady()).toBe(true);
		await h.controller.requestReconcile();
		expect(h.effects).toEqual(["ruleset"]);
		expect(h.controller.appliedState()?.clientZones).toEqual([
			{ ifname: "wlan0", ipv4Cidr: "10.42.0.0/24" },
		]);
		expect(
			h.controller.appliedState()?.uplinks.map((entry) => entry.ifname),
		).toEqual(["wwu1c2"]);
		expect(h.deadlines).toHaveLength(0);
		expect(h.bypassWarnings()).toHaveLength(0);
	},
);

test("a known non-Wi-Fi candidate waits again while a new type listing is pending or fails", async () => {
	processIfconfigOutput(
		"wlwg0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>\n        inet 172.22.0.2  netmask 255.255.255.0",
	);
	const devices = spyOn(nm, "nmDevices").mockResolvedValue([
		"wlwg0:wireguard:connected:vpn-profile",
	]);
	await wifiUpdateDevices();
	expect(wifiZonesReady()).toBe(true);
	const gate = Promise.withResolvers<string[] | undefined>();
	devices.mockReturnValue(gate.promise);
	const refreshing = wifiUpdateDevices();
	expect(wifiZonesReady()).toBe(false);
	gate.resolve(undefined);
	await refreshing;
	expect(wifiZonesReady()).toBe(false);
});

test.each(["", "unknown"])(
	"a candidate with NM type '%s' still waits for radio classification",
	async (type) => {
		spyOn(nm, "nmDevices").mockResolvedValue([`wlan0:${type}:connected:${ap}`]);
		await wifiUpdateDevices();
		expect(wifiZonesReady()).toBe(false);
	},
);

test("discovery ignores an NM Wi-Fi device without a supported name or kernel evidence", async () => {
	processIfconfigOutput(
		`${snapshot}\n\nath0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>\n        ether 02:00:00:00:00:02`,
	);
	spyOn(nm, "nmDevices").mockResolvedValue([
		`wlan0:wifi:connected:${ap}`,
		"ath0:wifi:disconnected:",
	]);
	await wifiUpdateDevices();
	expect(
		Object.values(getWifiInterfacesByMacAddress()).map((entry) => entry.ifname),
	).toEqual(["wlan0"]);
	expect(wifiZonesReady()).toBe(true);
});

test("discovery accepts a kernel-reported radio outside wl names", async () => {
	spyOn(nm, "nmDeviceProp").mockResolvedValue([
		"Test",
		"Radio",
		"no",
		"no",
		"yes",
	]);
	spyOn(wifiInterfaceReaders, "pathExists").mockImplementation(
		(path) => path === "/sys/class/net/ath0/phy80211",
	);
	setPermanentMacReaderForTest(async (ifname) =>
		ifname === "ath0" ? "02:00:00:00:00:02" : mac,
	);
	// ath0 is its own radio: another ifindex, phy and permanent address.
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) =>
		path === "/sys/class/net/ath0/ifindex"
			? "4"
			: path.endsWith("/ifindex")
				? "3"
				: path === "/sys/devices/radio/phy1/index"
					? "1"
					: path.endsWith("/index")
						? "0"
						: path.startsWith("/sys/devices/radio/phy1/")
							? "02:00:00:00:00:02"
							: mac,
	);
	spyOn(radioIdentityReaders, "realpath").mockImplementation(async (path) =>
		path.startsWith("/sys/class/net/ath0/")
			? "/sys/devices/radio/phy1"
			: "/sys/devices/radio/phy0",
	);
	processIfconfigOutput(
		`${snapshot}\n\nath0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>\n        ether 02:00:00:00:00:02`,
	);
	spyOn(nm, "nmDevices").mockResolvedValue([
		`wlan0:wifi:connected:${ap}`,
		"ath0:wifi:disconnected:",
	]);
	await wifiUpdateDevices();
	expect(
		Object.values(getWifiInterfacesByMacAddress()).map((entry) => entry.ifname),
	).toEqual(["wlan0", "ath0"]);
	expect(wifiZonesReady()).toBe(true);
});

test("a kernel-reported radio NetworkManager has not classified yet keeps readiness pending", async () => {
	spyOn(wifiInterfaceReaders, "pathExists").mockImplementation(
		(path) => path === "/sys/class/net/ath0/phy80211",
	);
	processIfconfigOutput(
		`${snapshot}\n\nath0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>\n        ether 02:00:00:00:00:02`,
	);
	spyOn(nm, "nmDevices").mockResolvedValue([
		`wlan0:wifi:connected:${ap}`,
		"ath0:unknown:unavailable:",
	]);
	await wifiUpdateDevices();
	expect(wifiZonesReady()).toBe(false);
});

test("a radio renamed away from a wl name stays a Wi-Fi candidate by kernel evidence", async () => {
	spyOn(wifiInterfaceReaders, "pathExists").mockImplementation(
		(path) => path === "/sys/class/net/radio0/phy80211",
	);
	spyOn(nm, "nmDeviceProp").mockResolvedValue([
		"Test",
		"Radio",
		"no",
		"no",
		"yes",
	]);
	processIfconfigOutput(snapshot.replace("wlan0", "radio0"));
	spyOn(nm, "nmDevices").mockResolvedValue([`radio0:unknown:connected:${ap}`]);
	await wifiUpdateDevices();
	expect(wifiZonesReady()).toBe(false);
	spyOn(nm, "nmDevices").mockResolvedValue([`radio0:wifi:connected:${ap}`]);
	await wifiUpdateDevices();
	expect(
		Object.values(getWifiInterfacesByMacAddress()).map((entry) => entry.ifname),
	).toEqual(["radio0"]);
	expect(wifiZonesReady()).toBe(true);
});

test.each(
	["wlwg0", "wlx020000000001"].flatMap((ifname) =>
		(["disappearance", "ifindex replacement"] as const).flatMap((replacement) =>
			[false, true].map((staleRead) => ({ ifname, replacement, staleRead })),
		),
	),
)(
	"$ifname $replacement revokes non-Wi-Fi evidence with stale read $staleRead",
	async ({ ifname, replacement, staleRead }) => {
		await useWifiIfname(ifname);
		const output = snapshot.replace("wlan0", ifname);
		processIfconfigOutput(
			output,
			undefined,
			0,
			undefined,
			new Map([[ifname, 41]]),
		);
		const oldRow = `${ifname}:wireguard:connected:old-vpn`;
		const devices = spyOn(nm, "nmDevices").mockResolvedValue([oldRow]);
		await wifiUpdateDevices();
		expect(wifiZonesReady()).toBe(true);
		const gate = Promise.withResolvers<string[]>();
		devices.mockReturnValue(gate.promise);
		const refreshing = staleRead ? wifiUpdateDevices() : undefined;
		if (staleRead) expect(wifiZonesReady()).toBe(false);
		if (replacement === "disappearance")
			processIfconfigOutput(snapshot.split("\n\n").slice(1).join("\n\n"));
		processIfconfigOutput(
			output,
			undefined,
			0,
			undefined,
			new Map([[ifname, 42]]),
		);
		if (refreshing) {
			gate.resolve([oldRow]);
			await refreshing;
		}
		const h = recovered();
		await h.controller.requestReconcile();
		expect(h.effects).toEqual([]);
		expect(wifiZonesReady()).toBe(false);
		expect(await readDesiredSteeringState()).toEqual({
			pending: true,
			netifReady: true,
			reason: "zones",
		});
		expect(h.deadlines).toHaveLength(1);
		expect(h.bypassWarnings()).toHaveLength(0);
	},
);

test.each(["wlwg0", "wlx020000000001"])(
	"%s keeps its non-Wi-Fi classification through an unchanged OS lifetime",
	async (ifname) => {
		const output = `${snapshot}\n\n${ifname}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>\n        inet 172.22.0.2  netmask 255.255.255.0\n        ether 02:00:00:00:00:02`;
		const ifindices = new Map([[ifname, 41]]);
		processIfconfigOutput(output, undefined, 0, undefined, ifindices);
		spyOn(nm, "nmDevices").mockResolvedValue([
			`wlan0:wifi:connected:${ap}`,
			`${ifname}:wireguard:connected:current-vpn`,
		]);
		await wifiUpdateDevices();
		const h = recovered();
		processIfconfigOutput(output, undefined, 100, undefined, ifindices);
		await h.controller.requestReconcile();
		expect(wifiZonesReady()).toBe(true);
		expect(h.effects).toEqual(["ruleset"]);
		expect(h.controller.appliedState()?.clientZones).toEqual([
			{ ifname: "wlan0", ipv4Cidr: "10.42.0.0/24" },
		]);
		expect(h.deadlines).toHaveLength(0);
		expect(h.bypassWarnings()).toHaveLength(0);
	},
);

test.each(["wlwg0", "wlx020000000001"])(
	"%s replacement cannot inherit a previous Wi-Fi classification either",
	async (ifname) => {
		await useWifiIfname(ifname);
		const output = snapshot.replace("wlan0", ifname);
		await wifiUpdateDevices();
		processIfconfigOutput(snapshot.split("\n\n").slice(1).join("\n\n"));
		processIfconfigOutput(output);
		const h = recovered();
		await h.controller.requestReconcile();
		expect(h.effects).toEqual([]);
		expect(wifiZonesReady()).toBe(false);
	},
);

test("OS address parsing retains ifindices even before an interface has an address", () => {
	const ifindices = new Map<string, number>();
	const addresses = parseIpAddrShow(
		"41: wlx020000000001: <BROADCAST,UP> mtu 1500\n42: wlp1s0.10@wlp1s0: <BROADCAST,UP> mtu 1500",
		ifindices,
	);
	expect([...ifindices]).toEqual([
		["wlx020000000001", 41],
		["wlp1s0.10", 42],
	]);
	expect(addresses.size).toBe(0);
});

test.each(["wlwg0", "wlx020000000001"])(
	"%s type reads from a monitor placeholder cannot classify its first OS publication",
	async (ifname) => {
		processIfconfigOutput(snapshot.split("\n\n").slice(1).join("\n\n"));
		handleNetifMonitorEvent({
			type: "device-state",
			device: ifname,
			state: "connected",
		});
		const gate = Promise.withResolvers<string[]>();
		spyOn(nm, "nmDevices").mockReturnValue(gate.promise);
		const refreshing = wifiUpdateDevices();
		processIfconfigOutput(
			snapshot.replace("wlan0", ifname),
			undefined,
			0,
			undefined,
			new Map([[ifname, 42]]),
		);
		gate.resolve([`${ifname}:wireguard:connected:old-vpn`]);
		await refreshing;
		const h = recovered();
		await h.controller.requestReconcile();
		expect(h.effects).toEqual([]);
		expect(wifiZonesReady()).toBe(false);
	},
);

test.each([
	"unrelated witness",
	"current witness",
	"initial unknown",
	"replacement",
] as const)(
	"physical Wi-Fi steering survives classification uncertainty: %s",
	async (change) => {
		const permanent = "58:02:05:e1:79:1c";
		const replacement = "68:02:05:e1:79:1d";
		let changed = change === "initial unknown";
		clearWifiInterfacesForTest();
		addWifiInterface(permanent, {
			id: 0,
			ifname: "wlan0",
			conn: "station",
			hw: "Test radio",
			available: new Map(),
			saved: {},
			savedAll: {},
		});
		processIfconfigOutput(
			[
				"wlan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>",
				"        inet 192.168.2.8  netmask 255.255.255.0",
				`        ether ${permanent}`,
				"",
				"clap-clients: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>",
				"        inet 10.42.0.1  netmask 255.255.255.0",
				"        ether 02:00:00:00:00:09",
			].join("\n"),
		);
		spyOn(nm, "nmDevices").mockResolvedValue([
			"wlan0:wifi:connected:station",
			"clap-wlan0:wifi:disconnected:",
		]);
		spyOn(nm, "nmConnGetFields").mockResolvedValue(["infrastructure"]);
		spyOn(nm, "nmDeviceProp").mockResolvedValue([
			"Test",
			"Radio",
			"no",
			"no",
			"yes",
		]);
		spyOn(radioIdentityReaders, "realpath").mockImplementation(async (path) =>
			path.includes("/net/wlan0/")
				? "/sys/devices/radio/phy0"
				: "/sys/devices/radio/phy1",
		);
		spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) => {
			if (path.endsWith("/ifindex")) {
				const parent = path.includes("/net/wlan0/");
				if (
					changed &&
					((parent &&
						change !== "unrelated witness" &&
						change !== "replacement") ||
						(!parent && change === "unrelated witness"))
				)
					return undefined;
				return parent
					? changed && change === "replacement"
						? "30"
						: "3"
					: "8";
			}
			if (path.endsWith("/index")) return path.includes("/phy0/") ? "0" : "1";
			return path.includes("/phy0/")
				? changed && change === "replacement"
					? replacement
					: permanent
				: "14:ac:60:12:34:56";
		});
		setPermanentMacReaderForTest(async () =>
			changed && change === "replacement" ? replacement : permanent,
		);
		spyOn(routes, "planUplinkRoute").mockImplementation(async (candidate) => ({
			...candidate,
			table: String(30_000 + ((candidate.mark >>> 8) & 0xffff)),
			managed: true,
		}));
		const flushed: number[] = [];
		const removed: string[] = [];
		const reset: UplinkFlowsResetEvent[] = [];
		const applier = new UplinkSteeringApplier({
			discoverRoutes: async () => [],
			ensureRoute: async (route) => ({ route, changed: false }),
			rollbackRoute: async () => {},
			removeRoute: async (route) => {
				removed.push(route.table);
			},
			applyRuleset: async () => {},
			deactivateSharing: async () => {},
			flushConntrack: async (mark) => {
				flushed.push(mark);
			},
			setIpForwarding: async () => {},
			publishFlowsReset: (event) => {
				reset.push(event);
			},
		});
		coordinator = new UplinkSteeringCoordinator({
			readDesiredState: (context) =>
				readDesiredSteeringState(undefined, context),
			apply: (previous, next) => applier.apply(previous, next),
			publishAvailability: () => {},
		});
		await wifiUpdateDevices();
		await coordinator.requestReconcile();
		if (change === "initial unknown") {
			expect(await readDesiredSteeringState()).toEqual({
				pending: true,
				netifReady: true,
				reason: "identity",
			});
			expect(coordinator.appliedState()).toBeUndefined();
		} else {
			const first = coordinator.appliedState();
			expect(first?.uplinks.map((entry) => entry.identity)).toEqual([
				`wifi-mac:${permanent}`,
			]);
			expect(first?.routes.map((route) => route.table)).toEqual(["73883"]);
			const lifetime = wifiRadioIdentity.state.rows.get("wlan0")?.lifetime;
			changed = true;
			await wifiUpdateDevices();
			await coordinator.requestReconcile();
			if (change === "unrelated witness")
				expect(wifiRadioIdentity.state.rows.get("wlan0")?.lifetime).toEqual(
					lifetime,
				);
			if (change === "current witness")
				expect(
					await readDesiredSteeringState(undefined, { hasAppliedState: true }),
				).toEqual({
					pending: true,
					netifReady: true,
					reason: "identity",
				});
			expect(
				coordinator.appliedState()?.uplinks.map((entry) => entry.identity),
			).toEqual([
				`wifi-mac:${change === "replacement" ? replacement : permanent}`,
			]);
			if (change !== "replacement")
				expect(coordinator.appliedState()?.routes).toEqual(first?.routes);
		}
		expect(flushed).toEqual(change === "replacement" ? [3400231680] : []);
		expect(removed).toEqual(change === "replacement" ? ["73883"] : []);
		expect(reset.map((event) => event.iface)).toEqual(
			change === "replacement" ? ["wlan0"] : [],
		);
	},
);
