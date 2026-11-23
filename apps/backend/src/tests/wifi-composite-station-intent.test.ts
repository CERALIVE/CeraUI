import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { getConfig, getConfigFilePath } from "../modules/config.ts";
import { rememberHotspotCredentials } from "../modules/wifi/hotspot-credentials.ts";
import { setWifiAdapterMode } from "../modules/wifi/wifi-adapter-mode-transition.ts";
import { getWifiInterfacesByMacAddress } from "../modules/wifi/wifi-connections.ts";
import {
	defaultHotspotStopDeps,
	wifiHotspotStop,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { ACTIVE_PATH, RUN_ID } from "./helpers/wifi-active-observation.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

const f = autoconnectFixture();
const REMOTE_PORT = "usb-OtherPort:2.0";
const REMOTE = `${MAC}@${REMOTE_PORT}`;
const CURRENT = `${MAC}@${PORT}`;
const PORT_PROFILE = "operator-port-ap";
const savedModes = z.object({ wifi_modes: z.record(z.string(), z.string()) });

function soleDevice() {
	const row = getWifiInterfacesByMacAddress()[MAC];
	if (!row) throw new Error("Missing sole Wi-Fi adapter");
	return row.id;
}

function seedRemoteCopy() {
	rememberHotspotCredentials(
		MAC,
		{ ssid: "Policy AP", password: "fixture-password", conn: PROFILE },
		REMOTE,
	);
	f.persistMode(MAC, "hotspot");
}

test("returning sole Stop sends Down without disarming a live port-owned profile", async () => {
	const legacy = f.profiles.get(PROFILE);
	if (!legacy) throw new Error("Missing legacy profile");
	const profile = { ...legacy, "match.path": PORT };
	f.profiles.set(PORT_PROFILE, profile);
	rememberHotspotCredentials(CURRENT, {
		ssid: "Port-owned AP",
		password: "port-owned-password",
		conn: PORT_PROFILE,
	});
	f.persistMode(CURRENT, "hotspot");
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		mac: MAC,
		path: REMOTE_PORT,
	});
	f.list([`wlan0:wifi:connected:${PORT_PROFILE}`, "wlan1:wifi:disconnected:"]);
	await f.discover();
	expect(getWifiInterfacesByMacAddress()[CURRENT]?.activeConn).toBe(
		PORT_PROFILE,
	);
	f.witnesses.delete("wlan1");
	f.list([`wlan0:wifi:connected:${PORT_PROFILE}`]);
	await f.discover();

	// Discovery disarms profiles; model an external edit before the operator's Stop.
	f.profiles.set(PORT_PROFILE, { ...profile, "connection.autoconnect": "yes" });
	const write = spyOn(defaultHotspotStopDeps, "nmConnSetFields");
	const down = spyOn(defaultHotspotStopDeps, "nmDisconnect").mockResolvedValue(
		true,
	);
	expect(await wifiHotspotStop({ device: soleDevice() })).toEqual({
		success: true,
	});
	expect(down.mock.calls).toEqual([
		[PORT_PROFILE, ACTIVE_PATH, RUN_ID, "wlan0"],
	]);
	expect(write.mock.calls.filter(([uuid]) => uuid === PORT_PROFILE)).toEqual(
		[],
	);
	expect(f.profiles.get(PORT_PROFILE)?.["connection.autoconnect"]).toBe("yes");
});

test("failed sole Stop removes a copy's newly written mode from memory and disk", async () => {
	seedRemoteCopy();
	f.list([`wlan0:wifi:connected:${PROFILE}`]);
	await f.discover();
	spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(async () => {
		expect(getConfig().wifi_modes).toEqual({
			[MAC]: "station",
			[REMOTE]: "station",
		});
		return false;
	});

	expect(await wifiHotspotStop({ device: soleDevice() })).toEqual({
		success: false,
		error: "deactivation-failed",
	});
	const expected = { [MAC]: "hotspot" } as const;
	expect(getConfig().wifi_modes).toEqual(expected);
	expect(
		savedModes.parse(await Bun.file(getConfigFilePath()).json()).wifi_modes,
	).toEqual(expected);
});

test("choosing Station on a sole adapter retires mode on a remote copy", async () => {
	seedRemoteCopy();
	f.persistMode(REMOTE, "hybrid");
	await f.discover();

	expect(await setWifiAdapterMode(soleDevice(), "station")).toEqual({
		success: true,
		applied: "station",
	});
	expect(getConfig().wifi_modes).toEqual({
		[MAC]: "station",
		[REMOTE]: "station",
	});
});
