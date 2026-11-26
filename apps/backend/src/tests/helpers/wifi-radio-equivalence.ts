import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HotspotCredentials } from "../../modules/wifi/hotspot-credentials.ts";
import type { wifiBuildMsg } from "../../modules/wifi/wifi.ts";
import {
	canHotspot,
	type HotspotActivationDeps,
} from "../../modules/wifi/wifi-hotspot-types.ts";
import type { wifiUpdateDevices } from "../../modules/wifi/wifi-interfaces.ts";
import { createEquivalenceNm } from "./wifi-radio-equivalence-nm.ts";

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
	readonly limitedFrames?: readonly number[];
	readonly resample?: true;
	readonly duringDiscovery?: (
		discovery: ReturnType<typeof wifiUpdateDevices>,
	) => Promise<void>;
	readonly publication?: () => Promise<void>;
};

// The recorded legacy transcript predates these two additive observations.
function legacyWifiStatus(rows: unknown): unknown {
	if (typeof rows !== "object" || rows === null) return rows;
	return Object.fromEntries(
		Object.entries(rows).map(([id, row]) => {
			if (typeof row !== "object" || row === null) {
				return [id, row];
			}
			const {
				incarnation: _incarnation,
				observed_mode: _observedMode,
				...legacy
			} = row as Record<string, unknown>;
			return [id, legacy];
		}),
	);
}

export async function radioEquivalenceTranscript(
	fixture: EquivalenceFixture,
	duplicateBroadcast = false,
	observe?: (rows: ReturnType<typeof wifiBuildMsg>) => void,
) {
	const { jest, spyOn } = await import("bun:test");
	const deepStrictEqual: typeof import("node:assert/strict").deepStrictEqual = (
		await import("node:assert/strict")
	).deepStrictEqual;
	const { logger } = await import("../../helpers/logger.ts");
	const runner = await import("../../helpers/run.ts");
	const mocks = await import("../../mocks/mock-service.ts");
	const { getConfig, getConfigFilePath, setConfigFilePath } = await import(
		"../../modules/config.ts"
	);
	const { wifiAdapterModeRecorder } = await import(
		"../../modules/wifi/wifi-adapter-mode.ts"
	);
	const { onWifiChange, setWifiState } = await import(
		"../../modules/wifi/state/wifi-state.ts"
	);
	const wifi = await import("../../modules/wifi/wifi.ts");
	const { currentHotspotApIfnames, wifiBuildMsg } = wifi;
	const { setApStaCapabilityRunnerForTest } = await import(
		"../../modules/wifi/wifi-ap-sta-capability.ts"
	);
	const {
		refreshWifiCapabilities,
		resetWifiCapabilitiesForTest,
		setWifiCapabilityDepsForTest,
	} = await import("../../modules/wifi/wifi-capabilities.ts");
	const {
		clearWifiInterfacesForTest,
		getWifiInterfacesByMacAddress,
		resetWifiScanStampsForTest,
		wifiCancelScanRefresh,
		wifiStateInit,
	} = await import("../../modules/wifi/wifi-connections.ts");
	const {
		wifiDeviceListAdd,
		wifiDeviceListEndUpdate,
		wifiDeviceListStartUpdate,
	} = await import("../../modules/wifi/wifi-device-list.ts");
	const { wifiHotspotPrepare, wifiHotspotStart } = await import(
		"../../modules/wifi/wifi-hotspot-activation.ts"
	);
	const {
		refreshHotspotClients,
		resetHotspotClientsForTest,
		setHotspotClientsDepsForTest,
	} = await import("../../modules/wifi/wifi-hotspot-clients.ts");
	const { handleWifiMonitorEvent } = await import(
		"../../modules/wifi/wifi-hotspot-monitor.ts"
	);
	const {
		getWifiIdToMacAddress,
		resetWifiConnectionModeCache,
		resetWifiInterfaceDiscoveryForTest,
		stopWifiUpdateLoopForTest,
		wifiUpdateDevices,
	} = await import("../../modules/wifi/wifi-interfaces.ts");
	const { setPermanentMacReaderForTest } = await import(
		"../../modules/wifi/wifi-permanent-mac.ts"
	);
	const { wifiRadioIdentity } = await import(
		"../../modules/wifi/wifi-radio-identity.ts"
	);
	const { projectWifiRadioIncarnation } = await import(
		"../../modules/wifi/wifi-radio-publication.ts"
	);
	const compat = await import("../../rpc/compat.ts");
	const { getClients } = await import("../../rpc/events.ts");
	jest.useFakeTimers();
	jest.setSystemTime(0);
	let phase = "setup";
	const broadcasts: Array<{ phase: string; at: number; payload: unknown }> = [];
	let radios: readonly RadioFixture[] = [];
	const unexpected: string[] = [];
	const calls: unknown[][] = [];
	const logs: Array<{ level: string; args: unknown[] }> = [];
	const localBroadcasts: Array<{
		type: string;
		payload: unknown;
		recipients: number;
		log: (typeof logs)[number] | undefined;
	}> = [];
	const publicationLogs = new Set<(typeof logs)[number]>();
	const store = new Map<string, HotspotCredentials>();
	const nm = createEquivalenceNm(() => radios, unexpected);
	const restorers: Array<() => void | Promise<void>> = [];
	const previousConfigPath = getConfigFilePath();
	const previousModes = getConfig().wifi_modes;
	const modeScratch = await mkdtemp(join(tmpdir(), "wifi-parity-modes-"));
	setConfigFilePath(join(modeScratch, "config.json"));
	getConfig().wifi_modes = {};
	restorers.push(async () => {
		getConfig().wifi_modes = previousModes;
		setConfigFilePath(previousConfigPath);
		await rm(modeScratch, { recursive: true, force: true });
	});
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
	const realLocal = compat.broadcastMsgLocal;
	const localSink = spyOn(compat, "broadcastMsgLocal").mockImplementation(
		(type, data, activeMin = 0, except, authedOnly = true) => {
			const recipients = [...getClients()].filter(
				(client) =>
					client !== except &&
					(!authedOnly || client.data.isAuthenticated) &&
					client.data.lastActive >= activeMin,
			).length;
			const result = realLocal(type, data, activeMin, except, authedOnly);
			localBroadcasts.push({
				type,
				payload: structuredClone(data),
				recipients,
				log: logs.at(-1),
			});
			return result;
		},
	);
	restorers.push(() => localSink.mockRestore());
	if (duplicateBroadcast) {
		const owner = wifi.broadcastWifiState;
		const doubled = spyOn(wifi, "broadcastWifiState").mockImplementation(() => {
			owner();
			owner();
		});
		restorers.push(() => doubled.mockRestore());
	}
	const command = spyOn(runner, "run").mockImplementation(nm.run);
	const mockMode = spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
	restorers.push(
		() => command.mockRestore(),
		() => mockMode.mockRestore(),
	);
	clearWifiInterfacesForTest();
	resetWifiInterfaceDiscoveryForTest();
	resetWifiConnectionModeCache();
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

	let confirmedUuid: string | undefined;
	const deps: HotspotActivationDeps = {
		readProfileInstance: async () => undefined,
		releaseConcurrentInterface: async () => true,
		recordIntent: wifiAdapterModeRecorder,
		pollHotspotActive: async (_iface, uuid) => confirmedUuid === uuid,
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
		nmApConnAdd: async (ifname, identity, bindingFields) => {
			calls.push(["nmApConnAdd", ifname, identity, bindingFields]);
			return `fixture-uuid-${ifname}`;
		},
		nmConnDelete: async () => true,
		nmDisconnect: async () => true,
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
			logs: logs.filter((entry) => !publicationLogs.has(entry)),
		});
	const frames = [];
	try {
		for (const frame of fixture.frames) {
			phase = "discovery:pending";
			radios = frame;
			nm.reset();
			wifiDeviceListStartUpdate();
			for (const radio of radios) {
				if (radio.operational)
					wifiDeviceListAdd(radio.ifname, radio.operational);
			}
			wifiDeviceListEndUpdate();
			const discovery = wifiUpdateDevices();
			if (fixture.duringDiscovery) await fixture.duringDiscovery(discovery);
			await discovery;
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
				confirmedUuid = undefined;
				const start = await wifiHotspotStart({ device: iface.id }, deps);
				phase = "start:published";
				const starting = snapshot();
				phase = "confirmation:pending";
				if (canHotspot(iface) && iface.hotspot.conn)
					nm.activate(iface.ifname, iface.hotspot.conn);
				confirmedUuid = "hotspot" in iface ? iface.hotspot.conn : undefined;
				await handleWifiMonitorEvent({
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
			const wireBefore = new Map(
				Object.values(getWifiInterfacesByMacAddress()).map((row) => [
					row.ifname,
					projectWifiRadioIncarnation(
						row,
						wifiRadioIdentity.state.rows.get(row.ifname),
					),
				]),
			);
			const beforeLocal = localBroadcasts.length;
			if (fixture.resample) {
				const { wifiRadioObservation } = await import(
					"../../modules/wifi/wifi-radio-observation.ts"
				);
				wifiRadioObservation.enqueue(
					Object.values(getWifiInterfacesByMacAddress()).map((row) => ({
						ifname: row.ifname,
						row,
						...(row.degradedReason
							? { degradedReason: row.degradedReason }
							: {}),
					})),
					wifiRadioIdentity.publishedObservation,
				);
			}
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
			const tokenChanged = Object.values(getWifiInterfacesByMacAddress()).some(
				(row) =>
					wireBefore.get(row.ifname) !==
					projectWifiRadioIncarnation(
						row,
						wifiRadioIdentity.state.rows.get(row.ifname),
					),
			);
			const publicationFrames = localBroadcasts.slice(beforeLocal);
			deepStrictEqual(
				publicationFrames.map(({ type, payload }) => ({ type, payload })),
				tokenChanged
					? [{ type: "status", payload: { wifi: wifiBuildMsg() } }]
					: [],
				"Detached shadow changed legacy state: publication frame count or payload",
			);
			for (const frame of publicationFrames) {
				deepStrictEqual(
					frame.log,
					{
						level: "debug",
						args: ["broadcast", { event: "status", clients: frame.recipients }],
					},
					"Detached shadow changed legacy state: publication debug log",
				);
				if (frame.log) publicationLogs.add(frame.log);
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
			await handleWifiMonitorEvent({
				type: "device-state",
				device: iface.ifname,
				state: "connected",
			});
		}
		clearWifiInterfacesForTest();
		resetWifiInterfaceDiscoveryForTest();
		resetWifiConnectionModeCache();
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
