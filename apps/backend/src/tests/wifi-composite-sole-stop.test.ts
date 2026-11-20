import { expect, spyOn, test } from "bun:test";
import { getConfig, getConfigFilePath } from "../modules/config.ts";
import {
	getHotspotCredentials,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import {
	defaultAdapterModeDeps,
	reconcileWifiAdapterModes,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import { getWifiInterfacesByMacAddress } from "../modules/wifi/wifi-connections.ts";
import {
	defaultHotspotStopDeps,
	wifiHotspotStop,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { canHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
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
	expect(disconnect.mock.calls).toEqual([[PORT_PROFILE]]);
	expect(f.profiles.get(PORT_PROFILE)).toEqual(profile);
	expect(getHotspotCredentials(FIRST)).toEqual(port);
	expect(getConfig().wifi_modes).toEqual({
		[MAC]: "station",
		[FIRST]: "hotspot",
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
