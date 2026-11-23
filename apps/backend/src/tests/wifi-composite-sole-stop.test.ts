import { expect, spyOn, test } from "bun:test";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	getHotspotCredentials,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import {
	defaultAdapterModeDeps,
	reconcileWifiAdapterModes,
	setWifiAdapterMode,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import {
	cancelWifiAdapterReconciliation,
	hasDeferredWifiStationIntent,
} from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import { getWifiInterfacesByMacAddress } from "../modules/wifi/wifi-connections.ts";
import {
	defaultHotspotStopDeps,
	wifiHotspotStop,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { canHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import { ACTIVE_PATH, RUN_ID } from "./helpers/wifi-active-observation.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

const f = autoconnectFixture();
const OTHER_PORT = "usb-OtherPort:2.0";
const FIRST = `${MAC}@${PORT}`;
const SECOND = `${MAC}@${OTHER_PORT}`;
const OWNED = `${MAC}@usb-Parked:3.0`;
const PORT_PROFILE = "saved-port-profile";
const OTHER_PROFILE = "independent-other-ap";

function seedCopies() {
	for (const owner of [FIRST, SECOND])
		rememberHotspotCredentials(
			MAC,
			{ ssid: "Legacy AP", password: "legacy-password", conn: PROFILE },
			owner,
		);
}

function addTwin() {
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		mac: MAC,
		path: OTHER_PORT,
	});
}

function row(key: string) {
	const found = getWifiInterfacesByMacAddress()[key];
	if (!found || !canHotspot(found)) throw new Error(`Missing AP row ${key}`);
	return found;
}

function seedPortProfile(owner: string, port: string, profileMac = MAC) {
	const legacy = f.profiles.get(PROFILE);
	if (!legacy) throw new Error("Missing legacy profile");
	const credentials = {
		ssid: "Saved port AP",
		password: "saved-port-password",
		conn: PORT_PROFILE,
	};
	rememberHotspotCredentials(owner, credentials);
	f.profiles.set(PORT_PROFILE, {
		...legacy,
		"802-11-wireless.ssid": credentials.ssid,
		"802-11-wireless-security.psk": credentials.password,
		"802-11-wireless.mac-address": profileMac,
		"connection.autoconnect": "no",
		"match.path": port,
	});
}

function seedIndependentPorts() {
	seedPortProfile(FIRST, PORT);
	const profile = f.profiles.get(PORT_PROFILE);
	if (!profile) throw new Error("Missing current port profile");
	f.profiles.set(OTHER_PROFILE, { ...profile, "match.path": OTHER_PORT });
	rememberHotspotCredentials(SECOND, {
		ssid: "Other Port AP",
		password: "other-port-password",
		conn: OTHER_PROFILE,
	});
	f.persistMode(SECOND, "hotspot");
	f.persistMode(FIRST, "hotspot");
	f.persistMode(MAC, "hotspot");
}

function pinRestoredPlainProfile() {
	const profile = f.profiles.get(PROFILE);
	if (!profile) throw new Error("Missing plain profile");
	profile["match.path"] = PORT;
}

async function chooseStation(action: "stop" | "station", key = MAC) {
	const id = row(key).id;
	if (action === "stop")
		expect(await wifiHotspotStop({ device: id })).toEqual({ success: true });
	else
		expect(await setWifiAdapterMode(id, action)).toEqual({
			success: true,
			applied: "station",
		});
}

function observeOffChoice() {
	const down = spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(
		async () => {
			f.list(["wlan0:wifi:disconnected:"]);
			return true;
		},
	);
	return down;
}

function expectIntent(
	plain: "hotspot" | "station",
	port: "hotspot" | "station",
	deferred: string[] = [],
) {
	expect(getConfig().wifi_modes).toEqual({
		[MAC]: plain,
		[FIRST]: port,
		[SECOND]: "hotspot",
	});
	expect([MAC, FIRST, SECOND].filter(hasDeferredWifiStationIntent)).toEqual(
		deferred,
	);
}

for (const action of ["stop", "station"] as const) {
	test.each(["port live", "already down", "plain live"] as const)(
		`${action} retires only the current independent port when %s`,
		async (ap) => {
			seedIndependentPorts();
			if (ap === "port live") pinRestoredPlainProfile();
			addTwin();
			f.list([
				`wlan0:wifi:connected:${PORT_PROFILE}`,
				"wlan1:wifi:disconnected:",
			]);
			await f.discover();
			expect(row(FIRST).activeConn).toBe(PORT_PROFILE);
			expectIntent("hotspot", "hotspot");
			f.witnesses.delete("wlan1");
			f.list([
				ap === "port live"
					? `wlan0:wifi:connected:${PORT_PROFILE}`
					: ap === "plain live"
						? `wlan0:wifi:connected:${PROFILE}`
						: "wlan0:wifi:disconnected:",
			]);
			await f.discover();
			expectIntent("hotspot", "hotspot");
			const saved = [FIRST, SECOND].map(
				(owner) => getHotspotCredentials(owner)?.conn,
			);
			const down = observeOffChoice();
			await chooseStation(action);
			const plain = ap === "port live" ? "hotspot" : "station";
			expectIntent(plain, "station");
			expect(down.mock.calls).toEqual(
				ap === "already down"
					? []
					: [
							[
								ap === "port live" ? PORT_PROFILE : PROFILE,
								ACTIVE_PATH,
								RUN_ID,
								"wlan0",
							],
						],
			);
			expect(
				[FIRST, SECOND].map((owner) => getHotspotCredentials(owner)?.conn),
			).toEqual(saved);

			// Simulated reboot: discard the process-only queue and reload the disk choice.
			cancelWifiAdapterReconciliation();
			const disk = await Bun.file(getConfigFilePath()).json();
			getConfig().wifi_modes = disk.wifi_modes;
			await f.discover();
			await f.restore();
			expect(f.activations).toEqual([]);
			expectIntent(plain, "station");

			addTwin();
			f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
			await f.discover();
			const up = spyOn(
				defaultAdapterModeDeps,
				"startHotspot",
			).mockResolvedValue({
				success: false,
				error: "activation-failed",
			});
			await reconcileWifiAdapterModes();
			expect(up.mock.calls.map(([id]) => id)).toEqual([row(SECOND).id]);
			expectIntent(plain, "station");
		},
	);
}

test.each([
	["stop", "station"],
	["station", "stop"],
] as const)(
	"%s then accepted sole Hotspot then %s after twin return retires the independent intent again",
	async (first, last) => {
		seedIndependentPorts();
		addTwin();
		f.list([
			`wlan0:wifi:connected:${PORT_PROFILE}`,
			"wlan1:wifi:disconnected:",
		]);
		await f.discover();
		f.witnesses.delete("wlan1");
		f.list([`wlan0:wifi:connected:${PORT_PROFILE}`]);
		await f.discover();
		const down = observeOffChoice();
		await chooseStation(first);
		expectIntent("hotspot", "station");
		await f.discover();
		const start = spyOn(
			defaultAdapterModeDeps,
			"startHotspot",
		).mockImplementation(async () => {
			f.list([`wlan0:wifi:connected:${PROFILE}`]);
			return { success: true };
		});
		expect(await setWifiAdapterMode(row(MAC).id, "hotspot")).toEqual({
			success: true,
			accepted: true,
			applied: "hotspot",
		});
		expectIntent("hotspot", "hotspot");
		await f.discover();
		expect(row(MAC).activeConn).toBe(PROFILE);
		addTwin();
		f.list([`wlan0:wifi:connected:${PROFILE}`, "wlan1:wifi:disconnected:"]);
		await f.discover();
		expect(row(FIRST).activeConn).toBe(PROFILE);
		expectIntent("hotspot", "hotspot");
		await chooseStation(last, FIRST);
		expectIntent("station", "station");
		expect(down.mock.calls).toEqual([
			[PORT_PROFILE, ACTIVE_PATH, RUN_ID, "wlan0"],
			[PROFILE, ACTIVE_PATH, RUN_ID, "wlan0"],
		]);
		f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
		await f.discover();
		start.mockClear();
		start.mockResolvedValue({ success: false, error: "activation-failed" });
		await reconcileWifiAdapterModes();
		expect(start.mock.calls.map(([id]) => id)).toEqual([row(SECOND).id]);
		f.witnesses.delete("wlan1");
		f.list(["wlan0:wifi:disconnected:"]);
		await f.discover();
		await f.restore();
		expect(f.activations).toEqual([]);
	},
);

test.each(["refused twice", "refused then accepted"] as const)(
	"an unsaved primary Stop survives config recovery and Hotspot %s",
	async (outcome) => {
		seedIndependentPorts();
		f.list([`wlan0:wifi:connected:${PROFILE}`]);
		await f.discover();
		expectIntent("hotspot", "hotspot");
		const configPath = getConfigFilePath();
		const down = observeOffChoice();
		f.failIntent();
		await chooseStation("stop");
		expect(down.mock.calls).toEqual([[PROFILE, ACTIVE_PATH, RUN_ID, "wlan0"]]);
		expectIntent("hotspot", "hotspot", [MAC, FIRST]);
		await f.discover();
		await f.restore();
		expect(f.activations).toEqual([]);

		setConfigFilePath(configPath);
		expectIntent("hotspot", "hotspot", [MAC, FIRST]);
		const start = spyOn(
			defaultAdapterModeDeps,
			"startHotspot",
		).mockResolvedValue({
			success: false,
			error: "activation-failed",
		});
		const chooseHotspot = () => setWifiAdapterMode(row(MAC).id, "hotspot");
		expect(await chooseHotspot()).toEqual({
			success: false,
			error: "activation-failed",
		});
		expect(getConfig().wifi_modes?.[MAC]).toBe("hotspot");
		expect(hasDeferredWifiStationIntent(MAC)).toBe(true);
		expectIntent("hotspot", "hotspot", [MAC, FIRST]);
		if (outcome === "refused twice") {
			expect(await chooseHotspot()).toEqual({
				success: false,
				error: "activation-failed",
			});
			expectIntent("hotspot", "hotspot", [MAC, FIRST]);
			await f.restore();
			expect(f.activations).toEqual([]);
			await f.discover();
			expectIntent("station", "station");
			const saved = await Bun.file(configPath).json();
			expect(saved.wifi_modes).toEqual(getConfig().wifi_modes);
			cancelWifiAdapterReconciliation();
			getConfig().wifi_modes = saved.wifi_modes;
			await f.discover();
			await f.restore();
			expect(f.activations).toEqual([]);
		} else {
			start.mockImplementation(async () => {
				pinRestoredPlainProfile();
				return { success: true };
			});
			expect(await chooseHotspot()).toEqual({
				success: true,
				accepted: true,
				applied: "hotspot",
			});
			expectIntent("hotspot", "hotspot");
			await f.restore();
			expect(f.activations).toEqual([PROFILE]);
		}
		expect(start).toHaveBeenCalledTimes(2);
	},
);

test("a later failed Down does not erase an earlier unsaved Stop", async () => {
	seedIndependentPorts();
	f.list([`wlan0:wifi:connected:${PROFILE}`]);
	await f.discover();
	const down = observeOffChoice();
	const configPath = getConfigFilePath();
	f.failIntent();
	await chooseStation("stop");
	expectIntent("hotspot", "hotspot", [MAC, FIRST]);
	f.list([`wlan0:wifi:connected:${PROFILE}`]);
	down.mockResolvedValue(false);
	expect(await wifiHotspotStop({ device: row(MAC).id })).toEqual({
		success: false,
		error: "deactivation-failed",
	});
	expectIntent("hotspot", "hotspot", [MAC, FIRST]);
	setConfigFilePath(configPath);
	f.list(["wlan0:wifi:disconnected:"]);
	await f.discover();
	expectIntent("station", "station");
	await f.restore();
	expect(f.activations).toEqual([]);
});

test("failed plain AP Down rolls back both durable owners and preserves the other port", async () => {
	seedIndependentPorts();
	f.list([`wlan0:wifi:connected:${PROFILE}`]);
	await f.discover();
	expectIntent("hotspot", "hotspot");
	const down = spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(
		async () => {
			expectIntent("station", "station");
			return false;
		},
	);
	expect(await wifiHotspotStop({ device: row(MAC).id })).toEqual({
		success: false,
		error: "deactivation-failed",
	});
	expect(down.mock.calls).toEqual([[PROFILE, ACTIVE_PATH, RUN_ID, "wlan0"]]);
	expectIntent("hotspot", "hotspot");
	const disk = await Bun.file(getConfigFilePath()).json();
	expect(disk.wifi_modes).toEqual(getConfig().wifi_modes);
	expect(row(MAC).activeConn).toBe(PROFILE);
});

test("an unreadable current port is not guessed from either independent profile", async () => {
	seedIndependentPorts();
	const witness = f.witnesses.get("wlan0");
	if (!witness) throw new Error("Missing sole witness");
	f.witnesses.set("wlan0", { ...witness, path: "" });
	await f.discover();
	expectIntent("hotspot", "hotspot");
	await chooseStation("stop");
	expectIntent("station", "hotspot");
	await f.restore();
	expect(f.activations).toEqual([]);
});

test("Stop clears the exact live plain AP without guessing either independent port", async () => {
	seedIndependentPorts();
	const witness = f.witnesses.get("wlan0");
	if (!witness) throw new Error("Missing sole witness");
	f.witnesses.set("wlan0", { ...witness, path: "" });
	f.list([`wlan0:wifi:connected:${PROFILE}`]);
	await f.discover();
	expect(row(MAC).activeConn).toBe(PROFILE);
	expectIntent("hotspot", "hotspot");
	const down = observeOffChoice();
	await chooseStation("stop");
	expect(down.mock.calls).toEqual([[PROFILE, ACTIVE_PATH, RUN_ID, "wlan0"]]);
	expectIntent("station", "hotspot");
	await f.discover();
	await f.restore();
	expect(f.activations).toEqual([]);
});

test.each(["current port", "unreadable port"] as const)(
	"sole Stop at a %s prevents later twin restore from using stale copied intent",
	async (observed) => {
		seedCopies();
		seedPortProfile(OWNED, "usb-Parked:3.0");
		getConfig().wifi_modes = {
			[MAC]: "hotspot",
			[FIRST]: "hotspot",
			[SECOND]: "hotspot",
			[OWNED]: "hybrid",
		};
		const saved = [MAC, FIRST, SECOND, OWNED].map(getHotspotCredentials);
		const witness = f.witnesses.get("wlan0");
		if (!witness) throw new Error("Missing sole witness");
		if (observed === "unreadable port")
			f.witnesses.set("wlan0", { ...witness, path: "" });
		await f.discover();
		expect(await wifiHotspotStop({ device: row(MAC).id })).toEqual({
			success: true,
		});

		f.witnesses.set("wlan0", witness);
		addTwin();
		f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
		await f.discover();
		row(FIRST);
		row(SECOND);
		const start = spyOn(
			defaultAdapterModeDeps,
			"startHotspot",
		).mockResolvedValue({
			success: false,
			error: "activation-failed",
		});
		await reconcileWifiAdapterModes();
		expect(start).not.toHaveBeenCalled();
		expect(getConfig().wifi_modes).toEqual({
			[MAC]: "station",
			[FIRST]: "station",
			[SECOND]: "station",
			[OWNED]: "hybrid",
		});
		expect([MAC, FIRST, SECOND, OWNED].map(getHotspotCredentials)).toEqual(
			saved,
		);
		expect(f.profiles.has(PORT_PROFILE)).toBe(true);
	},
);

test("a failed sole Stop rolls back the durable station choice for every copy", async () => {
	seedCopies();
	f.persistMode(MAC, "hotspot");
	f.persistMode(FIRST, "hotspot");
	f.persistMode(SECOND, "hybrid");
	const previous = getConfig().wifi_modes;
	f.list([`wlan0:wifi:connected:${PROFILE}`]);
	await f.discover();
	spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(async () => {
		expect(getConfig().wifi_modes).toEqual({
			[MAC]: "station",
			[FIRST]: "station",
			[SECOND]: "station",
		});
		return false;
	});
	expect(await wifiHotspotStop({ device: row(MAC).id })).toEqual({
		success: false,
		error: "deactivation-failed",
	});
	expect(getConfig().wifi_modes).toEqual(previous);
	expect(await Bun.file(getConfigFilePath()).json()).toMatchObject({
		wifi_modes: previous,
	});
});

test("Stop after a twin leaves downs the running port profile without rewriting it", async () => {
	seedPortProfile(FIRST, PORT);
	f.persistMode(FIRST, "hotspot");
	addTwin();
	f.list([`wlan0:wifi:connected:${PORT_PROFILE}`, "wlan1:wifi:disconnected:"]);
	await f.discover();
	expect(row(FIRST).activeConn).toBe(PORT_PROFILE);

	f.witnesses.delete("wlan1");
	f.list([`wlan0:wifi:connected:${PORT_PROFILE}`]);
	await f.discover();
	const sole = row(MAC);
	expect(sole.activeConn).toBe(PORT_PROFILE);
	expect(sole.hotspot.conn).not.toBe(PORT_PROFILE);
	const port = getHotspotCredentials(FIRST);
	const profile = { ...f.profiles.get(PORT_PROFILE) };
	const disconnect = spyOn(
		defaultHotspotStopDeps,
		"nmDisconnect",
	).mockImplementation(async () => {
		f.list(["wlan0:wifi:disconnected:"]);
		return true;
	});
	expect(await wifiHotspotStop({ device: sole.id })).toEqual({ success: true });
	expect(disconnect.mock.calls).toEqual([
		[PORT_PROFILE, ACTIVE_PATH, RUN_ID, "wlan0"],
	]);
	expect(f.profiles.get(PORT_PROFILE)).toEqual(profile);
	expect(getHotspotCredentials(FIRST)).toEqual(port);
	expect(getConfig().wifi_modes).toEqual({
		[MAC]: "hotspot",
		[FIRST]: "station",
	});
});

test("discovery repins an owned twin profile to its physical MAC and keeps its port", async () => {
	const staleMac = "02:11:22:33:44:55";
	seedPortProfile(FIRST, PORT, staleMac);
	addTwin();
	f.list([`wlan0:wifi:connected:${PORT_PROFILE}`, "wlan1:wifi:disconnected:"]);
	await f.discover();

	expect(row(FIRST).activeConn).toBe(PORT_PROFILE);
	expect(f.profiles.get(PORT_PROFILE)).toMatchObject({
		"802-11-wireless.mac-address": MAC,
		"match.path": PORT,
	});
	expect(f.profiles.get(PROFILE)?.["802-11-wireless.mac-address"]).toBe(MAC);
});

test.each(["stop", "station"] as const)(
	"%s of a port-owned AP prevents plain-profile restore on that physical radio",
	async (action) => {
		seedPortProfile(FIRST, PORT);
		f.persistMode(MAC, "hotspot");
		f.persistMode(FIRST, "hotspot");
		addTwin();
		f.list([
			`wlan0:wifi:connected:${PORT_PROFILE}`,
			"wlan1:wifi:disconnected:",
		]);
		await f.discover();
		f.witnesses.delete("wlan1");
		f.list([`wlan0:wifi:connected:${PORT_PROFILE}`]);
		await f.discover();
		const sole = row(MAC);
		expect(sole.activeConn).toBe(PORT_PROFILE);
		const down = spyOn(
			defaultHotspotStopDeps,
			"nmDisconnect",
		).mockImplementation(async () => {
			f.list(["wlan0:wifi:disconnected:"]);
			return true;
		});
		const result =
			action === "stop"
				? await wifiHotspotStop({ device: sole.id })
				: await setWifiAdapterMode(sole.id, "station");
		expect(result.success).toBe(true);
		expect(down.mock.calls).toEqual([
			[PORT_PROFILE, ACTIVE_PATH, RUN_ID, "wlan0"],
		]);
		const start = spyOn(
			defaultAdapterModeDeps,
			"startHotspot",
		).mockResolvedValue({ success: false, error: "activation-failed" });
		await f.discover();
		await reconcileWifiAdapterModes();
		expect(start).not.toHaveBeenCalled();
	},
);

test.each(["accepted", "refused"] as const)(
	"a %s explicit sole Hotspot supersedes port Station only on acceptance",
	async (outcome) => {
		seedPortProfile(FIRST, PORT);
		const localCredentials = getHotspotCredentials(FIRST);
		if (!localCredentials) throw new Error("Missing port credentials");
		rememberHotspotCredentials(FIRST, { ...localCredentials, channel: "auto" });
		const remote = "independent-remote-ap";
		const localProfile = f.profiles.get(PORT_PROFILE);
		if (!localProfile) throw new Error("Missing port profile");
		f.profiles.set(remote, { ...localProfile, "match.path": OTHER_PORT });
		rememberHotspotCredentials(SECOND, {
			ssid: "Other Port AP",
			password: "other-port-password",
			conn: remote,
		});
		const saved = [FIRST, SECOND].map(getHotspotCredentials);
		const profile = { ...localProfile };
		f.persistMode(MAC, "hotspot");
		f.persistMode(FIRST, "hotspot");
		f.persistMode(SECOND, "hybrid");
		addTwin();
		f.list([
			`wlan0:wifi:connected:${PORT_PROFILE}`,
			"wlan1:wifi:disconnected:",
		]);
		await f.discover();
		f.witnesses.delete("wlan1");
		f.list([`wlan0:wifi:connected:${PORT_PROFILE}`]);
		await f.discover();
		spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(
			async () => {
				f.list(["wlan0:wifi:disconnected:"]);
				return true;
			},
		);
		expect(await wifiHotspotStop({ device: row(MAC).id })).toEqual({
			success: true,
		});
		expect(getConfig().wifi_modes?.[FIRST]).toBe("station");
		expect(getConfig().wifi_modes?.[MAC]).toBe("hotspot");
		expect([MAC, FIRST, SECOND].some(hasDeferredWifiStationIntent)).toBe(false);
		await f.discover();

		let intentAtStart: string | undefined;
		const start = spyOn(
			defaultAdapterModeDeps,
			"startHotspot",
		).mockImplementation(async () => {
			intentAtStart = getConfig().wifi_modes?.[FIRST];
			if (outcome === "refused")
				return { success: false, error: "activation-failed" };
			pinRestoredPlainProfile();
			f.list([`wlan0:wifi:connected:${PROFILE}`]);
			return { success: true };
		});
		expect(await setWifiAdapterMode(row(MAC).id, "hotspot")).toEqual(
			outcome === "accepted"
				? { success: true, accepted: true, applied: "hotspot" }
				: { success: false, error: "activation-failed" },
		);
		expect(start).toHaveBeenCalledTimes(1);
		expect(intentAtStart).toBe("hotspot");
		expect(getConfig().wifi_modes?.[FIRST]).toBe(
			outcome === "accepted" ? "hotspot" : "station",
		);
		expect(getConfig().wifi_modes?.[MAC]).toBe("hotspot");
		expect([MAC, FIRST, SECOND].some(hasDeferredWifiStationIntent)).toBe(false);
		await f.discover();
		f.list(["wlan0:wifi:disconnected:"]);
		await f.discover();
		await f.restore();

		expect(f.activations).toEqual(outcome === "accepted" ? [PROFILE] : []);
		expect([FIRST, SECOND].map(getHotspotCredentials)).toEqual(saved);
		expect(f.profiles.get(PORT_PROFILE)).toEqual(profile);
		expect(f.profiles.has(remote)).toBe(true);
		expect(getConfig().wifi_modes?.[SECOND]).toBe("hybrid");
	},
);
