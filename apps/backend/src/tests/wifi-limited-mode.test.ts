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
import * as nmSecrets from "../modules/network/network-manager-secret.ts";
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
import * as profileOperations from "../modules/wifi/wifi-hotspot-profile-operation.ts";
import type { WifiInterfaceWithHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import * as interfaces from "../modules/wifi/wifi-interfaces.ts";
import { getWifiIdToMacAddress } from "../modules/wifi/wifi-interfaces.ts";
import { restoreLimitedHotspot } from "../modules/wifi/wifi-limited-hotspot-restore.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
import { hotspotConfigureProcedure } from "../rpc/procedures/wifi.procedure.ts";
import { iwCreationReceipt } from "./helpers/iw-creation-receipt.ts";
import {
	nmcliFieldNames,
	nmcliFieldOutput,
} from "./helpers/nmcli-field-output.ts";
import {
	ACTIVE_PATH,
	mockRosterActivation,
} from "./helpers/wifi-active-observation.ts";
import { firstApInstances } from "./helpers/wifi-first-ap-instances.ts";
import {
	decodeProfile,
	encodeProfile,
} from "./helpers/wifi-first-ap-keyfile-codec.ts";
import { limitedHybridFixture } from "./helpers/wifi-limited-hybrid.ts";
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
let profileBand: string;
let profilePort: string;
let profileIfname: string;
let hasProfile: boolean;
let streamingOn: boolean;
let originalConfigPath: string;
let scratch: string;
let originalIds: Record<number, string>;
let limitedKernel: Awaited<ReturnType<typeof limitedHybridFixture>> | undefined;

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
	profileBand = "";
	profilePort = "";
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
		if (bin !== "nmcli" || nmcliFieldNames(args).length === 0)
			throw new Error(`Unexpected limited test command: ${bin}`);
		reads.push(`profile:${args.at(-1)}`);
		const values: Record<string, string> = {
			"802-11-wireless.mode": "ap",
			"802-11-wireless.ssid": NAME,
			"802-11-wireless-security.psk": PASSWORD,
			"802-11-wireless.band": profileBand,
			"802-11-wireless.channel": channel,
			"802-11-wireless-security.key-mgmt": "wpa-psk",
			"connection.interface-name": profileIfname,
			"match.path": profilePort,
		};
		return nmcliFieldOutput(args, (field) => values[field] ?? "");
	});
	spyOn(nmSecrets, "readVerifiedNmWifiSecret").mockImplementation(
		async (uuid) => (uuid === UUID ? PASSWORD : undefined),
	);
	spyOn(nm, "nmConnect").mockImplementation(async (uuid, _timeout, receipt) => {
		effects.push(`up:${uuid}`);
		limitedKernel?.connected(uuid);
		receipt?.(ACTIVE_PATH);
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
	limitedKernel = await limitedHybridFixture();
	spyOn(nm, "nmDevices").mockResolvedValue(["wlan0:wifi:disconnected:"]);
	spyOn(nm, "nmDisconnect").mockImplementation(async (uuid) => {
		effects.push(`down:${uuid}`);
		limitedKernel?.disconnected();
		return true;
	});
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
	spyOn(nm, "nmDevices").mockResolvedValue([`wlan0:wifi:connected:${UUID}`]);
	mockRosterActivation();
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
	spyOn(nm, "nmDevices").mockResolvedValue([`wlan0:wifi:connected:${UUID}`]);
	mockRosterActivation();
	row.activeConn = UUID;
	row.activeMode = "ap";
	spyOn(nm, "nmConnGetFields").mockResolvedValue(undefined);
	await handleHotspotConn(KEY, UUID, { active: true });
	expect(await wifiHotspotStop({ device: 0 })).toEqual({ success: true });
	expect(effects).toEqual([`down:${UUID}`]);
});

test("an unreadable concurrent active profile still leaves its observed UUID stoppable", async () => {
	spyOn(nm, "nmDevices").mockResolvedValue([
		"wlan0:wifi:connected:station-uplink",
		`clap-wlan0:wifi:connected:${UUID}`,
	]);
	mockRosterActivation();
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
	spyOn(nm, "nmDevices").mockResolvedValue([
		"wlan0:wifi:connected:replacement-ap",
	]);
	mockRosterActivation();
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

test.each(["plain", "port-only"] as const)(
	"limited boot requires lane A's plain intent for a correctly pinned profile (%s)",
	async (intent) => {
		const port = `${MAC}@usb-Port2:1.0`;
		const key = intent === "plain" ? MAC : port;
		getConfig().wifi_modes = { [key]: "hotspot" };
		profilePort = "usb-Port2:1.0";
		spyOn(radioIdentityReaders, "readDevicePath").mockResolvedValue(
			profilePort,
		);
		spyOn(credentials, "getHotspotCredentials").mockImplementation((owner) =>
			owner === key
				? { ssid: NAME, password: PASSWORD, conn: UUID, channel: "auto" }
				: undefined,
		);
		await reconcileWifiAdapterModes();
		expect(effects).toEqual(intent === "plain" ? [`up:${UUID}`] : []);
		expect(getConfig().wifi_modes).toEqual({ [key]: "hotspot" });
	},
);

test("limited boot cannot inherit a port-only hybrid profile with no live path", async () => {
	const port = `${MAC}@usb-Port2:1.0`;
	getConfig().wifi_modes = { [port]: "hybrid" };
	profileIfname = "clap-wlan0";
	spyOn(credentials, "getHotspotCredentials").mockImplementation((key) =>
		key === port ? { ssid: NAME, password: PASSWORD, conn: UUID } : undefined,
	);
	await reconcileWifiAdapterModes({
		...defaultAdapterModeDeps,
		readCapabilities: () => ({ staApCombo: { supported: true } }),
	});
	expect(effects).toEqual([]);
});

test.each(["missing", "matching"] as const)(
	"D12 with a plain Hybrid intent checks the saved path against the %s live path",
	async (path) => {
		getConfig().wifi_modes = { [MAC]: "hybrid" };
		profileIfname = "clap-wlan0";
		profilePort = "usb-Port2:1.0";
		spyOn(radioIdentityReaders, "readDevicePath").mockResolvedValue(
			path === "matching" ? profilePort : undefined,
		);
		await reconcileWifiAdapterModes({
			...defaultAdapterModeDeps,
			readCapabilities: () => ({ staApCombo: { supported: true } }),
		});
		expect(effects).toEqual(path === "matching" ? [`up:${UUID}`] : []);
		expect(warnings).toEqual(
			path === "missing"
				? [
						"limited restore: available port does not prove the saved owner on wlan0",
					]
				: ["hotspot restored on an adapter that could not be identified"],
		);
	},
);

test("exclusive D12 refuses a profile pinned to an interface other than the selected radio", async () => {
	profileIfname = "wlan9";
	await reconcileWifiAdapterModes();
	expect(effects).toEqual([]);
});

test("D12 sends the saved UUID and the verified interface to NetworkManager", async () => {
	const connect = spyOn(nm, "nmConnect");
	connect.mockRestore();
	const cli = spyOn(runner, "run");
	const read = cli.getMockImplementation();
	if (!read) throw new Error("Missing test CLI");
	const requests: string[][] = [];
	cli.mockImplementation(async (binary, args) => {
		if (binary === "nmcli" && args.includes("up")) {
			requests.push([...args]);
			return "Connection successfully activated";
		}
		return read(binary, args);
	});
	await reconcileWifiAdapterModes();
	expect(requests).toEqual([
		["-w", "30", "conn", "up", "uuid", UUID, "ifname", "wlan0"],
	]);
});

test("limited exclusive restore rechecks sole-radio eligibility at Up dispatch", async () => {
	// The profile-operation ownership preflight runs after D12's selection.
	spyOn(credentials, "getHotspotCredentialOwners").mockImplementation(() => {
		addWifiInterface("limited:4:1", radio(1));
		return [];
	});
	await reconcileWifiAdapterModes();
	expect(effects).toEqual([]);
});

test("limited hybrid restore rechecks intent at Up dispatch", async () => {
	getConfig().wifi_modes = { [MAC]: "hybrid" };
	profileIfname = "clap-wlan0";
	spyOn(credentials, "getHotspotCredentialOwners").mockImplementation(() => {
		getConfig().wifi_modes = { [MAC]: "station" };
		return [];
	});
	await reconcileWifiAdapterModes({
		...defaultAdapterModeDeps,
		readCapabilities: () => ({ staApCombo: { supported: true } }),
	});
	expect(effects).toEqual([]);
});

function alreadyPinnedLimitedProfile() {
	const profile = {
		"connection.interface-name": "clap-wlan0",
		"connection.autoconnect": "yes",
		"802-11-wireless.mode": "ap",
	};
	const resources = firstApInstances(
		new Set([UUID]),
		new Map([[UUID, profile]]),
	);
	resources.add(UUID);
	const observation = {
		active: undefined,
		pending: false,
		mode: "ap",
		ifname: profileIfname,
	};
	const inventory = spyOn(nm, "nmConnsGet");
	const listing = inventory.getMockImplementation();
	if (!listing) throw new Error("Missing fixture inventory");
	inventory.mockImplementation(async (fields) =>
		fields === "uuid,dbus-path" || fields === "uuid,filename"
			? resources.read(["--fields", fields], observation).split("\n")
			: listing(fields),
	);
	spyOn(credentials, "getHotspotCredentialOwners").mockImplementation((uuid) =>
		uuid === UUID ? [MAC] : [],
	);
	spyOn(runner, "run").mockImplementation(async (binary, args = []) => {
		if (binary === "busctl") return resources.busReply(args);
		if (binary === "nmcli" && nmcliFieldNames(args).length)
			return resources.read([...args], observation);
		throw new Error("Unexpected profile command");
	});
	spyOn(runner, "runWithStdin").mockImplementation(
		async (_binary, args, input) => {
			const fields = decodeProfile(input);
			for (let i = 3; i < args.length; i += 2) {
				const key = args[i];
				const value = args[i + 1];
				if (key === undefined || value === undefined)
					throw new Error("Invalid offline delta");
				fields[key] = value;
			}
			return encodeProfile(fields);
		},
	);
	return resources.files;
}

// Inject inside the caller's mutation guard, not on a global read count.
function duringDispatchProfileRead(
	change: () => void,
	atBoundary: (arm: () => void) => void = atUpPreflight,
) {
	let changed = false;
	let atDispatch = false;
	atBoundary(() => {
		atDispatch = true;
	});
	const read = nm.nmConnGetFields;
	spyOn(nm, "nmConnGetFields").mockImplementation(async (uuid, fields) => {
		const result = await read(uuid, fields);
		if (
			atDispatch &&
			!changed &&
			fields.includes("match.path") &&
			fields[0] === "802-11-wireless.mode"
		) {
			changed = true;
			change();
		}
		return result;
	});
	return () => changed;
}

function atCreatePreflight(change: () => void) {
	const select = spyOn(concurrent, "selectConcurrentApInterface");
	const implementation = select.getMockImplementation();
	if (!implementation) throw new Error("Missing fixture selector");
	select.mockImplementation((parent, admitted, create, onRefusal, guard) =>
		implementation(
			parent,
			admitted,
			create,
			onRefusal,
			guard && {
				...guard,
				beforeCreate: () => {
					change();
					return guard.beforeCreate();
				},
			},
		),
	);
}

function atUpPreflight(change: () => void) {
	let dispatched = false;
	const run = profileOperations.runHotspotProfileOperation;
	spyOn(profileOperations, "runHotspotProfileOperation").mockImplementation(
		(operation, evidence) => {
			if (operation.kind !== "up") return run(operation, evidence);
			const guarded: profileOperations.HotspotProfileOperation = {
				...operation,
				run: (...args: Parameters<typeof operation.run>) => {
					dispatched = true;
					change();
					return operation.run(...args);
				},
			};
			return run(guarded, evidence);
		},
	);
	return () => dispatched;
}

test.each(["lifetime", "MAC", "port"] as const)(
	"limited exclusive Up rejects unpublished changes to live %s evidence",
	async (evidence) => {
		if (!limitedKernel) throw new Error("Missing limited fixture");
		const kernel = limitedKernel;
		if (evidence === "port") profilePort = "original-port";
		const published = wifiRadioIdentity.state;
		const changed = duringDispatchProfileRead(() => {
			switch (evidence) {
				case "lifetime":
					kernel.replaceParent();
					break;
				case "MAC":
					kernel.permanent("dc:a6:32:aa:bb:cc");
					break;
				case "port":
					spyOn(radioIdentityReaders, "readDevicePath").mockResolvedValue(
						"replacement-port",
					);
					break;
			}
		});
		await reconcileWifiAdapterModes();
		expect(changed()).toBe(true);
		expect(wifiRadioIdentity.state).toBe(published);
		expect(effects).toEqual([]);
	},
);

test("limited hybrid restore activates an already pinned profile without modifying it", async () => {
	getConfig().wifi_modes = { [MAC]: "hybrid" };
	profileIfname = "clap-wlan0";
	const files = alreadyPinnedLimitedProfile();
	spyOn(runner, "runWithStdin").mockRejectedValue(
		new Error("Offline serialization unavailable"),
	);
	try {
		const bytes = await Bun.file(files.filename(UUID)).text();
		await reconcileWifiAdapterModes({
			...defaultAdapterModeDeps,
			readCapabilities: () => ({ staApCombo: { supported: true } }),
		});
		expect(effects).toEqual([`up:${UUID}`]);
		expect(await Bun.file(files.filename(UUID)).text()).toBe(bytes);
	} finally {
		files.close();
	}
});

test("limited hybrid restore does not change the target's device autoconnect policy", async () => {
	getConfig().wifi_modes = { [MAC]: "hybrid" };
	profileIfname = "clap-wlan0";
	await reconcileWifiAdapterModes({
		...defaultAdapterModeDeps,
		readCapabilities: () => ({ staApCombo: { supported: true } }),
	});
	expect(effects).toContain(`up:${UUID}`);
	expect(limitedKernel?.calls.filter(([binary]) => binary === "nmcli")).toEqual(
		[],
	);
});

test("limited hybrid cold restore creates its leg without changing device autoconnect", async () => {
	getConfig().wifi_modes = { [MAC]: "hybrid" };
	profileIfname = "clap-wlan0";
	if (!limitedKernel) throw new Error("Missing hybrid fixture");
	await limitedKernel.cold();
	await reconcileWifiAdapterModes({
		...defaultAdapterModeDeps,
		readCapabilities: () => ({ staApCombo: { supported: true } }),
	});
	expect(effects).toContain(`up:${UUID}`);
	expect(
		limitedKernel.calls.filter((args) => args.includes("add")),
	).toHaveLength(1);
	expect(limitedKernel.calls.filter(([binary]) => binary === "nmcli")).toEqual(
		[],
	);
});

test("limited hybrid cold restore never adds a leg to an unpublished replacement parent", async () => {
	getConfig().wifi_modes = { [MAC]: "hybrid" };
	profileIfname = "clap-wlan0";
	if (!limitedKernel) throw new Error("Missing hybrid fixture");
	const kernel = limitedKernel;
	await kernel.cold();
	const published = wifiRadioIdentity.state;
	const changed = duringDispatchProfileRead(
		kernel.replaceParent,
		atCreatePreflight,
	);
	await reconcileWifiAdapterModes({
		...defaultAdapterModeDeps,
		readCapabilities: () => ({ staApCombo: { supported: true } }),
	});
	expect(changed()).toBe(true);
	expect(wifiRadioIdentity.state).toBe(published);
	expect(kernel.calls.filter((args) => args.includes("add"))).toEqual([]);
	expect(effects).toEqual([]);
});

test.each(["1", "11"])(
	"limited same-channel hybrid restore checks saved channel %s against the station",
	async (savedChannel) => {
		getConfig().wifi_modes = { [MAC]: "hybrid" };
		profileIfname = "clap-wlan0";
		channel = savedChannel;
		profileBand = "bg";
		row.hotspot.bandCapability = ["auto", "auto_24"];
		setDerivedApChannels([
			{ channel: 1, freqMhz: 2412, band: "bg" },
			{ channel: 11, freqMhz: 2462, band: "bg" },
		]);
		await reconcileWifiAdapterModes({
			...defaultAdapterModeDeps,
			readCapabilities: () => ({ staApCombo: { supported: true } }),
		});
		expect(effects.filter((effect) => effect.startsWith("up:"))).toEqual(
			savedChannel === "1" ? [`up:${UUID}`] : [],
		);
	},
);

test("limited hybrid restore refuses a profile changed during the station probe", async () => {
	getConfig().wifi_modes = { [MAC]: "hybrid" };
	profileIfname = "clap-wlan0";
	let checkingUp = false;
	atUpPreflight(() => {
		checkingUp = true;
	});
	spyOn(concurrent, "readHybridStationChannel").mockImplementation(async () => {
		if (checkingUp) profileIfname = "unrelated-leg";
		return {
			identity: "station",
			frequency: 2412,
			fields: {},
			sameChannelOnly: true,
		};
	});
	await reconcileWifiAdapterModes({
		...defaultAdapterModeDeps,
		readCapabilities: () => ({ staApCombo: { supported: true } }),
	});
	expect(effects).toEqual([]);
});

test("limited hybrid Up refuses a roam during the dispatch leg identity check", async () => {
	getConfig().wifi_modes = { [MAC]: "hybrid" };
	profileIfname = "clap-wlan0";
	const kernel = limitedKernel;
	if (!kernel) throw new Error("Missing fixture");
	let checkingUp = false;
	let roamed = false;
	atUpPreflight(() => {
		checkingUp = true;
	});
	const readLeg = concurrent.readHybridTargetIdentity;
	spyOn(concurrent, "readHybridTargetIdentity").mockImplementation(
		async (...args) => {
			const result = await readLeg(...args);
			if (checkingUp) {
				roamed = true;
				kernel.roam();
			}
			return result;
		},
	);
	await reconcileWifiAdapterModes({
		...defaultAdapterModeDeps,
		readCapabilities: () => ({ staApCombo: { supported: true } }),
	});
	expect(roamed).toBe(true);
	expect(effects).toEqual([]);
});

test("limited hybrid Up refuses a station roam during the final profile read", async () => {
	getConfig().wifi_modes = { [MAC]: "hybrid" };
	profileIfname = "clap-wlan0";
	let identity = "station";
	spyOn(concurrent, "readHybridStationChannel").mockImplementation(
		async () => ({
			identity,
			frequency: 2412,
			fields: {},
			sameChannelOnly: true,
		}),
	);
	const roamed = duringDispatchProfileRead(() => {
		identity = "roamed";
	});
	await reconcileWifiAdapterModes({
		...defaultAdapterModeDeps,
		readCapabilities: () => ({ staApCombo: { supported: true } }),
	});
	expect(roamed()).toBe(true);
	expect(effects).toEqual([]);
});

test("limited hybrid Up refuses a replaced leg after the last profile read", async () => {
	getConfig().wifi_modes = { [MAC]: "hybrid" };
	profileIfname = "clap-wlan0";
	if (!limitedKernel) throw new Error("Missing hybrid fixture");
	const kernel = limitedKernel;
	const files = alreadyPinnedLimitedProfile();
	const replaced = duringDispatchProfileRead(kernel.replaceLeg);
	try {
		const bytes = await Bun.file(files.filename(UUID)).text();
		await reconcileWifiAdapterModes({
			...defaultAdapterModeDeps,
			readCapabilities: () => ({ staApCombo: { supported: true } }),
		});
		expect(replaced()).toBe(true);
		expect(effects).toEqual([]);
		expect(await Bun.file(files.filename(UUID)).text()).toBe(bytes);
	} finally {
		files.close();
	}
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
		spyOn(nm, "nmConnect").mockImplementation(
			async (_uuid, _timeout, receipt) => {
				if (outcome === "throws") throw new Error("Activation failed");
				if (outcome === "replacement")
					fixture.targets.set("clap-wlan0", { ifindex: 99, wdev: "0x99" });
				if (outcome === "cancel") cancel();
				const accepted = outcome === "success" || outcome === "cancel";
				if (accepted) {
					limitedKernel?.connected(UUID);
					receipt?.(ACTIVE_PATH);
				}
				return accepted;
			},
		);
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
			(ifname, admitted) =>
				concurrent.ensureConcurrentApInterface(ifname, admitted),
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
		spyOn(defaultHotspotDeps, "nmApConnAdd").mockImplementation(async () => {
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
		else
			expect(result).toEqual({
				success: false,
				error: "activation-failed",
				...(outcome === "reuse"
					? { reason: "hybrid-channel-not-permitted" }
					: {}),
			});
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
	test(`round five: discovery preserves targets without allocating reused=${reused}`, async () => {
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
			expect(Object.keys(connections.getWifiInterfacesByMacAddress())).toEqual([
				MAC,
			]);
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
	const connecting = handleWifi(
		{ send: (frame) => connected.resolve(String(frame)) },
		{ connect: "station-fixture" },
	);
	expect(JSON.parse(await connected.promise).wifi).toEqual({
		connect: true,
		device: "0",
	});
	await connecting;
	setWifiJoinNmcliRunner(async () => ({
		stdout: "Device 'wlan0' successfully activated with 'new-station-fixture'.",
		stderr: "",
		exitCode: 0,
	}));
	const joined = Promise.withResolvers<string>();
	const joining = handleWifi(
		{ send: (frame) => joined.resolve(String(frame)) },
		{
			new: { device: 0, ssid: "Station fixture", password: PASSWORD },
		},
	);
	expect(JSON.parse(await joined.promise).wifi).toEqual({
		new: { success: true, device: 0 },
	});
	expect(effects).toEqual(["up:station-fixture"]);
	await joining;
});

test("limited Stop and station selection cannot clear another present radio's intent", async () => {
	const other = "dc:a6:32:aa:bb:cc";
	addWifiInterface(other, radio(1));
	getConfig().wifi_modes = { [other]: "hotspot" };
	row.activeConn = UUID;
	row.activeMode = "ap";
	row.hotspot.conn = UUID;
	const roster = spyOn(nm, "nmDevices").mockResolvedValue([
		`wlan0:wifi:connected:${UUID}`,
	]);
	mockRosterActivation();
	expect(await wifiHotspotStop({ device: 0 })).toEqual({ success: true });
	expect(getConfig().wifi_modes).toEqual({ [other]: "hotspot" });
	roster.mockResolvedValue(["wlan0:wifi:disconnected:"]);
	expect(await setWifiAdapterMode(0, "station")).toEqual({
		success: true,
		applied: "station",
	});
	expect(getConfig().wifi_modes).toEqual({ [other]: "hotspot" });
	expect(effects).toEqual([`down:${UUID}`]);
});

test("limited hybrid restore preserves the station and uses only the already bound profile", async () => {
	const saved = {
		ssid: NAME,
		password: PASSWORD,
		conn: UUID,
		channel: "ch_11" as const,
	};
	spyOn(credentials, "getHotspotCredentials").mockImplementation((key) =>
		key === MAC ? saved : undefined,
	);
	spyOn(credentials, "rememberHotspotCredentials").mockImplementation(
		(_key, value) => {
			effects.push("store-write");
			Object.assign(saved, value);
		},
	);
	row.hotspot.channel = saved.channel;
	getConfig().wifi_modes = { [MAC]: "hybrid" };
	row.conn = "station-uplink";
	streamingOn = true;
	profileIfname = "clap-wlan0";
	spyOn(concurrent, "ensureConcurrentApInterface").mockImplementation(
		async () => {
			effects.push("iw-add");
			return { ifname: "clap-wlan0", created: false, type: "managed" };
		},
	);
	await reconcileWifiAdapterModes({
		...defaultAdapterModeDeps,
		readCapabilities: () => ({ staApCombo: { supported: true } }),
	});
	expect(effects).toEqual(["iw-add", `up:${UUID}`]);
	expect(saved.channel).toBe("ch_11");
	expect(row.hotspot.channel).toBe("ch_11");
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
		if (scenario === "replacement") {
			if (!limitedKernel) throw new Error("Missing limited fixture");
			limitedKernel.replaceParent();
			await limitedKernel.observeParent();
		}
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

test.each(["initial", "target changed", "channel changed"] as const)(
	"limited hybrid restore reports the structured %s failure",
	async (stage) => {
		getConfig().wifi_modes = { [MAC]: "hybrid" };
		profileIfname = "clap-wlan0";
		let channelReads = 0;
		spyOn(concurrent, "readHybridStationChannel").mockImplementation(
			async () =>
				stage === "initial"
					? undefined
					: {
							identity:
								stage === "channel changed"
									? String(++channelReads)
									: "station",
							frequency: 2412,
							fields: {},
							sameChannelOnly: true,
						},
		);
		spyOn(concurrent, "revalidateConcurrentApInterface").mockResolvedValue(
			stage !== "target changed",
		);
		const warnings: unknown[][] = [];
		spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
			warnings.push(args);
			return logger;
		});
		await restoreLimitedHotspot(
			row,
			{
				...defaultAdapterModeDeps,
				readCapabilities: () => ({ staApCombo: { supported: true } }),
			},
			() => ({ [MAC]: "hybrid" }),
			undefined,
			{ attempt: 2, maxAttempts: 3 },
		);
		expect(warnings.map(([, fields]) => fields)).toEqual([
			expect.objectContaining({
				event: "wifi-hybrid-target-refused",
				path: "limited-restore",
				reasonCode:
					stage === "initial"
						? "station-channel-unavailable"
						: "limited-hybrid-revalidation-failed",
				subReason:
					stage === "initial"
						? "channel-read-unreported"
						: stage === "target changed"
							? "target-no-longer-valid"
							: "station-channel-changed",
				attempt: 2,
				maxAttempts: 3,
			}),
		]);
		expect(effects).toEqual([]);
	},
);

test("limited hybrid revalidation identifies lost admission after checking the target", async () => {
	getConfig().wifi_modes = { [MAC]: "hybrid" };
	profileIfname = "clap-wlan0";
	spyOn(concurrent, "readHybridStationChannel").mockResolvedValue({
		identity: "station",
		frequency: 2412,
		fields: {},
		sameChannelOnly: true,
	});
	let preference: "hybrid" | "station" = "hybrid";
	const revalidate = concurrent.revalidateConcurrentApInterface;
	spyOn(concurrent, "revalidateConcurrentApInterface").mockImplementation(
		async (target) => {
			const result = await revalidate(target);
			preference = "station";
			return result;
		},
	);
	const warnings: unknown[][] = [];
	spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
		warnings.push(args);
		return logger;
	});
	await restoreLimitedHotspot(
		row,
		{
			...defaultAdapterModeDeps,
			readCapabilities: () => ({ staApCombo: { supported: true } }),
		},
		() => ({ [MAC]: preference }),
		undefined,
		{ attempt: 2, maxAttempts: 3 },
	);
	expect(warnings.map(([, fields]) => fields)).toEqual([
		expect.objectContaining({
			event: "wifi-hybrid-target-refused",
			path: "limited-restore",
			reasonCode: "limited-hybrid-revalidation-failed",
			subReason: "admission-lost",
			attempt: 2,
		}),
	]);
});

test("regulatory change stops a limited live AP without profile or intent writes", async () => {
	spyOn(nm, "nmDevices").mockResolvedValue([`wlan0:wifi:connected:${UUID}`]);
	mockRosterActivation();
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
