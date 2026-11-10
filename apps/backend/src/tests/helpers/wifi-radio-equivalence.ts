import { spyOn } from "bun:test";
import * as runner from "../../helpers/run.ts";
import * as mocks from "../../mocks/mock-service.ts";
import type { HotspotCredentials } from "../../modules/wifi/hotspot-credentials.ts";
import {
	onWifiChange,
	setWifiState,
} from "../../modules/wifi/state/wifi-state.ts";
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

export type RadioFixture = {
	readonly ifname: string;
	readonly operational: string | undefined;
	readonly permanent: string | undefined;
	readonly ifindex: number;
	readonly phy: number;
	readonly state: string;
};

export type EquivalenceFixture = {
	readonly name: string;
	readonly frames: readonly (readonly RadioFixture[])[];
	readonly admitted: boolean;
};

export async function radioEquivalenceTranscript(fixture: EquivalenceFixture) {
	let radios: readonly RadioFixture[] = [];
	const unexpected: string[] = [];
	const calls: unknown[][] = [];
	const store = new Map<string, HotspotCredentials>();
	const restorers: Array<() => void | Promise<void>> = [];
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
			if (args.includes("GENERAL.PATH"))
				return `pci-0000:01:00.${radios.find((r) => r.ifname === args.at(-1))?.phy}`;
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
		broadcastState: () => undefined,
		setDupIpSuppression: (ifname, suppressed) => {
			calls.push(["setDupIpSuppression", ifname, suppressed]);
		},
		publishOutcome: (operation, device, result) => {
			calls.push(["publishOutcome", operation, device, result]);
		},
	};
	const snapshot = () => ({
		wifi: wifiBuildMsg(),
		keys: Object.keys(getWifiInterfacesByMacAddress()),
		ids: { ...getWifiIdToMacAddress() },
	});
	const frames = [];
	try {
		for (const frame of fixture.frames) {
			radios = frame;
			wifiDeviceListStartUpdate();
			for (const radio of radios) {
				if (radio.operational)
					wifiDeviceListAdd(radio.ifname, radio.operational);
			}
			wifiDeviceListEndUpdate();
			await wifiUpdateDevices();
			await refreshWifiCapabilities(radios.map((r) => r.ifname));
			wifiCancelScanRefresh();
			stopWifiUpdateLoopForTest();
			const discovered = snapshot();
			const activations = [];
			for (const iface of Object.values(getWifiInterfacesByMacAddress())) {
				const prepare = await wifiHotspotPrepare({ device: iface.id }, deps);
				const prepared = snapshot();
				const start = await wifiHotspotStart({ device: iface.id }, deps);
				const starting = snapshot();
				handleWifiMonitorEvent({
					type: "device-state",
					device: iface.ifname,
					state: "connected",
				});
				await refreshHotspotClients(currentHotspotApIfnames());
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
		}
		return { frames, calls, unexpected };
	} finally {
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
	}
}
