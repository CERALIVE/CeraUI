import { expect, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import {
	getHotspotCredentialOwners,
	getHotspotCredentials,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import { getWifiInterfacesByMacAddress } from "../modules/wifi/wifi-connections.ts";
import { startHotspotForInterface } from "../modules/wifi/wifi-hotspot-activation.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { canHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

const f = autoconnectFixture();

test("each twin's first Start creates its own profile from saved port credentials", async () => {
	const secondPort = "usb-SecondPort:2.0";
	f.persistMode(MAC, "station");
	const twins = [
		{ port: PORT, ssid: "Left AP", password: "saved-left-password" },
		{ port: secondPort, ssid: "Right AP", password: "saved-right-password" },
	];
	for (const { port, ssid, password } of twins)
		rememberHotspotCredentials(`${MAC}@${port}`, { ssid, password });
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		mac: MAC,
		path: secondPort,
	});
	f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
	await f.discover();
	const plain = getHotspotCredentials(MAC);
	const legacy = { ...f.profiles.get(PROFILE) };
	const deps = {
		...f.deps,
		nmApConnAdd: async (
			...[ifname, identity, fields]: Parameters<typeof f.deps.nmApConnAdd>
		) => {
			const uuid = `${ifname}-first-profile`;
			f.profiles.set(uuid, {
				...fields,
				"802-11-wireless.mode": "ap",
				"802-11-wireless.ssid": identity.name,
				"802-11-wireless-security.psk": identity.password,
			});
			return uuid;
		},
	};

	for (const { port, ssid, password } of twins) {
		const owner = `${MAC}@${port}`;
		const row = getWifiInterfacesByMacAddress()[owner];
		if (!row || !canHotspot(row)) throw new Error(`Missing twin at ${port}`);
		expect(await startHotspotForInterface(owner, row, deps)).toEqual({
			success: true,
		});
		settlePending(row.ifname, true);
		const uuid = `${row.ifname}-first-profile`;
		expect(f.profiles.get(uuid)).toMatchObject({
			"802-11-wireless.mac-address": MAC,
			"match.path": port,
			"802-11-wireless.ssid": ssid,
			"802-11-wireless-security.psk": password,
		});
		expect(getHotspotCredentials(owner)).toMatchObject({
			ssid,
			password,
			conn: uuid,
		});
		expect(getHotspotCredentialOwners(uuid)).toEqual([owner]);
	}
	expect(f.activations).toEqual(["wlan0-first-profile", "wlan1-first-profile"]);
	expect(getConfig().wifi_modes).toEqual({
		[MAC]: "station",
		[`${MAC}@${PORT}`]: "hotspot",
		[`${MAC}@${secondPort}`]: "hotspot",
	});
	expect(getHotspotCredentials(MAC)).toEqual(plain);
	expect(f.profiles.get(PROFILE)).toEqual(legacy);
});
