import { expect, spyOn, test } from "bun:test";
import * as nm from "../modules/network/network-manager.ts";
import * as profileInstances from "../modules/network/network-manager-profile-instance.ts";
import { getWifiInterfacesByMacAddress } from "../modules/wifi/wifi-connections.ts";
import {
	defaultHotspotStopDeps,
	wifiHotspotStop,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { canHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import * as compat from "../rpc/compat.ts";
import { ACTIVE_PATH, RUN_ID } from "./helpers/wifi-active-observation.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

const f = autoconnectFixture();
const OTHER_PORT = "usb-Distinct:2";
const PORT_A = `${MAC}@${PORT}`;
const PORT_B = `${MAC}@${OTHER_PORT}`;

function twin(path = OTHER_PORT, active?: string) {
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		mac: MAC,
		path,
	});
	f.list([
		active ? `wlan0:wifi:connected:${active}` : "wlan0:wifi:disconnected:",
		"wlan1:wifi:disconnected:",
	]);
}

function rowAt(ifname: string) {
	const row = Object.values(getWifiInterfacesByMacAddress()).find(
		(candidate) => candidate.ifname === ifname,
	);
	if (!row || !canHotspot(row))
		throw new Error(`Missing AP-capable row ${ifname}`);
	return row;
}

test("a port swap excludes Stop on the destination while its active UUID is being refreshed", async () => {
	twin();
	await f.discover();
	const target = rowAt("wlan1");
	const left = f.witnesses.get("wlan0");
	const right = f.witnesses.get("wlan1");
	if (!left || !right) throw new Error("Missing original port witnesses");
	f.witnesses.set("wlan0", { ...left, path: OTHER_PORT });
	f.witnesses.set("wlan1", { ...right, path: PORT });
	f.list(["wlan0:wifi:connected:swap-new-active", "wlan1:wifi:disconnected:"]);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const getFields = nm.nmConnGetFields;
	spyOn(nm, "nmConnGetFields").mockImplementation(async (uuid, fields) => {
		if (uuid === "swap-new-active" && fields[0] === "802-11-wireless.mode") {
			entered.resolve();
			await release.promise;
		}
		return getFields(uuid, fields);
	});
	const discovery = f.discover();
	const disconnect = spyOn(
		defaultHotspotStopDeps,
		"nmDisconnect",
	).mockResolvedValue(true);
	try {
		await entered.promise;
		expect(await wifiHotspotStop({ device: target.id })).toEqual({
			success: false,
			error: "DEVICE_BUSY",
		});
		expect(disconnect).not.toHaveBeenCalled();
	} finally {
		release.resolve();
		await discovery;
	}
	expect(rowAt("wlan0").id).toBe(target.id);
});

test("unverified legacy disarm cannot publish healthy twins before a verified retry", async () => {
	twin();
	const healthy: string[] = [];
	spyOn(compat, "broadcastMsg").mockImplementation(() => {
		const rows = getWifiInterfacesByMacAddress();
		if (rows[PORT_A] && rows[PORT_B]) {
			healthy.push(f.profiles.get(PROFILE)?.["connection.autoconnect"] ?? "");
		}
	});
	const read = spyOn(
		profileInstances,
		"readNmProfileInstance",
	).mockResolvedValue(undefined);
	await f.discover();
	expect(f.profiles.get(PROFILE)?.["connection.autoconnect"]).toBe("yes");
	expect(healthy).toEqual([]);
	read.mockRestore();
	await f.discover();
	expect(healthy[0]).toBe("no");
	expect(healthy).not.toContain("yes");
});

test("an ambiguous collision leaves an existing AP up until Stop targets only its active UUID", async () => {
	const live = "operator-live-ap";
	const legacy = f.profiles.get(PROFILE);
	if (!legacy) throw new Error("Missing legacy profile");
	f.profiles.set(live, { ...legacy, "connection.autoconnect": "no" });
	twin(PORT, live);
	const disconnect = spyOn(
		defaultHotspotStopDeps,
		"nmDisconnect",
	).mockImplementation(async () => {
		twin(PORT);
		return true;
	});
	await f.discover();
	const row = rowAt("wlan0");
	expect(row.degradedReason).toBe("permanent-mac-unresolved");
	expect(row.activeConn).toBe(live);
	expect(disconnect).not.toHaveBeenCalled();
	expect(await wifiHotspotStop({ device: row.id })).toEqual({ success: true });
	expect(disconnect.mock.calls).toEqual([[live, ACTIVE_PATH, RUN_ID, "wlan0"]]);
	expect(f.profiles.has(PROFILE)).toBe(true);
	expect(f.profiles.has(live)).toBe(true);
});
