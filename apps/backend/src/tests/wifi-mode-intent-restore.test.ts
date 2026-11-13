import {
	afterEach,
	beforeEach,
	expect,
	jest,
	mock,
	spyOn,
	test,
} from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WifiAdapterMode } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { logger } from "../helpers/logger.ts";
import * as mocks from "../mocks/mock-service.ts";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import * as networkManager from "../modules/network/network-manager.ts";
import * as streaming from "../modules/streaming/streaming.ts";
import { hotspotCredentialsStore } from "../modules/wifi/hotspot-credentials.ts";
import {
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import { handleWifi } from "../modules/wifi/wifi.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../modules/wifi/wifi-adapter-lock.ts";
import {
	getPersistedWifiAdapterMode,
	getPersistedWifiAdapterModes,
	observedWifiAdapterMode,
	persistWifiAdapterMode,
	recordWifiAdapterModeIntent,
	restoreWifiAdapterMode,
	wifiAdapterModeRecorder,
} from "../modules/wifi/wifi-adapter-mode.ts";
import {
	notifyWifiAdapterModeDiscovery,
	notifyWifiAdapterModeEdge,
} from "../modules/wifi/wifi-adapter-mode-events.ts";
import * as transition from "../modules/wifi/wifi-adapter-mode-transition.ts";
import {
	resetApStaCapabilityStateForTest,
	setApStaCapabilityRunnerForTest,
	supportsApStaConcurrency,
} from "../modules/wifi/wifi-ap-sta-capability.ts";
import {
	getWifiCapabilitiesForInterface,
	refreshWifiCapabilities,
	resetWifiCapabilitiesForTest,
	setWifiCapabilityDepsForTest,
} from "../modules/wifi/wifi-capabilities.ts";
import { addWifiInterface } from "../modules/wifi/wifi-connections.ts";
import {
	defaultHotspotDeps,
	wifiHotspotStart,
} from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	defaultHotspotConfigDeps,
	defaultHotspotStopDeps,
	reconfigureHotspotForRegdomain,
	wifiHotspotStop,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import type { WifiInterfaceWithHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import {
	getWifiIdToMacAddress,
	wifiUpdateDevices,
} from "../modules/wifi/wifi-interfaces.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
import {
	hotspotStartProcedure,
	hotspotStopProcedure,
} from "../rpc/procedures/wifi.procedure.ts";
import { wifiProtocolContext } from "./helpers/wifi-protocol-context.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const MAC = "dc:a6:32:01:02:03";
const IFNAME = "wlan-intent";
const PROFILE = "intent-ap";
let row: WifiInterfaceWithHotspot;
let inherited: ReturnType<typeof isolateWifiRegistry>;
let previousPath: string;
let previousModes: ReturnType<typeof getConfig>["wifi_modes"];
let scratch: string;
let streamingOn: boolean;
let acceptsActivation: boolean;
let acceptsStop: boolean;
let transcript: string[];
let modesAtEffect: Array<WifiAdapterMode | undefined>;
let warnings: string[];
let stopRestore: (() => void) | undefined;

function radio(capability: boolean | undefined): WifiInterfaceWithHotspot {
	return {
		id: 0,
		ifname: IFNAME,
		conn: "station-link",
		hw: "Intent test radio",
		available: new Map(),
		saved: {},
		savedAll: {},
		...(capability === undefined
			? {}
			: { supportsApStaConcurrency: capability }),
		hotspot: {
			conn: PROFILE,
			name: "Intent AP",
			password: "fixture-password",
			channel: "auto",
			availableChannels: ["auto"],
			warnings: {},
		},
	};
}

function seed(next = radio(false)): void {
	row = next;
	addWifiInterface(MAC, row);
	getWifiIdToMacAddress()[0] = MAC;
}

function effect(name: string): void {
	transcript.push(name);
	modesAtEffect.push(getPersistedWifiAdapterMode(MAC));
}

function observed(mode: WifiAdapterMode): void {
	row.conn = mode === "hotspot" ? PROFILE : "station-link";
	row.activeConn = row.conn;
	row.activeMode = mode === "hotspot" ? "ap" : "infrastructure";
	if (mode === "hybrid") {
		row.concurrentHotspot = { ifname: "clap-intent", activeConn: PROFILE };
	} else {
		delete row.concurrentHotspot;
	}
}

async function diskModes(): Promise<Record<string, WifiAdapterMode>> {
	const file = Bun.file(getConfigFilePath());
	return (await file.exists()) ? ((await file.json()).wifi_modes ?? {}) : {};
}

function bootSource() {
	let published = false;
	let listener: (() => Promise<void>) | undefined;
	return {
		hasDiscovery: () => published,
		subscribe: (callback: () => Promise<void>) => {
			listener = callback;
			return () => {
				listener = undefined;
			};
		},
		publish: async (discovery = true) => {
			published ||= discovery;
			await listener?.();
		},
	};
}

function modeDeps(): transition.AdapterModeTransitionDeps {
	return {
		...transition.defaultAdapterModeDeps,
		readCapabilities: (ifname) => defaultHotspotDeps.readCapabilities?.(ifname),
	};
}

function useLiveCapabilities(): void {
	Object.assign(defaultHotspotDeps, {
		readCapabilities: getWifiCapabilitiesForInterface,
	});
}

async function seedFailedProbe(): Promise<void> {
	useLiveCapabilities();
	setApStaCapabilityRunnerForTest(async () => {
		throw new Error("fixture iw unavailable");
	});
	seed(radio(await supportsApStaConcurrency(IFNAME)));
}

async function publishRealCapabilities(): Promise<void> {
	const fixture = (name: string) =>
		readFile(join(import.meta.dir, "fixtures", "wifi", name), "utf8");
	const [phy, reg, dev] = await Promise.all([
		fixture("iw-phy-rock5bplus-rtl8852be.txt"),
		fixture("iw-reg-get-rock5bplus.txt"),
		fixture("iw-dev-rock5bplus.txt"),
	]);
	setWifiCapabilityDepsForTest({
		runIw: async (args) =>
			args[0] === "phy" ? phy : args[0] === "reg" ? reg : dev,
		readPhyName: async () => "phy0",
		pathExists: async () => false,
		readNmcliWifiProperties: async () => undefined,
		now: () => 0,
	});
	await refreshWifiCapabilities([IFNAME]);
	await notifyWifiAdapterModeEdge();
}

function startRestore(source: ReturnType<typeof bootSource>): void {
	// The unchanged implementation's one-shot wait is the negative control.
	if (
		"startWifiAdapterModeRestore" in transition &&
		typeof transition.startWifiAdapterModeRestore === "function"
	) {
		stopRestore = transition.startWifiAdapterModeRestore(modeDeps(), source);
	} else {
		void Reflect.apply(transition.reconcileWifiAdapterModes, undefined, [
			modeDeps(),
			getPersistedWifiAdapterModes,
			(ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
		]);
	}
}

async function advance(seconds: number): Promise<void> {
	for (let second = 0; second < seconds; second++) {
		jest.advanceTimersByTime(1000);
		for (let turn = 0; turn < 30; turn++) await Promise.resolve();
	}
}

beforeEach(async () => {
	jest.useFakeTimers();
	inherited = isolateWifiRegistry();
	previousPath = getConfigFilePath();
	previousModes = getConfig().wifi_modes;
	scratch = await mkdtemp(join(tmpdir(), "wifi-mode-intent-"));
	setConfigFilePath(join(scratch, "config.json"));
	getConfig().wifi_modes = {};
	onWifiChange(() => {});
	setWifiState({});
	streamingOn = false;
	acceptsActivation = true;
	acceptsStop = true;
	transcript = [];
	modesAtEffect = [];
	warnings = [];
	Object.assign(defaultHotspotDeps, {
		readCapabilities: () =>
			row?.supportsApStaConcurrency === undefined
				? undefined
				: { staApCombo: { supported: row.supportsApStaConcurrency } },
	});
	spyOn(logger, "warn").mockImplementation((message) => {
		warnings.push(String(message));
		return logger;
	});
	spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
	spyOn(streaming, "getIsStreaming").mockImplementation(() => streamingOn);
	spyOn(hotspotCredentialsStore, "get").mockReturnValue(undefined);
	spyOn(hotspotCredentialsStore, "remember").mockImplementation(() => {});
	spyOn(defaultHotspotDeps, "nmConnSetFields").mockImplementation(async () => {
		effect("fields");
		return true;
	});
	spyOn(defaultHotspotDeps, "nmConnect").mockImplementation(async () => {
		effect("activate");
		return acceptsActivation;
	});
	spyOn(defaultHotspotDeps, "nmHotspot").mockImplementation(async () => {
		effect("create");
		return PROFILE;
	});
	spyOn(defaultHotspotDeps, "broadcastState").mockImplementation(() => {});
	spyOn(defaultHotspotDeps, "setDupIpSuppression").mockImplementation(() => {});
	spyOn(defaultHotspotDeps, "pruneHotspotConns").mockImplementation(
		async () => {},
	);
	spyOn(defaultHotspotDeps, "ensureConcurrentInterface").mockImplementation(
		async () => {
			effect("virtual");
			return { ifname: "clap-intent", created: true };
		},
	);
	spyOn(defaultHotspotDeps, "releaseConcurrentInterface").mockImplementation(
		async () => {},
	);
	spyOn(defaultHotspotDeps, "pollHotspotActive").mockImplementation(
		async () => true,
	);
	spyOn(defaultHotspotStopDeps, "nmConnSetFields").mockImplementation(
		async () => {
			effect("stop-fields");
			return true;
		},
	);
	spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(async () => {
		effect("disconnect");
		return acceptsStop;
	});
	spyOn(
		defaultHotspotStopDeps,
		"releaseConcurrentInterface",
	).mockImplementation(async () => {});
	spyOn(defaultHotspotStopDeps, "broadcastState").mockImplementation(() => {});
	spyOn(defaultHotspotStopDeps, "setDupIpSuppression").mockImplementation(
		() => {},
	);
	spyOn(defaultHotspotStopDeps, "rescan").mockImplementation(async () => {});
	seed();
});

afterEach(async () => {
	stopRestore?.();
	stopRestore = undefined;
	wifiRadioObservation.stop();
	resetWifiCapabilitiesForTest();
	resetApStaCapabilityStateForTest();
	settlePending(IFNAME, false);
	jest.clearAllTimers();
	jest.useRealTimers();
	mock.restore();
	useLiveCapabilities();
	getConfig().wifi_modes = previousModes;
	setConfigFilePath(previousPath);
	delete getWifiIdToMacAddress()[0];
	restoreWifiRegistry(inherited);
	setWifiState({});
	await rm(scratch, { recursive: true, force: true });
});

for (const capability of [false, true] as const) {
	test(`(1) confirmed direct ${capability ? "hybrid" : "exclusive"} start records its actual mode before effects`, async () => {
		seed(radio(capability));
		const mode = capability ? "hybrid" : "hotspot";
		const result = await call(
			hotspotStartProcedure,
			{ device: "0" },
			{ context: wifiProtocolContext() },
		);
		settlePending(IFNAME, true);
		expect(result).toEqual({ success: true, accepted: true });
		expect(observedWifiAdapterMode(row)).toBe(mode);
		expect(await diskModes()).toEqual({ [MAC]: mode });
		expect(modesAtEffect.every((value) => value === mode)).toBe(true);
		expect(transcript).toContain("activate");
	});
}

test("(1) stop remembers station under the same key as direct start, before teardown", async () => {
	await wifiHotspotStart({ device: 0 });
	settlePending(IFNAME, true);
	modesAtEffect = [];
	const result = await call(
		hotspotStopProcedure,
		{ device: "0" },
		{ context: wifiProtocolContext() },
	);
	expect(result).toEqual({ success: true });
	expect(observedWifiAdapterMode(row)).toBe("station");
	expect(await diskModes()).toEqual({ [MAC]: "station" });
	expect(modesAtEffect).toEqual(["station", "station"]);
});

for (const previous of [undefined, "station", "hotspot", "hybrid"] as const) {
	test(`(1) refused start restores ${previous ?? "an absent key"} in the real store`, async () => {
		if (previous !== undefined) persistWifiAdapterMode(MAC, previous);
		seed(radio(true));
		acceptsActivation = false;
		expect(await wifiHotspotStart({ device: 0 })).toEqual({
			success: false,
			error: "activation-failed",
		});
		expect(await diskModes()).toEqual(
			previous === undefined ? {} : { [MAC]: previous },
		);
		expect(observedWifiAdapterMode(row)).toBe("station");
	});
}

test("(2) an adapter appearing fifteen seconds after boot is restored on its discovery edge", async () => {
	persistWifiAdapterMode(MAC, "hotspot");
	restoreWifiRegistry([]);
	const source = bootSource();
	startRestore(source);
	await source.publish();
	await advance(15);
	seed();
	await source.publish();
	settlePending(IFNAME, true);
	expect(observedWifiAdapterMode(row)).toBe("hotspot");
	expect(await diskModes()).toEqual({ [MAC]: "hotspot" });
	expect(transcript).toContain("activate");
	expect(jest.getTimerCount()).toBe(0);
});

test("(3) boot does not act before discovery has published", async () => {
	persistWifiAdapterMode(MAC, "hotspot");
	const source = bootSource();
	startRestore(source);
	await advance(1);
	expect(transcript).toEqual([]);
	expect(observedWifiAdapterMode(row)).toBe("station");
	await source.publish();
	settlePending(IFNAME, true);
	expect(observedWifiAdapterMode(row)).toBe("hotspot");
});

test("(4) streaming restore stays pending with an empty NM transcript, logs once, and re-arms on clearance", async () => {
	persistWifiAdapterMode(MAC, "hotspot");
	streamingOn = true;
	const source = bootSource();
	startRestore(source);
	await source.publish();
	await source.publish();
	expect(transcript).toEqual([]);
	expect(await diskModes()).toEqual({ [MAC]: "hotspot" });
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toContain("streaming");
	console.info(
		"B2_STREAMING_RESTORE",
		JSON.stringify({
			networkManager: transcript,
			intent: await diskModes(),
			warnings: warnings.length,
		}),
	);
	streamingOn = false;
	await source.publish(false);
	settlePending(IFNAME, true);
	expect(observedWifiAdapterMode(row)).toBe("hotspot");
	expect(jest.getTimerCount()).toBe(0);
});

for (const active of ["hotspot", "hybrid", "foreign", "pending"] as const) {
	test(`(5) restore leaves ${active} APs alone`, async () => {
		seed(radio(true));
		persistWifiAdapterMode(MAC, active === "hotspot" ? "hybrid" : "hotspot");
		if (active === "pending") row.hotspot.transition = "activating";
		else if (active === "foreign") row.activeMode = "ap";
		else observed(active);
		const source = bootSource();
		startRestore(source);
		await source.publish();
		await source.publish();
		expect(transcript).toEqual([]);
	});
}

for (const from of ["hybrid", "hotspot"] as const) {
	const target = from === "hybrid" ? "hotspot" : "hybrid";
	test(`(6) real delegates switch ${from} to ${target} without recording the intermediate stop`, async () => {
		seed(radio(true));
		observed(from);
		persistWifiAdapterMode(MAC, from);
		const result = await transition.setWifiAdapterMode(0, target, modeDeps());
		settlePending(IFNAME, true);
		expect(result.success).toBe(true);
		expect(await diskModes()).toEqual({ [MAC]: target });
		expect(observedWifiAdapterMode(row)).toBe(target);
		expect(modesAtEffect.every((mode) => mode === target)).toBe(true);
		expect(transcript).toContain("disconnect");
		expect(transcript).toContain("activate");
	});
}

for (const path of ["direct", "mode"] as const) {
	test(`(7) ${path} exclusive start while streaming refuses without any write or NM effect and logs once`, async () => {
		streamingOn = true;
		const result =
			path === "direct"
				? await wifiHotspotStart({ device: 0 })
				: await transition.setWifiAdapterMode(0, "hotspot", modeDeps());
		expect(result).toEqual({ success: false, error: "DEVICE_BUSY" });
		expect(getPersistedWifiAdapterModes()).toEqual({});
		expect(await Bun.file(getConfigFilePath()).exists()).toBe(false);
		expect(transcript).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("streaming");
		console.info(
			`B2_STREAMING_${path.toUpperCase()}`,
			JSON.stringify({
				networkManager: transcript,
				intent: getPersistedWifiAdapterModes(),
				warnings: warnings.length,
			}),
		);
	});
}

for (const path of ["direct-hybrid", "stop", "station", "hybrid"] as const) {
	test(`(7) streaming permits ${path} without dropping the station connection`, async () => {
		seed(radio(true));
		streamingOn = true;
		if (path === "stop" || path === "station") observed("hybrid");
		const result =
			path === "direct-hybrid"
				? await wifiHotspotStart({ device: 0 })
				: path === "stop"
					? await wifiHotspotStop({ device: 0 })
					: await transition.setWifiAdapterMode(0, path, modeDeps());
		settlePending(IFNAME, true);
		expect(result.success).toBe(true);
		expect(row.conn).toBe("station-link");
		expect(getPersistedWifiAdapterMode(MAC)).toBe(
			path === "stop" || path === "station" ? "station" : "hybrid",
		);
	});
}

for (const capability of [false, undefined] as const) {
	test(`(8) persisted hybrid with ${String(capability)} capability refuses direct start and restore without NM calls`, async () => {
		seed(radio(capability));
		persistWifiAdapterMode(MAC, "hybrid");
		expect(await wifiHotspotStart({ device: 0 })).toEqual({
			success: false,
			error: "activation-failed",
		});
		expect(transcript).toEqual([]);
		expect(warnings).toHaveLength(1);
		warnings = [];
		const source = bootSource();
		startRestore(source);
		await source.publish();
		await source.publish();
		expect(transcript).toEqual([]);
		expect(await diskModes()).toEqual({ [MAC]: "hybrid" });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("activation-failed");
		expect(
			await transition.setWifiAdapterMode(0, "hybrid", modeDeps()),
		).toEqual({
			success: false,
			error: "capability-unproven",
		});
	});
}

for (const previous of [undefined, "station"] as const) {
	test(`(8) ${previous ?? "absent"} intent on a proven non-hybrid radio still allows exclusive start`, async () => {
		if (previous !== undefined) persistWifiAdapterMode(MAC, previous);
		expect(await wifiHotspotStart({ device: 0 })).toEqual({ success: true });
		settlePending(IFNAME, true);
		expect(observedWifiAdapterMode(row)).toBe("hotspot");
		expect(await diskModes()).toEqual({ [MAC]: "hotspot" });
	});
}

test("unknown capability and absent intent allow exclusive start without pinning future boots to hotspot", async () => {
	seed(radio(undefined));
	expect(await wifiHotspotStart({ device: 0 })).toEqual({ success: true });
	settlePending(IFNAME, true);
	expect(observedWifiAdapterMode(row)).toBe("hotspot");
	expect(getPersistedWifiAdapterModes()).toEqual({});
	expect(await Bun.file(getConfigFilePath()).exists()).toBe(false);
});

test("unknown capability preserves a station choice instead of pinning exclusive mode", async () => {
	seed(radio(undefined));
	persistWifiAdapterMode(MAC, "station");
	expect(await wifiHotspotStart({ device: 0 })).toEqual({ success: true });
	settlePending(IFNAME, true);
	expect(observedWifiAdapterMode(row)).toBe("hotspot");
	expect(await diskModes()).toEqual({ [MAC]: "station" });
});

test("capability arrival retries pending hybrid once and a duplicate edge does not start twice", async () => {
	await seedFailedProbe();
	persistWifiAdapterMode(MAC, "hybrid");
	stopRestore = transition.startWifiAdapterModeRestore(modeDeps());
	await notifyWifiAdapterModeDiscovery();
	expect(transcript).toEqual([]);
	expect(row.supportsApStaConcurrency).toBe(false);
	transcript = [];
	await publishRealCapabilities();
	settlePending(IFNAME, true);
	const completed = [...transcript];
	await notifyWifiAdapterModeEdge();
	expect(observedWifiAdapterMode(row)).toBe("hybrid");
	expect(transcript).toEqual(completed);
	expect(completed).toContain("virtual");
});

test("boot apply re-reads intent and cannot restore a snapshot over a newer station choice", async () => {
	persistWifiAdapterMode(MAC, "hotspot");
	restoreWifiRegistry([]);
	const source = bootSource();
	startRestore(source);
	await advance(1);
	persistWifiAdapterMode(MAC, "station");
	seed();
	await source.publish();
	await advance(10);
	expect(await diskModes()).toEqual({ [MAC]: "station" });
	expect(observedWifiAdapterMode(row)).toBe("station");
	expect(transcript).toEqual([]);
});

for (const mode of ["station", "hotspot", "hybrid"] as const) {
	test(`the already-${mode} shortcut records only a proven mode choice under the lock`, async () => {
		seed(radio(true));
		observed(mode);
		const result =
			mode === "station"
				? await wifiHotspotStop({ device: 0 })
				: await wifiHotspotStart({ device: 0 });
		expect(result).toEqual({ success: true });
		expect(await diskModes()).toEqual(
			mode === "hotspot" ? {} : { [MAC]: mode },
		);
		expect(transcript).toEqual([]);
	});
}

test("failed stop restores its previous intent after prewriting station", async () => {
	observed("hotspot");
	persistWifiAdapterMode(MAC, "hotspot");
	acceptsStop = false;
	expect(await wifiHotspotStop({ device: 0 })).toEqual({
		success: false,
		error: "deactivation-failed",
	});
	expect(await diskModes()).toEqual({ [MAC]: "hotspot" });
	expect(modesAtEffect).toEqual(["station", "station"]);
});

test("a throwing start restores its previous intent at the lock exit", async () => {
	persistWifiAdapterMode(MAC, "station");
	spyOn(defaultHotspotDeps, "ensureConcurrentInterface").mockImplementation(
		async () => {
			throw new Error("fixture allocation failed");
		},
	);
	seed(radio(true));
	await expect(wifiHotspotStart({ device: 0 })).rejects.toThrow(
		"fixture allocation failed",
	);
	expect(await diskModes()).toEqual({ [MAC]: "station" });
});

test("not-confirmed retains the accepted target", async () => {
	spyOn(defaultHotspotDeps, "pollHotspotActive").mockImplementation(
		() => new Promise<boolean>(() => {}),
	);
	expect(await wifiHotspotStart({ device: 0 })).toEqual({ success: true });
	settlePending(IFNAME, false);
	expect(observedWifiAdapterMode(row)).toBe("station");
	expect(await diskModes()).toEqual({ [MAC]: "hotspot" });
});

test("a failed mode operation cannot undo a newer intent and holds the lock through delegation", async () => {
	persistWifiAdapterMode(MAC, "hybrid");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<boolean>();
	spyOn(defaultHotspotDeps, "nmConnect").mockImplementation(async () => {
		entered.resolve();
		return release.promise;
	});
	const older = transition.setWifiAdapterMode(0, "hotspot", modeDeps());
	await entered.promise;
	try {
		expect(
			await transition.setWifiAdapterMode(0, "station", modeDeps()),
		).toEqual({ success: false, error: "DEVICE_BUSY" });
		persistWifiAdapterMode(MAC, "station");
	} finally {
		release.resolve(false);
	}
	expect(await older).toEqual({ success: false, error: "activation-failed" });
	expect(await diskModes()).toEqual({ [MAC]: "station" });
});

test("a direct start cannot roll back over an externally superseding intent", async () => {
	persistWifiAdapterMode(MAC, "hybrid");
	seed(radio(true));
	spyOn(defaultHotspotDeps, "nmConnect").mockImplementation(async () => {
		persistWifiAdapterMode(MAC, "station");
		return false;
	});
	expect(await wifiHotspotStart({ device: 0 })).toEqual({
		success: false,
		error: "activation-failed",
	});
	expect(await diskModes()).toEqual({ [MAC]: "station" });
});

test("busy already-there mode and toggle shortcuts persist nothing", async () => {
	const result = await withWifiAdapterLock(
		wifiAdapterLockKey(MAC),
		async () => {
			expect(
				await transition.setWifiAdapterMode(0, "station", modeDeps()),
			).toEqual({ success: false, error: "DEVICE_BUSY" });
			expect(await wifiHotspotStart({ device: 0 })).toEqual({
				success: false,
				error: "DEVICE_BUSY",
			});
			expect(await wifiHotspotStop({ device: 0 })).toEqual({
				success: false,
				error: "DEVICE_BUSY",
			});
		},
	);
	expect(result.success).toBe(true);
	expect(getPersistedWifiAdapterModes()).toEqual({});
	expect(transcript).toEqual([]);
});

for (const succeeds of [true, false]) {
	test(`regulatory ${succeeds ? "reconfigure" : "rollback"} preserves the real mode store`, async () => {
		observed("hotspot");
		persistWifiAdapterMode(MAC, "hotspot");
		let forward = true;
		const result = await reconfigureHotspotForRegdomain(MAC, row, "auto", {
			...defaultHotspotConfigDeps,
			nmConnSetFields: async () => true,
			nmConnect: async () => {
				if (forward) {
					forward = false;
					return succeeds;
				}
				return true;
			},
			wifiUpdateSavedConns: async () => {},
			broadcastState: () => {},
			rememberCredentials: () => {},
			getCapabilities: () => undefined,
		});
		expect(result).toBe(succeeds);
		expect(await diskModes()).toEqual({ [MAC]: "hotspot" });
	});
}

test("stopping the boot subscription prevents a late discovery from applying", async () => {
	persistWifiAdapterMode(MAC, "hotspot");
	const source = bootSource();
	startRestore(source);
	stopRestore?.();
	await source.publish();
	expect(transcript).toEqual([]);
	expect(jest.getTimerCount()).toBe(0);
});

test("real discovery, capability publication and streaming clearance drive the boot subscription", async () => {
	restoreWifiRegistry([]);
	persistWifiAdapterMode(MAC, "hotspot");
	streamingOn = true;
	streaming.updateStatus(true);
	stopRestore = transition.startWifiAdapterModeRestore(modeDeps());
	spyOn(networkManager, "nmDevices").mockResolvedValue([]);
	await wifiUpdateDevices();
	for (let turn = 0; turn < 30; turn++) await Promise.resolve();
	expect(warnings).toEqual([]);
	seed();
	setWifiCapabilityDepsForTest({
		runIw: async (args) => (args[0] === "reg" ? "country US: DFS-FCC\n" : ""),
		readPhyName: async () => undefined,
		pathExists: async () => false,
		readNmcliWifiProperties: async () => undefined,
		now: () => 0,
	});
	await refreshWifiCapabilities([IFNAME]);
	for (let turn = 0; turn < 30; turn++) await Promise.resolve();
	expect(transcript).toEqual([]);
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toContain("streaming");
	const applied = Promise.withResolvers<void>();
	spyOn(defaultHotspotDeps, "nmConnect").mockImplementation(async () => {
		effect("activate");
		applied.resolve();
		return true;
	});
	streamingOn = false;
	streaming.updateStatus(false);
	await applied.promise;
	for (let turn = 0; turn < 30; turn++) await Promise.resolve();
	settlePending(IFNAME, true);
	expect(observedWifiAdapterMode(row)).toBe("hotspot");
	expect(await diskModes()).toEqual({ [MAC]: "hotspot" });
});

test("legacy Start and Stop dispatch remember their choices through the unchanged handlers", async () => {
	const started = Promise.withResolvers<void>();
	spyOn(defaultHotspotDeps, "nmConnect").mockImplementation(async () => {
		effect("activate");
		started.resolve();
		return true;
	});
	handleWifi(wifiProtocolContext().ws, { hotspot: { start: { device: 0 } } });
	await started.promise;
	for (let turn = 0; turn < 30; turn++) await Promise.resolve();
	settlePending(IFNAME, true);
	expect(await diskModes()).toEqual({ [MAC]: "hotspot" });
	const stopped = Promise.withResolvers<void>();
	spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(async () => {
		effect("disconnect");
		stopped.resolve();
		return true;
	});
	handleWifi(wifiProtocolContext().ws, { hotspot: { stop: { device: 0 } } });
	await stopped.promise;
	for (let turn = 0; turn < 30; turn++) await Promise.resolve();
	expect(await diskModes()).toEqual({ [MAC]: "station" });
	expect(observedWifiAdapterMode(row)).toBe("station");
});

test("the event leaf imports without preload or application files and cannot retain a process", async () => {
	const modulePath = new URL(
		"../modules/wifi/wifi-adapter-mode-events.ts",
		import.meta.url,
	).href;
	const child = Bun.spawn(
		[
			"bun",
			"-e",
			`const m = await import(${JSON.stringify(modulePath)}); const cancel = m.wifiAdapterModeRestoreSource.subscribe(() => new Promise(() => {})); void m.notifyWifiAdapterModeDiscovery(); cancel(); console.log("MODE_EVENTS_EXIT");`,
		],
		{
			cwd: scratch,
			env: process.env,
			stdout: "pipe",
			stderr: "pipe",
			timeout: 3000,
		},
	);
	const [exit, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ exit, stdout, stderr }).toEqual({
		exit: 0,
		stdout: "MODE_EVENTS_EXIT\n",
		stderr: "",
	});
	expect(await Bun.file(join(scratch, "setup.json")).exists()).toBe(false);
});

for (const path of ["direct-start", "direct-stop", "mode"] as const) {
	for (const hasPrevious of [false, true]) {
		test(`F1 ${path} keeps durable ${hasPrevious ? "intent" : "absence"} when persistence throws`, async () => {
			const previous = path === "direct-stop" ? "hotspot" : "station";
			if (hasPrevious) persistWifiAdapterMode(MAC, previous);
			if (path === "direct-stop") observed("hotspot");
			const durablePath = getConfigFilePath();
			const before = await diskModes();
			const failingPath = join(scratch, "unwritable-config");
			await mkdir(failingPath);
			setConfigFilePath(failingPath);
			const operation =
				path === "direct-start"
					? wifiHotspotStart({ device: 0 })
					: path === "direct-stop"
						? wifiHotspotStop({ device: 0 })
						: transition.setWifiAdapterMode(0, "hotspot", modeDeps());
			await expect(operation).rejects.toThrow();
			expect(transcript).toEqual([]);
			expect(getPersistedWifiAdapterModes()).toEqual(before);
			setConfigFilePath(durablePath);
			expect(await diskModes()).toEqual(before);
		});
	}
}

test("F1 a failed Start write cannot become an AP through later restore", async () => {
	persistWifiAdapterMode(MAC, "station");
	const durablePath = getConfigFilePath();
	const failingPath = join(scratch, "unwritable-config");
	await mkdir(failingPath);
	setConfigFilePath(failingPath);
	await expect(wifiHotspotStart({ device: 0 })).rejects.toThrow();
	setConfigFilePath(durablePath);
	await transition.reconcileWifiAdapterModes(modeDeps());
	settlePending(IFNAME, true);
	expect(transcript).toEqual([]);
	expect(observedWifiAdapterMode(row)).toBe("station");
	expect(getPersistedWifiAdapterModes()).toEqual(await diskModes());
});

test("F1 a throwing restore leaves reads at the last successfully persisted target", async () => {
	persistWifiAdapterMode(MAC, "station");
	const undo = recordWifiAdapterModeIntent(
		MAC,
		"hotspot",
		wifiAdapterModeRecorder,
	);
	const durablePath = getConfigFilePath();
	const failingPath = join(scratch, "unwritable-config");
	await mkdir(failingPath);
	setConfigFilePath(failingPath);
	expect(undo).toThrow();
	expect(getPersistedWifiAdapterMode(MAC)).toBe("hotspot");
	setConfigFilePath(durablePath);
	expect(getPersistedWifiAdapterModes()).toEqual(await diskModes());
});

test("F1 direct restore deletion is not published when its durable write fails", async () => {
	persistWifiAdapterMode(MAC, "hotspot");
	const durablePath = getConfigFilePath();
	const failingPath = join(scratch, "unwritable-config");
	await mkdir(failingPath);
	setConfigFilePath(failingPath);
	expect(() => restoreWifiAdapterMode(MAC, undefined)).toThrow();
	expect(getPersistedWifiAdapterMode(MAC)).toBe("hotspot");
	setConfigFilePath(durablePath);
	expect(getPersistedWifiAdapterModes()).toEqual(await diskModes());
});

test("F2 direct Start uses fresh parser/cache proof after the initial probe failed", async () => {
	await seedFailedProbe();
	persistWifiAdapterMode(MAC, "hybrid");
	await publishRealCapabilities();
	expect(row.supportsApStaConcurrency).toBe(false);
	expect(await wifiHotspotStart({ device: 0 })).toEqual({ success: true });
	settlePending(IFNAME, true);
	expect(observedWifiAdapterMode(row)).toBe("hybrid");
	expect(row.conn).toBe("station-link");
	expect(transcript).toContain("virtual");
	expect(await diskModes()).toEqual({ [MAC]: "hybrid" });
});

test("F2 proven hybrid capability still requires successful interface allocation", async () => {
	await seedFailedProbe();
	persistWifiAdapterMode(MAC, "hybrid");
	await publishRealCapabilities();
	spyOn(defaultHotspotDeps, "ensureConcurrentInterface").mockImplementation(
		async () => undefined,
	);
	expect(await wifiHotspotStart({ device: 0 })).toEqual({
		success: false,
		error: "activation-failed",
	});
	expect(transcript).toEqual([]);
	expect(observedWifiAdapterMode(row)).toBe("station");
	expect(await diskModes()).toEqual({ [MAC]: "hybrid" });
});

test("F3 the actual failed probe permits exclusive Start without recording hotspot", async () => {
	await seedFailedProbe();
	expect(row.supportsApStaConcurrency).toBe(false);
	expect(getWifiCapabilitiesForInterface(IFNAME)).toBeUndefined();
	expect(await wifiHotspotStart({ device: 0 })).toEqual({ success: true });
	settlePending(IFNAME, true);
	expect(observedWifiAdapterMode(row)).toBe("hotspot");
	expect(getPersistedWifiAdapterModes()).toEqual({});
	expect(await Bun.file(getConfigFilePath()).exists()).toBe(false);
});

for (const newer of ["station", "hotspot", "mode-only"] as const) {
	test(`F4 confirmed teardown preserves a newer ${newer} observation`, async () => {
		observed("hotspot");
		persistWifiAdapterMode(MAC, "hotspot");
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<boolean>();
		spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(
			async () => {
				entered.resolve();
				return finish.promise;
			},
		);
		const stopped = wifiHotspotStop({ device: 0 });
		await entered.promise;
		const uuid = newer === "mode-only" ? PROFILE : `newer-${newer}`;
		row.activeConn = uuid;
		row.activeMode = newer === "hotspot" ? "ap" : "infrastructure";
		row.conn = uuid;
		if (newer === "hotspot") row.hotspot.conn = uuid;
		finish.resolve(true);
		expect(await stopped).toEqual({ success: true });
		expect(row.activeConn).toBe(uuid);
		expect(row.activeMode).toBe(newer === "hotspot" ? "ap" : "infrastructure");
		expect(row.conn).toBe(uuid);
	});
}
