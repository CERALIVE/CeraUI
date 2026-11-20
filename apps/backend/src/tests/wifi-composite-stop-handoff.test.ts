import { expect, spyOn, test } from "bun:test";
import * as nm from "../modules/network/network-manager.ts";
import { rememberHotspotCredentials } from "../modules/wifi/hotspot-credentials.ts";
import {
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import {
	defaultHotspotStopDeps,
	wifiHotspotStop,
} from "../modules/wifi/wifi-hotspot-config.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

const f = autoconnectFixture();
const PORT_KEY = `${MAC}@${PORT}`;
const TWIN = "wlan1:wifi:disconnected:";
const UUID = "ap-live-during-handoff";

function addTwin() {
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		mac: MAC,
		path: "usb-OtherPort:2.0",
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
		).mockResolvedValue(undefined);
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
		expect(down.mock.calls).toEqual([[UUID]]);
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
	expect(down.mock.calls).toEqual([[UUID]]);
});
