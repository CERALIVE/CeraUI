import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as runner from "../helpers/run.ts";
import * as mockWifi from "../mocks/providers/wifi.ts";
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
	prepareHotspotForInterface,
	startHotspotForInterface,
} from "../modules/wifi/wifi-hotspot-activation.ts";
import { wifiHotspotConfig } from "../modules/wifi/wifi-hotspot-config.ts";
import * as discovery from "../modules/wifi/wifi-hotspot-discovery.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
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
import {
	resetWifiPermanentMacCache,
	setPermanentMacReaderForTest,
} from "../modules/wifi/wifi-permanent-mac.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
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
let unreadableSettings = false;

function profile(mac = "", ifname = "wlan0"): Record<string, string> {
	return {
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
		credentials: hotspotCredentialsStore,
		findHotspotConn: discovery.findHotspotConnForAdapter,
		nmConnSetFields: async (uuid, fields) => {
			effects.push([uuid, JSON.stringify(fields)]);
			return true;
		},
		nmConnect: async (uuid) => {
			effects.push(["up", uuid]);
			return true;
		},
		nmHotspot: async (_ifname, ssid, password) => {
			effects.push(["create", ssid, password]);
			return "b-new-profile";
		},
		wifiUpdateSavedConns: async () => {},
		broadcastState: () => {},
		setDupIpSuppression: () => {},
		pruneHotspotConns: async () => {},
	};
}

beforeEach(() => {
	inherited = isolateWifiRegistry();
	resetHotspotCredentialsForTest();
	resetWifiConnectionModeCache();
	resetWifiInterfaceDiscoveryForTest();
	resetWifiPermanentMacCache();
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
	effects.length = 0;
	unexpected.length = 0;
	afterWrite = undefined;
	unreadableSettings = false;
	devices = "wlan0:wifi:disconnected:";
	setPermanentMacReaderForTest(async () => B);
	setWifiCapabilityDepsForTest({
		runIw: async () => "",
		readPhyName: async () => undefined,
		pathExists: async () => false,
		readNmcliWifiProperties: async () => new Map(),
		now: () => 0,
	});
	spyOn(mockWifi, "shouldMockWifi").mockReturnValue(false);
	spyOn(runner, "run").mockImplementation(async (bin, args) => {
		if (
			bin === "iw" &&
			(args.join(" ") === "dev wlan0 station dump" ||
				args.join(" ") === "dev clap-wlan0 station dump")
		)
			return "";
		if (bin === "nmcli") {
			const fieldIndex = args.indexOf("--get-values");
			if (fieldIndex !== -1) {
				const uuid = args.at(-1) ?? "";
				const fields = profiles.get(uuid);
				if (
					unreadableSettings &&
					args[fieldIndex + 1]?.includes("connection.autoconnect-priority")
				) {
					throw new Error("Fixture settings unavailable");
				}
				return (args[fieldIndex + 1] ?? "")
					.split(",")
					.map((field) => fields?.[field] ?? "")
					.join("\n");
			}
			if (args[0] === "con" && args[1] === "modify") {
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
});

afterEach(async () => {
	stopWifiUpdateLoopForTest();
	wifiCancelScanRefresh();
	wifiRadioObservation.stop();
	settlePending("wlan0", true);
	restoreWifiRegistry(inherited);
	resetHotspotCredentialsForTest();
	resetWifiConnectionModeCache();
	resetWifiInterfaceDiscoveryForTest();
	resetWifiPermanentMacCache();
	setPermanentMacReaderForTest(null);
	resetWifiCapabilitiesForTest();
	setWifiState({});
	mock.restore();
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
	afterWrite = () => ownByA(false);

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

test("O7 real saved-profile sweep leaves foreign profiles and credentials untouched", async () => {
	ownByA(false);
	const iface = radio();
	profiles.set(FOREIGN, profile(B));
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
});

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
		expect(effects).toEqual([]);
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

test("main equivalence: evidence-based orphan migration preserves credentials and unrelated profiles", async () => {
	const iface = radio();
	const unrelated = JSON.stringify(profiles.get(UNRELATED));
	// An old scan-time pin, with no present or persisted owner, still migrates.
	profiles.set(FOREIGN, profile("26:c3:93:b6:9c:a7"));

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

test("main equivalence: unreadable orphan settings retain the existing name attribution", async () => {
	const iface = radio();
	unreadableSettings = true;

	await discovery.handleHotspotConn(undefined, FOREIGN);

	expect(
		JSON.stringify({
			conn: iface.hotspot.conn,
			pin: profiles.get(FOREIGN)?.["802-11-wireless.mac-address"],
			credentials: getHotspotCredentials(B),
		}),
	).toBe(JSON.stringify({ conn: FOREIGN, pin: B }));
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
