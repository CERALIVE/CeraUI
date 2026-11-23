import { expect, spyOn, test } from "bun:test";
import { call } from "@orpc/server";
import { getConfig } from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import { rememberHotspotCredentials } from "../modules/wifi/hotspot-credentials.ts";
import * as adapterLock from "../modules/wifi/wifi-adapter-lock.ts";
import {
	defaultAdapterModeDeps,
	reconcileWifiAdapterModes,
	setWifiAdapterMode,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import {
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import {
	defaultHotspotStopDeps,
	wifiHotspotStop,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { isWifiModeTargetPending } from "../modules/wifi/wifi-interfaces.ts";
import { hotspotStopProcedure } from "../rpc/procedures/wifi.procedure.ts";
import { ACTIVE_PATH, RUN_ID } from "./helpers/wifi-active-observation.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";
import { wifiProtocolContext } from "./helpers/wifi-protocol-context.ts";

const f = autoconnectFixture();
const PORT_KEY = `${MAC}@${PORT}`;
const TWIN_PORT = "usb-OtherPort:2.0";
const TWIN_KEY = `${MAC}@${TWIN_PORT}`;
const TWIN_AP = "independent-twin-ap";
const TWIN = "wlan1:wifi:disconnected:";
const UUID = "ap-live-during-handoff";
const awaitStopHandoff = adapterLock.awaitWifiStopHandoff;

function addTwin() {
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		mac: MAC,
		path: TWIN_PORT,
	});
}

function seedLiveProfile() {
	const legacy = f.profiles.get(PROFILE);
	if (!legacy) throw new Error("Missing legacy profile");
	f.profiles.set(UUID, {
		...legacy,
		"connection.autoconnect": "no",
		"match.path": PORT,
	});
	rememberHotspotCredentials(PORT_KEY, {
		ssid: "Policy AP",
		password: "fixture-password",
		conn: UUID,
	});
}

test.each(["arrives", "leaves", "leaves with a hybrid AP"] as const)(
	"Stop on the destination is busy while a twin %s and the active AP is being read",
	async (change) => {
		const arrival = change === "arrives";
		const hybrid = change === "leaves with a hybrid AP";
		seedLiveProfile();
		removeWifiInterface(MAC);
		if (!arrival) addTwin();
		f.list(["wlan0:wifi:disconnected:", ...(arrival ? [] : [TWIN])]);
		await f.discover();
		const source = getWifiInterfacesByMacAddress()[arrival ? MAC : PORT_KEY];
		if (!source) throw new Error("Missing source adapter");
		if (arrival) addTwin();
		else f.witnesses.delete("wlan1");
		if (hybrid) {
			const parent = f.witnesses.get("wlan0");
			if (!parent) throw new Error("Missing hybrid parent");
			f.witnesses.set("clap-wlan0", { ...parent, ifindex: 7 });
		}
		f.list([
			hybrid ? "wlan0:wifi:disconnected:" : `wlan0:wifi:connected:${UUID}`,
			...(hybrid ? [`clap-wlan0:wifi:connected:${UUID}`] : []),
			...(arrival ? [TWIN] : []),
		]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const getFields = nm.nmConnGetFields;
		spyOn(nm, "nmConnGetFields").mockImplementation(async (uuid, fields) => {
			if (
				uuid === UUID &&
				fields.length === 1 &&
				fields[0] === "802-11-wireless.mode"
			) {
				entered.resolve();
				await release.promise;
			}
			return getFields(uuid, fields);
		});
		const down = spyOn(
			defaultHotspotStopDeps,
			"nmDisconnect",
		).mockImplementation(async () => {
			f.list(["wlan0:wifi:disconnected:", ...(arrival ? [TWIN] : [])]);
			return true;
		});
		spyOn(
			defaultHotspotStopDeps,
			"releaseConcurrentInterface",
		).mockResolvedValue(true);
		const discovery = f.discover();
		try {
			await entered.promise;
			expect(await wifiHotspotStop({ device: source.id })).toEqual({
				success: false,
				error: "DEVICE_BUSY",
			});
			expect(down).not.toHaveBeenCalled();
		} finally {
			release.resolve();
			await discovery;
		}
		const registry = getWifiInterfacesByMacAddress();
		const destination = registry[arrival ? PORT_KEY : MAC];
		expect(destination?.id).toBe(source.id);
		expect(await wifiHotspotStop({ device: source.id })).toEqual({
			success: true,
		});
		expect(down.mock.calls).toEqual([
			[UUID, ACTIVE_PATH, RUN_ID, hybrid ? "clap-wlan0" : "wlan0"],
		]);
	},
);

test.each(["stop", "stop RPC", "station"] as const)(
	"%s requested during handoff waits for the live AP and does not require a second click",
	async (action) => {
		seedLiveProfile();
		removeWifiInterface(MAC);
		addTwin();
		f.list(["wlan0:wifi:disconnected:", TWIN]);
		await f.discover();
		const source = getWifiInterfacesByMacAddress()[PORT_KEY];
		if (!source) throw new Error("Missing source adapter");
		f.witnesses.delete("wlan1");
		f.list([`wlan0:wifi:connected:${UUID}`]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const getFields = nm.nmConnGetFields;
		spyOn(nm, "nmConnGetFields").mockImplementation(async (uuid, fields) => {
			if (uuid === UUID && fields.join() === "802-11-wireless.mode") {
				entered.resolve();
				await release.promise;
			}
			return getFields(uuid, fields);
		});
		const down = spyOn(
			defaultHotspotStopDeps,
			"nmDisconnect",
		).mockImplementation(async () => {
			f.list(["wlan0:wifi:disconnected:"]);
			return true;
		});
		const discovery = f.discover();
		let result: { success: boolean };
		await entered.promise;
		const handlerEntered = Promise.withResolvers<void>();
		const probeHeld = Promise.withResolvers<void>();
		const releaseProbe = Promise.withResolvers<void>();
		const probeKey = adapterLock.wifiAdapterLockKeyForDeviceId(source.id);
		if (!probeKey) throw new Error("Missing handoff lock key");
		const probe =
			action === "stop RPC"
				? adapterLock
						.withWifiAdapterLock(probeKey, async () => {
							probeHeld.resolve();
							await releaseProbe.promise;
						})
						.then(() => probeHeld.resolve())
				: undefined;
		if (probe) await probeHeld.promise;
		spyOn(adapterLock, "awaitWifiStopHandoff").mockImplementation((row) => {
			if (row.id === source.id && isWifiModeTargetPending(row))
				handlerEntered.resolve();
			return awaitStopHandoff(row);
		});
		const command =
			action === "stop"
				? wifiHotspotStop({ device: source.id })
				: action === "stop RPC"
					? call(
							hotspotStopProcedure,
							{ device: String(source.id) },
							{
								context: wifiProtocolContext(),
							},
						)
					: setWifiAdapterMode(source.id, "station");
		try {
			expect(
				await Promise.race([
					handlerEntered.promise.then(() => "entered"),
					command.then(() => "returned"),
				]),
			).toBe("entered");
			expect(down).not.toHaveBeenCalled();
		} finally {
			releaseProbe.resolve();
			await probe;
			release.resolve();
			[result] = await Promise.all([command, discovery]);
		}
		expect(result.success).toBe(true);
		expect(down.mock.calls).toEqual([[UUID, ACTIVE_PATH, RUN_ID, "wlan0"]]);
	},
);

test("Stop of a returning adapter with an unreadable active mode asks for a retry", async () => {
	seedLiveProfile();
	addTwin();
	f.list(["wlan0:wifi:disconnected:", TWIN]);
	await f.discover();
	const source = getWifiInterfacesByMacAddress()[PORT_KEY];
	if (!source) throw new Error("Missing source adapter");

	f.witnesses.delete("wlan1");
	f.list([`wlan0:wifi:connected:${UUID}`]);
	const getFields = nm.nmConnGetFields;
	const observation = spyOn(nm, "nmConnGetFields").mockImplementation(
		async (uuid, fields) =>
			uuid === UUID &&
			fields.length === 1 &&
			fields[0] === "802-11-wireless.mode"
				? undefined
				: getFields(uuid, fields),
	);
	await f.discover();
	expect(getWifiInterfacesByMacAddress()[MAC]?.id).toBe(source.id);
	const down = spyOn(defaultHotspotStopDeps, "nmDisconnect").mockResolvedValue(
		true,
	);
	expect(await wifiHotspotStop({ device: source.id })).toEqual({
		success: false,
		error: "DEVICE_BUSY",
	});
	expect(down).not.toHaveBeenCalled();

	observation.mockRestore();
	await f.discover();
	expect(await wifiHotspotStop({ device: source.id })).toEqual({
		success: true,
	});
	expect(down.mock.calls).toEqual([[UUID, ACTIVE_PATH, RUN_ID, "wlan0"]]);
});

test.each(["stop", "station"] as const)(
	"%s on an arriving twin's composite row records intent for the live plain owner",
	async (action) => {
		f.persistMode(MAC, "hotspot");
		removeWifiInterface(MAC);
		f.list([`wlan0:wifi:connected:${PROFILE}`]);
		await f.discover();
		addTwin();
		f.list([`wlan0:wifi:connected:${PROFILE}`, TWIN]);
		await f.discover();
		const row = getWifiInterfacesByMacAddress()[PORT_KEY];
		if (!row) throw new Error("Missing composite adapter");
		expect(row.activeConn).toBe(PROFILE);
		const down = spyOn(
			defaultHotspotStopDeps,
			"nmDisconnect",
		).mockResolvedValue(true);

		const result =
			action === "stop"
				? await wifiHotspotStop({ device: row.id })
				: await setWifiAdapterMode(row.id, "station");
		expect(result.success).toBe(true);
		expect(down.mock.calls).toEqual([[PROFILE, ACTIVE_PATH, RUN_ID, "wlan0"]]);
		expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
	},
);

test.each(["stop", "station"] as const)(
	"%s on a composite row with a live plain AP also retires the selected independent port",
	async (action) => {
		seedLiveProfile();
		const profile = f.profiles.get(UUID);
		if (!profile) throw new Error("Missing independent profile");
		f.profiles.set(TWIN_AP, { ...profile, "match.path": TWIN_PORT });
		rememberHotspotCredentials(TWIN_KEY, {
			ssid: "Twin AP",
			password: "other-port-password",
			conn: TWIN_AP,
		});
		f.persistMode(MAC, "hotspot");
		f.persistMode(PORT_KEY, "hotspot");
		f.persistMode(TWIN_KEY, "hotspot");
		removeWifiInterface(MAC);
		f.list([`wlan0:wifi:connected:${PROFILE}`]);
		await f.discover();
		addTwin();
		f.list([`wlan0:wifi:connected:${PROFILE}`, TWIN]);
		await f.discover();
		const rows = getWifiInterfacesByMacAddress();
		const selected = rows[PORT_KEY];
		const other = rows[TWIN_KEY];
		if (!selected || !other) throw new Error("Missing composite adapters");
		expect(selected.id).not.toBe(other.id);
		expect(selected.activeConn).toBe(PROFILE);
		const down = spyOn(
			defaultHotspotStopDeps,
			"nmDisconnect",
		).mockImplementation(async () => {
			f.list(["wlan0:wifi:disconnected:", TWIN]);
			return true;
		});
		const result =
			action === "stop"
				? await wifiHotspotStop({ device: selected.id })
				: await setWifiAdapterMode(selected.id, "station");
		expect(result.success).toBe(true);
		expect(down.mock.calls).toEqual([[PROFILE, ACTIVE_PATH, RUN_ID, "wlan0"]]);
		await f.discover();
		const start = spyOn(
			defaultAdapterModeDeps,
			"startHotspot",
		).mockResolvedValue({
			success: false,
			error: "activation-failed",
		});
		await reconcileWifiAdapterModes();
		expect(start.mock.calls.map(([id]) => id)).toEqual([other.id]);
		expect(getConfig().wifi_modes).toEqual({
			[MAC]: "station",
			[PORT_KEY]: "station",
			[TWIN_KEY]: "hotspot",
		});
	},
);
