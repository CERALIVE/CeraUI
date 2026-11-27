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
import {
	statusResponseSchema,
	type WifiAdapterMode,
} from "@ceraui/rpc/schemas";
import * as runner from "../helpers/run.ts";
import { run } from "../helpers/run.ts";
import * as config from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import * as streaming from "../modules/streaming/streaming.ts";
import { runIw } from "../modules/wifi/regdomain.ts";
import {
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import { broadcastWifiState, wifiBuildMsg } from "../modules/wifi/wifi.ts";
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
	defaultAdapterModeDeps,
	setWifiAdapterMode,
	startWifiAdapterModeRestore,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import * as legacy from "../modules/wifi/wifi-ap-sta-capability.ts";
import * as caps from "../modules/wifi/wifi-capabilities.ts";
import * as concurrent from "../modules/wifi/wifi-concurrent-interface.ts";
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
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
import * as compat from "../rpc/compat.ts";
import {
	nmcliFieldNames,
	nmcliFieldOutput,
} from "./helpers/nmcli-field-output.ts";
import { mockRosterActivation } from "./helpers/wifi-active-observation.ts";
import { mockHotspotConfirmationPoll } from "./helpers/wifi-hotspot-test-setup.ts";
import { fakeShadowSysfs } from "./helpers/wifi-radio-equivalence-shadow.ts";
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
let restoreShadow: () => Promise<void>;

const flush = async () => {
	for (let i = 0; i < 1000; i++) await Promise.resolve();
};

async function publishVerifiedRestoreInputs() {
	await wifiRadioIdentity.discover([{ ifname: "wlan0", row }]);
	const saved: Readonly<Record<string, string>> = {
		"match.path": "platform-equivalence-phy0",
		"connection.interface-name": "clap-wlan0",
		"802-11-wireless.mode": "ap",
		"802-11-wireless.mac-address": MAC,
	};
	const command = runner.run;
	spyOn(runner, "run").mockImplementation(async (binary, args, options) =>
		binary === "nmcli" && args?.at(-1) === AP && nmcliFieldNames(args).length
			? nmcliFieldOutput(args, (field) => saved[field] ?? "")
			: command(binary, args, options),
	);
}

async function prove(
	supported = true,
	now = () => 0,
	phyName: "phy0" | "phy1" = "phy0",
): Promise<void> {
	const fixture = (name: string) =>
		readFile(join(import.meta.dir, "fixtures/wifi", name), "utf8");
	const [phy, reg, dev] = await Promise.all([
		fixture("iw-phy-mt7925-nm-hybrid.txt"),
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
							"total <= 3, #channels <= 1",
							`total <= ${supported ? 3 : 1}, #channels <= 1`,
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
	// Only the first-discovery wdev witness read is faked; other platform reads are unchanged.
	concurrent.setConcurrentInterfaceDepsForTest(async (command, args) => {
		if (command === "iw" && args[1]?.startsWith("clap-") && args[2] === "info")
			throw new Error("No platform wdev in this suite");
		return command === "iw" ? runIw(args) : run(command, args);
	}, null);
	restoreShadow = await fakeShadowSysfs(() => [
		{
			ifname: "wlan0",
			operational: MAC,
			permanent: MAC,
			ifindex: 3,
			phy: 0,
			state: "connected",
		},
		{
			ifname: "clap-wlan0",
			operational: MAC,
			permanent: MAC,
			ifindex: 4,
			phy: 0,
			state: "disconnected",
		},
	]);
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
		readProfilePins: async () => ["", ""],
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
		credentials: {
			get: () => ({
				conn: AP,
				ssid: "Publication AP",
				password: "fixture-password",
			}),
			remember: () => {},
		},
		pruneHotspotConns: async () => {},
		releaseConcurrentInterface: async () => {
			effects.push("release");
			return true;
		},
		ensureConcurrentInterface: async () => {
			effects.push("virtual");
			return { ifname: "clap-wlan0", created: true };
		},
	} satisfies Partial<HotspotActivationDeps>);
	mockHotspotConfirmationPoll();
	spyOn(nm, "nmDevices").mockImplementation(async () => [
		`wlan0:wifi:${row.activeConn ? `connected:${row.activeConn}` : "disconnected:"}`,
		...(row.concurrentHotspot?.activeConn
			? [
					`${row.concurrentHotspot.ifname}:wifi:connected:${row.concurrentHotspot.activeConn}`,
				]
			: []),
	]);
	mockRosterActivation();
	Object.assign(defaultHotspotStopDeps, {
		nmConnSetFields: async () => true,
		nmDisconnect: async () => {
			effects.push("down");
			return true;
		},
		releaseConcurrentInterface: async () => {
			effects.push("release");
			return true;
		},
		broadcastState: () => {},
		setDupIpSuppression: () => {},
		rescan: async () => {},
	});
});

afterEach(async () => {
	concurrent.setConcurrentInterfaceDepsForTest(null, null);
	cancel?.();
	cancel = undefined;
	unsubscribe?.();
	unsubscribe = undefined;
	await settlePending("wlan0", false);
	wifiRadioObservation.stop();
	await restoreShadow();
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

function captureModePublications() {
	const frames: unknown[][] = [];
	const status = (scope: string, type: string, payload: unknown) => {
		if (type !== "status") return;
		const wifi = statusResponseSchema.parse(payload).wifi?.[row.id];
		if (wifi)
			frames.push([scope, wifi.observed_mode, wifi.leaving, wifi.transition]);
	};
	spyOn(compat, "broadcastMsg").mockImplementation((type, payload) =>
		status("normal", type, payload),
	);
	spyOn(compat, "broadcastMsgLocal").mockImplementation((type, payload) => {
		status("local", type, payload);
		return "";
	});
	const publishOutcome: NonNullable<HotspotActivationDeps["publishOutcome"]> = (
		kind,
		_id,
		outcome,
	) => {
		frames.push([kind, outcome.success]);
	};
	return { frames, publishOutcome };
}

for (const outcome of ["confirmed", "not-confirmed", "refused"] as const) {
	test(`direct Start keeps Station through the terminal: ${outcome}`, async () => {
		await prove(false);
		await wifiRadioIdentity.discover([{ ifname: row.ifname, row }]);
		expect(wifiBuildMsg()[row.id]?.incarnation).toBeString();
		const { frames, publishOutcome } = captureModePublications();
		const result = await wifiHotspotStart(
			{ device: row.id },
			{
				...defaultHotspotDeps,
				...(outcome === "refused" ? { nmConnect: async () => false } : {}),
				broadcastState: broadcastWifiState,
				publishOutcome,
			},
		);
		if (outcome === "confirmed") settlePending(row.ifname, true);
		if (outcome === "not-confirmed") await settlePending(row.ifname, false);
		expect(result).toEqual(
			outcome === "refused"
				? { success: false, error: "activation-failed" }
				: { success: true },
		);
		const settled = outcome === "confirmed" ? "hotspot" : "station";
		expect(frames).toEqual([
			["normal", "station", "station", "activating"],
			["normal", settled, "station", undefined],
			["start", outcome === "confirmed"],
			["local", settled, undefined, undefined],
		]);
	});
}

test.each(["direct", "mode"] as const)(
	"Stop takes over a pending %s Start without exposing the intermediate AP mode",
	async (kind) => {
		await prove(false);
		await wifiRadioIdentity.discover([{ ifname: row.ifname, row }]);
		const { frames, publishOutcome } = captureModePublications();
		const request = { device: row.id };
		if (kind === "direct") {
			expect(
				await wifiHotspotStart(request, {
					...defaultHotspotDeps,
					broadcastState: broadcastWifiState,
					publishOutcome,
				}),
			).toEqual({ success: true });
		} else {
			spyOn(defaultHotspotDeps, "broadcastState").mockImplementation(
				broadcastWifiState,
			);
			expect(
				await setWifiAdapterMode(row.id, "hotspot", {
					...defaultAdapterModeDeps,
					publishHotspotOutcome: publishOutcome,
					publishOutcome: (_device, result) => {
						frames.push(
							"pending" in result
								? ["mode", "pending", result.mode]
								: ["mode", result.success],
						);
					},
				}),
			).toEqual({ success: true, accepted: true, applied: "hotspot" });
		}
		// NM can report the AP before the Start monitor sends its outcome.
		row.activeConn = AP;
		row.activeMode = "ap";
		expect(
			await wifiHotspotStop(request, {
				...defaultHotspotStopDeps,
				broadcastState: broadcastWifiState,
				publishOutcome,
			}),
		).toEqual({ success: true });
		expect(frames).toEqual([
			...(kind === "mode" ? [["mode", "pending", "hotspot"]] : []),
			["normal", "station", "station", "activating"],
			["normal", "hotspot", "station", undefined],
			["start", false],
			...(kind === "mode" ? [["mode", false]] : []),
			["normal", "hotspot", "station", "deactivating"],
			["normal", "station", "station", undefined],
			["stop", true],
			["local", "station", undefined, undefined],
		]);
	},
);

test("a second Start retires the superseded observer without holding Station past its own terminal", async () => {
	await prove(false);
	await wifiRadioIdentity.discover([{ ifname: row.ifname, row }]);
	const { frames, publishOutcome } = captureModePublications();
	const deps = {
		...defaultHotspotDeps,
		broadcastState: broadcastWifiState,
		publishOutcome,
	};
	for (const attempt of ["first", "second"]) {
		expect(await wifiHotspotStart({ device: row.id, attempt }, deps)).toEqual({
			success: true,
		});
	}
	settlePending(row.ifname, true);
	expect(frames).toEqual([
		["normal", "station", "station", "activating"],
		["normal", "station", "station", "activating"],
		["normal", "hotspot", "station", undefined],
		["start", true],
		["local", "hotspot", undefined, undefined],
	]);
});

for (const outcome of [
	"confirmed",
	"stop-refused",
	"start-refused",
	"timed-out",
] as const) {
	test(`Hybrid to Hotspot keeps Hybrid through the mode terminal: ${outcome}`, async () => {
		row.concurrentHotspot = { ifname: "clap-wlan0", activeConn: AP };
		persistWifiAdapterMode(MAC, "hybrid");
		await prove();
		await wifiRadioIdentity.discover([{ ifname: row.ifname, row }]);
		expect(wifiBuildMsg()[row.id]?.incarnation).toBeString();
		const { frames, publishOutcome } = captureModePublications();
		spyOn(defaultHotspotDeps, "broadcastState").mockImplementation(
			broadcastWifiState,
		);
		spyOn(defaultHotspotStopDeps, "broadcastState").mockImplementation(
			broadcastWifiState,
		);
		if (outcome === "stop-refused")
			spyOn(defaultHotspotStopDeps, "nmDisconnect").mockResolvedValue(false);
		if (outcome === "start-refused")
			spyOn(defaultHotspotDeps, "nmConnect").mockResolvedValue(false);
		let expire: (() => void) | undefined;
		const result = await setWifiAdapterMode(row.id, "hotspot", {
			...defaultAdapterModeDeps,
			armTerminalTimeout: (callback) => {
				expire = callback;
				return () => {
					expire = undefined;
				};
			},
			publishHotspotOutcome: publishOutcome,
			publishOutcome: (_device, result) => {
				frames.push(
					"pending" in result
						? ["mode", "pending", result.mode]
						: ["mode", result.success],
				);
			},
		});
		const stopped = outcome !== "stop-refused";
		const confirmed = outcome === "confirmed";
		const timedOut = outcome === "timed-out";
		if (confirmed) settlePending(row.ifname, true);
		expect(result).toEqual(
			confirmed || timedOut
				? { success: true, accepted: true, applied: "hotspot" }
				: {
						success: false,
						error: stopped ? "activation-failed" : "deactivation-failed",
					},
		);
		if (timedOut) {
			if (!expire) throw new Error("Mode terminal timeout was not armed");
			expire();
			settlePending(row.ifname, true);
		}
		const final = confirmed ? "hotspot" : stopped ? "station" : "hybrid";
		expect(frames).toEqual([
			["mode", "pending", "hotspot"],
			["normal", "hybrid", "hybrid", "deactivating"],
			["normal", stopped ? "station" : "hybrid", "hybrid", undefined],
			["stop", stopped],
			...(stopped
				? [
						["normal", "station", "hybrid", "activating"],
						...(timedOut
							? []
							: [
									["normal", final, "hybrid", undefined],
									["start", confirmed],
								]),
					]
				: []),
			["mode", confirmed],
			["local", final, undefined, timedOut ? "activating" : undefined],
			...(timedOut
				? [
						["normal", "hotspot", undefined, undefined],
						["start", true],
					]
				: []),
		]);
	});
}

for (const { success, replaced } of [
	{ success: true, replaced: false },
	{ success: false, replaced: false },
	{ success: true, replaced: true },
]) {
	test(`direct Stop retains only its own prior mode and refreshes local peers, success=${success}, replaced=${replaced}`, async () => {
		row.conn = AP;
		row.activeConn = AP;
		row.activeMode = "ap";
		await wifiRadioIdentity.discover([{ ifname: row.ifname, row }]);
		const incarnation = wifiBuildMsg()[row.id]?.incarnation;
		expect(incarnation).toBeString();
		const { frames, publishOutcome } = captureModePublications();
		expect(
			await wifiHotspotStop(
				{ device: row.id },
				{
					...defaultHotspotStopDeps,
					broadcastState: broadcastWifiState,
					nmDisconnect: async () => {
						if (replaced) {
							await wifiRadioIdentity.discover([]);
							await wifiRadioIdentity.discover([{ ifname: row.ifname, row }]);
							const replacement = wifiBuildMsg()[row.id];
							expect(replacement?.incarnation).toBeString();
							expect(replacement?.incarnation).not.toBe(incarnation);
							expect(replacement).not.toHaveProperty("leaving");
							expect(replacement).not.toHaveProperty("transition");
						}
						return success;
					},
					publishOutcome,
				},
			),
		).toEqual(
			success
				? { success: true }
				: { success: false, error: "deactivation-failed" },
		);
		const settled = success ? "station" : "hotspot";
		expect(frames).toEqual([
			["normal", "hotspot", "hotspot", "deactivating"],
			["normal", settled, replaced ? undefined : "hotspot", undefined],
			["stop", success],
			["local", settled, undefined, undefined],
		]);
	});
}

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
	expect(getPersistedWifiAdapterModes()).toEqual({ [MAC]: "hotspot" });
	effects = [];
	expect(await wifiHotspotStart({ device: 0 })).toEqual({ success: true });
	expect(getPersistedWifiAdapterModes()).toEqual({ [MAC]: "hotspot" });
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
	const roster = spyOn(nm, "nmDevices").mockResolvedValue([
		"wlan0:wifi:connected:station",
		`clap-wlan0:wifi:connected:${AP}`,
	]);
	spyOn(nm, "nmConnGetFields").mockResolvedValue(["infrastructure"]);
	spyOn(devices, "wifiDeviceListGetMacAddress").mockReturnValue(MAC);
	spyOn(devices, "wifiDeviceListGetInetAddress").mockReturnValue("192.0.2.2");
	spyOn(connections, "wifiUpdateScanResult").mockResolvedValue(true);
	spyOn(connections, "wifiScheduleScanRefresh").mockImplementation(() => {});
	spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(async () => {
		effects.push("down");
		roster.mockResolvedValue([
			"wlan0:wifi:connected:station",
			"clap-wlan0:wifi:disconnected:",
		]);
		await interfaces.wifiUpdateDevices();
		return true;
	});
	const result = await setWifiAdapterMode(0, "hotspot");
	await settlePending("wlan0", true);
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
				await settlePending("wlan0", true);
				const mustRefuse =
					previous === "hybrid" && supported !== true && observed !== "hybrid";
				const target: WifiAdapterMode =
					observed !== "station"
						? observed
						: supported === true && previous !== "hotspot"
							? "hybrid"
							: "hotspot";
				const expected = mustRefuse ? previous : target;
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
		const roster = spyOn(nm, "nmDevices").mockResolvedValue([
			`wlan0:wifi:connected:${AP}`,
			"clap-wlan0:wifi:disconnected:",
		]);
		spyOn(nm, "nmConnGetFields").mockResolvedValue(["infrastructure"]);
		spyOn(devices, "wifiDeviceListGetMacAddress").mockReturnValue(MAC);
		spyOn(devices, "wifiDeviceListGetInetAddress").mockReturnValue("192.0.2.2");
		spyOn(connections, "wifiUpdateScanResult").mockResolvedValue(true);
		spyOn(connections, "wifiScheduleScanRefresh").mockImplementation(() => {});
		spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(
			async () => {
				effects.push("down");
				roster.mockResolvedValue([
					parent === "disconnected"
						? "wlan0:wifi:disconnected:"
						: "wlan0:wifi:connected:new-station",
					"clap-wlan0:wifi:disconnected:",
				]);
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
		await settlePending("wlan0", true);
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
	expect(row.activeConn).toBeNull();
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
		await publishVerifiedRestoreInputs();
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
		await settlePending("wlan0", true);
		expect(attempts).toBe(accepted ? 1 : 2);
		expect(observedWifiAdapterMode(row)).toBe("hybrid");
		expect(getPersistedWifiAdapterModes()).toEqual({ [MAC]: "hybrid" });
		expect(jest.getTimerCount()).toBe(0);
	});
}

test("identical successful capability publications never re-arm a refused activation", async () => {
	persistWifiAdapterMode(MAC, "hybrid");
	await publishVerifiedRestoreInputs();
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
	expect(jest.getTimerCount()).toBe(1);
});

test("a coalesced binding change re-arms pending intent even when support stays true", async () => {
	persistWifiAdapterMode(MAC, "hybrid");
	await publishVerifiedRestoreInputs();
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
	await settlePending("wlan0", true);
	expect(attempts).toBe(2);
	expect(observedWifiAdapterMode(row)).toBe("hybrid");
});
