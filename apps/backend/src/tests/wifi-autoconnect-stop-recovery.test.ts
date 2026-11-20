import { afterEach, expect, jest, spyOn, test } from "bun:test";
import * as time from "../helpers/time.ts";
import { getConfig } from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import { observedWifiAdapterMode } from "../modules/wifi/wifi-adapter-mode.ts";
import {
	getWifiInterfacesByMacAddress,
	wifiCancelScanRefresh,
} from "../modules/wifi/wifi-connections.ts";
import { canHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import { resetWifiInterfaceDiscoveryForTest } from "../modules/wifi/wifi-interfaces.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

import {
	advancePolicy as advance,
	policyStop as stop,
} from "./helpers/wifi-reconcile-fixture.ts";

const f = autoconnectFixture();
const profile = () => {
	const value = f.profiles.get(PROFILE);
	if (!value) throw new Error("Missing fixture profile");
	return value;
};
afterEach(() => {
	resetBootReadiness();
	jest.useRealTimers();
});

test.each([false, true])(
	"round3 owner rejected off-write reports stopped then startup deactivates the rebooted AP, limited=%s",
	async (limited) => {
		f.persistMode(MAC, "hotspot");
		profile()["match.path"] = PORT;
		if (limited)
			f.witnesses.set("wlan0", {
				ifindex: 3,
				phy: "/sys/devices/policy/phy0",
				path: PORT,
			});
		await f.discover();
		const row = Object.values(getWifiInterfacesByMacAddress()).find(canHotspot);
		if (!row) throw new Error("Missing fixture radio");
		row.hotspot.conn = PROFILE;
		row.conn = PROFILE;
		row.activeConn = PROFILE;
		row.activeMode = "ap";
		const write = nm.nmConnSetFields;
		let accepted = false;
		spyOn(nm, "nmConnSetFields").mockImplementation((uuid, fields) =>
			accepted ? write(uuid, fields) : Promise.resolve(false),
		);
		const disconnect = spyOn(nm, "nmDisconnect").mockImplementation(
			async () => {
				f.list(["wlan0:wifi:disconnected:"]);
				return true;
			},
		);

		expect(await stop(() => nm.nmDisconnect(PROFILE))).toEqual({
			success: true,
		});
		expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
		expect(profile()["connection.autoconnect"]).toBe("yes");
		expect(getBootReadiness().degraded).toBe(true);

		// Reboot retained the intent, while NM activated the still-armed AP.
		resetWifiInterfaceDiscoveryForTest();
		row.conn = PROFILE;
		row.activeConn = PROFILE;
		row.activeMode = "ap";
		f.list([`wlan0:wifi:connected:${PROFILE}`]);
		f.publications.length = 0;
		accepted = true;
		await f.discover();

		expect(disconnect).toHaveBeenCalledTimes(2);
		expect(observedWifiAdapterMode(row)).toBe("station");
		expect(profile()["connection.autoconnect"]).toBe("no");
		expect(f.publications).not.toContain("yes");
		expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
		expect(getBootReadiness().degraded).toBe(false);
	},
);

test.each(["yes", "no"])(
	"round3 owner station startup disconnects an active owned AP with autoconnect=%s",
	async (autoconnect) => {
		f.persistMode(MAC, "station");
		profile()["connection.autoconnect"] = autoconnect;
		f.list([`wlan0:wifi:connected:${PROFILE}`]);
		const disconnect = spyOn(nm, "nmDisconnect").mockImplementation(
			async () => {
				f.list(["wlan0:wifi:disconnected:"]);
				return true;
			},
		);

		await f.discover();

		expect(disconnect).toHaveBeenCalledWith(PROFILE);
		expect(observedWifiAdapterMode(f.row())).toBe("station");
		expect(profile()["connection.autoconnect"]).toBe("no");
		expect(getBootReadiness().degraded).toBe(false);
	},
);

test("round3 owner Stop policy recovers on its scheduled retry while keeping station intent", async () => {
	jest.useFakeTimers();
	jest.setSystemTime(10_000);
	spyOn(time, "getms").mockImplementation(() => Date.now());
	f.persistMode(MAC, "hotspot");
	profile()["match.path"] = PORT;
	await f.discover();
	wifiCancelScanRefresh();
	f.row().conn = PROFILE;
	f.row().activeConn = PROFILE;
	f.row().activeMode = "ap";
	const write = nm.nmConnSetFields;
	let accepted = false;
	spyOn(nm, "nmConnSetFields").mockImplementation((uuid, fields) =>
		accepted ? write(uuid, fields) : Promise.resolve(false),
	);
	const disconnect = jest.fn(async () => true);

	expect(await stop(disconnect)).toEqual({ success: true });
	expect(getBootReadiness().degraded).toBe(true);
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
	accepted = true;
	await advance(3000);

	expect(disconnect).toHaveBeenCalledTimes(1);
	expect(profile()["connection.autoconnect"]).toBe("no");
	expect(getBootReadiness().degraded).toBe(false);
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
});

test("round3 owner a failed Stop disconnect keeps the existing failure and prior intent", async () => {
	f.persistMode(MAC, "hotspot");
	profile()["match.path"] = PORT;
	await f.discover();
	f.row().conn = PROFILE;
	f.row().activeConn = PROFILE;
	f.row().activeMode = "ap";

	expect(await stop(async () => false)).toEqual({
		success: false,
		error: "deactivation-failed",
	});
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "hotspot" });
});

test("round3 owner already-stopped limited adapter checks its station owner's profiles", async () => {
	f.persistMode(MAC, "station");
	f.witnesses.set("wlan0", {
		ifindex: 3,
		phy: "/sys/devices/policy/phy0",
		path: PORT,
	});
	await f.discover();
	profile()["connection.autoconnect"] = "yes";
	const disconnect = jest.fn(async () => true);

	expect(await stop(disconnect)).toEqual({ success: true });
	expect(disconnect).not.toHaveBeenCalled();
	expect(profile()["connection.autoconnect"]).toBe("no");
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
});
