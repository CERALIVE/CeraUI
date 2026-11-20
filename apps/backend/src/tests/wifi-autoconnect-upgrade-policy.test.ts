import { expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { getConfig, getConfigFilePath } from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import { rememberHotspotCredentials } from "../modules/wifi/hotspot-credentials.ts";
import { observedWifiAdapterMode } from "../modules/wifi/wifi-adapter-mode.ts";
import { getWifiInterfacesByMacAddress } from "../modules/wifi/wifi-connections.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

const f = autoconnectFixture();
const profile = () => {
	const value = f.profiles.get(PROFILE);
	if (!value) throw new Error("Missing fixture profile");
	return value;
};

test("(11) a release hybrid profile gains durable intent before quiesce and returns through B2 restore", async () => {
	f.seed(true);
	await f.discover();
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "hybrid" });
	expect(
		JSON.parse(await readFile(getConfigFilePath(), "utf8")).wifi_modes,
	).toEqual({ [MAC]: "hybrid" });
	expect(profile()?.["connection.autoconnect"]).toBe("no");
	expect(
		f.effects
			.filter((e) => e.fields["connection.autoconnect"] === "no")
			.map((e) => e.intent),
	).toEqual(["hybrid"]);
	await f.restore();
	expect(observedWifiAdapterMode(f.row())).toBe("hybrid");
});

test("(12) failed durable intent leaves the existing autoconnect recovery path on", async () => {
	f.seed(true);
	f.failIntent();
	await f.discover();
	expect(getConfig().wifi_modes).toEqual({});
	expect(profile()?.["connection.autoconnect"]).toBe("yes");
	expect(
		f.effects.filter((e) => e.fields["connection.autoconnect"] === "no"),
	).toEqual([]);
});

test("startup quiesces an owned live AP without stopping it or changing its credentials", async () => {
	f.list([`wlan0:wifi:connected:${PROFILE}`]);
	await f.discover();
	expect(profile()["connection.autoconnect"]).toBe("no");
	expect(observedWifiAdapterMode(f.row())).toBe("hotspot");
	expect(f.row().hotspot.name).toBe("Policy AP");
	expect(f.row().hotspot.password).toBe("fixture-password");
	expect(
		f.effects.every((effect) =>
			Object.keys(effect.fields).every(
				(field) => field === "connection.autoconnect",
			),
		),
	).toBe(true);
});

test("(13) a limited row preserves its live profile and autoconnect without a same-address twin", async () => {
	f.witnesses.set("wlan0", {
		ifindex: 3,
		phy: "/sys/devices/policy/phy0",
		path: PORT,
	});
	f.list([`wlan0:wifi:connected:${PROFILE}`]);
	const before = structuredClone(profile());
	await f.discover();
	expect(profile()).toEqual(before);
	expect(f.effects).toEqual([]);
	const row = Object.values(getWifiInterfacesByMacAddress())[0];
	expect(row && observedWifiAdapterMode(row)).toBe("hotspot");
});

test.each([1, 2])(
	"review R1 preserves recovery with %i disconnected unreadable radios",
	async (count) => {
		f.witnesses.set("wlan0", {
			ifindex: 3,
			phy: "/sys/devices/policy/phy0",
			path: PORT,
		});
		if (count === 2) {
			f.witnesses.set("wlan1", {
				ifindex: 5,
				phy: "/sys/devices/policy/phy1",
				path: "usb-other-port",
			});
			f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
		}
		const before = structuredClone(profile());

		await f.discover();
		await f.restore();

		expect(profile()).toEqual(before);
		expect(f.effects).toEqual([]);
		expect(Object.values(getWifiInterfacesByMacAddress())).toHaveLength(count);
	},
);

test("review R2 discovery defers while Start has an autoconnect write pending", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const write = nm.nmConnSetFields;
	spyOn(nm, "nmConnSetFields").mockImplementation(async (uuid, fields) => {
		if (fields["connection.autoconnect"] === "yes") {
			entered.resolve();
			await release.promise;
		}
		return write(uuid, fields);
	});
	const start = f.start();
	await entered.promise;
	rememberHotspotCredentials(`${MAC}@usb-twin`, {
		ssid: "Twin",
		password: "twin-password",
	});
	const reads = spyOn(nm, "nmConnGetFields");
	try {
		await f.discover();
		expect(reads.mock.calls).toEqual([]);
		expect(f.publications).toEqual([]);
	} finally {
		release.resolve();
		await start;
	}

	await f.discover();
	expect(profile()["connection.autoconnect"]).toBe("no");
	expect(f.publications).not.toContain("yes");
});
