import { jest, spyOn } from "bun:test";
import { deepStrictEqual } from "node:assert/strict";
import { logger } from "../../helpers/logger.ts";
import * as runner from "../../helpers/run.ts";
import * as mocks from "../../mocks/mock-service.ts";
import type { HotspotCredentials } from "../../modules/wifi/hotspot-credentials.ts";
import {
	onWifiChange,
	setWifiState,
} from "../../modules/wifi/state/wifi-state.ts";
import * as wifi from "../../modules/wifi/wifi.ts";
import {
	currentHotspotApIfnames,
	wifiBuildMsg,
} from "../../modules/wifi/wifi.ts";
import { setApStaCapabilityRunnerForTest } from "../../modules/wifi/wifi-ap-sta-capability.ts";
import {
	refreshWifiCapabilities,
	resetWifiCapabilitiesForTest,
	setWifiCapabilityDepsForTest,
} from "../../modules/wifi/wifi-capabilities.ts";
import {
	clearWifiInterfacesForTest,
	getWifiInterfacesByMacAddress,
	resetWifiScanStampsForTest,
	wifiCancelScanRefresh,
	wifiStateInit,
} from "../../modules/wifi/wifi-connections.ts";
import {
	wifiDeviceListAdd,
	wifiDeviceListEndUpdate,
	wifiDeviceListStartUpdate,
} from "../../modules/wifi/wifi-device-list.ts";
import {
	wifiHotspotPrepare,
	wifiHotspotStart,
} from "../../modules/wifi/wifi-hotspot-activation.ts";
import {
	refreshHotspotClients,
	resetHotspotClientsForTest,
	setHotspotClientsDepsForTest,
} from "../../modules/wifi/wifi-hotspot-clients.ts";
import { handleWifiMonitorEvent } from "../../modules/wifi/wifi-hotspot-monitor.ts";
import type { HotspotActivationDeps } from "../../modules/wifi/wifi-hotspot-types.ts";
import {
	getWifiIdToMacAddress,
	resetWifiConnectionModeCache,
	resetWifiInterfaceDiscoveryForTest,
	stopWifiUpdateLoopForTest,
	wifiUpdateDevices,
} from "../../modules/wifi/wifi-interfaces.ts";
import {
	resetWifiPermanentMacCache,
	setPermanentMacReaderForTest,
} from "../../modules/wifi/wifi-permanent-mac.ts";
import * as compat from "../../rpc/compat.ts";

export type RadioFixture = {
	readonly ifname: string;
	readonly operational: string | undefined;
	readonly permanent: string | undefined;
	readonly ifindex: number;
	readonly phy: number;
	readonly state: string;
	readonly beforeRead?: (path: string) => Promise<void>;
};

export type EquivalenceFixture = {
	readonly name: string;
	readonly frames: readonly (readonly RadioFixture[])[];
	readonly admitted: boolean;
	readonly publication?: () => Promise<void>;
};

// P's only allowed byte delta is the optional field on each Wi-Fi row.
function legacyWifiStatus(rows: unknown): unknown {
	if (typeof rows !== "object" || rows === null) return rows;
	return Object.fromEntries(
		Object.entries(rows).map(([id, row]) => {
			if (typeof row !== "object" || row === null || !("incarnation" in row)) {
				return [id, row];
			}
			const { incarnation: _incarnation, ...legacy } = row;
			return [id, legacy];
		}),
	);
}

export async function radioEquivalenceTranscript(
	fixture: EquivalenceFixture,
	duplicateBroadcast = false,
	observe?: (rows: ReturnType<typeof wifiBuildMsg>) => void,
) {
	jest.useFakeTimers();
	jest.setSystemTime(0);
	let phase = "setup";
	const broadcasts: Array<{ phase: string; at: number; payload: unknown }> = [];
	let radios: readonly RadioFixture[] = [];
	const unexpected: string[] = [];
	const calls: unknown[][] = [];
	const logs: Array<{ level: string; args: unknown[] }> = [];
	const store = new Map<string, HotspotCredentials>();
	const restorers: Array<() => void | Promise<void>> = [];
	for (const level of ["error", "warn", "info", "debug"] as const) {
		const log = spyOn(logger, level).mockImplementation(
			(...args: unknown[]) => {
				logs.push({ level, args: structuredClone(args) });
				return logger;
			},
		);
		restorers.push(() => log.mockRestore());
	}
	const realSink = compat.broadcastMsg;
	const sink = spyOn(compat, "broadcastMsg").mockImplementation(
		(type, data, activeMin, authedOnly) => {
			if (
				phase !== "cleanup" &&
				type === "status" &&
				typeof data === "object" &&
				data !== null &&
				"wifi" in data
			) {
				broadcasts.push({
					phase,
					at: Date.now(),
					payload: structuredClone({
						...data,
						wifi: legacyWifiStatus(data.wifi),
					}),
				});
			}
			realSink(type, data, activeMin, authedOnly);
		},
	);
	restorers.push(() => sink.mockRestore());
	if (duplicateBroadcast) {
		const owner = wifi.broadcastWifiState;
		const doubled = spyOn(wifi, "broadcastWifiState").mockImplementation(() => {
			owner();
			owner();
		});
		restorers.push(() => doubled.mockRestore());
	}
	const command = spyOn(runner, "run").mockImplementation(async (bin, args) => {
		if (bin === "nmcli") {
			if (
				args.join(" ") ===
				"--terse --fields device,type,state,con-uuid device status"
			)
				return radios.map((r) => `${r.ifname}:wifi:${r.state}:`).join("\n");
			if (
				args.includes(
					"GENERAL.VENDOR,GENERAL.PRODUCT,WIFI-PROPERTIES.AP,WIFI-PROPERTIES.5GHZ,WIFI-PROPERTIES.2GHZ",
				)
			)
				return "Fixture\nRadio\nyes\nno\nyes";
			if (args.join(" ") === "--terse --fields uuid,type connection show")
				return "";
			if (
				args.includes("IN-USE,BSSID,SSID,MODE,CHAN,RATE,SIGNAL,BARS,SECURITY")
			)
				return "";
		}
		unexpected.push(`${bin} ${args.join(" ")}`);
		throw new Error(`Unexpected equivalence command: ${bin} ${args.join(" ")}`);
	});
	const mockMode = spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
	restorers.push(
		() => command.mockRestore(),
		() => mockMode.mockRestore(),
	);
	clearWifiInterfacesForTest();
	resetWifiInterfaceDiscoveryForTest();
	resetWifiConnectionModeCache();
	resetWifiPermanentMacCache();
	resetWifiScanStampsForTest();
	resetWifiCapabilitiesForTest();
	resetHotspotClientsForTest();
	setHotspotClientsDepsForTest({ runIw: async () => "", now: () => 0 });
	onWifiChange(() => undefined);
	setWifiState({});
	wifiStateInit({
		on: () => undefined,
		off: () => undefined,
		start: () => undefined,
		stop: () => undefined,
	});
	setPermanentMacReaderForTest(
		async (ifname) => radios.find((r) => r.ifname === ifname)?.permanent,
	);
	setApStaCapabilityRunnerForTest(async () => "");
	setWifiCapabilityDepsForTest({
		runIw: async () => "",
		readPhyName: async () => undefined,
		pathExists: async () => false,
		readNmcliWifiProperties: async () => new Map(),
		now: () => 0,
	});

	const identityModule = new URL(
		"../../modules/wifi/wifi-radio-identity.ts",
		import.meta.url,
	);
	// Main has no shadow producer; its production discovery remains untouched.
	if (await Bun.file(identityModule).exists()) {
		const { fakeShadowSysfs } = await import(
			"./wifi-radio-equivalence-shadow.ts"
		);
		restorers.push(await fakeShadowSysfs(() => radios));
	}

	const deps: HotspotActivationDeps = {
		credentials: {
			get: (mac) => {
				calls.push(["credentials.get", mac]);
				return (
					store.get(mac) ?? {
						ssid: `fixture-${mac.replaceAll(":", "")}`,
						password: "fixture-password",
						channel: "auto",
					}
				);
			},
			remember: (mac, credentials) => {
				calls.push(["credentials.remember", mac, { ...credentials }]);
				store.set(mac, { ...credentials });
			},
		},
		findHotspotConn: async (mac, stored) => {
			calls.push(["findHotspotConn", mac, stored]);
			return undefined;
		},
		nmHotspot: async (ifname, ssid, password) => {
			calls.push(["nmHotspot", ifname, ssid, password]);
			return `fixture-uuid-${ifname}`;
		},
		nmConnSetFields: async (uuid, fields) => {
			calls.push(["nmConnSetFields", uuid, fields]);
			return true;
		},
		nmConnect: async (uuid) => {
			calls.push(["nmConnect", uuid]);
			return true;
		},
		pruneHotspotConns: async (mac, keep) => {
			calls.push(["pruneHotspotConns", mac, keep]);
		},
		wifiUpdateSavedConns: async () => {
			calls.push(["wifiUpdateSavedConns"]);
		},
		broadcastState: () => wifi.broadcastWifiState(),
		setDupIpSuppression: (ifname, suppressed) => {
			calls.push(["setDupIpSuppression", ifname, suppressed]);
		},
		publishOutcome: (operation, device, result) => {
			calls.push(["publishOutcome", operation, device, result]);
		},
	};
	const snapshot = () => ({
		wifi: legacyWifiStatus(wifiBuildMsg()),
		keys: Object.keys(getWifiInterfacesByMacAddress()),
		ids: { ...getWifiIdToMacAddress() },
	});
	const legacySnapshot = () =>
		structuredClone({
			status: JSON.stringify(legacyWifiStatus(wifiBuildMsg())),
			keys: Object.keys(getWifiInterfacesByMacAddress()),
			registry: getWifiInterfacesByMacAddress(),
			ids: getWifiIdToMacAddress(),
			calls,
			credentials: [...store],
			broadcasts,
			logs,
		});
	const frames = [];
	try {
		for (const frame of fixture.frames) {
			phase = "discovery:pending";
			radios = frame;
			wifiDeviceListStartUpdate();
			for (const radio of radios) {
				if (radio.operational)
					wifiDeviceListAdd(radio.ifname, radio.operational);
			}
			wifiDeviceListEndUpdate();
			await wifiUpdateDevices();
			phase = "discovery:published";
			await refreshWifiCapabilities(radios.map((r) => r.ifname));
			wifiCancelScanRefresh();
			stopWifiUpdateLoopForTest();
			const discovered = snapshot();
			const activations = [];
			for (const iface of Object.values(getWifiInterfacesByMacAddress())) {
				phase = "prepare:pending";
				const prepare = await wifiHotspotPrepare({ device: iface.id }, deps);
				phase = "prepare:published";
				const prepared = snapshot();
				phase = "start:pending";
				const start = await wifiHotspotStart({ device: iface.id }, deps);
				phase = "start:published";
				const starting = snapshot();
				phase = "confirmation:pending";
				handleWifiMonitorEvent({
					type: "device-state",
					device: iface.ifname,
					state: "connected",
				});
				await refreshHotspotClients(currentHotspotApIfnames());
				phase = "confirmation:published";
				activations.push({
					device: iface.id,
					prepare,
					start,
					prepared,
					starting,
					confirmed: snapshot(),
				});
			}
			frames.push({ discovered, activations });
			phase = "frame:published";
			if (fixture.publication) await fixture.publication();
			const beforeShadow = legacySnapshot();
			// Both main and A receive the same one-millisecond inter-frame gap.
			jest.advanceTimersByTime(1);
			const observationModule = new URL(
				"../../modules/wifi/wifi-radio-observation.ts",
				import.meta.url,
			);
			if (await Bun.file(observationModule).exists()) {
				const { wifiRadioObservation } = await import(
					"../../modules/wifi/wifi-radio-observation.ts"
				);
				await wifiRadioObservation.settled;
			}
			deepStrictEqual(
				legacySnapshot(),
				beforeShadow,
				"Detached shadow changed legacy state",
			);
			observe?.(structuredClone(wifiBuildMsg()));
		}
		return { frames, calls, unexpected, broadcasts };
	} finally {
		phase = "cleanup";
		onWifiChange(() => undefined);
		wifiCancelScanRefresh();
		stopWifiUpdateLoopForTest();
		for (const iface of Object.values(getWifiInterfacesByMacAddress())) {
			handleWifiMonitorEvent({
				type: "device-state",
				device: iface.ifname,
				state: "connected",
			});
		}
		clearWifiInterfacesForTest();
		resetWifiInterfaceDiscoveryForTest();
		resetWifiConnectionModeCache();
		resetWifiPermanentMacCache();
		resetWifiScanStampsForTest();
		setPermanentMacReaderForTest(null);
		setApStaCapabilityRunnerForTest(null);
		resetWifiCapabilitiesForTest();
		resetHotspotClientsForTest();
		wifiDeviceListStartUpdate();
		wifiDeviceListEndUpdate();
		setWifiState({});
		for (const restore of restorers.reverse()) await restore();
		jest.useRealTimers();
	}
}
