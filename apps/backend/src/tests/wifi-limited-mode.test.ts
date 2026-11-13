import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { logger } from "../helpers/logger.ts";
import * as runner from "../helpers/run.ts";
import * as mocks from "../mocks/mock-service.ts";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import * as streaming from "../modules/streaming/streaming.ts";
import * as credentials from "../modules/wifi/hotspot-credentials.ts";
import { setDerivedApChannels } from "../modules/wifi/regdomain.ts";
import {
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import {
	handleWifi,
	setWifiJoinNmcliRunner,
	wifiBuildMsg,
} from "../modules/wifi/wifi.ts";
import { wifiAdapterModeRestoreSource } from "../modules/wifi/wifi-adapter-mode-events.ts";
import {
	reconcileWifiAdapterModes,
	startWifiAdapterModeRestore,
} from "../modules/wifi/wifi-adapter-mode-restore.ts";
import {
	defaultAdapterModeDeps,
	setWifiAdapterMode,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import * as apSta from "../modules/wifi/wifi-ap-sta-capability.ts";
import * as capabilities from "../modules/wifi/wifi-capabilities.ts";
import * as concurrent from "../modules/wifi/wifi-concurrent-interface.ts";
import * as connections from "../modules/wifi/wifi-connections.ts";
import { addWifiInterface } from "../modules/wifi/wifi-connections.ts";
import { reconcileHotspotChannels } from "../modules/wifi/wifi-country.ts";
import * as devices from "../modules/wifi/wifi-device-list.ts";
import {
	defaultHotspotDeps,
	wifiHotspotPrepare,
	wifiHotspotStart,
} from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	defaultHotspotStopDeps,
	wifiHotspotConfig,
	wifiHotspotStop,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { handleHotspotConn } from "../modules/wifi/wifi-hotspot-discovery.ts";
import type { WifiInterfaceWithHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import * as interfaces from "../modules/wifi/wifi-interfaces.ts";
import { getWifiIdToMacAddress } from "../modules/wifi/wifi-interfaces.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
import { hotspotConfigureProcedure } from "../rpc/procedures/wifi.procedure.ts";
import { iwCreationReceipt } from "./helpers/iw-creation-receipt.ts";
import { wifiProtocolContext } from "./helpers/wifi-protocol-context.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const MAC = "58:02:05:e1:79:1c";
const KEY = "limited:3:0";
const UUID = "limited-fixture-ap";
const NAME = "Limited fixture";
const PASSWORD = "synthetic-fixture-password";
let row: WifiInterfaceWithHotspot;
let registry: ReturnType<typeof isolateWifiRegistry>;
let modes: ReturnType<typeof getConfig>["wifi_modes"];
let effects: string[];
let reads: string[];
let warnings: string[];
let frames: string[];
let channel: string;
let profileIfname: string;
let hasProfile: boolean;
let streamingOn: boolean;
let originalConfigPath: string;
let scratch: string;
let originalIds: Record<number, string>;

function radio(id = 0): WifiInterfaceWithHotspot {
	return {
		id,
		ifname: `wlan${id}`,
		conn: null,
		hw: "Fixture radio",
		available: new Map(),
		saved: {},
		savedAll: {},
		degradedReason: "permanent-mac-unresolved",
		supportsApStaConcurrency: false,
		hotspot: { availableChannels: ["auto"], warnings: {} },
	};
}

beforeEach(async () => {
	originalConfigPath = getConfigFilePath();
	scratch = await mkdtemp(join(tmpdir(), "wifi-limited-"));
	setConfigFilePath(join(scratch, "config.json"));
	originalIds = { ...getWifiIdToMacAddress() };
	registry = isolateWifiRegistry();
	modes = getConfig().wifi_modes;
	getConfig().wifi_modes = { [MAC]: "hotspot" };
	effects = [];
	reads = [];
	warnings = [];
	frames = [];
	channel = "0";
	profileIfname = "";
	hasProfile = true;
	streamingOn = false;
	row = radio();
	addWifiInterface(KEY, row);
	getWifiIdToMacAddress()[0] = KEY;
	setWifiState({});
	setDerivedApChannels([]);
	spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
	spyOn(streaming, "getIsStreaming").mockImplementation(() => streamingOn);
	spyOn(logger, "warn").mockImplementation((message) => {
		warnings.push(String(message));
		return logger;
	});
	spyOn(credentials, "getHotspotCredentials").mockImplementation((key) => {
		reads.push(`store:${key}`);
		return key === MAC && hasProfile
			? { ssid: NAME, password: PASSWORD, conn: UUID, channel: "auto" }
			: undefined;
	});
	spyOn(credentials, "canUseHotspotConnection").mockImplementation((key) => {
		reads.push(`owner:${key}`);
		return true;
	});
	spyOn(credentials, "rememberHotspotCredentials").mockImplementation(() => {
		effects.push("store-write");
	});
	spyOn(credentials.hotspotCredentialsStore, "get").mockImplementation(() => {
		effects.push("store-read");
		return undefined;
	});
	spyOn(credentials.hotspotCredentialsStore, "remember").mockImplementation(
		() => {
			effects.push("store-write");
		},
	);
	spyOn(runner, "run").mockImplementation(async (bin, args) => {
		if (bin !== "nmcli" || !args.includes("--get-values"))
			throw new Error(`Unexpected limited test command: ${bin}`);
		reads.push(`profile:${args[8]}`);
		const values: Record<string, string> = {
			"802-11-wireless.mode": "ap",
			"802-11-wireless.ssid": NAME,
			"802-11-wireless-security.psk": PASSWORD,
			"802-11-wireless.band": "",
			"802-11-wireless.channel": channel,
			"802-11-wireless-security.key-mgmt": "wpa-psk",
			"connection.interface-name": profileIfname,
		};
		return (args[5] ?? "")
			.split(",")
			.map((field) => values[field] ?? "")
			.join("\n");
	});
	spyOn(nm, "nmConnect").mockImplementation(async (uuid) => {
		effects.push(`up:${uuid}`);
		return true;
	});
	spyOn(nm, "nmConnSetFields").mockImplementation(async () => {
		effects.push("direct-modify");
		return true;
	});
	spyOn(defaultHotspotDeps, "nmConnSetFields").mockImplementation(async () => {
		effects.push("modify");
		return true;
	});
	spyOn(defaultHotspotDeps, "findHotspotConn").mockImplementation(async () => {
		effects.push("profile-search");
		return undefined;
	});
	spyOn(defaultHotspotDeps, "ensureConcurrentInterface").mockImplementation(
		async () => {
			effects.push("iw-add");
			return { ifname: "clap-wlan0", created: true };
		},
	);
	spyOn(defaultHotspotStopDeps, "nmConnSetFields").mockImplementation(
		async () => {
			effects.push("autoconnect");
			return true;
		},
	);
	spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(
		async (uuid) => {
			effects.push(`down:${uuid}`);
			return true;
		},
	);
	spyOn(defaultHotspotStopDeps, "broadcastState").mockImplementation(() => {});
	spyOn(defaultHotspotStopDeps, "setDupIpSuppression").mockImplementation(
		() => {},
	);
	spyOn(defaultHotspotStopDeps, "rescan").mockImplementation(async () => {});
});

afterEach(async () => {
	mock.restore();
	concurrent.resetConcurrentInterfaceDepsForTest();
	setWifiJoinNmcliRunner(null);
	getConfig().wifi_modes = modes;
	restoreWifiRegistry(registry);
	for (const id of Object.keys(getWifiIdToMacAddress()))
		delete getWifiIdToMacAddress()[Number(id)];
	Object.assign(getWifiIdToMacAddress(), originalIds);
	setConfigFilePath(originalConfigPath);
	await rm(scratch, { recursive: true, force: true });
	setDerivedApChannels([]);
	setWifiState({});
});

function allocationFixture() {
	const fixture = {
		targets: new Map<string, { ifindex: number; wdev: string }>(),
		afterAdd: (): void => {},
		visible: async (): Promise<boolean> => true,
	};
	concurrent.setConcurrentInterfaceDepsForTest(
		async (_bin, args) => {
			const entry =
				args[0] === "wdev"
					? [...fixture.targets].find(([, value]) => value.wdev === args[1])
					: [...fixture.targets].find(([name]) => name === args[1]);
			if (args.at(-1) === "info") {
				if (!entry) throw new Error("No fixture interface");
				return `Interface ${entry[0]}\n ifindex ${entry[1].ifindex}\n wdev ${entry[1].wdev}\n wiphy 0\n type managed\n`;
			}
			if (args.includes("add")) {
				fixture.targets.set("clap-wlan0", { ifindex: 7, wdev: "0x7" });
				fixture.afterAdd();
				return iwCreationReceipt();
			}
			if (args.at(-1) === "del") {
				if (entry) fixture.targets.delete(entry[0]);
				return "";
			}
			throw new Error("Unexpected fixture command");
		},
		() => fixture.visible(),
	);
	return fixture;
}

function restoreFeed() {
	let listener: (() => Promise<void>) | undefined;
	return {
		hasDiscovery: () => true,
		subscribe: (next: () => Promise<void>) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		edge: () => listener?.() ?? Promise.resolve(),
	};
}

for (const operation of [
	"load",
	"save",
	"start",
	"hotspot",
	"hybrid",
] as const) {
	test(`limited ${operation} refuses before effects, even when already active`, async () => {
		row.activeConn = UUID;
		row.activeMode = "ap";
		row.hotspot.conn = UUID;
		const result =
			operation === "load" || operation === "save"
				? await wifiHotspotPrepare({
						device: 0,
						...(operation === "save" ? { name: NAME, password: PASSWORD } : {}),
					})
				: operation === "start"
					? await wifiHotspotStart({ device: 0 })
					: await setWifiAdapterMode(0, operation);
		expect(result).toEqual({ success: false, error: "radio-unverified" });
		expect(effects).toEqual([]);
		expect(reads).toEqual([]);
		expect(getConfig().wifi_modes).toEqual({ [MAC]: "hotspot" });
	});
}

test("limited configure sends the typed terminal frame without effects", async () => {
	const context = wifiProtocolContext((frame) => frames.push(frame));
	await wifiHotspotConfig(context.ws, {
		device: 0,
		name: NAME,
		password: PASSWORD,
		channel: "auto",
	});
	expect(frames.map((frame) => JSON.parse(frame).wifi.hotspot.config)).toEqual([
		{ device: 0, error: "radio-unverified" },
	]);
	expect(effects).toEqual([]);
	expect(
		await call(
			hotspotConfigureProcedure,
			{ device: "0", name: NAME, password: PASSWORD, channel: "auto" },
			{ context },
		),
	).toEqual({ success: false, error: "radio-unverified" });
	expect(effects).toEqual([]);
	expect(reads).toEqual([]);
});

test("only the active profile supplies limited details and Stop only deactivates its UUID", async () => {
	row.activeConn = UUID;
	row.activeMode = "ap";
	await handleHotspotConn(KEY, "unrelated-profile");
	expect(row.hotspot.name).toBeUndefined();
	await handleHotspotConn(KEY, UUID, { active: true });
	expect(reads).toEqual([`profile:${UUID}`]);
	expect(wifiBuildMsg()["0"]?.hotspot).toMatchObject({
		name: NAME,
		password: PASSWORD,
	});
	expect(await wifiHotspotStop({ device: 0 })).toEqual({ success: true });
	expect(effects).toEqual([`down:${UUID}`]);
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
	await reconcileWifiAdapterModes();
	expect(effects).toEqual([`down:${UUID}`]);
});

test("an unreadable active profile still leaves its observed UUID stoppable", async () => {
	row.activeConn = UUID;
	row.activeMode = "ap";
	spyOn(nm, "nmConnGetFields").mockResolvedValue(undefined);
	await handleHotspotConn(KEY, UUID, { active: true });
	expect(await wifiHotspotStop({ device: 0 })).toEqual({ success: true });
	expect(effects).toEqual([`down:${UUID}`]);
});

test("an unreadable concurrent active profile still leaves its observed UUID stoppable", async () => {
	row.conn = "station-uplink";
	row.activeConn = row.conn;
	row.activeMode = "infrastructure";
	row.concurrentHotspot = { ifname: "clap-wlan0", activeConn: UUID };
	spyOn(nm, "nmConnGetFields").mockResolvedValue(undefined);
	await handleHotspotConn(KEY, UUID, { active: true });
	expect(await wifiHotspotStop({ device: 0 })).toEqual({ success: true });
	expect(effects).toEqual([`down:${UUID}`]);
	expect(row.conn).toBe("station-uplink");
});

test("an unreadable switched AP profile clears the previous profile details", async () => {
	row.activeConn = UUID;
	row.activeMode = "ap";
	await handleHotspotConn(KEY, UUID, { active: true });
	expect(wifiBuildMsg()["0"]?.hotspot).toMatchObject({
		name: NAME,
		password: PASSWORD,
	});
	row.activeConn = "replacement-ap";
	spyOn(nm, "nmConnGetFields").mockResolvedValue(undefined);
	await handleHotspotConn(KEY, row.activeConn, { active: true });
	const visible = wifiBuildMsg()["0"]?.hotspot;
	expect(visible?.name).toBeUndefined();
	expect(visible?.password).toBeUndefined();
	expect(visible?.channel).toBeUndefined();
	expect(visible?.security).toBeUndefined();
	expect(await wifiHotspotStop({ device: 0 })).toEqual({ success: true });
	expect(effects).toEqual(["down:replacement-ap"]);
});

for (const change of ["cancel", "second-adapter", "replacement-row"] as const) {
	test(`limited restore rechecks ${change} after the held profile read`, async () => {
		let listener: (() => Promise<void>) | undefined;
		const source = {
			hasDiscovery: () => true,
			subscribe: (callback: () => Promise<void>) => {
				listener = callback;
				return () => {
					listener = undefined;
				};
			},
		};
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const read = nm.nmConnGetFields;
		spyOn(nm, "nmConnGetFields").mockImplementation(async (uuid, fields) => {
			entered.resolve();
			await release.promise;
			return read(uuid, fields);
		});
		const stop = startWifiAdapterModeRestore(defaultAdapterModeDeps, source);
		const flight = listener?.();
		try {
			await entered.promise;
			if (change === "cancel") stop();
			else if (change === "second-adapter")
				addWifiInterface("limited:4:1", radio(1));
			else addWifiInterface(KEY, radio());
			release.resolve();
			await flight;
			expect(effects).toEqual([]);
		} finally {
			stop();
			release.resolve();
			await flight;
		}
	});
}

for (const change of ["cancel", "second-adapter"] as const) {
	test(`limited hybrid restore rechecks ${change} after the held interface allocation`, async () => {
		getConfig().wifi_modes = { [MAC]: "hybrid" };
		profileIfname = "clap-wlan0";
		let listener: (() => Promise<void>) | undefined;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		spyOn(concurrent, "ensureConcurrentApInterface").mockImplementation(
			async () => {
				effects.push("iw-add");
				entered.resolve();
				await release.promise;
				return { ifname: "clap-wlan0", created: true, type: "managed" };
			},
		);
		const stop = startWifiAdapterModeRestore(
			{
				...defaultAdapterModeDeps,
				readCapabilities: () => ({ staApCombo: { supported: true } }),
			},
			{
				hasDiscovery: () => true,
				subscribe: (callback) => {
					listener = callback;
					return () => {
						listener = undefined;
					};
				},
			},
		);
		const flight = listener?.();
		try {
			await entered.promise;
			if (change === "cancel") stop();
			else addWifiInterface("limited:4:1", radio(1));
			release.resolve();
			await flight;
			expect(effects).toEqual(["iw-add"]);
		} finally {
			stop();
			release.resolve();
			await flight;
		}
	});
}

test("limited restore counts nonstation address groups before plain record precedence", async () => {
	const other = "dc:a6:32:aa:bb:cc";
	getConfig().wifi_modes = {
		[MAC]: "station",
		[`${MAC}@port`]: "hybrid",
		[other]: "hotspot",
	};
	spyOn(credentials, "getHotspotCredentials").mockImplementation((key) =>
		key === other
			? { ssid: NAME, password: PASSWORD, conn: UUID, channel: "auto" }
			: undefined,
	);
	await reconcileWifiAdapterModes();
	expect(effects).toEqual([]);
	expect(warnings).toEqual([
		"limited restore: requires exactly one logical intent and profile owner on wlan0",
	]);
});

for (const boundary of ["info", "visibility"] as const) {
	for (const change of [
		"cancel",
		"second-adapter",
		"replacement-row",
		"station-choice",
	] as const) {
		test(`round two: real allocator respects ${change} at ${boundary}`, async () => {
			getConfig().wifi_modes = { [MAC]: "hybrid" };
			profileIfname = "clap-wlan0";
			const targets = new Map<string, string>();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<boolean>();
			concurrent.setConcurrentInterfaceDepsForTest(
				async (_bin, args) => {
					if (args.at(-1) === "info") {
						if (targets.has("clap-wlan0"))
							return "Interface clap-wlan0\n ifindex 7\n wdev 0x7\n wiphy 0\n type managed\n";
						if (boundary === "info") {
							entered.resolve();
							await release.promise;
						}
						throw new Error("No fixture interface");
					}
					if (args.includes("add")) {
						targets.set("clap-wlan0", "created-by-this-operation");
						effects.push("iw-add");
						return iwCreationReceipt();
					}
					if (args.at(-1) === "del") {
						targets.delete("clap-wlan0");
						effects.push("iw-delete");
						return "";
					}
					throw new Error("Unexpected fixture allocator command");
				},
				async () => {
					if (boundary === "visibility") {
						entered.resolve();
						return release.promise;
					}
					return true;
				},
			);
			const feed = restoreFeed();
			const stop = startWifiAdapterModeRestore(
				{
					...defaultAdapterModeDeps,
					readCapabilities: () => ({ staApCombo: { supported: true } }),
				},
				feed,
			);
			const flight = feed.edge();
			try {
				await entered.promise;
				if (change === "cancel") stop();
				else if (change === "second-adapter")
					addWifiInterface("limited:4:1", radio(1));
				else if (change === "replacement-row") addWifiInterface(KEY, radio());
				else getConfig().wifi_modes = { [MAC]: "station" };
				release.resolve(false);
				await flight;
				expect(effects).toEqual(
					boundary === "info" ? [] : ["iw-add", "iw-delete"],
				);
				expect(targets).toEqual(new Map());
			} finally {
				stop();
				release.resolve(false);
				await flight;
			}
		});
	}
}

for (const type of ["AP", "managed"] as const) {
	test(`round two: D12 preserves an unowned existing ${type} interface`, async () => {
		getConfig().wifi_modes = { [MAC]: "hybrid" };
		profileIfname = "clap-wlan0";
		const targets = new Map([
			["clap-wlan0", { identity: "preexisting-unrecorded", type }],
		]);
		concurrent.setConcurrentInterfaceDepsForTest(
			async (_bin, args) => {
				if (args.at(-1) === "info")
					return `Interface clap-wlan0\n\ttype ${targets.get("clap-wlan0")?.type}\n`;
				if (args.at(-1) === "del") {
					targets.delete("clap-wlan0");
					effects.push("iw-delete");
					return "";
				}
				if (args.includes("add")) {
					targets.set("clap-wlan0", {
						identity: "created-this-call",
						type: "managed",
					});
					effects.push("iw-add");
					return iwCreationReceipt();
				}
				throw new Error("Unexpected fixture allocator command");
			},
			async () => type === "AP",
		);
		await reconcileWifiAdapterModes({
			...defaultAdapterModeDeps,
			readCapabilities: () => ({ staApCombo: { supported: true } }),
		});
		expect(targets).toEqual(
			new Map([["clap-wlan0", { identity: "preexisting-unrecorded", type }]]),
		);
		expect(effects).toEqual([]);
	});
}

test("round two: allocator cleanup removes only its newly created failed target", async () => {
	getConfig().wifi_modes = { [MAC]: "hybrid" };
	profileIfname = "clap-wlan0";
	const targets = new Set<string>();
	concurrent.setConcurrentInterfaceDepsForTest(
		async (_bin, args) => {
			if (args.at(-1) === "info") {
				if (targets.has("clap-wlan0"))
					return "Interface clap-wlan0\n ifindex 7\n wdev 0x7\n wiphy 0\n type managed\n";
				throw new Error("No fixture interface");
			}
			if (args.includes("add")) {
				targets.add("clap-wlan0");
				effects.push("iw-add");
				return iwCreationReceipt();
			} else if (args.at(-1) === "del") {
				targets.delete("clap-wlan0");
				effects.push("iw-delete");
			} else throw new Error("Unexpected fixture allocator command");
			return "";
		},
		async () => false,
	);
	await reconcileWifiAdapterModes({
		...defaultAdapterModeDeps,
		readCapabilities: () => ({ staApCombo: { supported: true } }),
	});
	expect(targets).toEqual(new Set());
	expect(effects).toEqual(["iw-add", "iw-delete"]);
});

test("round two: production discovery does not repeat accepted restore after unrelated station choice", async () => {
	const other = "dc:a6:32:aa:bb:cc";
	wifiRadioObservation.reopenForTest();
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	await wifiRadioIdentity.discover([]);
	interfaces.resetWifiInterfaceDiscoveryForTest();
	interfaces.resetWifiConnectionModeCache();
	addWifiInterface(other, {
		id: 1,
		ifname: "wlan1",
		hw: "Station-only fixture",
		conn: null,
		available: new Map(),
		saved: {},
		savedAll: {},
	});
	devices.wifiDeviceListStartUpdate();
	devices.wifiDeviceListAdd("wlan0", "02:00:00:00:00:01");
	devices.wifiDeviceListAdd("wlan1", other);
	devices.wifiDeviceListEndUpdate();
	onWifiChange(() => undefined);
	spyOn(capabilities, "refreshWifiCapabilities").mockResolvedValue(undefined);
	spyOn(connections, "wifiUpdateScanResult").mockResolvedValue(false);
	spyOn(radioIdentityReaders, "realpath").mockImplementation(async (path) =>
		path.includes("/wlan0/")
			? "/sys/fixture/phy0"
			: path.includes("/wlan1/")
				? "/sys/fixture/phy1"
				: undefined,
	);
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) => {
		if (path.endsWith("/ifindex")) return path.includes("/wlan0/") ? "3" : "4";
		if (path.endsWith("/index")) return path.includes("/phy0/") ? "0" : "1";
		if (path === "/sys/fixture/phy1/macaddress") return other;
		return undefined;
	});
	const listingEntered = Promise.withResolvers<void>();
	const releaseListing = Promise.withResolvers<void>();
	let listings = 0;
	spyOn(nm, "nmDevices").mockImplementation(async () => {
		if (++listings === 2) {
			listingEntered.resolve();
			await releaseListing.promise;
		}
		return ["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"];
	});
	const activationEntered = Promise.withResolvers<void>();
	const releaseActivation = Promise.withResolvers<void>();
	spyOn(nm, "nmConnect").mockImplementation(async (uuid) => {
		effects.push(`up:${uuid}`);
		activationEntered.resolve();
		await releaseActivation.promise;
		return true;
	});
	let published = false;
	let notifications = 0;
	const firstDrain = Promise.withResolvers<void>();
	const secondDrain = Promise.withResolvers<void>();
	const subscribe = wifiAdapterModeRestoreSource.subscribe;
	spyOn(wifiAdapterModeRestoreSource, "hasDiscovery").mockImplementation(
		() => published,
	);
	spyOn(wifiAdapterModeRestoreSource, "subscribe").mockImplementation(
		(listener) =>
			subscribe(() => {
				published = true;
				const number = ++notifications;
				const flight = listener();
				if (number === 1) firstDrain.resolve(flight);
				if (number === 2) secondDrain.resolve(flight);
				return flight;
			}),
	);
	const stop = startWifiAdapterModeRestore({
		...defaultAdapterModeDeps,
		readCapabilities: () => ({ staApCombo: { supported: true } }),
	});
	let staleDiscovery: Promise<boolean | undefined> | undefined;
	try {
		await interfaces.wifiUpdateDevices();
		await activationEntered.promise;
		staleDiscovery = interfaces.wifiUpdateDevices();
		await listingEntered.promise;
		expect(
			await setWifiAdapterMode(1, "station", {
				...defaultAdapterModeDeps,
				publishOutcome: () => undefined,
			}),
		).toEqual({ success: true, applied: "station" });
		releaseListing.resolve();
		await staleDiscovery;
		releaseActivation.resolve();
		await Promise.all([firstDrain.promise, secondDrain.promise]);
		expect(connections.getWifiInterfacesByMacAddress()[KEY]).toBe(row);
		expect(wifiBuildMsg()["0"]?.mode).toBe("station");
		expect(effects).toEqual([`up:${UUID}`]);
	} finally {
		stop();
		releaseListing.resolve();
		releaseActivation.resolve();
		await staleDiscovery;
		wifiRadioObservation.stop();
		await wifiRadioObservation.settled;
		await wifiRadioIdentity.discover([]);
		interfaces.stopWifiUpdateLoopForTest();
		connections.wifiCancelScanRefresh();
	}
});

for (const failure of [
	"add",
	"visibility",
	"visibility-error",
	"replacement",
	"reuse",
] as const) {
	test(`round four: allocator retains exact cleanup authority after ${failure}`, async () => {
		const fixture = allocationFixture();
		let admitted = true;
		if (failure === "reuse")
			fixture.targets.set("clap-wlan0", { ifindex: 20, wdev: "0x20" });
		fixture.afterAdd = () => {
			if (failure === "add") admitted = false;
		};
		fixture.visible = async () => {
			if (failure === "visibility-error") throw new Error("Visibility failed");
			if (failure === "replacement")
				fixture.targets.set("clap-wlan0", { ifindex: 99, wdev: "0x99" });
			admitted = false;
			return false;
		};
		expect(
			await concurrent.ensureConcurrentApInterface("wlan0", () => admitted),
		).toBeUndefined();
		expect(fixture.targets).toEqual(
			failure === "replacement"
				? new Map([["clap-wlan0", { ifindex: 99, wdev: "0x99" }]])
				: failure === "reuse"
					? new Map([["clap-wlan0", { ifindex: 20, wdev: "0x20" }]])
					: new Map(),
		);
		if (failure === "add" || failure === "visibility") {
			admitted = true;
			fixture.afterAdd = () => undefined;
			fixture.visible = async () => true;
			expect(
				await concurrent.ensureConcurrentApInterface("wlan0", () => admitted),
			).toEqual({
				ifname: "clap-wlan0",
				created: true,
				type: "managed",
			});
		}
	});
}

for (const outcome of [
	"success",
	"refused",
	"throws",
	"cancel",
	"ownership",
	"replacement",
	"reuse",
] as const) {
	test(`round four: D12 allocation handoff rolls back exactly its own target on ${outcome}`, async () => {
		getConfig().wifi_modes = { [MAC]: "hybrid" };
		profileIfname = "clap-wlan0";
		const fixture = allocationFixture();
		if (outcome === "reuse")
			fixture.targets.set("clap-wlan0", { ifindex: 20, wdev: "0x20" });
		let owner = true;
		spyOn(credentials, "canUseHotspotConnection").mockImplementation(
			() => owner,
		);
		fixture.visible = async () => {
			if (outcome === "ownership") owner = false;
			return true;
		};
		let cancel = (): void => {};
		spyOn(nm, "nmConnect").mockImplementation(async () => {
			if (outcome === "throws") throw new Error("Activation failed");
			if (outcome === "replacement")
				fixture.targets.set("clap-wlan0", { ifindex: 99, wdev: "0x99" });
			if (outcome === "cancel") cancel();
			return outcome === "success" || outcome === "cancel";
		});
		const feed = restoreFeed();
		cancel = startWifiAdapterModeRestore(
			{
				...defaultAdapterModeDeps,
				readCapabilities: () => ({ staApCombo: { supported: true } }),
			},
			feed,
		);
		try {
			await feed.edge();
			expect(fixture.targets).toEqual(
				outcome === "success"
					? new Map([["clap-wlan0", { ifindex: 7, wdev: "0x7" }]])
					: outcome === "replacement"
						? new Map([["clap-wlan0", { ifindex: 99, wdev: "0x99" }]])
						: outcome === "reuse"
							? new Map([["clap-wlan0", { ifindex: 20, wdev: "0x20" }]])
							: new Map(),
			);
		} finally {
			cancel();
		}
	});
}

for (const outcome of [
	"refused",
	"throws",
	"rollback-throws",
	"replacement",
	"reuse",
] as const) {
	test(`round four sibling: request activation releases only its own allocation on ${outcome}`, async () => {
		connections.removeWifiInterface(KEY);
		delete row.degradedReason;
		row.supportsApStaConcurrency = true;
		addWifiInterface(MAC, row);
		getWifiIdToMacAddress()[0] = MAC;
		getConfig().wifi_modes = { [MAC]: "hybrid" };
		const fixture = allocationFixture();
		if (outcome === "reuse")
			fixture.targets.set("clap-wlan0", { ifindex: 20, wdev: "0x20" });
		spyOn(defaultHotspotDeps, "ensureConcurrentInterface").mockImplementation(
			concurrent.ensureConcurrentApInterface,
		);
		spyOn(defaultHotspotDeps, "readCapabilities").mockReturnValue({
			staApCombo: { supported: true },
		});
		const creationError = new Error("Creation refused");
		const throws = outcome === "throws" || outcome === "rollback-throws";
		spyOn(defaultHotspotDeps, "broadcastState").mockImplementation(() => {
			if (outcome === "rollback-throws" && row.hotspot.transition === undefined)
				throw new Error("Rollback observer refused");
		});
		spyOn(defaultHotspotDeps, "nmHotspot").mockImplementation(async () => {
			if (throws) throw creationError;
			if (outcome === "replacement")
				fixture.targets.set("clap-wlan0", { ifindex: 99, wdev: "0x99" });
			return undefined;
		});
		const result = await wifiHotspotStart({ device: 0 }).then(
			(value) => value,
			(error) => error,
		);
		if (throws) expect(result).toBeInstanceOf(Error);
		else expect(result).toEqual({ success: false, error: "activation-failed" });
		if (throws) expect(result).toBe(creationError);
		expect(row.hotspot.transition).toBeUndefined();
		expect(row.concurrentHotspot).toBeUndefined();
		expect(fixture.targets).toEqual(
			outcome === "replacement"
				? new Map([["clap-wlan0", { ifindex: 99, wdev: "0x99" }]])
				: outcome === "reuse"
					? new Map([["clap-wlan0", { ifindex: 20, wdev: "0x20" }]])
					: new Map(),
		);
	});
}

for (const reused of [false, true]) {
	test(`round five: discovery abort retains allocation ownership reused=${reused}`, async () => {
		connections.clearWifiInterfacesForTest();
		wifiRadioObservation.reopenForTest();
		wifiRadioObservation.stop();
		await wifiRadioObservation.settled;
		await wifiRadioIdentity.discover([]);
		interfaces.resetWifiInterfaceDiscoveryForTest();
		const fixture = allocationFixture();
		if (reused)
			fixture.targets.set("clap-wlan0", { ifindex: 20, wdev: "0x20" });
		fixture.visible = async () => {
			interfaces.terminateWifiDiscovery();
			return true;
		};
		spyOn(apSta, "supportsApStaConcurrency").mockResolvedValue(true);
		spyOn(nm, "nmDevices").mockResolvedValue(["wlan0:wifi:disconnected:"]);
		spyOn(nm, "nmDeviceProp").mockResolvedValue([
			"Fixture",
			"Radio",
			"yes",
			"no",
			"yes",
		]);
		spyOn(radioIdentityReaders, "realpath").mockResolvedValue(
			"/sys/fixture/phy0",
		);
		spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) => {
			if (path.endsWith("/ifindex")) return "3";
			if (path.endsWith("/index")) return "0";
			if (path.endsWith("/macaddress")) return MAC;
			return undefined;
		});
		devices.wifiDeviceListStartUpdate();
		devices.wifiDeviceListAdd("wlan0", MAC);
		devices.wifiDeviceListEndUpdate();
		try {
			await interfaces.wifiUpdateDevices();
			expect(fixture.targets).toEqual(
				reused
					? new Map([["clap-wlan0", { ifindex: 20, wdev: "0x20" }]])
					: new Map(),
			);
			expect(connections.getWifiInterfacesByMacAddress()).toEqual({});
		} finally {
			interfaces.resetWifiInterfaceDiscoveryForTest();
			wifiRadioObservation.stop();
			await wifiRadioObservation.settled;
			await wifiRadioIdentity.discover([]);
		}
	});
}

test("station selection remains available and clears the restored logical intent", async () => {
	const persisted: Array<[string, string]> = [];
	expect(
		await setWifiAdapterMode(0, "station", {
			...defaultAdapterModeDeps,
			persistMode: (key, mode) => persisted.push([key, mode]),
		}),
	).toEqual({ success: true, applied: "station" });
	expect(persisted).toEqual([[MAC, "station"]]);
	expect(effects).toEqual([]);
});

test("limited station connect and new join succeed without an invalid MAC pin", async () => {
	spyOn(connections, "wifiUpdateScanResult").mockResolvedValue(false);
	spyOn(nm, "nmConnsGet").mockResolvedValue([]);
	spyOn(nm, "nmConnSetWifiMacAddress").mockImplementation(async () => {
		effects.push("invalid-mac-pin");
		return true;
	});
	row.saved = { "Station fixture": "station-fixture" };
	const connected = Promise.withResolvers<string>();
	handleWifi(
		{ send: (frame) => connected.resolve(String(frame)) },
		{ connect: "station-fixture" },
	);
	expect(JSON.parse(await connected.promise).wifi).toEqual({
		connect: true,
		device: "0",
	});
	setWifiJoinNmcliRunner(async () => ({
		stdout: "Device 'wlan0' successfully activated with 'new-station-fixture'.",
		stderr: "",
		exitCode: 0,
	}));
	const joined = Promise.withResolvers<string>();
	handleWifi(
		{ send: (frame) => joined.resolve(String(frame)) },
		{
			new: { device: 0, ssid: "Station fixture", password: PASSWORD },
		},
	);
	expect(JSON.parse(await joined.promise).wifi).toEqual({
		new: { success: true, device: 0 },
	});
	expect(effects).toEqual(["up:station-fixture"]);
});

test("limited Stop and station selection cannot clear another present radio's intent", async () => {
	const other = "dc:a6:32:aa:bb:cc";
	addWifiInterface(other, radio(1));
	getConfig().wifi_modes = { [other]: "hotspot" };
	row.activeConn = UUID;
	row.activeMode = "ap";
	row.hotspot.conn = UUID;
	expect(await wifiHotspotStop({ device: 0 })).toEqual({ success: true });
	expect(await setWifiAdapterMode(0, "station")).toEqual({
		success: true,
		applied: "station",
	});
	expect(getConfig().wifi_modes).toEqual({ [other]: "hotspot" });
	expect(effects).toEqual([`down:${UUID}`]);
});

test("limited hybrid restore preserves the station and uses only the already bound profile", async () => {
	getConfig().wifi_modes = { [MAC]: "hybrid" };
	row.conn = "station-uplink";
	streamingOn = true;
	profileIfname = "clap-wlan0";
	spyOn(concurrent, "ensureConcurrentApInterface").mockImplementation(
		async () => {
			effects.push("iw-add");
			return { ifname: "clap-wlan0", created: true, type: "managed" };
		},
	);
	await reconcileWifiAdapterModes({
		...defaultAdapterModeDeps,
		readCapabilities: () => ({ staApCombo: { supported: true } }),
	});
	expect(effects).toEqual(["iw-add", `up:${UUID}`]);
	expect(row.conn).toBe("station-uplink");
	expect(warnings).toEqual([
		"hotspot restored on an adapter that could not be identified",
	]);
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "hybrid" });
});

for (const scenario of [
	"all",
	"two-radios",
	"two-intents",
	"composite",
	"channel",
	"replacement",
	"missing-profile",
	"streaming",
	"hybrid-unproven",
] as const) {
	test(`limited boot restore: ${scenario}`, async () => {
		if (scenario === "two-radios") addWifiInterface("limited:4:1", radio(1));
		if (scenario === "two-intents")
			getConfig().wifi_modes = {
				[MAC]: "hotspot",
				"dc:a6:32:aa:bb:cc": "hybrid",
			};
		if (scenario === "composite")
			getConfig().wifi_modes = { [MAC]: "hotspot", [`${MAC}@port`]: "hotspot" };
		if (scenario === "channel") channel = "165";
		if (scenario === "replacement") row.ifname = "replacement";
		if (scenario === "missing-profile") hasProfile = false;
		if (scenario === "streaming") {
			streamingOn = true;
			row.conn = "station-uplink";
		}
		if (scenario === "hybrid-unproven")
			getConfig().wifi_modes = { [MAC]: "hybrid" };
		const before = structuredClone(getConfig().wifi_modes);
		await reconcileWifiAdapterModes();
		const starts = ["all", "composite", "replacement"].includes(scenario);
		expect(effects).toEqual(starts ? [`up:${UUID}`] : []);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(
			starts
				? "hotspot restored on an adapter that could not be identified"
				: "limited restore",
		);
		expect(getConfig().wifi_modes).toEqual(before);
	});
}

test("regulatory change stops a limited live AP without profile or intent writes", async () => {
	row.activeConn = UUID;
	row.activeMode = "ap";
	Object.assign(row.hotspot, {
		conn: UUID,
		name: NAME,
		password: PASSWORD,
		channel: "auto",
	});
	const before = structuredClone(getConfig().wifi_modes);
	await reconcileHotspotChannels();
	expect(effects).toEqual([`down:${UUID}`]);
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toContain("limited");
	expect(getConfig().wifi_modes).toEqual(before);
});
