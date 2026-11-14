import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import * as runner from "../helpers/run.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	getNetworkInterfaces,
	processIfconfigOutput,
	resetNetifSnapshotForTest,
} from "../modules/network/network-interfaces.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { UplinkSteeringApplier } from "../modules/network/uplink-steering/applier.ts";
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
	addWifiInterface,
	clearWifiInterfacesForTest,
	wifiCancelScanRefresh,
} from "../modules/wifi/wifi-connections.ts";
import * as hotspotDiscovery from "../modules/wifi/wifi-hotspot-discovery.ts";
import {
	resetWifiConnectionModeCache,
	resetWifiInterfaceDiscoveryForTest,
	wifiUpdateDevices,
	wifiZonesReady,
} from "../modules/wifi/wifi-interfaces.ts";
import {
	resetWifiPermanentMacCache,
	setPermanentMacReaderForTest,
} from "../modules/wifi/wifi-permanent-mac.ts";
import { radioIdentityReaders } from "../modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
import * as compat from "../rpc/compat.ts";
import { constructedTwinDeps } from "./helpers/constructed-usb-twins.ts";

const mac = "02:00:00:00:00:01";
const ap = "test-ap-profile";
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
	jest.useFakeTimers();
	jest.setSystemTime(0);
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	resetWifiInterfaceDiscoveryForTest();
	resetWifiConnectionModeCache();
	resetWifiPermanentMacCache();
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
	resetWifiPermanentMacCache();
	clearWifiInterfacesForTest();
	resetUsbNetMarkers();
	processIfconfigOutput("");
	resetNetifSnapshotForTest();
	jest.restoreAllMocks();
	jest.useRealTimers();
});

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

test.each([
	"nmcli failure",
	"unknown AP mode",
	"skipped device",
	"per-device error",
] as const)(
	"recovered sharing survives %s until the single 15 second bypass",
	async (failure) => {
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

test("a failed first refresh followed by a classified AP keeps matching routes without a bypass warning", async () => {
	const devices = spyOn(nm, "nmDevices").mockResolvedValue(undefined);
	const h = recovered();
	await h.controller.requestReconcile();
	await wifiUpdateDevices();
	await h.controller.requestReconcile();
	devices.mockResolvedValue([`wlan0:wifi:connected:${ap}`]);
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
});

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
