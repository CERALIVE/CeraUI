import {
	afterEach,
	beforeEach,
	expect,
	jest,
	mock,
	spyOn,
	test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as runner from "../helpers/run.ts";
import * as mockWifi from "../mocks/providers/wifi.ts";
import * as profileFile from "../modules/network/network-manager-profile-file.ts";
import * as profileWrite from "../modules/network/network-manager-profile-write.ts";
import {
	getAllHotspotCredentials,
	getHotspotCredentials,
	hotspotCredentialsStore,
	initHotspotCredentials,
	rememberHotspotCredentials,
	resetHotspotCredentialsForTest,
} from "../modules/wifi/hotspot-credentials.ts";
import {
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import { wifiUpdateSavedConns } from "../modules/wifi/wifi.ts";
import {
	resetWifiCapabilitiesForTest,
	setWifiCapabilityDepsForTest,
} from "../modules/wifi/wifi-capabilities.ts";
import {
	addWifiInterface,
	wifiCancelScanRefresh,
} from "../modules/wifi/wifi-connections.ts";
import {
	wifiDeviceListAdd,
	wifiDeviceListEndUpdate,
	wifiDeviceListStartUpdate,
} from "../modules/wifi/wifi-device-list.ts";
import {
	defaultHotspotDeps,
	prepareHotspotForInterface,
	startHotspotForInterface,
} from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	type HotspotConfigDeps,
	wifiHotspotConfig,
} from "../modules/wifi/wifi-hotspot-config.ts";
import * as discovery from "../modules/wifi/wifi-hotspot-discovery.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { readHotspotProfilePins } from "../modules/wifi/wifi-hotspot-profile-operation.ts";
import type {
	HotspotActivationDeps,
	WifiInterfaceWithHotspot,
} from "../modules/wifi/wifi-hotspot-types.ts";
import { isApMode } from "../modules/wifi/wifi-hotspot-types.ts";
import {
	getWifiIdToMacAddress,
	resetWifiConnectionModeCache,
	resetWifiInterfaceDiscoveryForTest,
	stopWifiUpdateLoopForTest,
	wifiUpdateDevices,
} from "../modules/wifi/wifi-interfaces.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
import {
	nmcliFieldNames,
	nmcliFieldOutput,
} from "./helpers/nmcli-field-output.ts";
import { mockSettingsDeletion } from "./helpers/wifi-active-observation.ts";
import { firstApInstances } from "./helpers/wifi-first-ap-instances.ts";
import {
	decodeProfile,
	encodeProfile,
} from "./helpers/wifi-first-ap-keyfile-codec.ts";
import { fakeShadowSysfs } from "./helpers/wifi-radio-equivalence-shadow.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const A = "58:02:05:e1:79:1c";
const B = "dc:a6:32:aa:bb:cc";
const FOREIGN = "a-profile";
const UNRELATED = "operator-profile";
const PAIR = { ssid: "Adapter-A", password: "adapter-a-secret" };
const OWN_PAIR = { ssid: "Adapter-B", password: "adapter-b-secret" };
const profiles = new Map<string, Record<string, string>>();
const effects: string[][] = [];
const unexpected: string[] = [];
let devices = "wlan0:wifi:disconnected:";
let inherited: ReturnType<typeof isolateWifiRegistry>;
let scratch: string | undefined;
let afterWrite: (() => void) | undefined;
let beforeWrite: ((args: readonly string[]) => Promise<void>) | undefined;
let unreadableSettings = false;
let afterPruneSettings: ((isFinalRead: boolean) => void) | undefined;
let sampledPruneActivity: boolean;
let pruneSecretReads: number;
let pruneSecretFlags: number;
let afterPruneActivity: ((afterFinalSettings: boolean) => void) | undefined;
let readFinalSettings: boolean;
let afterSavedSettingsRead: (() => void) | undefined;
let historicalActivity: "yes" | "no" | "unknown" = "no";
let restoreShadow: () => Promise<void>;
let resources: ReturnType<typeof firstApInstances>;
let settleDiscoveryRace: (() => Promise<void>) | undefined;

function profile(mac = "", ifname = "wlan0"): Record<string, string> {
	return {
		"802-11-wireless-security.psk-flags": "0",
		"connection.interface-name": ifname,
		"connection.autoconnect": "yes",
		"connection.autoconnect-priority": "0",
		"802-11-wireless.mode": "ap",
		"802-11-wireless.ssid": PAIR.ssid,
		"802-11-wireless-security.psk": PAIR.password,
		"802-11-wireless.mac-address": mac,
		"802-11-wireless.band": "",
		"802-11-wireless.channel": "0",
		"802-11-wireless.hidden": "no",
		"802-11-wireless-security.key-mgmt": "wpa-psk",
		"802-11-wireless-security.pairwise": "ccmp",
		"802-11-wireless-security.group": "ccmp",
		"802-11-wireless-security.proto": "rsn",
		"802-11-wireless-security.pmf": "1",
	};
}

function radio(): WifiInterfaceWithHotspot {
	const iface: WifiInterfaceWithHotspot = {
		id: 0,
		ifname: "wlan0",
		conn: null,
		hw: "Fixture radio",
		available: new Map(),
		saved: {},
		savedAll: {},
		hotspot: { availableChannels: ["auto"], warnings: {} },
	};
	addWifiInterface(B, iface);
	getWifiIdToMacAddress()[0] = B;
	return iface;
}

function ownByA(history: boolean): void {
	rememberHotspotCredentials(A, { ...PAIR, conn: FOREIGN });
	if (history) {
		rememberHotspotCredentials(A, { ...PAIR, conn: "a-current" });
	}
}

function activationDeps(): HotspotActivationDeps {
	return {
		readProfileInstance: async (uuid) =>
			profiles.has(uuid) ? undefined : null,
		releaseConcurrentInterface: async () => true,
		credentials: hotspotCredentialsStore,
		findHotspotConn: discovery.findHotspotConnForAdapter,
		nmConnSetFields: async (uuid, fields) => {
			effects.push([uuid, JSON.stringify(fields)]);
			const settings = profiles.get(uuid);
			if (settings) Object.assign(settings, fields);
			return true;
		},
		nmConnect: async (uuid) => {
			effects.push(["up", uuid]);
			return true;
		},
		nmApConnAdd: async (_ifname, { name: ssid, password }) => {
			effects.push(["create", ssid, password]);
			return "b-new-profile";
		},
		nmConnDelete: async () => true,
		nmDisconnect: async () => true,
		wifiUpdateSavedConns: async () => {},
		broadcastState: () => {},
		setDupIpSuppression: () => {},
		pruneHotspotConns: async () => {},
	};
}

beforeEach(async () => {
	inherited = isolateWifiRegistry();
	resetHotspotCredentialsForTest();
	resetWifiConnectionModeCache();
	resetWifiInterfaceDiscoveryForTest();
	resetWifiCapabilitiesForTest();
	onWifiChange(() => {});
	setWifiState({});
	profiles.clear();
	profiles.set(FOREIGN, profile());
	profiles.set(UNRELATED, {
		...profile("02:00:00:00:00:99", "other0"),
		"802-11-wireless.ssid": "Operator-AP",
		"802-11-wireless-security.psk": "operator-secret",
	});
	resources = firstApInstances(new Set(profiles.keys()), profiles);
	effects.length = 0;
	unexpected.length = 0;
	afterWrite = undefined;
	beforeWrite = undefined;
	unreadableSettings = false;
	afterPruneSettings = undefined;
	sampledPruneActivity = false;
	pruneSecretReads = 0;
	pruneSecretFlags = 0;
	afterPruneActivity = undefined;
	readFinalSettings = false;
	afterSavedSettingsRead = undefined;
	historicalActivity = "no";
	settleDiscoveryRace = undefined;
	devices = "wlan0:wifi:disconnected:";
	restoreShadow = await fakeShadowSysfs(() => [
		{
			ifname: "wlan0",
			operational: B,
			permanent: B,
			ifindex: 3,
			phy: 0,
			state: "disconnected",
		},
		{
			ifname: "clap-wlan0",
			operational: B,
			permanent: B,
			ifindex: 4,
			phy: 0,
			state: "connected",
		},
	]);
	setWifiCapabilityDepsForTest({
		runIw: async () => "",
		readPhyName: async () => undefined,
		pathExists: async () => false,
		readNmcliWifiProperties: async () => new Map(),
		now: () => 0,
	});
	spyOn(mockWifi, "shouldMockWifi").mockReturnValue(false);
	mockSettingsDeletion(resources.run, (path) => {
		resources.sync();
		const uuid = resources.paths().find(([, target]) => target === path)?.[0];
		if (!uuid || !profiles.delete(uuid))
			throw new Error("Historical deletion must select a live settings path");
	});
	spyOn(runner, "run").mockImplementation(async (bin, args) => {
		resources.sync();
		if (bin === "busctl") return resources.busReply(args);
		if (
			bin === "iw" &&
			(args.join(" ") === "dev wlan0 station dump" ||
				args.join(" ") === "dev clap-wlan0 station dump")
		)
			return "";
		if (bin === "nmcli") {
			if (args[0] === "connection" && args[1] === "load") {
				const loaded = decodeProfile(readFileSync(args[2] ?? "", "utf8"));
				const uuid = loaded["connection.uuid"];
				if (!uuid) throw new Error("Missing loaded ownership fixture UUID");
				const current = profiles.get(uuid) ?? {};
				const delta = Object.entries(loaded).filter(
					([key, value]) =>
						key !== "connection.uuid" &&
						key !== "connection.type" &&
						key !== "802-11-wireless-security.psk-flags" &&
						current[key] !== value,
				);
				const effect = ["con", "modify", uuid, ...delta.flat()];
				if (beforeWrite) await beforeWrite(effect);
				effects.push(effect);
				Object.assign(current, loaded);
				resources.bumpVersion(uuid);
				afterWrite?.();
				return "";
			}
			if (args.includes("--fields")) {
				const fields = args[args.indexOf("--fields") + 1];
				if (fields === "uuid,type,name")
					return [...profiles.keys()]
						.map(
							(id) =>
								`${id}:802-11-wireless:${profiles.get(id)?.["connection.id"] ?? "Operator"}`,
						)
						.join("\n");
				if (fields === "uuid,active" || fields === "uuid,active,dbus-path") {
					if (fields === "uuid,active,dbus-path") sampledPruneActivity = true;
					const inventory = [...profiles.keys()]
						.map((id) => {
							const active = id === FOREIGN ? historicalActivity : "no";
							const path = resources.paths().find(([uuid]) => uuid === id)?.[1];
							return fields === "uuid,active"
								? `${id}:${active}`
								: `${id}:${active}:${path}`;
						})
						.join("\n");
					afterPruneActivity?.(readFinalSettings);
					return inventory;
				}
				if (fields === "uuid,dbus-path" || fields === "uuid,filename")
					return [...profiles.keys()]
						.map(
							(uuid) =>
								`${uuid}:${
									fields === "uuid,filename"
										? resources.files.filename(uuid)
										: resources.paths().find(([id]) => id === uuid)?.[1]
								}`,
						)
						.join("\n");
			}
			const fieldNames = nmcliFieldNames(args);
			if (fieldNames.length > 0) {
				const uuid = args.at(-1) ?? "";
				const fields = profiles.get(uuid);
				if (
					unreadableSettings &&
					fieldNames.includes("connection.autoconnect-priority")
				) {
					throw new Error("Fixture settings unavailable");
				}
				const output = nmcliFieldOutput(args, (field) => fields?.[field] ?? "");
				if (
					uuid === FOREIGN &&
					fieldNames.includes("connection.autoconnect-priority")
				)
					afterSavedSettingsRead?.();
				if (uuid === FOREIGN) {
					if (args.includes("--show-secrets")) pruneSecretFlags++;
					if (fieldNames.includes("802-11-wireless-security.psk"))
						pruneSecretReads++;
					if (
						fieldNames.includes("match.path") &&
						fieldNames.includes("802-11-wireless.mode")
					) {
						readFinalSettings ||= sampledPruneActivity;
						afterPruneSettings?.(sampledPruneActivity);
					}
				}
				return output;
			}
			if (args[0] === "con" && args[1] === "modify") {
				if (beforeWrite) await beforeWrite(args);
				effects.push([...args]);
				const fields = profiles.get(args[2] ?? "");
				for (let i = 3; i < args.length; i += 2) {
					const key = args[i];
					const value = args[i + 1];
					if (fields && key && value !== undefined) fields[key] = value;
				}
				afterWrite?.();
				return "";
			}
			if (args.join(" ") === "--terse --fields uuid,type connection show") {
				return [...profiles.keys()]
					.map((id) => `${id}:802-11-wireless`)
					.join("\n");
			}
			if (
				args.join(" ") ===
				"--terse --fields device,type,state,con-uuid device status"
			) {
				return devices;
			}
			if (
				args.includes("IN-USE,BSSID,SSID,MODE,CHAN,RATE,SIGNAL,BARS,SECURITY")
			)
				return "";
		}
		unexpected.push(`${bin} ${args.join(" ")}`);
		throw new Error(`Unexpected ownership command: ${bin} ${args.join(" ")}`);
	});
	spyOn(runner, "runWithStdin").mockImplementation(async (bin, args, input) => {
		if (
			bin !== "nmcli" ||
			args.slice(0, 3).join(" ") !== "--offline connection modify"
		)
			throw new Error("Unexpected ownership offline operation");
		const fields = decodeProfile(input);
		for (let i = 3; i < args.length; i += 2) {
			const key = args[i],
				value = args[i + 1];
			if (!key || value === undefined)
				throw new Error("Invalid offline fields");
			fields[key] = value;
		}
		return encodeProfile(fields);
	});
});

afterEach(async () => {
	await settleDiscoveryRace?.();
	stopWifiUpdateLoopForTest();
	wifiCancelScanRefresh();
	wifiRadioObservation.stop();
	await restoreShadow();
	await settlePending("wlan0", false);
	restoreWifiRegistry(inherited);
	resetHotspotCredentialsForTest();
	resetWifiConnectionModeCache();
	resetWifiInterfaceDiscoveryForTest();
	resetWifiCapabilitiesForTest();
	setWifiState({});
	jest.useRealTimers();
	mock.restore();
	resources.files.close();
	if (scratch) await rm(scratch, { recursive: true });
	scratch = undefined;
	expect(unexpected).toEqual([]);
});

for (const history of [false, true]) {
	for (const route of [
		"explicit active O1",
		"ifname O2",
		"concurrent O8",
	] as const) {
		test(`${route} never adopts an absent adapter's ${history ? "previous" : "current"} UUID`, async () => {
			ownByA(history);
			const iface = radio();
			if (route === "concurrent O8") {
				iface.supportsApStaConcurrency = true;
				profiles.set(FOREIGN, profile("", "clap-wlan0"));
			}
			const before = JSON.stringify([...profiles]);
			const identities = getAllHotspotCredentials();

			await discovery.handleHotspotConn(
				route === "explicit active O1" ? B : undefined,
				FOREIGN,
				{ active: true },
			);

			expect(iface.hotspot.conn).toBeUndefined();
			expect(iface.hotspot.password).toBeUndefined();
			expect(getAllHotspotCredentials()).toEqual(identities);
			expect(JSON.stringify([...profiles])).toBe(before);
			expect(effects).toEqual([]);
		});
	}
}

for (const route of ["stale hint", "SSID fallback", "MAC pin"] as const) {
	test(`O3 rejects another owner's profile through ${route}`, async () => {
		ownByA(true);
		profiles.set(FOREIGN, profile(route === "MAC pin" ? B : ""));
		const stored = {
			...PAIR,
			...(route === "stale hint" ? { conn: FOREIGN } : {}),
		};

		expect(
			await discovery.findHotspotConnForAdapter(B, stored),
		).toBeUndefined();
		expect(effects).toEqual([]);
		expect(getHotspotCredentials(B)).toBeUndefined();
	});
}

for (const present of [false, true]) {
	test(`O3 rejects a known ${present ? "present" : "absent"} conflicting pin even without UUID ownership`, async () => {
		radio();
		if (present) addWifiInterface(A, { ...radio(), id: 1, ifname: "wlan1" });
		else rememberHotspotCredentials(A, PAIR);
		profiles.set(FOREIGN, profile(A));

		expect(await discovery.findHotspotConnForAdapter(B, PAIR)).toBeUndefined();
		await discovery.handleHotspotConn(undefined, FOREIGN, { active: true });
		expect(getHotspotCredentials(B)).toBeUndefined();
		expect(effects).toEqual([]);
	});
}

for (const history of [false, true]) {
	test(`O4 rejects a store write using another adapter's ${history ? "previous" : "current"} UUID`, () => {
		ownByA(history);
		const before = getAllHotspotCredentials();

		rememberHotspotCredentials(B, { ...PAIR, conn: FOREIGN });

		expect(getAllHotspotCredentials()).toEqual(before);
		expect(getHotspotCredentials(B)).toBeUndefined();
	});
}

test("O5 live settings save cannot rewrite another adapter's profile or store", async () => {
	ownByA(false);
	const iface = radio();
	iface.hotspot = {
		...iface.hotspot,
		conn: FOREIGN,
		name: PAIR.ssid,
		password: PAIR.password,
	};
	iface.activeConn = FOREIGN;
	const sent: string[] = [];
	const before = JSON.stringify([...profiles]);
	const identities = getAllHotspotCredentials();

	await wifiHotspotConfig(
		{
			send: (message) => {
				sent.push(message);
			},
		},
		{
			device: 0,
			name: OWN_PAIR.ssid,
			password: OWN_PAIR.password,
			channel: "auto",
		},
	);

	expect(sent.map((s) => JSON.parse(s).wifi.hotspot.config)).toEqual([
		{ device: 0, error: "saving" },
	]);
	expect(JSON.stringify([...profiles])).toBe(before);
	expect(getAllHotspotCredentials()).toEqual(identities);
	expect(effects).toEqual([]);
});

for (const complete of [false, true]) {
	for (const operation of ["prepare", "save", "start"] as const) {
		test(`O6 ${operation} rechecks ${complete ? "complete cached" : "incomplete repair"} UUID ownership`, async () => {
			ownByA(true);
			const iface = radio();
			iface.hotspot.conn = FOREIGN;
			if (complete) {
				iface.hotspot.name = PAIR.ssid;
				iface.hotspot.password = PAIR.password;
			}
			const deps = activationDeps();
			const before = getAllHotspotCredentials();

			const result =
				operation === "start"
					? await startHotspotForInterface(B, iface, deps)
					: await prepareHotspotForInterface(
							B,
							iface,
							operation === "save"
								? { name: OWN_PAIR.ssid, password: OWN_PAIR.password }
								: {},
							deps,
						);

			expect(result).toEqual({ success: false, error: "activation-failed" });
			expect(getAllHotspotCredentials()).toEqual(before);
			expect(effects).toEqual([]);
		});
	}
}

test("O6 already-active shortcut rechecks the cached UUID owner", async () => {
	ownByA(false);
	const iface = radio();
	iface.hotspot = {
		...iface.hotspot,
		conn: FOREIGN,
		name: PAIR.ssid,
		password: PAIR.password,
	};
	iface.activeConn = FOREIGN;

	expect(await startHotspotForInterface(B, iface, activationDeps())).toEqual({
		success: false,
		error: "activation-failed",
	});
	expect(effects).toEqual([]);
});

test("O6 checks ownership acquired while a profile lookup was pending", async () => {
	const iface = radio();
	const deps = activationDeps();
	deps.findHotspotConn = async () => {
		ownByA(false);
		return { uuid: FOREIGN, ...PAIR, channel: "auto" };
	};

	expect(await prepareHotspotForInterface(B, iface, {}, deps)).toEqual({
		success: false,
		error: "activation-failed",
	});
	expect(iface.hotspot.conn).toBeUndefined();
	expect(getHotspotCredentials(B)).toBeUndefined();
	expect(effects).toEqual([]);
});

test("O1 rechecks ownership after awaited profile normalization", async () => {
	const iface = radio();
	profiles.set(FOREIGN, profile(B));
	rememberHotspotCredentials(B, { ...PAIR, conn: FOREIGN });
	afterWrite = () => {
		resetHotspotCredentialsForTest();
		ownByA(false);
	};

	await discovery.handleHotspotConn(B, FOREIGN, { active: true });

	expect(iface.hotspot.conn).toBeUndefined();
	expect(getHotspotCredentials(B)).toBeUndefined();
	expect(effects).toEqual([
		["con", "modify", FOREIGN, "connection.autoconnect-priority", "999"],
	]);
});

test("O5 does not restart or remember a profile claimed during the live save", async () => {
	const iface = radio();
	iface.hotspot = {
		...iface.hotspot,
		conn: FOREIGN,
		name: PAIR.ssid,
		password: PAIR.password,
	};
	iface.activeConn = FOREIGN;
	afterWrite = () => ownByA(false);
	const sent: string[] = [];

	await wifiHotspotConfig(
		{
			send: (message) => {
				sent.push(message);
			},
		},
		{
			device: 0,
			name: OWN_PAIR.ssid,
			password: OWN_PAIR.password,
			channel: "auto",
		},
	);

	expect(sent.map((s) => JSON.parse(s).wifi.hotspot.config)).toEqual([
		{ device: 0, error: "saving" },
	]);
	expect(getHotspotCredentials(B)).toBeUndefined();
	expect(effects).toHaveLength(1);
	expect(iface.hotspot.transition).toBeUndefined();
});

test.each([true, false])(
	"saved-profile sweep leaves foreign profiles untouched (other owner=%p)",
	async (recorded) => {
		if (recorded) ownByA(false);
		const iface = radio();
		profiles.set(FOREIGN, profile(recorded ? B : "26:c3:93:b6:9c:a7"));
		const before = JSON.stringify([...profiles]);
		const realHandle = discovery.handleHotspotConn;
		const pending: Promise<void>[] = [];
		spyOn(discovery, "handleHotspotConn").mockImplementation((...args) => {
			const result = realHandle(...args);
			pending.push(result);
			return result;
		});

		await wifiUpdateSavedConns();
		await Promise.all(pending);

		expect(pending).toHaveLength(2);
		expect(iface.hotspot.conn).toBeUndefined();
		expect(getHotspotCredentials(B)).toBeUndefined();
		expect(JSON.stringify([...profiles])).toBe(before);
		expect(effects).toEqual([]);
	},
);

test("Prepare stores new credentials without overwriting an unrecorded saved AP", async () => {
	const iface = radio();
	profiles.set(FOREIGN, profile(B));
	const before = JSON.stringify(profiles.get(FOREIGN));

	const chosen = { name: OWN_PAIR.ssid, password: OWN_PAIR.password };
	const result = await prepareHotspotForInterface(
		B,
		iface,
		chosen,
		activationDeps(),
	);

	expect(JSON.stringify(profiles.get(FOREIGN))).toBe(before);
	expect(result).toEqual({ success: true, firstTime: true, ...chosen });
	expect(iface.hotspot.conn).toBeUndefined();
	expect(getHotspotCredentials(B)).toMatchObject(OWN_PAIR);
});

test("Start creates a distinct owned AP instead of reusing an unrecorded profile", async () => {
	const iface = radio();
	profiles.set(FOREIGN, profile(B));
	const before = JSON.stringify(profiles.get(FOREIGN));
	rememberHotspotCredentials(B, OWN_PAIR);

	expect(await startHotspotForInterface(B, iface, activationDeps())).toEqual({
		success: true,
	});
	expect(effects.filter(([effect]) => effect === "create")).toEqual([
		["create", OWN_PAIR.ssid, OWN_PAIR.password],
	]);
	expect(getHotspotCredentials(B)?.conn).toBe("b-new-profile");
	expect(JSON.stringify(profiles.get(FOREIGN))).toBe(before);
});

test("Start cannot normalize a saved AP whose record vanishes during refresh", async () => {
	const iface = radio();
	iface.hotspot.conn = FOREIGN;
	iface.hotspot.name = PAIR.ssid;
	iface.hotspot.password = PAIR.password;
	rememberHotspotCredentials(B, { ...PAIR, conn: FOREIGN });
	const before = JSON.stringify(profiles.get(FOREIGN));
	const deps = activationDeps();
	deps.wifiUpdateSavedConns = async () => {
		resetHotspotCredentialsForTest();
	};

	const result = await startHotspotForInterface(B, iface, deps);

	expect(effects).toEqual([]);
	expect(result).toEqual({ success: false, error: "activation-failed" });
	expect(JSON.stringify(profiles.get(FOREIGN))).toBe(before);
});

test.each(["802-11-wireless.mac-address", "match.path"] as const)(
	"cached Start refuses a conflicting live %s pin",
	async (field) => {
		const iface = radio();
		iface.hotspot.conn = FOREIGN;
		iface.hotspot.name = PAIR.ssid;
		iface.hotspot.password = PAIR.password;
		rememberHotspotCredentials(B, { ...PAIR, conn: FOREIGN });
		const fields = {
			...profile(B),
			[field]: field === "match.path" ? "pci-foreign-port" : A,
		};
		profiles.set(FOREIGN, fields);
		// A missing in-memory pin must not hide a live pin owned by a different radio.
		rememberHotspotCredentials(A, OWN_PAIR);
		const before = { ...fields };
		const readProfilePins = defaultHotspotDeps.readProfilePins;
		if (!readProfilePins) throw new Error("Expected production pin reader");
		const refresh = mock(wifiUpdateSavedConns);
		const deps = {
			...activationDeps(),
			readProfilePins,
			wifiUpdateSavedConns: refresh,
		};

		const result = await startHotspotForInterface(B, iface, deps);

		expect(effects).toEqual([]);
		expect(result).toEqual({ success: false, error: "activation-failed" });
		expect(profiles.get(FOREIGN)).toEqual(before);
		expect(refresh).not.toHaveBeenCalled();
	},
);

test("starting one owner cannot prune another owner's retired profile", async () => {
	ownByA(true);
	rememberHotspotCredentials(B, { ...OWN_PAIR, conn: UNRELATED });
	rememberHotspotCredentials(B, { ...OWN_PAIR, conn: "b-current" });
	profiles.set(FOREIGN, { ...profile(A, ""), "connection.id": "Hotspot" });
	profiles.set(UNRELATED, { ...profile(B, ""), "connection.id": "Hotspot-1" });

	expect(await discovery.pruneDuplicateHotspotConns(B, "b-current")).toEqual([
		UNRELATED,
	]);
	expect([...profiles.keys()]).toEqual([FOREIGN]);
});

test("production prune deletes an eligible retired AP through its exact settings path", async () => {
	ownByA(true);
	profiles.set(FOREIGN, { ...profile(A, ""), "connection.id": "Hotspot" });
	expect(await discovery.pruneDuplicateHotspotConns(A, "a-current")).toEqual([
		FOREIGN,
	]);
	expect(profiles.has(FOREIGN)).toBe(false);
});

test.each(["discovery", "prepare"] as const)(
	"%s cannot rewrite an owned AP pinned to a foreign port",
	async (action) => {
		const iface = radio();
		rememberHotspotCredentials(B, { ...PAIR, conn: FOREIGN });
		const fields = { ...profile(B), "match.path": "pci-foreign-port" };
		profiles.set(FOREIGN, fields);
		iface.hotspot.conn = FOREIGN;
		iface.hotspot.name = PAIR.ssid;
		iface.hotspot.password = PAIR.password;
		const before = { ...fields };
		if (action === "discovery") await discovery.handleHotspotConn(B, FOREIGN);
		else {
			expect(
				await prepareHotspotForInterface(
					B,
					iface,
					{ name: OWN_PAIR.ssid, password: OWN_PAIR.password },
					{
						...activationDeps(),
						...(defaultHotspotDeps.readProfilePins
							? { readProfilePins: defaultHotspotDeps.readProfilePins }
							: {}),
					},
				),
			).toEqual({ success: false, error: "activation-failed" });
		}
		expect(effects).toEqual([]);
		expect(profiles.get(FOREIGN)).toEqual(before);
	},
);

test.each([false, true])(
	"cold Start leaves an owned profile pinned to another port untouched (pin changes during refresh=%p)",
	async (duringRefresh) => {
		const iface = radio();
		rememberHotspotCredentials(B, { ...PAIR, conn: FOREIGN });
		const foreignPort = "pci-foreign-port";
		const fields = {
			...profile(B),
			"match.path": duringRefresh ? "" : foreignPort,
		};
		profiles.set(FOREIGN, fields);
		let foreignPinObserved = !duringRefresh;
		if (duringRefresh)
			afterSavedSettingsRead = () => {
				afterSavedSettingsRead = undefined;
				// Only the independent pin read sees drift; the operation receipt
				// must remain eligible so it cannot mask a missing refresh guard.
				foreignPinObserved = true;
			};
		const readProfilePins = defaultHotspotDeps.readProfilePins;
		if (!readProfilePins) throw new Error("Expected production pin reader");
		const refresh = mock(wifiUpdateSavedConns);

		const result = await startHotspotForInterface(B, iface, {
			...activationDeps(),
			readProfilePins: async (uuid) =>
				uuid === FOREIGN && foreignPinObserved
					? [B, foreignPort]
					: readProfilePins(uuid),
			wifiUpdateSavedConns: refresh,
		});

		expect(effects).toEqual([]);
		expect(result).toEqual({ success: false, error: "activation-failed" });
		expect(refresh).toHaveBeenCalledTimes(duringRefresh ? 1 : 0);
		expect(foreignPinObserved).toBe(true);
		expect(profiles.get(FOREIGN)).toEqual({
			...profile(B),
			"match.path": duringRefresh ? "" : foreignPort,
		});
	},
);

test.each(["activate", "restart"] as const)(
	"the real prune retains a profile when NM can %s after the inactivity sample",
	async (change) => {
		ownByA(true);
		profiles.set(FOREIGN, { ...profile(A, ""), "connection.id": "Hotspot" });
		let changed = false;
		afterPruneActivity = (afterFinalSettings) => {
			if (change === "restart" && !afterFinalSettings) return;
			afterPruneActivity = undefined;
			changed = true;
			if (change === "activate") historicalActivity = "yes";
			else {
				const paths = resources.paths();
				resources.restart();
				resources.restorePaths(paths);
			}
		};

		expect(await discovery.pruneDuplicateHotspotConns(A, "a-current")).toEqual(
			[],
		);
		expect(changed).toBe(true);
		expect(profiles.has(FOREIGN)).toBe(true);
	},
);

test.each(["802-11-wireless.mac-address", "match.path"] as const)(
	"historical prune rejects an inactive candidate with a conflicting live %s pin",
	async (pin) => {
		ownByA(true);
		profiles.set(FOREIGN, {
			...profile(A, ""),
			"connection.id": "Hotspot",
			[pin]: pin === "match.path" ? "pci-foreign-port" : B,
		});
		const deleteConnection = mock(async () => false);
		expect(
			await discovery.pruneDuplicateHotspotConns(A, "a-current", {
				...discovery.defaultHotspotProfileDeps,
				deleteConnection,
			}),
		).toEqual([]);
		expect(deleteConnection).not.toHaveBeenCalled();
		expect(profiles.has(FOREIGN)).toBe(true);
	},
);

test("historical classification never reads the keyfile secret", async () => {
	ownByA(true);
	profiles.set(FOREIGN, { ...profile(A, ""), "connection.id": "Hotspot" });
	const readSecret = spyOn(profileFile, "readNmProfileFileSecret");
	const openKeyfile = spyOn(profileWrite, "openNmProfileFile");
	await discovery.pruneDuplicateHotspotConns(A, "a-current");
	expect(readSecret).not.toHaveBeenCalled();
	expect(openKeyfile).not.toHaveBeenCalled();
	expect(pruneSecretReads).toBe(0);
	expect(pruneSecretFlags).toBe(0);
});

test("historical pruning preserves a replacement at the same settings path during the activity read", async () => {
	ownByA(true);
	profiles.set(FOREIGN, { ...profile(A, ""), "connection.id": "Hotspot" });
	afterPruneActivity = () => {
		afterPruneActivity = undefined;
		resources.replace(FOREIGN, "Replacement AP", false);
	};

	expect(await discovery.pruneDuplicateHotspotConns(A, "a-current")).toEqual(
		[],
	);
	expect(profiles.get(FOREIGN)?.["802-11-wireless.ssid"]).toBe(
		"Replacement AP",
	);
});

test("historical pruning preserves a profile activated during the final settings read", async () => {
	ownByA(true);
	profiles.set(FOREIGN, { ...profile(A, ""), "connection.id": "Hotspot" });
	afterPruneSettings = (isFinalRead) => {
		if (isFinalRead) historicalActivity = "yes";
	};

	expect(await discovery.pruneDuplicateHotspotConns(A, "a-current")).toEqual(
		[],
	);
	expect(historicalActivity).toBe("yes");
	expect(profiles.has(FOREIGN)).toBe(true);
});

test.each(["inactive", "active", "replaced", "unknown"] as const)(
	"historical pruning requires the same inactive NM profile (candidate=%s)",
	async (candidate) => {
		ownByA(true);
		profiles.set(FOREIGN, { ...profile(A, ""), "connection.id": "Hotspot" });
		afterPruneSettings = (isFinalRead) => {
			if (candidate === "active") historicalActivity = "yes";
			if (candidate === "unknown") historicalActivity = "unknown";
			if (candidate === "replaced" && isFinalRead)
				resources.replace(FOREIGN, "Replacement AP");
		};

		const removed = await discovery.pruneDuplicateHotspotConns(A, "a-current");

		expect(removed).toEqual(candidate === "inactive" ? [FOREIGN] : []);
		expect([...profiles.keys()].sort()).toEqual(
			(candidate === "inactive" ? [UNRELATED] : [FOREIGN, UNRELATED]).sort(),
		);
		expect(pruneSecretReads).toBe(0);
	},
);

for (const concurrent of [false, true]) {
	test(`${concurrent ? "O8" : "O9"} discovery preserves active observed state without adopting a foreign UUID`, async () => {
		ownByA(false);
		const iface = radio();
		iface.supportsApStaConcurrency = concurrent;
		devices = concurrent
			? "wlan0:wifi:disconnected:\nclap-wlan0:wifi:connected:a-profile"
			: "wlan0:wifi:connected:a-profile";
		profiles.set(FOREIGN, profile("", concurrent ? "clap-wlan0" : "wlan0"));
		wifiDeviceListStartUpdate();
		wifiDeviceListAdd("wlan0", B);
		wifiDeviceListEndUpdate();

		await wifiUpdateDevices();

		expect(
			concurrent ? iface.concurrentHotspot?.activeConn : iface.activeConn,
		).toBe(FOREIGN);
		if (!concurrent) {
			expect(iface.activeMode).toBe("ap");
			expect(isApMode(iface)).toBe(true);
		}
		expect(iface.hotspot.conn).toBeUndefined();
		expect(iface.hotspot.password).toBeUndefined();
		expect(getHotspotCredentials(B)).toBeUndefined();
		expect(effects).toEqual([
			["con", "modify", "a-profile", "connection.autoconnect", "no"],
		]);
	});
}

test("all persisted owners arbitrate a pre-existing two-owner contamination", async () => {
	scratch = await mkdtemp(join(tmpdir(), "hotspot-ownership-"));
	const file = join(scratch, "credentials.json");
	await Bun.write(
		file,
		JSON.stringify({
			version: 2,
			adapters: {
				[A]: { ...PAIR, conn: FOREIGN },
				[B]: { ...PAIR, conn: FOREIGN },
			},
		}),
	);
	await initHotspotCredentials(file);
	radio();
	const before = getAllHotspotCredentials();

	expect(
		await discovery.findHotspotConnForAdapter(A, getHotspotCredentials(A)),
	).toBeUndefined();
	expect(
		await discovery.findHotspotConnForAdapter(B, getHotspotCredentials(B)),
	).toBeUndefined();
	expect(
		await prepareHotspotForInterface(B, radio(), {}, activationDeps()),
	).toEqual({ success: false, error: "activation-failed" });
	rememberHotspotCredentials(B, OWN_PAIR);
	expect(getAllHotspotCredentials()).toEqual(before);
	expect(effects).toEqual([]);
});

test("recorded legacy profile migration preserves credentials and unrelated profiles", async () => {
	const iface = radio();
	await wifiRadioIdentity.discover([{ ifname: iface.ifname, row: iface }]);
	const unrelated = JSON.stringify(profiles.get(UNRELATED));
	// A recorded profile can still repair its stale scan-time pin.
	profiles.set(FOREIGN, profile("26:c3:93:b6:9c:a7"));
	rememberHotspotCredentials(B, { ...PAIR, conn: FOREIGN });

	await discovery.handleHotspotConn(undefined, FOREIGN, { active: true });

	expect(
		JSON.stringify({
			hotspot: iface.hotspot,
			credentials: getHotspotCredentials(B),
			pin: profiles.get(FOREIGN)?.["802-11-wireless.mac-address"],
			autoconnect: profiles.get(FOREIGN)?.["connection.autoconnect"],
		}),
	).toBe(
		JSON.stringify({
			hotspot: {
				availableChannels: ["auto"],
				warnings: {},
				conn: FOREIGN,
				name: PAIR.ssid,
				password: PAIR.password,
				channel: "auto",
				security: "wpa2",
			},
			credentials: {
				...PAIR,
				conn: FOREIGN,
				channel: "auto",
				previousConns: [],
			},
			pin: B,
			autoconnect: "yes",
		}),
	);
	expect(JSON.stringify(profiles.get(UNRELATED))).toBe(unrelated);
	expect(effects).toEqual([
		[
			"con",
			"modify",
			FOREIGN,
			"connection.interface-name",
			"",
			"802-11-wireless.mac-address",
			B,
		],
		["con", "modify", FOREIGN, "connection.autoconnect-priority", "999"],
	]);
});

test("unreadable settings retain name attribution for a recorded profile", async () => {
	const iface = radio();
	const own = { ...PAIR, conn: FOREIGN };
	rememberHotspotCredentials(B, own);
	unreadableSettings = true;

	await discovery.handleHotspotConn(undefined, FOREIGN);

	expect(
		JSON.stringify({
			conn: iface.hotspot.conn,
			pin: profiles.get(FOREIGN)?.["802-11-wireless.mac-address"],
			credentials: getHotspotCredentials(B),
		}),
	).toBe(
		JSON.stringify({
			conn: FOREIGN,
			pin: B,
			credentials: { ...own, previousConns: [] },
		}),
	);
});

test("the same owner's normalized UUID hint remains usable", async () => {
	rememberHotspotCredentials(B, { ...PAIR, conn: FOREIGN });
	profiles.set(FOREIGN, profile(B));

	expect(
		(
			await discovery.findHotspotConnForAdapter(
				B.toUpperCase(),
				getHotspotCredentials(B),
			)
		)?.uuid,
	).toBe(FOREIGN);
});

test("pending prepare cannot repair a UUID claimed by competing discovery", async () => {
	jest.useFakeTimers();
	const iface = radio();
	const candidateProfile = profile(B);
	profiles.set(FOREIGN, candidateProfile);
	rememberHotspotCredentials(B, { ...PAIR, conn: FOREIGN });
	addWifiInterface(A, {
		...iface,
		id: 1,
		ifname: "wlan1",
		hotspot: { availableChannels: ["auto"], warnings: {} },
	});
	const lookupGate = Promise.withResolvers<void>();
	const lookupEntered = Promise.withResolvers<void>();
	const priorityGate = Promise.withResolvers<void>();
	const priorityEntered = Promise.withResolvers<void>();
	beforeWrite = async (args) => {
		if (args[3] !== "connection.autoconnect-priority") return;
		priorityEntered.resolve();
		await priorityGate.promise;
	};
	const deps = activationDeps();
	deps.findHotspotConn = async (mac, stored) => {
		const candidate = await discovery.findHotspotConnForAdapter(mac, stored);
		lookupEntered.resolve();
		await lookupGate.promise;
		return candidate;
	};

	const prepare = prepareHotspotForInterface(B, iface, {}, deps);
	const pending: Promise<unknown>[] = [prepare];
	settleDiscoveryRace = async () => {
		lookupGate.resolve();
		priorityGate.resolve();
		await Promise.allSettled(pending);
	};
	await lookupEntered.promise;
	candidateProfile["802-11-wireless.mac-address"] = "";
	resetHotspotCredentialsForTest();
	ownByA(false);
	const claimA = discovery.handleHotspotConn(A, FOREIGN, { active: true });
	pending.push(claimA);
	await priorityEntered.promise;
	priorityGate.resolve();
	await claimA;
	const claimB = discovery.handleHotspotConn(undefined, FOREIGN, {
		active: true,
	});
	pending.push(claimB);
	await claimB;
	lookupGate.resolve();
	const result = await prepare;

	expect(result).toEqual({ success: false, error: "activation-failed" });
	expect(getHotspotCredentials(A)?.conn).toBe(FOREIGN);
	expect(getHotspotCredentials(B)).toBeUndefined();
	expect(iface.hotspot.conn).toBeUndefined();
	expect(profiles.get(FOREIGN)?.["802-11-wireless.ssid"]).toBe(PAIR.ssid);
	expect(profiles.get(FOREIGN)?.["802-11-wireless-security.psk"]).toBe(
		PAIR.password,
	);
	expect(effects.filter((effect) => effect[0] === FOREIGN)).toEqual([]);
});

for (const complete of [false, true]) {
	test(`empty awaited lookup refuses a ${complete ? "complete" : "incomplete"} foreign cache`, async () => {
		jest.useFakeTimers();
		const iface = radio();
		const lookupGate = Promise.withResolvers<void>();
		const lookupEntered = Promise.withResolvers<void>();
		const deps = activationDeps();
		deps.findHotspotConn = async () => {
			lookupEntered.resolve();
			await lookupGate.promise;
			return undefined;
		};
		const prepare = prepareHotspotForInterface(B, iface, {}, deps);
		await lookupEntered.promise;
		ownByA(false);
		iface.hotspot.conn = FOREIGN;
		if (complete) {
			iface.hotspot.name = PAIR.ssid;
			iface.hotspot.password = PAIR.password;
		}
		lookupGate.resolve();

		expect(await prepare).toEqual({
			success: false,
			error: "activation-failed",
		});
		expect(effects).toEqual([]);
		expect(getHotspotCredentials(B)).toBeUndefined();
	});
}

test("pending prepare still adopts a legitimate single-adapter discovery", async () => {
	jest.useFakeTimers();
	const iface = radio();
	profiles.set(FOREIGN, profile(B));
	rememberHotspotCredentials(B, { ...PAIR, conn: FOREIGN });
	const lookupGate = Promise.withResolvers<void>();
	const lookupEntered = Promise.withResolvers<void>();
	const deps = activationDeps();
	deps.findHotspotConn = async (mac, stored) => {
		lookupEntered.resolve();
		await lookupGate.promise;
		return discovery.findHotspotConnForAdapter(mac, stored);
	};
	const prepare = prepareHotspotForInterface(B, iface, {}, deps);
	await lookupEntered.promise;
	await discovery.handleHotspotConn(undefined, FOREIGN, { active: true });
	lookupGate.resolve();
	await prepare;
	await discovery.handleHotspotConn(undefined, FOREIGN, { active: true });

	expect(await prepare).toEqual({
		success: true,
		name: PAIR.ssid,
		password: PAIR.password,
	});
	expect(getHotspotCredentials(B)?.conn).toBe(FOREIGN);
	expect(profiles.get(FOREIGN)?.["802-11-wireless-security.psk"]).toBe(
		PAIR.password,
	);
});

for (const unverified of [false, true]) {
	test(`${unverified ? "unverified" : "verified"} single-adapter prepare and start preserve credential ownership`, async () => {
		jest.useFakeTimers();
		const iface = radio();
		if (unverified) iface.degradedReason = "permanent-mac-unresolved";
		rememberHotspotCredentials(B, OWN_PAIR);
		const deps = activationDeps();
		deps.findHotspotConn = async () => undefined;

		const prepared = await prepareHotspotForInterface(B, iface, {}, deps);
		const started = await startHotspotForInterface(B, iface, deps);

		expect(prepared).toEqual(
			unverified
				? {
						success: false,
						error: "radio-unverified",
					}
				: {
						success: true,
						name: OWN_PAIR.ssid,
						password: OWN_PAIR.password,
						firstTime: true,
					},
		);
		expect(started).toEqual(
			unverified
				? { success: false, error: "radio-unverified" }
				: { success: true },
		);
		expect(effects.filter((effect) => effect[0] === "create")).toEqual(
			unverified ? [] : [["create", OWN_PAIR.ssid, OWN_PAIR.password]],
		);
		expect(getHotspotCredentials(B)).toMatchObject({
			...OWN_PAIR,
			...(unverified ? {} : { conn: "b-new-profile" }),
		});
		if (unverified) expect(effects).toEqual([]);
		if (unverified)
			expect(getHotspotCredentials(B)).toEqual({
				...OWN_PAIR,
				previousConns: [],
			});
	});
}

test("SSID fallback rechecks a candidate claimed while another profile is read", async () => {
	for (const conn of [FOREIGN, "missing"])
		rememberHotspotCredentials(B, { ...PAIR, conn });
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const deps = {
		...discovery.defaultHotspotProfileDeps,
		getApProfileFields: async (uuid: string) => {
			if (uuid === UNRELATED) {
				entered.resolve();
				await gate.promise;
			}
			const fields = profiles.get(uuid);
			return [
				fields?.["802-11-wireless.mode"] ?? "",
				fields?.["802-11-wireless.ssid"] ?? "",
				fields?.["802-11-wireless-security.psk"] ?? "",
				"",
				"",
				fields?.["802-11-wireless.mac-address"] ?? "",
			] as const;
		},
	};
	const lookup = discovery.findHotspotConnForAdapter(B, PAIR, deps);
	await entered.promise;
	resetHotspotCredentialsForTest();
	ownByA(false);
	gate.resolve();

	expect(await lookup).toBeUndefined();
	expect(getHotspotCredentials(B)).toBeUndefined();
});

for (const operation of ["prepare", "save", "start"] as const) {
	test(`${operation} rechecks current cache after identity resolution settles`, async () => {
		jest.useFakeTimers();
		const iface = radio();
		ownByA(false);
		rememberHotspotCredentials(B, { ...OWN_PAIR, conn: "b-profile" });
		iface.hotspot = {
			...iface.hotspot,
			conn: "b-profile",
			name: OWN_PAIR.ssid,
			password: OWN_PAIR.password,
		};
		const deps = activationDeps();
		deps.credentials = {
			...hotspotCredentialsStore,
			get: (mac) => {
				const stored = getHotspotCredentials(mac);
				queueMicrotask(() => {
					iface.hotspot.conn = FOREIGN;
					iface.hotspot.name = PAIR.ssid;
					iface.hotspot.password = PAIR.password;
				});
				return stored;
			},
		};

		const result =
			operation === "start"
				? await startHotspotForInterface(B, iface, deps)
				: await prepareHotspotForInterface(
						B,
						iface,
						operation === "save"
							? { name: "New-B", password: "new-b-secret" }
							: {},
						deps,
					);

		expect(result).toEqual({ success: false, error: "activation-failed" });
		expect(getHotspotCredentials(B)?.password).toBe(OWN_PAIR.password);
		expect(effects).toEqual([]);
	});
}

test("secret repair refuses credential return when the current cache changes during its await", async () => {
	const iface = radio();
	iface.hotspot.conn = "b-profile";
	profiles.set("b-profile", profile(B));
	for (const conn of ["b-profile", "previous-current"])
		rememberHotspotCredentials(B, { ...OWN_PAIR, conn });
	rememberHotspotCredentials(B, OWN_PAIR);
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const deps = activationDeps();
	deps.findHotspotConn = async () => undefined;
	const write = deps.nmConnSetFields;
	deps.nmConnSetFields = async (uuid, fields) => {
		entered.resolve();
		await gate.promise;
		return write(uuid, fields);
	};
	const prepare = prepareHotspotForInterface(B, iface, {}, deps);
	await entered.promise;
	ownByA(false);
	iface.hotspot.conn = FOREIGN;
	gate.resolve();

	expect(await prepare).toEqual({ success: false, error: "activation-failed" });
	expect(effects.map((effect) => effect[0])).toEqual(["b-profile"]);
	expect(getHotspotCredentials(B)?.conn).toBeUndefined();
});

for (const stage of [
	"binding",
	"activation",
	"autoconnect",
	"creation",
	"saved sweep",
	"new binding",
	"new activation",
	"new autoconnect",
] as const) {
	test(`start rechecks current cached ownership after ${stage}`, async () => {
		jest.useFakeTimers();
		const iface = radio();
		rememberHotspotCredentials(B, { ...OWN_PAIR, conn: "b-profile" });
		iface.hotspot = {
			...iface.hotspot,
			...(stage === "creation" ||
			stage === "saved sweep" ||
			stage.startsWith("new ")
				? {}
				: { conn: "b-profile" }),
			name: OWN_PAIR.ssid,
			password: OWN_PAIR.password,
		};
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const pause = async () => {
			entered.resolve();
			await gate.promise;
		};
		const deps = activationDeps();
		deps.findHotspotConn = async () => undefined;
		deps.nmConnSetFields = async (uuid, fields) => {
			effects.push([uuid, JSON.stringify(fields)]);
			if (
				((stage === "binding" || stage === "new binding") &&
					fields["802-11-wireless.mac-address"] !== undefined) ||
				((stage === "autoconnect" || stage === "new autoconnect") &&
					fields["connection.autoconnect-priority"] === "999")
			)
				await pause();
			return true;
		};
		deps.nmConnect = async (uuid) => {
			effects.push(["up", uuid]);
			if (stage === "activation" || stage === "new activation") await pause();
			return true;
		};
		deps.nmApConnAdd = async (_ifname, { name: ssid, password }) => {
			effects.push(["create", ssid, password]);
			if (stage === "creation" || stage === "new binding") await pause();
			return "b-new-profile";
		};
		deps.wifiUpdateSavedConns = async () => {
			if (stage === "saved sweep") await pause();
		};
		const start = startHotspotForInterface(B, iface, deps);
		await entered.promise;
		ownByA(false);
		iface.hotspot.conn = FOREIGN;
		iface.hotspot.name = PAIR.ssid;
		iface.hotspot.password = PAIR.password;
		gate.resolve();

		expect(await start).toEqual({ success: false, error: "activation-failed" });
		expect(getHotspotCredentials(B)?.password).toBe(OWN_PAIR.password);
		expect(
			effects.filter(
				(effect) => effect[0] === FOREIGN || effect[1] === FOREIGN,
			),
		).toEqual([]);
	});
}

for (const stage of [
	"save",
	"restart failure",
	"restart success",
	"rollback save",
	"rollback restart",
	"saved sweep",
] as const) {
	test(`live configure rechecks current cached ownership after ${stage}`, async () => {
		jest.useFakeTimers();
		const iface = radio();
		iface.hotspot = {
			...iface.hotspot,
			conn: "b-profile",
			name: OWN_PAIR.ssid,
			password: OWN_PAIR.password,
			channel: "auto",
		};
		iface.activeConn = "b-profile";
		profiles.set("b-profile", {
			...profile(B),
			"802-11-wireless.ssid": OWN_PAIR.ssid,
			"802-11-wireless-security.psk": OWN_PAIR.password,
		});
		rememberHotspotCredentials(B, { ...OWN_PAIR, conn: "b-profile" });
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const pause = async () => {
			entered.resolve();
			await gate.promise;
		};
		let writes = 0;
		let connects = 0;
		const deps: HotspotConfigDeps = {
			nmConnSetFields: async (uuid, fields) => {
				effects.push([uuid, JSON.stringify(fields)]);
				Object.assign(profiles.get(uuid) ?? {}, fields);
				if (fields["802-11-wireless-security.psk"] !== undefined)
					Object.assign(profiles.get(uuid) ?? {}, {
						"802-11-wireless-security.psk-flags": "0",
					});
				resources.sync();
				writes++;
				if (
					(stage === "save" && writes === 1) ||
					(stage === "rollback save" && writes === 2)
				)
					await pause();
				return true;
			},
			nmConnect: async (uuid) => {
				effects.push(["up", uuid]);
				connects++;
				if (
					stage === "restart failure" ||
					stage === "restart success" ||
					(stage === "rollback restart" && connects === 2)
				)
					await pause();
				return (
					stage !== "restart failure" &&
					!(
						(stage === "rollback save" || stage === "rollback restart") &&
						connects === 1
					)
				);
			},
			wifiUpdateSavedConns: async () => {
				if (stage === "saved sweep") await pause();
			},
			broadcastState: () => {},
			rememberCredentials: rememberHotspotCredentials,
			getCapabilities: () => undefined,
		};
		const sent: string[] = [];
		const save = wifiHotspotConfig(
			{
				send: (message) => {
					sent.push(message);
				},
			},
			{ device: 0, name: "New-B", password: "new-b-secret", channel: "auto" },
			deps,
		);
		await entered.promise;
		ownByA(false);
		iface.hotspot.conn = FOREIGN;
		iface.hotspot.name = PAIR.ssid;
		iface.hotspot.password = PAIR.password;
		gate.resolve();
		await save;

		expect(
			sent.map((message) => JSON.parse(message).wifi.hotspot.config),
		).toEqual([{ device: 0, error: "saving" }]);
		expect(
			effects.filter(
				(effect) => effect[0] === FOREIGN || effect[1] === FOREIGN,
			),
		).toEqual([]);
		expect(iface.hotspot.transition).toBeUndefined();
	});
}

test("prepare rechecks cached ownership after the adapter lock settles", async () => {
	const iface = radio();
	ownByA(false);
	rememberHotspotCredentials(B, OWN_PAIR);
	const deps = activationDeps();
	deps.findHotspotConn = async () => undefined;
	let reads = 0;
	deps.credentials = {
		...hotspotCredentialsStore,
		get: (mac) => {
			const stored = getHotspotCredentials(mac);
			if (++reads === 2) {
				queueMicrotask(() => {
					iface.hotspot.conn = FOREIGN;
					iface.hotspot.name = PAIR.ssid;
					iface.hotspot.password = PAIR.password;
				});
			}
			return stored;
		},
	};

	expect(await prepareHotspotForInterface(B, iface, {}, deps)).toEqual({
		success: false,
		error: "activation-failed",
	});
	expect(getHotspotCredentials(B)?.password).toBe(OWN_PAIR.password);
	expect(effects).toEqual([]);
});

test("prepare save refuses a foreign current cache after the profile write settles", async () => {
	const iface = radio();
	iface.hotspot = {
		...iface.hotspot,
		conn: "b-profile",
		name: OWN_PAIR.ssid,
		password: OWN_PAIR.password,
	};
	profiles.set("b-profile", {
		...profile(B),
		"802-11-wireless.ssid": OWN_PAIR.ssid,
		"802-11-wireless-security.psk": OWN_PAIR.password,
	});
	rememberHotspotCredentials(B, { ...OWN_PAIR, conn: "b-profile" });
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const deps = activationDeps();
	deps.nmConnSetFields = async (uuid, fields) => {
		effects.push([uuid, JSON.stringify(fields)]);
		Object.assign(profiles.get(uuid) ?? {}, fields, {
			"802-11-wireless-security.psk-flags": "0",
		});
		resources.sync();
		entered.resolve();
		await gate.promise;
		return true;
	};
	const save = prepareHotspotForInterface(
		B,
		iface,
		{ name: "New-B", password: "new-b-secret" },
		deps,
	);
	await entered.promise;
	ownByA(false);
	iface.hotspot.conn = FOREIGN;
	iface.hotspot.name = PAIR.ssid;
	iface.hotspot.password = PAIR.password;
	gate.resolve();

	expect(await save).toEqual({ success: false, error: "activation-failed" });
	expect(getHotspotCredentials(B)?.password).toBe(OWN_PAIR.password);
	expect(effects.map((effect) => effect[0])).toEqual(["b-profile"]);
});

for (const conflict of [
	"candidate claimed",
	"current cache replaced",
] as const) {
	test(`name attribution rejects ${conflict} during the MAC repin`, async () => {
		const iface = radio();
		const candidate = conflict === "candidate claimed" ? FOREIGN : "candidate";
		profiles.set(candidate, profile());
		rememberHotspotCredentials(B, { ...PAIR, conn: candidate });
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		beforeWrite = async (args) => {
			if (
				args[2] !== candidate ||
				!args.includes("802-11-wireless.mac-address")
			)
				return;
			entered.resolve();
			await gate.promise;
		};
		const adoption = discovery.handleHotspotConn(undefined, candidate, {
			active: true,
		});
		await entered.promise;
		if (conflict === "candidate claimed") resetHotspotCredentialsForTest();
		ownByA(false);
		iface.hotspot.conn = FOREIGN;
		iface.hotspot.name = PAIR.ssid;
		iface.hotspot.password = PAIR.password;
		gate.resolve();
		await adoption;

		expect(iface.hotspot.conn).toBeUndefined();
		expect(iface.hotspot.password).toBeUndefined();
		expect(getHotspotCredentials(B)).toEqual(
			conflict === "candidate claimed"
				? undefined
				: { ...PAIR, conn: candidate, previousConns: [] },
		);
		expect(
			effects.filter(
				(effect) => effect[3] === "connection.autoconnect-priority",
			),
		).toEqual([]);
	});
}

for (const operation of ["prepare", "start"] as const) {
	for (const owner of ["registry", "persisted"] as const) {
		test(`${operation} rechecks a newly ${owner} owner of the selected profile pin`, async () => {
			jest.useFakeTimers();
			const iface = radio();
			rememberHotspotCredentials(B, {
				ssid: PAIR.ssid,
				password: OWN_PAIR.password,
				conn: FOREIGN,
			});
			profiles.set(FOREIGN, profile(A));
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			const deps = activationDeps();
			deps.findHotspotConn = async (mac, stored) => {
				const selected = await discovery.findHotspotConnForAdapter(mac, stored);
				entered.resolve();
				await gate.promise;
				return selected;
			};
			const pending =
				operation === "prepare"
					? prepareHotspotForInterface(B, iface, {}, deps)
					: startHotspotForInterface(B, iface, deps);
			await entered.promise;
			if (owner === "registry") {
				addWifiInterface(A, {
					...iface,
					id: 1,
					ifname: "wlan1",
					hotspot: { availableChannels: ["auto"], warnings: {} },
				});
			} else {
				rememberHotspotCredentials(A, PAIR);
			}
			gate.resolve();

			expect(await pending).toEqual({
				success: false,
				error: "activation-failed",
			});
			expect(profiles.get(FOREIGN)?.["802-11-wireless.mac-address"]).toBe(A);
			expect(getHotspotCredentials(B)?.password).toBe(OWN_PAIR.password);
			expect(effects).toEqual([]);
		});
	}
}

for (const stage of ["binding", "activation", "autoconnect"] as const) {
	test(`start rechecks the selected profile pin after ${stage}`, async () => {
		jest.useFakeTimers();
		const iface = radio();
		rememberHotspotCredentials(B, {
			ssid: PAIR.ssid,
			password: OWN_PAIR.password,
			conn: FOREIGN,
		});
		profiles.set(FOREIGN, profile(A));
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const deps = activationDeps();
		deps.nmConnSetFields = async (uuid, fields) => {
			effects.push([uuid, JSON.stringify(fields)]);
			if (
				(stage === "binding" &&
					fields["802-11-wireless.mac-address"] !== undefined) ||
				(stage === "autoconnect" &&
					fields["connection.autoconnect-priority"] === "999")
			) {
				entered.resolve();
				await gate.promise;
			}
			return true;
		};
		deps.nmConnect = async (uuid) => {
			effects.push(["up", uuid]);
			if (stage === "activation") {
				entered.resolve();
				await gate.promise;
			}
			return true;
		};
		const start = startHotspotForInterface(B, iface, deps);
		await entered.promise;
		const admittedEffects = [...effects];
		addWifiInterface(A, {
			...iface,
			id: 1,
			ifname: "wlan1",
			hotspot: { availableChannels: ["auto"], warnings: {} },
		});
		gate.resolve();

		expect(await start).toEqual({ success: false, error: "activation-failed" });
		expect(effects).toEqual(admittedEffects);
		expect(getHotspotCredentials(B)?.password).toBe(OWN_PAIR.password);
	});
}

test("completed legacy profile migration keeps its new pin when the old pin owner returns", async () => {
	jest.useFakeTimers();
	const iface = radio();
	await wifiRadioIdentity.discover([{ ifname: iface.ifname, row: iface }]);
	rememberHotspotCredentials(B, {
		ssid: PAIR.ssid,
		password: OWN_PAIR.password,
		conn: FOREIGN,
	});
	profiles.set(FOREIGN, profile(A));
	const deps = {
		...activationDeps(),
		readProfilePins: readHotspotProfilePins,
		wifiUpdateSavedConns,
	};

	expect(await startHotspotForInterface(B, iface, deps)).toEqual({
		success: true,
	});
	addWifiInterface(A, {
		...iface,
		id: 1,
		ifname: "wlan1",
		hotspot: { availableChannels: ["auto"], warnings: {} },
	});
	expect(await prepareHotspotForInterface(B, iface, {}, deps)).toEqual({
		success: true,
		name: PAIR.ssid,
		password: PAIR.password,
	});
	expect(profiles.get(FOREIGN)?.["802-11-wireless.mac-address"]).toBe(B);
});

test("a prepared profile retains pin evidence for a later cached start", async () => {
	jest.useFakeTimers();
	const iface = radio();
	rememberHotspotCredentials(B, {
		ssid: PAIR.ssid,
		password: OWN_PAIR.password,
		conn: FOREIGN,
	});
	profiles.set(FOREIGN, profile(A));
	const deps = activationDeps();

	expect(await prepareHotspotForInterface(B, iface, {}, deps)).toEqual({
		success: true,
		name: PAIR.ssid,
		password: PAIR.password,
	});
	addWifiInterface(A, {
		...iface,
		id: 1,
		ifname: "wlan1",
		hotspot: { availableChannels: ["auto"], warnings: {} },
	});
	expect(await startHotspotForInterface(B, iface, deps)).toEqual({
		success: false,
		error: "activation-failed",
	});
	expect(profiles.get(FOREIGN)?.["802-11-wireless.mac-address"]).toBe(A);
	expect(effects).toEqual([]);
});
