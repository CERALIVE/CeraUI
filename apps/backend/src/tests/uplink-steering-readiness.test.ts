import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import * as runner from "../helpers/run.ts";
import * as time from "../helpers/time.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	getNetworkInterfaces,
	hasNetifSnapshot,
	NETIF_ERR_HOTSPOT,
	onNetworkInterfacesChange,
	processIfconfigOutput,
	refreshRouterCellularState,
	resetNetifSnapshotForTest,
	updateNetif,
} from "../modules/network/network-interfaces.ts";
import {
	defaultRouterCellularScanDeps,
	identityDeadlineExpired,
	onUsbNetScanCommitted,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
	usbNetScanCovers,
} from "../modules/network/router-cellular-scan.ts";
import * as shaperStatus from "../modules/network/uplink-shaper/status.ts";
import { UplinkSteeringApplier } from "../modules/network/uplink-steering/applier.ts";
import { UplinkSteeringCoordinator } from "../modules/network/uplink-steering/coordinator.ts";
import * as routes from "../modules/network/uplink-steering/route-manager.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";
import { readDesiredSteeringState } from "../modules/network/uplink-steering/state-builder.ts";
import * as deviceDetection from "../modules/system/device-detection.ts";
import {
	clearWifiInterfacesForTest,
	wifiCancelScanRefresh,
} from "../modules/wifi/wifi-connections.ts";
import { resetWifiInterfaceDiscoveryForTest } from "../modules/wifi/wifi-interfaces.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";

function ifconfig(ifname: string, ip: string): string {
	return [
		`${ifname}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${ip}  netmask 255.255.255.0`,
		"        ether 02:00:00:00:00:01",
		"        RX packets 1  bytes 0",
		"        TX packets 1  bytes 0",
	].join("\n");
}

const output = [
	ifconfig("wlan0", "10.42.0.1"),
	ifconfig("wwu1c2", "100.64.1.2"),
].join("\n\n");

afterEach(() => {
	jest.restoreAllMocks();
	wifiCancelScanRefresh();
	resetWifiInterfaceDiscoveryForTest();
	clearWifiInterfacesForTest();
	resetUsbNetMarkers();
	processIfconfigOutput("");
	resetNetifSnapshotForTest();
	jest.useRealTimers();
});

function recoveredSharing(classified = false) {
	const effects: string[] = [];
	const statuses: unknown[] = [];
	const identity = resolveModemPhysicalIdentity("wwu1c2").identityKey;
	const mark = stableUplinkMark(identity);
	const applier = new UplinkSteeringApplier({
		discoverRoutes: async () => [
			{
				identity,
				mark,
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
	const coordinator = new UplinkSteeringCoordinator({
		readDesiredState: (context) =>
			readDesiredSteeringState(
				classified
					? {
							netifReady: hasNetifSnapshot,
							discoverRoutes: async () => [],
							zonesReady: () => true,
							identityCovered: usbNetScanCovers,
							identityDeadlineExpired,
							interfaces: getNetworkInterfaces,
							health: () => [],
							wifiIdentity: () => undefined,
							physicalIdentity: (ifname) =>
								resolveModemPhysicalIdentity(ifname).identityKey,
							markForIdentity: stableUplinkMark,
							isBondCandidate: () => false,
							isClientZone: (ifname) => ifname === "wlan0",
							planRoute: (candidate) => routes.planUplinkRoute(candidate),
						}
					: undefined,
				context,
			),
		apply: (previous, next) => applier.apply(previous, next),
		retryCleanup: () => applier.retryPendingCleanup(),
		publishAvailability: (status) => {
			statuses.push(status);
		},
		waitBeforeRetry: async () => {},
	});
	spyOn(routes, "planUplinkRoute").mockImplementation(async (candidate) => ({
		...candidate,
		table: "30001",
		managed: false,
	}));
	return { coordinator, effects, statuses };
}

function identityDeadlineFixture() {
	jest.useFakeTimers();
	jest.setSystemTime(0);
	resetUsbNetMarkers();
	resetNetifSnapshotForTest();
	const clock = { now: 0 };
	spyOn(time, "getms").mockImplementation(() => clock.now);
	const flushed: number[] = [];
	const removed: string[] = [];
	const deadlines: Array<{ armedAt: number; delay: number }> = [];
	const applier = new UplinkSteeringApplier({
		discoverRoutes: async () => [],
		ensureRoute: async (route) => ({ route, changed: false }),
		rollbackRoute: async () => {},
		removeRoute: async (route) => {
			removed.push(route.ifname);
		},
		applyRuleset: async () => {},
		deactivateSharing: async () => {},
		flushConntrack: async (mark) => {
			flushed.push(mark);
		},
		setIpForwarding: async () => {},
		publishFlowsReset: () => {},
	});
	const coordinator = new UplinkSteeringCoordinator({
		readDesiredState: (context) =>
			readDesiredSteeringState(
				{
					netifReady: hasNetifSnapshot,
					discoverRoutes: async () => [],
					zonesReady: () => true,
					identityCovered: usbNetScanCovers,
					identityDeadlineExpired,
					interfaces: getNetworkInterfaces,
					health: () => [],
					wifiIdentity: () => undefined,
					physicalIdentity: (ifname) =>
						resolveModemPhysicalIdentity(ifname).identityKey,
					markForIdentity: stableUplinkMark,
					isBondCandidate: () => false,
					isClientZone: (ifname) => ifname === "eth9",
					planRoute: async (candidate) => ({
						...candidate,
						table: "30001",
						managed: false,
					}),
				},
				context,
			),
		apply: (previous, next) => applier.apply(previous, next),
		retryCleanup: () => applier.retryPendingCleanup(),
		publishAvailability: () => {},
		now: () => clock.now,
		schedule: (_fire, delay) => {
			deadlines.push({ armedAt: clock.now, delay });
			return () => {};
		},
	});
	const publish = () =>
		processIfconfigOutput(
			[ifconfig("eth9", "10.42.0.1"), ifconfig("wwan0", "100.64.1.2")].join(
				"\n\n",
			),
		);
	return { clock, coordinator, deadlines, flushed, removed, publish };
}

describe("#436 identity deadline clock corrections", () => {
	test("rollback after expiry keeps the active fallback mark and route through the real applier", async () => {
		const h = identityDeadlineFixture();
		try {
			h.publish();
			await h.coordinator.requestReconcile();
			h.clock.now = 15_000;
			jest.advanceTimersByTime(15_000);
			await h.coordinator.requestReconcile();
			expect(h.coordinator.appliedState()?.uplinks[0]?.mark).toBe(0xca20a300);

			jest.setSystemTime(1_000);
			await h.coordinator.requestReconcile();

			expect(h.flushed).toEqual([]);
			expect(h.removed).toEqual([]);
			expect(h.coordinator.appliedState()?.uplinks[0]?.ifname).toBe("wwan0");
		} finally {
			h.coordinator.stop();
		}
	});

	test("a forward wall-clock jump cannot admit an uncovered interface before fifteen elapsed seconds", async () => {
		const h = identityDeadlineFixture();
		try {
			h.publish();
			await h.coordinator.requestReconcile();
			h.clock.now = 1_000;
			jest.advanceTimersByTime(1_000);
			jest.setSystemTime(3_600_000);
			await h.coordinator.requestReconcile();

			expect(h.coordinator.appliedState()).toBeUndefined();
			expect(h.flushed).toEqual([]);
			expect(h.removed).toEqual([]);
			h.clock.now = 15_000;
			await h.coordinator.requestReconcile();
			expect(h.coordinator.appliedState()?.uplinks[0]?.ifname).toBe("wwan0");
		} finally {
			h.coordinator.stop();
		}
	});

	test("the deadline arms only after netif readiness despite wall-clock jumps", async () => {
		const h = identityDeadlineFixture();
		try {
			h.clock.now = 60_000;
			jest.advanceTimersByTime(60_000);
			jest.setSystemTime(3_600_000);
			await h.coordinator.requestReconcile();
			expect(h.deadlines).toEqual([]);
			expect(h.coordinator.appliedState()).toBeUndefined();

			h.publish();
			await h.coordinator.requestReconcile();
			expect(h.deadlines).toEqual([{ armedAt: 60_000, delay: 15_000 }]);
			h.clock.now = 74_999;
			jest.advanceTimersByTime(14_999);
			jest.setSystemTime(7_200_000);
			await h.coordinator.requestReconcile();
			expect(h.coordinator.appliedState()).toBeUndefined();

			h.clock.now = 75_000;
			await h.coordinator.requestReconcile();
			expect(h.coordinator.appliedState()?.uplinks[0]?.ifname).toBe("wwan0");
			expect(h.deadlines).toHaveLength(1);
			expect(h.flushed).toEqual([]);
			expect(h.removed).toEqual([]);
		} finally {
			h.coordinator.stop();
		}
	});
});

describe("#436 startup readiness", () => {
	test("real startup ordering keeps recovered sharing while wlan0 awaits its hotspot flag", async () => {
		resetWifiInterfaceDiscoveryForTest();
		clearWifiInterfacesForTest();
		processIfconfigOutput(output);
		await refreshUsbNetMarkers(["wwu1c2"], constructedTwinDeps());
		expect(getNetworkInterfaces().wlan0?.error).toBe(0);
		const { coordinator, effects, statuses } = recoveredSharing();

		await coordinator.requestReconcile();

		expect(effects).toEqual([]);
		expect(statuses).toEqual([]);
		expect(coordinator.appliedState()).toBeUndefined();
		coordinator.stop();
	});

	test("a scan slower than two seconds publishes the interface without planning a fallback identity", async () => {
		jest.useFakeTimers();
		jest.setSystemTime(0);
		processIfconfigOutput(ifconfig("wlan0", "10.42.0.1"));
		const wlan = getNetworkInterfaces().wlan0;
		if (!wlan) throw new Error("missing hotspot fixture");
		wlan.error = NETIF_ERR_HOTSPOT;
		wlan.enabled = false;
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const fixture = constructedTwinDeps();
		spyOn(defaultRouterCellularScanDeps, "resolveLink").mockImplementation(
			async (path) => {
				entered.resolve();
				await gate.promise;
				return fixture.resolveLink(path);
			},
		);
		spyOn(defaultRouterCellularScanDeps, "readAttr").mockImplementation(
			fixture.readAttr,
		);
		spyOn(defaultRouterCellularScanDeps, "listDir").mockImplementation(
			fixture.listDir,
		);
		spyOn(defaultRouterCellularScanDeps, "readLinkName").mockImplementation(
			fixture.readLinkName,
		);
		spyOn(runner, "run").mockImplementation(async (bin) =>
			bin === "ifconfig" ? output : "",
		);
		const published = Promise.withResolvers<void>();
		const unsubscribe = onNetworkInterfacesChange(() => {
			if (getNetworkInterfaces().wwu1c2) published.resolve();
		});
		const { coordinator, effects } = recoveredSharing(true);
		try {
			void updateNetif();
			const first = await Promise.race([
				entered.promise.then(() => "scan"),
				published.promise.then(() => "publication"),
			]);
			expect(first).toBe("scan");
			jest.advanceTimersByTime(2_000);
			await published.promise;
			await coordinator.requestReconcile();
			expect(effects).toEqual([]);
			expect(coordinator.appliedState()).toBeUndefined();
			gate.resolve();
			await refreshUsbNetMarkers(["wlan0", "wwu1c2"]);
			await coordinator.requestReconcile();
			expect(coordinator.appliedState()?.uplinks[0]?.identity).toStartWith(
				"id-path:",
			);
		} finally {
			gate.resolve();
			await refreshUsbNetMarkers(["wlan0", "wwu1c2"]);
			coordinator.stop();
			unsubscribe();
		}
	});

	test("netif never populated cannot apply after sixty seconds", async () => {
		jest.useFakeTimers();
		jest.setSystemTime(0);
		resetNetifSnapshotForTest();
		const { coordinator, effects } = recoveredSharing();
		const warn = spyOn(logger, "warn");
		await coordinator.requestReconcile();
		jest.advanceTimersByTime(60_000);
		await coordinator.requestReconcile();
		expect(effects).toEqual([]);
		expect(warn).not.toHaveBeenCalled();
		coordinator.stop();
	});

	test("publishes a new modem only after coverage, even when cadence asks about the old set", async () => {
		processIfconfigOutput(ifconfig("wlan0", "10.42.0.1"));
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const fixture = constructedTwinDeps();
		spyOn(defaultRouterCellularScanDeps, "resolveLink").mockImplementation(
			async (path) => {
				entered.resolve();
				await gate.promise;
				return fixture.resolveLink(path);
			},
		);
		spyOn(defaultRouterCellularScanDeps, "readAttr").mockImplementation(
			fixture.readAttr,
		);
		spyOn(defaultRouterCellularScanDeps, "listDir").mockImplementation(
			fixture.listDir,
		);
		spyOn(defaultRouterCellularScanDeps, "readLinkName").mockImplementation(
			fixture.readLinkName,
		);
		spyOn(runner, "run").mockImplementation(async (bin) =>
			bin === "ifconfig" ? output : "",
		);
		let publishedIdentity: string | undefined;
		let coveredAtPublication = false;
		const unsubscribe = onNetworkInterfacesChange(() => {
			if (!getNetworkInterfaces().wwu1c2) return;
			coveredAtPublication = usbNetScanCovers("wwu1c2");
			publishedIdentity = resolveModemPhysicalIdentity("wwu1c2").identityKey;
		});
		const publication = updateNetif();
		await entered.promise;
		const cadence = refreshRouterCellularState();
		expect(getNetworkInterfaces().wwu1c2).toBeUndefined();
		gate.resolve();
		try {
			await Promise.all([publication, cadence]);
			expect(coveredAtPublication).toBe(true);
			expect(publishedIdentity).toStartWith("id-path:");
			const { coordinator } = recoveredSharing(true);
			await coordinator.requestReconcile();
			expect(coordinator.appliedState()?.uplinks[0]?.identity).toBe(
				publishedIdentity,
			);
			coordinator.stop();
		} finally {
			gate.resolve();
			unsubscribe();
		}
	});

	test("a slow older OS refresh cannot overwrite a newer snapshot", async () => {
		const older = Promise.withResolvers<string>();
		let reads = 0;
		spyOn(runner, "run").mockImplementation(async (bin) => {
			if (bin !== "ifconfig") return "";
			if (reads++ === 0) return older.promise;
			return ifconfig("eth1", "192.0.2.20");
		});
		spyOn(defaultRouterCellularScanDeps, "resolveLink").mockResolvedValue(
			undefined,
		);
		const first = updateNetif();
		await updateNetif();
		older.resolve(ifconfig("eth0", "192.0.2.10"));
		await first;
		expect(Object.keys(getNetworkInterfaces())).toEqual(["eth1"]);
	});

	test("a superseded producer scan requests the full set again before publication", async () => {
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const fixture = constructedTwinDeps();
		let modemReads = 0;
		spyOn(defaultRouterCellularScanDeps, "resolveLink").mockImplementation(
			async (path) => {
				if (path === "/sys/class/net/wwu1c2/device") {
					modemReads++;
					if (modemReads === 1) {
						entered.resolve();
						await gate.promise;
					}
				}
				return fixture.resolveLink(path);
			},
		);
		spyOn(defaultRouterCellularScanDeps, "readAttr").mockImplementation(
			fixture.readAttr,
		);
		spyOn(defaultRouterCellularScanDeps, "listDir").mockImplementation(
			fixture.listDir,
		);
		spyOn(defaultRouterCellularScanDeps, "readLinkName").mockImplementation(
			fixture.readLinkName,
		);
		spyOn(runner, "run").mockImplementation(async (bin) =>
			bin === "ifconfig" ? output : "",
		);
		const producer = updateNetif();
		await entered.promise;
		await refreshUsbNetMarkers(["wlan0"]);
		gate.resolve();
		await producer;
		expect(modemReads).toBe(2);
		expect(usbNetScanCovers("wwu1c2")).toBe(true);
		expect(getNetworkInterfaces().wwu1c2?.ip).toBe("100.64.1.2");
	});

	test("the first empty OS snapshot announces readiness without Wi-Fi discovery", async () => {
		resetNetifSnapshotForTest();
		spyOn(runner, "run").mockResolvedValue("");
		let events = 0;
		const unsubscribe = onNetworkInterfacesChange(() => {
			events++;
		});
		try {
			await updateNetif();
			expect(hasNetifSnapshot()).toBe(true);
			expect(events).toBe(1);
			expect(await readDesiredSteeringState()).toEqual({
				clientZones: [],
				uplinks: [],
				routes: [],
			});
		} finally {
			unsubscribe();
		}
	});

	test("the shaping consumer preserves its published state while netif readiness is pending", async () => {
		resetNetifSnapshotForTest();
		spyOn(deviceDetection, "isRealDevice").mockResolvedValue(true);
		shaperStatus.publishShaperAvailable("streaming", "htb-fq_codel");
		const previous = shaperStatus.getUplinkShaperStatus();
		const runtime = await import(
			`../modules/network/uplink-shaper/runtime.ts?case=${encodeURIComponent("readiness")}`
		);
		try {
			await runtime.initUplinkShaper();
			await runtime.tickUplinkShaper();
			expect(shaperStatus.getUplinkShaperStatus()).toEqual(previous);
		} finally {
			shaperStatus.resetUplinkShaperStatusForTest();
		}
	});

	test("a serial-only scan commit requests exactly one reconcile", async () => {
		const fixture = constructedTwinDeps();
		let serial = "test-serial-A";
		const deps = {
			...fixture,
			readAttr: async (path: string) =>
				path.endsWith("/serial") ? serial : fixture.readAttr(path),
		};
		await refreshUsbNetMarkers(["wwu1c2"], deps);
		let reconciles = 0;
		const { coordinator } = recoveredSharing(true);
		const unsubscribe = onUsbNetScanCommitted(() => {
			reconciles++;
			void coordinator.requestReconcile();
		});
		try {
			serial = "test-serial-B";
			expect(await refreshUsbNetMarkers(["wwu1c2"], deps)).toBe(true);
			await coordinator.requestReconcile();
			expect(reconciles).toBe(1);
			expect(await refreshUsbNetMarkers(["wwu1c2"], deps)).toBe(false);
			expect(reconciles).toBe(1);
		} finally {
			unsubscribe();
			coordinator.stop();
		}
	});

	test("a never-covered modem uses its fallback after the shared deadline and warns once", async () => {
		jest.useFakeTimers();
		jest.setSystemTime(0);
		const clock = { now: 0 };
		spyOn(time, "getms").mockImplementation(() => clock.now);
		resetUsbNetMarkers();
		processIfconfigOutput(output);
		const { coordinator, effects } = recoveredSharing(true);
		const warn = spyOn(logger, "warn");
		await coordinator.requestReconcile();
		clock.now = 14_900;
		jest.advanceTimersByTime(14_900);
		await coordinator.requestReconcile();
		expect(effects).toEqual([]);
		clock.now = 15_000;
		jest.advanceTimersByTime(100);
		await coordinator.requestReconcile();
		expect(coordinator.appliedState()?.uplinks[0]?.identity).toBe(
			"ifname:wwu1c2",
		);
		await coordinator.requestReconcile();
		expect(
			warn.mock.calls.filter(
				(args) =>
					String(args[0]) ===
					"USB identity deadline expired; using fallback identity",
			),
		).toHaveLength(1);
		coordinator.stop();
	});

	test("twin startup uses two port identities on the first apply and keeps matching recovered routes", async () => {
		processIfconfigOutput(
			[
				ifconfig("wlan0", "10.42.0.1"),
				...constructedTwins.map((device, index) =>
					ifconfig(device.ifname, `100.64.${index + 1}.2`),
				),
			].join("\n\n"),
		);
		await refreshUsbNetMarkers(
			Object.keys(getNetworkInterfaces()),
			constructedTwinDeps(),
		);
		const { coordinator, effects } = recoveredSharing(true);
		await coordinator.requestReconcile();
		const identities = coordinator
			.appliedState()
			?.uplinks.map((entry) => entry.identity);
		expect(identities).toHaveLength(2);
		expect(
			identities?.every((identity) => identity.startsWith("id-path:")),
		).toBe(true);
		expect(new Set(identities).size).toBe(2);
		expect(effects).toEqual(["ruleset"]);
		coordinator.stop();
	});
});
