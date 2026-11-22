import { beforeEach, expect, spyOn, test } from "bun:test";
import * as runner from "../helpers/run.ts";
import { getConfig, getConfigFilePath } from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	getHotspotCredentialOwners,
	getHotspotCredentials,
	initHotspotCredentials,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import { wifiAdapterLockKeyForDeviceId } from "../modules/wifi/wifi-adapter-lock.ts";
import { reconcileWifiAdapterModes } from "../modules/wifi/wifi-adapter-mode-restore.ts";
import { defaultAdapterModeDeps } from "../modules/wifi/wifi-adapter-mode-transition.ts";
import { resolveWifiBinding } from "../modules/wifi/wifi-binding.ts";
import { getWifiInterfacesByMacAddress } from "../modules/wifi/wifi-connections.ts";
import {
	defaultHotspotDeps,
	prepareHotspotForInterface,
} from "../modules/wifi/wifi-hotspot-activation.ts";
import { canHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import * as released from "./helpers/released/hotspot-credentials-v2026.11.2.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";
import * as profileInstances from "./helpers/wifi-first-ap-instances.ts";

const f = autoconnectFixture();
beforeEach(() => {
	const instances = profileInstances.firstApInstances;
	const runSpy = spyOn(runner, "run");
	const run = runSpy.getMockImplementation();
	if (!run) throw new Error("Missing fake NetworkManager runner");
	let loading: string | undefined;
	runSpy.mockImplementation(async (...args) => {
		const [binary, argv] = args;
		if (binary !== "nmcli" || argv?.[0] !== "connection" || argv[1] !== "load")
			return run(...args);
		loading = argv[2];
		try {
			return await run(...args);
		} finally {
			loading = undefined;
		}
	});
	spyOn(profileInstances, "firstApInstances").mockImplementation((...args) => {
		const model = instances(...args);
		const write = model.files.write;
		model.files.write = (uuid) => {
			// NM load reads the published file; it doesn't replace its inode.
			if (!loading || model.files.filename(uuid) !== loading) write(uuid);
		};
		return model;
	});
});
const SECOND_PORT = "usb-Port2:1.0";
const primary = `${MAC}@${PORT}`;
const second = `${MAC}@${SECOND_PORT}`;

function addTwin(path: string | undefined = SECOND_PORT) {
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		mac: MAC,
		...(path === undefined ? {} : { path }),
	});
	f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
}

function rows() {
	return getWifiInterfacesByMacAddress();
}

function rowFor(ifname: string) {
	const entry = Object.entries(rows()).find(([, row]) => row.ifname === ifname);
	if (!entry || !canHotspot(entry[1]))
		throw new Error(`No AP row for ${ifname}`);
	return [entry[0], entry[1]] as const;
}

test("R1 sole Save keeps the original UUID and mirrors only credentials and mode", async () => {
	await f.sample();
	const row = f.row();
	const credentials = {
		name: "Saved at port 1",
		password: "saved-password-1",
	};
	expect(
		await prepareHotspotForInterface(MAC, row, credentials, f.deps),
	).toMatchObject({ success: true, ...credentials });
	expect(await f.start()).toEqual({ success: true });
	expect(getHotspotCredentialOwners(PROFILE)).toEqual([MAC]);
	expect(getHotspotCredentials(primary)).toMatchObject({
		ssid: credentials.name,
		password: credentials.password,
		channel: "auto",
	});
	expect(getHotspotCredentials(primary)?.conn).toBeUndefined();
	expect(getConfig().wifi_modes).toEqual({
		[MAC]: "hotspot",
		[primary]: "hotspot",
	});
});

test("R2 cold twins publish two stable verified rows with independent locks", async () => {
	addTwin();
	await f.discover();
	const a = rowFor("wlan0")[1];
	const b = rowFor("wlan1")[1];
	f.list(["wlan1:wifi:disconnected:", "wlan0:wifi:disconnected:"]);
	await f.discover();
	expect(Object.keys(rows()).sort()).toEqual([primary, second].sort());
	expect(rows()[primary]?.id).toBe(a.id);
	expect(rows()[second]?.id).toBe(b.id);
	expect(rows()[primary]?.degradedReason).toBeUndefined();
	expect(rows()[second]?.degradedReason).toBeUndefined();
	expect(wifiAdapterLockKeyForDeviceId(a.id)).toBe(primary);
	expect(wifiAdapterLockKeyForDeviceId(b.id)).toBe(second);
});

test("boot restore uses only the independently verified twin's profile", async () => {
	const remainingUuid = "surviving-port-ap";
	const legacy = f.profiles.get(PROFILE);
	if (!legacy) throw new Error("Missing plain profile");
	legacy["match.path"] = PORT;
	f.profiles.set(remainingUuid, {
		...legacy,
		"802-11-wireless.ssid": "Port two AP",
		"match.path": SECOND_PORT,
		"connection.autoconnect": "no",
	});
	rememberHotspotCredentials(second, {
		ssid: "Port two AP",
		password: "fixture-password",
		conn: remainingUuid,
	});
	addTwin();
	await f.discover();
	expect(rowFor("wlan1")[0]).toBe(second);
	getConfig().wifi_modes = { [primary]: "station", [second]: "hotspot" };
	const up = spyOn(defaultHotspotDeps, "nmConnect").mockImplementation(
		async (uuid) => {
			f.activations.push(uuid);
			return false;
		},
	);
	await reconcileWifiAdapterModes();
	expect(f.activations).toEqual([remainingUuid]);
	expect(legacy["match.path"]).toBe(PORT);
	expect(up.mock.calls.map(([uuid]) => uuid)).toEqual([remainingUuid]);
});

test("boot restore keeps the remaining twin's port-qualified profile", async () => {
	const remainingUuid = "surviving-port-ap";
	const legacy = f.profiles.get(PROFILE);
	if (!legacy) throw new Error("Missing plain profile");
	legacy["match.path"] = PORT;
	f.profiles.set(remainingUuid, {
		...legacy,
		"802-11-wireless.ssid": "Port two AP",
		"match.path": SECOND_PORT,
		"connection.autoconnect": "no",
	});
	rememberHotspotCredentials(second, {
		ssid: "Port two AP",
		password: "fixture-password",
		conn: remainingUuid,
	});
	addTwin();
	await f.discover();
	f.witnesses.delete("wlan0");
	f.list(["wlan1:wifi:disconnected:"]);
	await f.discover();
	expect(Object.keys(rows())).toEqual([MAC]);
	getConfig().wifi_modes = { [MAC]: "hotspot", [second]: "hotspot" };
	const up = spyOn(defaultHotspotDeps, "nmConnect").mockImplementation(
		async (uuid) => {
			f.activations.push(uuid);
			return false;
		},
	);
	await reconcileWifiAdapterModes();
	expect(f.activations).toEqual([remainingUuid]);
	expect(legacy["match.path"]).toBe(PORT);
	expect(up.mock.calls.map(([uuid]) => uuid)).toEqual([remainingUuid]);
});

test("boot restore cannot rebind a plain profile pinned to another port", async () => {
	const legacy = f.profiles.get(PROFILE);
	const remaining = f.witnesses.get("wlan0");
	if (!legacy || !remaining) throw new Error("Missing plain profile or radio");
	legacy["match.path"] = PORT;
	f.witnesses.set("wlan0", { ...remaining, path: SECOND_PORT });
	await f.sample();
	getConfig().wifi_modes = { [MAC]: "hotspot" };
	const up = spyOn(defaultHotspotDeps, "nmConnect").mockResolvedValue(false);
	await reconcileWifiAdapterModes();
	expect(up).not.toHaveBeenCalled();
	expect(f.profiles.get(PROFILE)?.["match.path"]).toBe(PORT);
});

test("an unconfigured surviving twin does not inherit an address-only legacy AP", async () => {
	addTwin();
	await f.discover();
	f.witnesses.delete("wlan0");
	f.list(["wlan1:wifi:disconnected:"]);
	await f.discover();
	getConfig().wifi_modes = { [MAC]: "hotspot" };
	const up = spyOn(defaultHotspotDeps, "nmConnect").mockResolvedValue(false);
	await reconcileWifiAdapterModes();
	expect(up).not.toHaveBeenCalled();
	expect(f.profiles.get(PROFILE)?.["match.path"] ?? "").toBe("");
});

test("a twin cannot inherit an address-only legacy AP after an empty roster", async () => {
	addTwin();
	await f.discover();
	const twin = f.witnesses.get("wlan1");
	if (!twin) throw new Error("Missing twin");
	f.witnesses.clear();
	f.list([]);
	await f.discover();
	expect(Object.keys(rows())).toEqual([]);
	f.witnesses.set("wlan0", twin);
	f.list(["wlan0:wifi:disconnected:"]);
	await f.discover();
	getConfig().wifi_modes = { [MAC]: "hotspot" };
	const up = spyOn(defaultHotspotDeps, "nmConnect").mockResolvedValue(false);
	await reconcileWifiAdapterModes();
	expect(up).not.toHaveBeenCalled();
	expect(f.profiles.get(PROFILE)?.["match.path"] ?? "").toBe("");
});

test("D12 does not start an unpinned legacy AP on an unidentified twin with port evidence", async () => {
	addTwin();
	await f.discover();
	const twin = f.witnesses.get("wlan1");
	if (!twin) throw new Error("Missing twin");
	f.witnesses.clear();
	f.list([]);
	await f.discover();
	f.witnesses.set("wlan0", { ...twin, mac: undefined });
	f.list(["wlan0:wifi:disconnected:"]);
	await f.discover();
	const [, limited] = rowFor("wlan0");
	expect(limited.degradedReason).toBe("permanent-mac-unresolved");
	expect(wifiRadioIdentity.state.rows.get("wlan0")?.devicePath).toBe(
		SECOND_PORT,
	);
	getConfig().wifi_modes = { [MAC]: "hotspot" };
	const up = spyOn(nm, "nmConnect").mockResolvedValue(false);
	await reconcileWifiAdapterModes();
	expect(up).not.toHaveBeenCalled();
});

test("verified hybrid restore keeps the required port pin while bringing up the owned AP", async () => {
	const profile = f.profiles.get(PROFILE);
	if (!profile) throw new Error("Missing legacy profile");
	profile["match.path"] = PORT;
	addTwin();
	await f.discover();
	f.witnesses.delete("wlan1");
	f.list(["wlan0:wifi:disconnected:"]);
	await f.discover();
	getConfig().wifi_modes = { [MAC]: "hybrid" };
	spyOn(defaultHotspotDeps, "readCapabilities").mockReturnValue({
		staApCombo: { supported: true },
	});
	spyOn(defaultHotspotDeps, "readHybridChannel").mockResolvedValue({
		identity: "station",
		frequency: 2412,
		fields: {},
		sameChannelOnly: true,
	});
	spyOn(defaultHotspotDeps, "ensureConcurrentInterface").mockResolvedValue({
		ifname: "clap-wlan0",
		created: false,
	});
	spyOn(defaultHotspotDeps, "validateConcurrentInterface").mockResolvedValue(
		true,
	);
	spyOn(defaultHotspotDeps, "releaseConcurrentInterface").mockResolvedValue(
		true,
	);
	const up = spyOn(defaultHotspotDeps, "nmConnect").mockResolvedValue(false);
	await reconcileWifiAdapterModes({
		...defaultAdapterModeDeps,
		readCapabilities: () => ({ staApCombo: { supported: true } }),
	});
	expect(f.profiles.get(PROFILE)?.["match.path"]).toBe(PORT);
	expect(up.mock.calls.map(([uuid]) => uuid)).toEqual([PROFILE]);
});

test("boot restore does not start from a cached key without a published witness", async () => {
	getConfig().wifi_modes = { [MAC]: "hotspot" };
	f.witnesses.clear();
	const up = spyOn(defaultHotspotDeps, "nmConnect").mockResolvedValue(false);
	await reconcileWifiAdapterModes();
	expect(up).not.toHaveBeenCalled();
	expect(f.effects).toEqual([]);
});

test("normal restore does not use the previous MAC when the fresh sample cannot read it", async () => {
	await f.sample();
	getConfig().wifi_modes = { [MAC]: "hotspot" };
	const radio = f.witnesses.get("wlan0");
	if (!radio) throw new Error("Missing radio witness");
	f.witnesses.set("wlan0", { ...radio, mac: undefined });
	const up = spyOn(defaultHotspotDeps, "nmConnect").mockResolvedValue(false);
	await reconcileWifiAdapterModes();
	expect(up).not.toHaveBeenCalled();
	expect(f.effects).toEqual([]);
});

test("Save refuses a port-only move after admission without changing NetworkManager", async () => {
	addTwin();
	await f.discover();
	const [key, row] = rowFor("wlan0");
	expect(key).toBe(primary);
	const radio = f.witnesses.get(row.ifname);
	if (!radio) throw new Error("Missing twin witness");
	const saved = {
		conn: "twin-save-profile",
		ssid: "Twin AP",
		password: "saved-twin-password",
	};
	rememberHotspotCredentials(key, saved);
	f.profiles.set(saved.conn, {
		"802-11-wireless.mode": "ap",
		"802-11-wireless.mac-address": MAC,
		"match.path": PORT,
		"802-11-wireless.ssid": saved.ssid,
		"802-11-wireless-security.psk": saved.password,
	});
	Object.assign(row.hotspot, {
		conn: saved.conn,
		name: saved.ssid,
		password: saved.password,
	});
	const serialize = spyOn(runner, "runWithStdin");
	const offline = serialize.getMockImplementation();
	if (!offline) throw new Error("Missing offline serializer fixture");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	serialize.mockImplementationOnce(async (...args) => {
		entered.resolve();
		await release.promise;
		return offline(...args);
	});
	const write = spyOn(f.deps, "nmConnSetFields");
	const up = spyOn(f.deps, "nmConnect");
	const down = spyOn(f.deps, "nmDisconnect");
	const run = spyOn(runner, "run");
	const before = f.effects.length;
	const result = prepareHotspotForInterface(
		key,
		row,
		{ name: "Renamed AP", password: "different-twin-password" },
		f.deps,
	);
	try {
		await Promise.race([
			entered.promise,
			result.then(() => {
				throw new Error("Save ended before reaching the offline read");
			}),
		]);
		// Only the fresh port read changes; discovery has not republished the row.
		f.witnesses.set(row.ifname, { ...radio, path: "usb-Port3:1.0" });
	} finally {
		release.resolve();
		await result;
	}
	await expect(result).resolves.toEqual({
		success: false,
		error: "radio-changed",
	});
	expect(write.mock.calls).toEqual([]);
	expect(up.mock.calls).toEqual([]);
	expect(down.mock.calls).toEqual([]);
	expect(
		run.mock.calls.filter(
			([binary, args]) => binary === "nmcli" && args?.includes("load"),
		),
	).toEqual([]);
	expect(f.effects.slice(before)).toEqual([]);
});

test("R3 an unseeded twin prepares new credentials without adopting the plain profile", async () => {
	addTwin();
	await f.discover();
	const [key, row] = rowFor("wlan1");
	const prepared = await prepareHotspotForInterface(key, row, {}, f.deps);
	expect(prepared).toMatchObject({ success: true, firstTime: true });
	if (!prepared.success) throw new Error("Expected a first-time draft");
	expect(prepared.password).not.toBe("fixture-password");
	expect(row.hotspot.conn).toBeUndefined();
	expect(getHotspotCredentialOwners(PROFILE)).toEqual([MAC]);
});

test.each([PORT, "usb-*", ""])(
	"R4 resolving the unsafe path %j makes both radios eligible together",
	async (path) => {
		addTwin(path);
		await f.discover();
		expect(rowFor("wlan0")[1].degradedReason).toBe("permanent-mac-unresolved");
		expect(rowFor("wlan1")[1].degradedReason).toBe("permanent-mac-unresolved");
		expect(f.profiles.has(PROFILE)).toBe(true);
		addTwin();
		await f.discover();
		expect(rowFor("wlan0")[1].degradedReason).toBeUndefined();
		expect(rowFor("wlan1")[1].degradedReason).toBeUndefined();
	},
);

test("R5 only the address portion is case-insensitive", () => {
	rememberHotspotCredentials(`${MAC.toUpperCase()}@${SECOND_PORT}`, {
		ssid: "Case sensitive port",
		password: "case-sensitive-password",
	});
	expect(getHotspotCredentials(second)?.ssid).toBe("Case sensitive port");
	expect(
		getHotspotCredentials(`${MAC}@${SECOND_PORT.toLowerCase()}`),
	).toBeUndefined();
});

test("R6 a physical port swap rotates both tokens and puts the keys on the new ports", async () => {
	addTwin();
	await f.sample();
	const before = wifiRadioIdentity.state.rows;
	const a = f.witnesses.get("wlan0");
	const b = f.witnesses.get("wlan1");
	if (!a || !b) throw new Error("Expected twin witnesses");
	f.witnesses.set("wlan0", { ...a, path: SECOND_PORT });
	f.witnesses.set("wlan1", { ...b, path: PORT });
	await f.sample();
	const after = wifiRadioIdentity.state.rows;
	expect(after.get("wlan0")).toMatchObject({ key: second, permanentMac: MAC });
	expect(after.get("wlan1")).toMatchObject({ key: primary, permanentMac: MAC });
	expect(after.get("wlan0")?.incarnation).not.toBe(
		before.get("wlan0")?.incarnation,
	);
	expect(after.get("wlan1")?.incarnation).not.toBe(
		before.get("wlan1")?.incarnation,
	);
});

test("R7 the address-only profile is disarmed before the verified twins publish", async () => {
	addTwin();
	await f.discover();
	expect(f.profiles.get(PROFILE)).toMatchObject({
		"connection.autoconnect": "no",
	});
	expect(f.publications).toContain("no");
	expect(f.publications).not.toContain("yes");
	expect(rowFor("wlan0")[0]).toBe(primary);
	expect(rowFor("wlan1")[0]).toBe(second);
});

test("released package reads and writes the candidate store across twin arrival", async () => {
	const path = `${getConfigFilePath()}.credentials`;
	await Bun.write(
		path,
		JSON.stringify({
			version: 1,
			adapters: {
				[MAC]: {
					ssid: "Released AP",
					password: "released-password",
					conn: PROFILE,
				},
			},
		}),
	);
	await initHotspotCredentials(path);
	const plain = {
		ssid: "Released AP",
		password: "released-password",
		conn: PROFILE,
	};
	expect(getHotspotCredentials(MAC)).toMatchObject(plain);
	rememberHotspotCredentials(MAC, plain, primary);
	const firstStore = await Bun.file(path).json();
	expect(firstStore.version).toBe(2);
	expect(firstStore.adapters[primary]).toEqual({
		ssid: plain.ssid,
		password: plain.password,
	});
	for (const phase of ["sole", "twin"] as const) {
		if (phase === "twin") {
			rememberHotspotCredentials(primary, { ...plain, conn: "port1-profile" });
			rememberHotspotCredentials(second, {
				ssid: "Port 2 AP",
				password: "port2-password",
				conn: "port2-profile",
			});
		}
		expect(getHotspotCredentialOwners(PROFILE)).toEqual([MAC]);
		await released.initHotspotCredentials(path);
		expect(released.getHotspotCredentials(MAC)).toMatchObject(plain);
		expect(released.canUseHotspotConnection(MAC, PROFILE)).toBe(true);
	}
	try {
		released.rememberHotspotCredentials(MAC, { ...plain, channel: "auto" });
		await initHotspotCredentials(path);
		expect(getHotspotCredentials(MAC)).toMatchObject({
			...plain,
			channel: "auto",
		});
		expect(getHotspotCredentials(primary)).toMatchObject({
			...plain,
			conn: "port1-profile",
		});
		expect(getHotspotCredentials(second)?.conn).toBe("port2-profile");
	} finally {
		released.resetHotspotCredentialsForTest();
	}
});

test("a returning sole adapter uses legacy credentials and preserves the port profile", async () => {
	rememberHotspotCredentials(primary, {
		ssid: "Port-owned AP",
		password: "saved-port-password",
		conn: "port-profile",
	});
	const row = f.row();
	row.hotspot = { availableChannels: ["auto"], warnings: {} };
	await f.sample();
	expect(wifiAdapterLockKeyForDeviceId(row.id)).toBe(MAC);
	expect(await prepareHotspotForInterface(MAC, row, {}, f.deps)).toEqual({
		success: true,
		name: "Policy AP",
		password: "fixture-password",
	});
	expect(getHotspotCredentials(MAC)?.conn).toBe(PROFILE);
	expect(getHotspotCredentialOwners("port-profile")).toEqual([primary]);
});

test("a sole Save preserves a port's independently saved credentials without a UUID", async () => {
	rememberHotspotCredentials(primary, {
		ssid: "Previously saved for this port",
		password: "previous-port-password",
	});
	await f.sample();
	const chosen = { name: "Plain record", password: "saved-plain-password" };
	expect(
		await prepareHotspotForInterface(MAC, f.row(), chosen, f.deps),
	).toMatchObject({
		success: true,
		...chosen,
	});
	expect(getHotspotCredentials(MAC)).toMatchObject({
		ssid: chosen.name,
		conn: PROFILE,
	});
	expect(getHotspotCredentials(primary)).toMatchObject({
		ssid: "Previously saved for this port",
		password: "previous-port-password",
	});
});

test.each([PORT, "", "usb-*"])(
	"a port losing distinct proof refuses the previous token without touching saved state (%j)",
	async (unsafePath) => {
		addTwin();
		await f.discover();
		const [, before] = rowFor("wlan1");
		const original = wifiRadioIdentity.state.rows.get(
			before.ifname,
		)?.incarnation;
		expect(wifiAdapterLockKeyForDeviceId(before.id)).toBe(second);
		addTwin(unsafePath);
		await f.discover();
		for (const ifname of ["wlan0", "wlan1"]) {
			const [key, row] = rowFor(ifname);
			const effects = f.effects.length;
			expect(await resolveWifiBinding(row.id, original, "config")).toEqual({
				success: false,
				error: "radio-unverified",
			});
			expect(await prepareHotspotForInterface(key, row, {}, f.deps)).toEqual({
				success: false,
				error: "radio-unverified",
			});
			expect(f.effects).toHaveLength(effects);
		}
		expect(getHotspotCredentialOwners(PROFILE)).toEqual([MAC]);
		expect(f.profiles.has(PROFILE)).toBe(true);
	},
);

test("late twin arrival preserves the original profile and reads each port's own credentials", async () => {
	await f.sample();
	const chosen = { name: "Legacy AP", password: "legacy-saved-password" };
	expect(
		await prepareHotspotForInterface(MAC, f.row(), chosen, f.deps),
	).toMatchObject({ success: true, ...chosen });
	const plain = getHotspotCredentials(MAC);
	expect(plain?.conn).toBe(PROFILE);
	addTwin();
	await f.discover();
	const [firstKey, first] = rowFor("wlan0");
	const [secondKey, other] = rowFor("wlan1");
	expect(await prepareHotspotForInterface(firstKey, first, {}, f.deps)).toEqual(
		{ success: true, ...chosen },
	);
	const otherChosen = { name: "Other AP", password: "other-saved-password" };
	expect(
		await prepareHotspotForInterface(secondKey, other, otherChosen, f.deps),
	).toMatchObject({ success: true, firstTime: true, ...otherChosen });
	expect(getHotspotCredentials(MAC)).toEqual(plain);
	expect(getHotspotCredentials(primary)).toMatchObject({
		ssid: chosen.name,
		password: chosen.password,
	});
	expect(getHotspotCredentials(second)).toMatchObject({
		ssid: otherChosen.name,
		password: otherChosen.password,
	});
	expect(getHotspotCredentialOwners(PROFILE)).toEqual([MAC]);
});
