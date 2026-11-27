import { afterEach, beforeEach, mock, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../../helpers/logger.ts";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../../modules/config.ts";
import * as nm from "../../modules/network/network-manager.ts";
import * as streaming from "../../modules/streaming/streaming.ts";
import {
	hotspotCredentialsStore,
	rememberHotspotCredentials,
	resetHotspotCredentialsForTest,
} from "../../modules/wifi/hotspot-credentials.ts";
import {
	onWifiChange,
	setWifiState,
} from "../../modules/wifi/state/wifi-state.ts";
import {
	persistWifiAdapterMode,
	wifiAdapterModeRecorder,
} from "../../modules/wifi/wifi-adapter-mode.ts";
import {
	defaultAdapterModeDeps,
	reconcileWifiAdapterModes,
} from "../../modules/wifi/wifi-adapter-mode-transition.ts";
import * as reconciler from "../../modules/wifi/wifi-adapter-reconciler.ts";
import {
	resetWifiCapabilitiesForTest,
	setWifiCapabilityDepsForTest,
} from "../../modules/wifi/wifi-capabilities.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	wifiCancelScanRefresh,
} from "../../modules/wifi/wifi-connections.ts";
import {
	startHotspotForInterface,
	startHotspotLocked,
} from "../../modules/wifi/wifi-hotspot-activation.ts";
import { settlePending } from "../../modules/wifi/wifi-hotspot-monitor.ts";
import { readHotspotProfilePins } from "../../modules/wifi/wifi-hotspot-profile-operation.ts";
import type {
	HotspotActivationDeps,
	WifiInterfaceWithHotspot,
} from "../../modules/wifi/wifi-hotspot-types.ts";
import {
	resetWifiConnectionModeCache,
	resetWifiInterfaceDiscoveryForTest,
	wifiUpdateDevices,
} from "../../modules/wifi/wifi-interfaces.ts";
import { bindingForRow } from "../../modules/wifi/wifi-operation-binding.ts";
import { wifiRadioIdentity } from "../../modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../../modules/wifi/wifi-radio-observation.ts";
import {
	autoconnectNetworkFixture,
	MAC,
	PORT,
	PROFILE,
} from "./wifi-autoconnect-network.ts";
import { mockQualifiedHybridDriver } from "./wifi-hybrid-qualification.ts";
import { isolateWifiRegistry, restoreWifiRegistry } from "./wifi-registry.ts";

export {
	MAC,
	PORT,
	PROFILE,
	type Witness,
} from "./wifi-autoconnect-network.ts";

export function autoconnectFixture() {
	const network = autoconnectNetworkFixture();
	const { profiles, witnesses, effects, publications, reads, activations } =
		network;
	let inherited: ReturnType<typeof isolateWifiRegistry>;
	let previousConfigPath: string;
	let previousModes: ReturnType<typeof getConfig>["wifi_modes"];
	let scratch: string;
	let row: WifiInterfaceWithHotspot;

	const deps: HotspotActivationDeps = {
		readProfileInstance: async () => undefined,
		releaseConcurrentInterface: async () => true,
		recordIntent: wifiAdapterModeRecorder,
		nmConnSetFields: (uuid, fields, permit) =>
			nm.nmConnSetFields(uuid, fields, permit),
		nmConnect: async (uuid) => {
			activations.push(uuid);
			return true;
		},
		nmApConnAdd: async (_device, _identity, fields) => {
			const profile = profiles.get(PROFILE);
			if (profile) Object.assign(profile, fields);
			return PROFILE;
		},
		nmConnDelete: async () => true,
		nmDisconnect: async () => true,
		wifiUpdateSavedConns: async () => undefined,
		broadcastState: () => undefined,
		setDupIpSuppression: () => undefined,
		credentials: hotspotCredentialsStore,
		findHotspotConn: async () => undefined,
		pruneHotspotConns: async () => undefined,
		ensureConcurrentInterface: async () => ({
			ifname: "clap-wlan0",
			created: false,
		}),
	};

	function seed(hybrid = false): WifiInterfaceWithHotspot {
		row = {
			id: 0,
			ifname: "wlan0",
			hw: "Policy radio",
			conn: null,
			available: new Map(),
			saved: {},
			savedAll: {},
			supportsApStaConcurrency: hybrid,
			hotspot: {
				conn: PROFILE,
				name: "Policy AP",
				password: "fixture-password",
				channel: "auto",
				availableChannels: ["auto"],
				warnings: {},
			},
		};
		addWifiInterface(MAC, row);
		witnesses.set("wlan0", {
			ifindex: 3,
			phy: "/sys/devices/policy/phy0",
			mac: MAC,
			path: PORT,
		});
		network.list(["wlan0:wifi:disconnected:"]);
		profiles.set(PROFILE, {
			"802-11-wireless.mode": "ap",
			"802-11-wireless.ssid": "Policy AP",
			"802-11-wireless-security.psk": "fixture-password",
			"connection.interface-name": hybrid ? "clap-wlan0" : "",
			"802-11-wireless.mac-address": hybrid ? "" : MAC,
			"connection.autoconnect": "yes",
			"connection.autoconnect-priority": "999",
		});
		rememberHotspotCredentials(MAC, {
			ssid: "Policy AP",
			password: "fixture-password",
			conn: PROFILE,
		});
		return row;
	}

	async function sample(): Promise<void> {
		await wifiRadioIdentity.discover(
			[...witnesses.keys()].map((ifname) => ({
				ifname,
				...(ifname === row.ifname ? { row } : {}),
			})),
		);
	}

	async function start(overrides: Partial<HotspotActivationDeps> = {}) {
		await sample();
		const result = await startHotspotForInterface(MAC, row, {
			...deps,
			...overrides,
		});
		settlePending(row.ifname, true);
		return result;
	}

	async function restore(
		overrides: Partial<HotspotActivationDeps> = {},
	): Promise<void> {
		await reconcileWifiAdapterModes({
			...defaultAdapterModeDeps,
			resolveInterfaces: getWifiInterfacesByMacAddress,
			readCapabilities: () => ({
				staApCombo: { supported: row.supportsApStaConcurrency === true },
			}),
			startHotspot: async (_device, _publish, attempt, binding) => {
				const result = await startHotspotLocked(
					MAC,
					row,
					{ ...deps, readProfilePins: readHotspotProfilePins, ...overrides },
					{
						restoreAttempt: attempt,
						binding: binding ?? bindingForRow(MAC, row),
					},
				);
				settlePending(row.ifname, true);
				return result;
			},
		});
	}

	beforeEach(async () => {
		mockQualifiedHybridDriver();
		inherited = isolateWifiRegistry();
		wifiRadioObservation.stop();
		await wifiRadioObservation.settled;
		resetWifiInterfaceDiscoveryForTest();
		resetWifiConnectionModeCache();
		wifiCancelScanRefresh();
		resetHotspotCredentialsForTest();
		previousConfigPath = getConfigFilePath();
		previousModes = getConfig().wifi_modes;
		scratch = await mkdtemp(join(tmpdir(), "wifi-policy-"));
		setConfigFilePath(join(scratch, "config.json"));
		getConfig().wifi_modes = {};
		network.reset();
		seed();
		spyOn(streaming, "getIsStreaming").mockReturnValue(false);
		network.install();
		spyOn(reconciler, "reconcileWifiAdapterPolicies");
		for (const level of ["debug", "info", "warn", "error"] as const)
			spyOn(logger, level).mockImplementation(() => logger);
		onWifiChange(() => undefined);
		setWifiState({});
		resetWifiCapabilitiesForTest();
		setWifiCapabilityDepsForTest({
			runIw: async () => "",
			readPhyName: async () => undefined,
			pathExists: async () => false,
			readNmcliWifiProperties: async () => new Map(),
			now: () => 0,
		});
		await wifiRadioIdentity.discover([]);
	});

	afterEach(async () => {
		await settlePending("wlan0", false);
		wifiRadioObservation.stop();
		await wifiRadioObservation.settled;
		resetWifiInterfaceDiscoveryForTest();
		resetWifiConnectionModeCache();
		wifiCancelScanRefresh();
		resetWifiCapabilitiesForTest();
		resetHotspotCredentialsForTest();
		onWifiChange(() => undefined);
		setWifiState({});
		mock.restore();
		network.close();
		restoreWifiRegistry(inherited);
		getConfig().wifi_modes = previousModes;
		setConfigFilePath(previousConfigPath);
		await rm(scratch, { recursive: true, force: true });
	});

	return {
		profiles,
		witnesses,
		effects,
		publications,
		reads,
		activations,
		deletions: network.deletions,
		deps,
		seed,
		sample,
		start,
		restore,
		discover: () => wifiUpdateDevices(),
		row: () => row,
		list: network.list,
		refusePin: network.refusePin,
		failIntent: () =>
			setConfigFilePath(join(scratch, "missing", "config.json")),
		persistMode: persistWifiAdapterMode,
	};
}
