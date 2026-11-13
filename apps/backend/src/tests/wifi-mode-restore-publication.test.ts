import {
	afterEach,
	beforeEach,
	expect,
	jest,
	mock,
	spyOn,
	test,
} from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WifiAdapterMode } from "@ceraui/rpc/schemas";
import * as config from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import * as streaming from "../modules/streaming/streaming.ts";
import {
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import {
	getPersistedWifiAdapterMode,
	getPersistedWifiAdapterModes,
	observedWifiAdapterMode,
	persistWifiAdapterMode,
} from "../modules/wifi/wifi-adapter-mode.ts";
import {
	notifyWifiAdapterModeDiscovery,
	wifiAdapterModeRestoreSource,
} from "../modules/wifi/wifi-adapter-mode-events.ts";
import {
	setWifiAdapterMode,
	startWifiAdapterModeRestore,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import * as legacy from "../modules/wifi/wifi-ap-sta-capability.ts";
import * as caps from "../modules/wifi/wifi-capabilities.ts";
import * as connections from "../modules/wifi/wifi-connections.ts";
import * as devices from "../modules/wifi/wifi-device-list.ts";
import {
	defaultHotspotDeps,
	wifiHotspotStart,
} from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	defaultHotspotStopDeps,
	wifiHotspotStop,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import type {
	HotspotActivationDeps,
	WifiInterfaceWithHotspot,
} from "../modules/wifi/wifi-hotspot-types.ts";
import * as interfaces from "../modules/wifi/wifi-interfaces.ts";
import * as permanent from "../modules/wifi/wifi-permanent-mac.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const MAC = "dc:a6:32:c3:03:01";
const AP = "r3-ap";
const startDefaults = { ...defaultHotspotDeps };
const stopDefaults = { ...defaultHotspotStopDeps };
let row: WifiInterfaceWithHotspot;
let inherited: ReturnType<typeof isolateWifiRegistry>;
let originalPath: string;
let originalModes: ReturnType<typeof config.getConfig>["wifi_modes"];
let scratch: string;
let effects: string[];
let cancel: (() => void) | undefined;
let unsubscribe: (() => void) | undefined;

const flush = async () => {
	for (let i = 0; i < 1000; i++) await Promise.resolve();
};
async function prove(
	supported = true,
	now = () => 0,
	phyName: "phy0" | "phy1" = "phy0",
): Promise<void> {
	const fixture = (name: string) =>
		readFile(join(import.meta.dir, "fixtures/wifi", name), "utf8");
	const [phy, reg, dev] = await Promise.all([
		fixture("iw-phy-rock5bplus-rtl8852be.txt"),
		fixture("iw-reg-get-rock5bplus.txt"),
		fixture("iw-dev-rock5bplus.txt"),
	]);
	caps.setWifiCapabilityDepsForTest({
		runIw: async (args) =>
			args[0] === "phy"
				? phy
						.replaceAll("phy0", phyName)
						.replace(
							"wiphy index: 0",
							phyName === "phy0" ? "wiphy index: 0" : "wiphy index: 1",
						)
						.replace(
							"total <= 2, #channels <= 1",
							`total <= ${supported ? 2 : 1}, #channels <= 1`,
						)
				: args[0] === "reg"
					? reg
					: dev.replace("phy#0", phyName === "phy0" ? "phy#0" : "phy#1"),
		readPhyName: async () => phyName,
		pathExists: async () => false,
		readNmcliWifiProperties: async () => undefined,
		now,
	});
	await caps.refreshWifiCapabilities(["wlan0"], { force: true });
}

beforeEach(async () => {
	jest.useFakeTimers();
	inherited = isolateWifiRegistry();
	originalPath = config.getConfigFilePath();
	originalModes = config.getConfig().wifi_modes;
	scratch = await mkdtemp(join(tmpdir(), "wifi-mode-publication-"));
	config.setConfigFilePath(join(scratch, "config.json"));
	config.getConfig().wifi_modes = {};
	effects = [];
	row = {
		id: 0,
		ifname: "wlan0",
		conn: "station",
		activeConn: "station",
		activeMode: "infrastructure",
		hw: "Publication fixture",
		available: new Map(),
		saved: {},
		savedAll: {},
		supportsApStaConcurrency: true,
		hotspot: {
			conn: AP,
			name: "Publication AP",
			password: "fixture-password",
			channel: "auto",
			availableChannels: ["auto"],
			warnings: {},
		},
	};
	connections.addWifiInterface(MAC, row);
	interfaces.getWifiIdToMacAddress()[0] = MAC;
	onWifiChange(() => {});
	setWifiState({});
	spyOn(streaming, "getIsStreaming").mockReturnValue(false);
	Object.assign(defaultHotspotDeps, {
		nmConnSetFields: async () => {
			effects.push("fields");
			return true;
		},
		nmConnect: async () => {
			effects.push("up");
			return true;
		},
		broadcastState: () => {},
		setDupIpSuppression: () => {},
		credentials: { get: () => undefined, remember: () => {} },
		pruneHotspotConns: async () => {},
		releaseConcurrentInterface: async () => {
			effects.push("release");
		},
		ensureConcurrentInterface: async () => {
			effects.push("virtual");
			return { ifname: "clap-wlan0", created: true };
		},
		pollHotspotActive: async () => true,
	} satisfies Partial<HotspotActivationDeps>);
	Object.assign(defaultHotspotStopDeps, {
		nmConnSetFields: async () => true,
		nmDisconnect: async () => {
			effects.push("down");
			return true;
		},
		releaseConcurrentInterface: async () => {
			effects.push("release");
		},
		broadcastState: () => {},
		setDupIpSuppression: () => {},
		rescan: async () => {},
	});
});

afterEach(async () => {
	cancel?.();
	cancel = undefined;
	unsubscribe?.();
	unsubscribe = undefined;
	settlePending("wlan0", false);
	wifiRadioObservation.stop();
	connections.wifiCancelScanRefresh();
	interfaces.stopWifiUpdateLoopForTest();
	caps.resetWifiCapabilitiesForTest();
	legacy.resetApStaCapabilityStateForTest();
	jest.clearAllTimers();
	jest.useRealTimers();
	mock.restore();
	Object.assign(defaultHotspotDeps, startDefaults);
	Object.assign(defaultHotspotStopDeps, stopDefaults);
	config.getConfig().wifi_modes = originalModes;
	config.setConfigFilePath(originalPath);
	delete interfaces.getWifiIdToMacAddress()[0];
	restoreWifiRegistry(inherited);
	setWifiState({});
	await rm(scratch, { recursive: true, force: true });
});

test("one discovery edge causes exactly one failed read of expired retained capability evidence", async () => {
	let now = 0;
	await prove(false, () => now);
	persistWifiAdapterMode(MAC, "hybrid");
	let reads = 0;
	now = caps.WIFI_CAPABILITIES_TTL_MS + 1;
	caps.setWifiCapabilityDepsForTest({
		now: () => now,
		runIw: async () => {
			if (++reads === 30) cancel?.(); // Bound the unchanged-code negative control.
			throw new Error("fixture iw unavailable after expiry");
		},
	});
	cancel = startWifiAdapterModeRestore();
	await notifyWifiAdapterModeDiscovery();
	await flush();
	expect(reads).toBe(1);
	expect(effects).toEqual([]);
	expect(getPersistedWifiAdapterModes()).toEqual({ [MAC]: "hybrid" });
	expect(jest.getTimerCount()).toBe(0);
});

test("capability invalidation publishes once and repeated invalid evidence is silent", async () => {
	const evidence: Array<boolean | undefined> = [];
	unsubscribe = wifiAdapterModeRestoreSource.subscribe(async () => {
		evidence.push(
			caps.getWifiCapabilitiesForInterface("wlan0")?.staApCombo.supported,
		);
	});
	await prove(false);
	await flush();
	caps.setWifiCapabilityDepsForTest({
		runIw: async () => "invalid phy",
		now: () => 0,
	});
	await caps.refreshWifiCapabilities(["wlan0"], { force: true });
	await flush();
	await caps.refreshWifiCapabilities(["wlan0"], { force: true });
	await flush();
	expect(evidence).toEqual([false, undefined]);
});

test("an unknown exclusive fallback remains unrecorded after a duplicate Start", async () => {
	legacy.setApStaCapabilityRunnerForTest(async () => {
		throw new Error("fixture initial iw failure");
	});
	row.supportsApStaConcurrency = await legacy.supportsApStaConcurrency("wlan0");
	expect(await wifiHotspotStart({ device: 0 })).toEqual({ success: true });
	settlePending("wlan0", true);
	expect(getPersistedWifiAdapterModes()).toEqual({});
	effects = [];
	expect(await wifiHotspotStart({ device: 0 })).toEqual({ success: true });
	expect(getPersistedWifiAdapterModes()).toEqual({});
	expect(effects).toEqual([]);
	expect(observedWifiAdapterMode(row)).toBe("hotspot");
});

for (const explicit of [false, true]) {
	test(`already-active exclusive Start retains eligible intent, explicit=${explicit}`, async () => {
		await prove(explicit);
		row.conn = AP;
		row.activeConn = AP;
		row.activeMode = "ap";
		if (explicit) persistWifiAdapterMode(MAC, "hotspot");
		expect(await wifiHotspotStart({ device: 0 })).toEqual({ success: true });
		expect(getPersistedWifiAdapterModes()).toEqual({ [MAC]: "hotspot" });
		expect(effects).toEqual([]);
	});
}

test("real discovery replacing an active marker with idle during teardown still confirms exclusive mode", async () => {
	row.concurrentHotspot = { ifname: "clap-wlan0", activeConn: AP };
	persistWifiAdapterMode(MAC, "hybrid");
	await prove();
	spyOn(nm, "nmDevices").mockResolvedValue([
		"wlan0:wifi:connected:station",
		"clap-wlan0:wifi:disconnected:",
	]);
	spyOn(nm, "nmConnGetFields").mockResolvedValue(["infrastructure"]);
	spyOn(devices, "wifiDeviceListGetMacAddress").mockReturnValue(MAC);
	spyOn(devices, "wifiDeviceListGetInetAddress").mockReturnValue("192.0.2.2");
	spyOn(permanent, "resolveWifiPermanentMac").mockResolvedValue(MAC);
	spyOn(connections, "wifiUpdateScanResult").mockResolvedValue(true);
	spyOn(connections, "wifiScheduleScanRefresh").mockImplementation(() => {});
	spyOn(wifiRadioObservation, "enqueue").mockImplementation(() => {});
	spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(async () => {
		effects.push("down");
		await interfaces.wifiUpdateDevices();
		return true;
	});
	const result = await setWifiAdapterMode(0, "hotspot");
	settlePending("wlan0", true);
	expect(result).toEqual({ success: true, accepted: true, applied: "hotspot" });
	expect(effects).not.toContain("virtual");
	expect(observedWifiAdapterMode(row)).toBe("hotspot");
	expect(row.concurrentHotspot).toBeUndefined();
	expect(getPersistedWifiAdapterModes()).toEqual({ [MAC]: "hotspot" });
});

test("teardown preserves a genuinely different active connection on the same virtual interface", async () => {
	row.concurrentHotspot = { ifname: "clap-wlan0", activeConn: AP };
	spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(async () => {
		row.concurrentHotspot = { ifname: "clap-wlan0", activeConn: "new-ap" };
		return true;
	});
	expect(await wifiHotspotStop({ device: 0 })).toEqual({ success: true });
	expect(row.concurrentHotspot).toEqual({
		ifname: "clap-wlan0",
		activeConn: "new-ap",
	});
	expect(effects).not.toContain("release");
});

for (const observed of ["station", "hotspot", "hybrid"] as const) {
	for (const supported of [true, false, undefined] as const) {
		for (const previous of [
			undefined,
			"station",
			"hotspot",
			"hybrid",
		] as const) {
			test(`Start matrix observed=${observed} capability=${supported} intent=${previous}`, async () => {
				if (observed === "hotspot") {
					row.conn = AP;
					row.activeConn = AP;
					row.activeMode = "ap";
				}
				if (observed === "hybrid")
					row.concurrentHotspot = { ifname: "clap-wlan0", activeConn: AP };
				if (supported !== undefined) await prove(supported);
				if (previous !== undefined) persistWifiAdapterMode(MAC, previous);
				config.saveConfig();
				const before = await Bun.file(config.getConfigFilePath()).text();
				const result = await wifiHotspotStart({ device: 0 });
				settlePending("wlan0", true);
				const mustRefuse =
					previous === "hybrid" && supported !== true && observed !== "hybrid";
				const target: WifiAdapterMode =
					observed !== "station"
						? observed
						: supported === true && previous !== "hotspot"
							? "hybrid"
							: "hotspot";
				const expected = mustRefuse
					? previous
					: target === "hybrid" || supported === false || previous === "hotspot"
						? target
						: previous;
				expect(getPersistedWifiAdapterMode(MAC)).toBe(expected);
				if (mustRefuse) {
					expect(result).toEqual({
						success: false,
						error: "activation-failed",
					});
					expect(await Bun.file(config.getConfigFilePath()).text()).toBe(
						before,
					);
					expect(effects).toEqual([]);
				} else {
					expect(result).toEqual({ success: true });
					expect(observedWifiAdapterMode(row)).toBe(target);
					if (observed !== "station") expect(effects).toEqual([]);
				}
			});
		}
	}
}

for (const parent of ["disconnected", "new-station"] as const) {
	test(`real discovery introduces idle marker during exclusive Stop; parent=${parent}`, async () => {
		row.conn = AP;
		row.activeConn = AP;
		row.activeMode = "ap";
		persistWifiAdapterMode(MAC, "hotspot");
		await prove();
		spyOn(nm, "nmDevices").mockResolvedValue([
			parent === "disconnected"
				? "wlan0:wifi:disconnected:"
				: "wlan0:wifi:connected:new-station",
			"clap-wlan0:wifi:disconnected:",
		]);
		spyOn(nm, "nmConnGetFields").mockResolvedValue(["infrastructure"]);
		spyOn(devices, "wifiDeviceListGetMacAddress").mockReturnValue(MAC);
		spyOn(devices, "wifiDeviceListGetInetAddress").mockReturnValue("192.0.2.2");
		spyOn(permanent, "resolveWifiPermanentMac").mockResolvedValue(MAC);
		spyOn(connections, "wifiUpdateScanResult").mockResolvedValue(true);
		spyOn(connections, "wifiScheduleScanRefresh").mockImplementation(() => {});
		spyOn(wifiRadioObservation, "enqueue").mockImplementation(() => {});
		spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(
			async () => {
				effects.push("down");
				await interfaces.wifiUpdateDevices();
				return true;
			},
		);
		expect(await setWifiAdapterMode(0, "station")).toEqual({
			success: true,
			applied: "station",
		});
		expect(row.concurrentHotspot).toBeUndefined();
		expect<string | null>(row.conn).toBe(
			parent === "disconnected" ? null : "new-station",
		);
		expect(await setWifiAdapterMode(0, "hotspot")).toEqual({
			success: true,
			accepted: true,
			applied: "hotspot",
		});
		settlePending("wlan0", true);
		expect(observedWifiAdapterMode(row)).toBe("hotspot");
		expect(effects).not.toContain("virtual");
	});
}

test("exclusive Stop retires matching parent aliases independently of an idle virtual marker", async () => {
	row.conn = AP;
	row.activeConn = AP;
	row.activeMode = "ap";
	row.concurrentHotspot = { ifname: "clap-wlan0", activeConn: null };
	expect(await wifiHotspotStop({ device: 0 })).toEqual({ success: true });
	expect(row.conn).toBeNull();
	expect(row.activeConn).toBeUndefined();
	expect(row.activeMode).toBeUndefined();
	expect(row.concurrentHotspot).toBeUndefined();
});

for (const replacement of ["same", "idle", "other-interface"] as const) {
	test(`semantic retirement control: ${replacement} replacement`, async () => {
		row.concurrentHotspot = { ifname: "clap-wlan0", activeConn: AP };
		const next = {
			ifname: replacement === "other-interface" ? "clap-wlan1" : "clap-wlan0",
			activeConn: replacement === "idle" ? null : AP,
		};
		spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(
			async () => {
				row.concurrentHotspot = next;
				return true;
			},
		);
		expect(await wifiHotspotStop({ device: 0 })).toEqual({ success: true });
		expect<WifiInterfaceWithHotspot["concurrentHotspot"]>(
			row.concurrentHotspot,
		).toEqual(replacement === "other-interface" ? next : undefined);
		expect(row.conn).toBe("station");
		expect(effects.includes("release")).toBe(replacement !== "other-interface");
	});
}

for (const accepted of [false, true]) {
	test(`coalesced invalidation and recovery survive a waiting activation; accepted=${accepted}`, async () => {
		persistWifiAdapterMode(MAC, "hybrid");
		await prove();
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<boolean>();
		let attempts = 0;
		spyOn(defaultHotspotDeps, "nmConnect").mockImplementation(async () => {
			effects.push("up");
			if (++attempts === 1) {
				entered.resolve();
				return finish.promise;
			}
			return true;
		});
		cancel = startWifiAdapterModeRestore();
		const discovery = notifyWifiAdapterModeDiscovery();
		await entered.promise;
		caps.setWifiCapabilityDepsForTest({
			runIw: async () => "invalid phy",
			now: () => 0,
		});
		await caps.refreshWifiCapabilities(["wlan0"], { force: true });
		expect(caps.getWifiCapabilitiesForInterface("wlan0")).toBeUndefined();
		await prove();
		finish.resolve(accepted);
		await discovery;
		await flush();
		settlePending("wlan0", true);
		expect(attempts).toBe(accepted ? 1 : 2);
		expect(observedWifiAdapterMode(row)).toBe("hybrid");
		expect(getPersistedWifiAdapterModes()).toEqual({ [MAC]: "hybrid" });
		expect(jest.getTimerCount()).toBe(0);
	});
}

test("identical successful capability publications never re-arm a refused activation", async () => {
	persistWifiAdapterMode(MAC, "hybrid");
	await prove();
	let attempts = 0;
	spyOn(defaultHotspotDeps, "nmConnect").mockImplementation(async () => {
		attempts++;
		return false;
	});
	cancel = startWifiAdapterModeRestore();
	await notifyWifiAdapterModeDiscovery();
	for (let i = 0; i < 40; i++) {
		await prove();
		await flush();
	}
	expect(attempts).toBe(1);
	expect(observedWifiAdapterMode(row)).toBe("station");
	expect(jest.getTimerCount()).toBe(0);
});

test("a coalesced binding change re-arms pending intent even when support stays true", async () => {
	persistWifiAdapterMode(MAC, "hybrid");
	await prove();
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<boolean>();
	let attempts = 0;
	spyOn(defaultHotspotDeps, "nmConnect").mockImplementation(async () => {
		if (++attempts === 1) {
			entered.resolve();
			return finish.promise;
		}
		return true;
	});
	cancel = startWifiAdapterModeRestore();
	const discovery = notifyWifiAdapterModeDiscovery();
	await entered.promise;
	await prove(true, () => 0, "phy1");
	finish.resolve(false);
	await discovery;
	await flush();
	settlePending("wlan0", true);
	expect(attempts).toBe(2);
	expect(observedWifiAdapterMode(row)).toBe("hybrid");
});
