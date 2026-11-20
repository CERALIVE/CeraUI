import { expect, spyOn, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	getHotspotCredentials,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import { wifiAdapterLockKeyForDeviceId } from "../modules/wifi/wifi-adapter-lock.ts";
import { resolveWifiBinding } from "../modules/wifi/wifi-binding.ts";
import {
	addWifiInterface,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import { prepareHotspotForInterface } from "../modules/wifi/wifi-hotspot-activation.ts";
import { wifiHotspotStop } from "../modules/wifi/wifi-hotspot-config.ts";
import { getWifiIdToMacAddress } from "../modules/wifi/wifi-interfaces.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

const f = autoconnectFixture();
const PORT_A = `${MAC}@${PORT}`;
const PORT_UUID = "saved-port-uuid";

function savePortOwner() {
	rememberHotspotCredentials(PORT_A, {
		ssid: "Port-owned AP",
		password: "port-owned-password",
		conn: PORT_UUID,
	});
	const legacy = f.profiles.get(PROFILE);
	if (!legacy) throw new Error("Missing legacy profile");
	f.profiles.set(PORT_UUID, {
		...legacy,
		"802-11-wireless.ssid": "Port-owned AP",
		"802-11-wireless-security.psk": "port-owned-password",
		"match.path": PORT,
		"connection.autoconnect": "no",
	});
}

test("a returning sole radio reads and locks the plain record after live port proof disappears", async () => {
	savePortOwner();
	const row = f.row();
	row.hotspot = { availableChannels: ["auto"], warnings: {} };
	getWifiIdToMacAddress()[row.id] = MAC;
	await f.sample();
	const token = wifiRadioIdentity.state.rows.get(row.ifname)?.incarnation;
	if (!token) throw new Error("Missing published incarnation");
	spyOn(radioIdentityReaders, "readDevicePath").mockResolvedValue(undefined);
	const admitted = await resolveWifiBinding(row.id, token, "config");
	expect(admitted).toMatchObject({ success: true });
	expect(await prepareHotspotForInterface(MAC, row, {}, f.deps)).toEqual({
		success: true,
		name: "Policy AP",
		password: "fixture-password",
	});
	expect(wifiAdapterLockKeyForDeviceId(row.id)).toBe(MAC);
	expect(getHotspotCredentials(PORT_A)).toMatchObject({ conn: PORT_UUID });
});

test("sole Stop retires the legacy boot intent and preserves the independent port intent and records", async () => {
	savePortOwner();
	const row = f.row();
	getWifiIdToMacAddress()[row.id] = MAC;
	getConfig().wifi_modes = { [MAC]: "hotspot", [PORT_A]: "hybrid" };
	await f.sample();
	const legacy = getHotspotCredentials(MAC);
	const port = getHotspotCredentials(PORT_A);
	expect(await wifiHotspotStop({ device: row.id })).toEqual({ success: true });
	expect(getConfig().wifi_modes).toEqual({
		[MAC]: "station",
		[PORT_A]: "hybrid",
	});
	expect(getHotspotCredentials(MAC)).toEqual(legacy);
	expect(getHotspotCredentials(PORT_A)).toEqual(port);
	const only = f.witnesses.get("wlan0");
	if (!only) throw new Error("Missing sole witness");
	f.witnesses.set("wlan0", { ...only, path: "" });
	await f.restore();
	expect(f.activations).toEqual([]);
});

test("a limited sole radio never restores a parked port profile when there is no plain intent", async () => {
	savePortOwner();
	f.persistMode(PORT_A, "hotspot");
	const row = f.row();
	removeWifiInterface(MAC);
	row.degradedReason = "permanent-mac-unresolved";
	row.hotspot = { availableChannels: ["auto"], warnings: {} };
	addWifiInterface("limited:3:0", row);
	const up = spyOn(nm, "nmConnect").mockResolvedValue(false);
	await f.restore();
	expect(up).not.toHaveBeenCalled();
	expect(getHotspotCredentials(PORT_A)?.conn).toBe(PORT_UUID);
	expect(getConfig().wifi_modes?.[PORT_A]).toBe("hotspot");
});
