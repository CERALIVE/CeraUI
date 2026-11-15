import { expect, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import { rememberHotspotCredentials } from "../modules/wifi/hotspot-credentials.ts";
import { observedWifiAdapterMode } from "../modules/wifi/wifi-adapter-mode.ts";
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

test("(1 / M1) a confirmed unique radio with both pins can autoconnect; clap shares its phy", async () => {
	f.witnesses.set("clap-wlan0", {
		ifindex: 4,
		phy: "/sys/devices/policy/phy0",
		mac: MAC,
		path: PORT,
	});
	expect(await f.start()).toEqual({ success: true });
	expect(profile()?.["802-11-wireless.mac-address"]).toBe(MAC);
	expect(profile()?.["match.path"]).toBe(PORT);
	expect(profile()?.["connection.autoconnect"]).toBe("yes");
});

test("(2 / M2) an unreadable port stays off and restores through saved intent", async () => {
	f.witnesses.set("wlan0", {
		ifindex: 3,
		phy: "/sys/devices/policy/phy0",
		mac: MAC,
	});
	await f.start();
	expect(profile()?.["connection.autoconnect"]).toBe("no");
	expect(getConfig().wifi_modes?.[MAC]).toBe("hotspot");
	f.row().conn = null;
	f.row().activeConn = null;
	await f.restore();
	expect(f.activations).toEqual([PROFILE, PROFILE]);
	expect(observedWifiAdapterMode(f.row())).toBe("hotspot");
});

for (const source of ["credentials", "wifi_modes"] as const) {
	test(`(3 / M3) an absent persisted twin in ${source} prevents autoconnect`, async () => {
		const twin = `${MAC}@usb-other-port`;
		if (source === "credentials")
			rememberHotspotCredentials(twin, {
				ssid: "Twin",
				password: "twin-password",
			});
		else f.persistMode(twin, "station");
		await f.start();
		expect(profile()?.["connection.autoconnect"]).toBe("no");
	});
}

test("(4 / M4) a newly present twin quiesces current and historical owned profiles before publication", async () => {
	profile()["match.path"] = PORT;
	rememberHotspotCredentials(MAC, {
		ssid: "Policy AP",
		password: "fixture-password",
		conn: "current-ap",
	});
	f.profiles.set("current-ap", { ...profile() });
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		mac: MAC,
		path: "usb-other-port",
	});
	f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
	await f.discover();
	expect(profile()?.["connection.autoconnect"]).toBe("no");
	expect(f.profiles.get("current-ap")?.["connection.autoconnect"]).toBe("no");
	expect(f.publications).not.toContain("yes");
});

for (const source of ["credentials", "wifi_modes"] as const) {
	test(`(3 / M3) persisting a second ${source} owner quiesces a previously safe profile`, async () => {
		profile()["match.path"] = PORT;
		await f.discover();
		expect(profile()["connection.autoconnect"]).toBe("yes");
		const key = `${MAC}@usb-second-port`;
		if (source === "credentials")
			rememberHotspotCredentials(key, {
				ssid: "Twin",
				password: "twin-password",
			});
		else f.persistMode(key, "station");
		await f.discover();
		expect(profile()["connection.autoconnect"]).toBe("no");
		expect(getConfig().wifi_modes?.[MAC]).toBe("hotspot");
	});
}

test("(5 / M5) hybrid restore uses intent and never arms autonomous activation", async () => {
	f.seed(true);
	await f.start();
	f.row().conn = null;
	delete f.row().concurrentHotspot;
	await f.restore();
	expect(observedWifiAdapterMode(f.row())).toBe("hybrid");
	expect(profile()?.["connection.autoconnect"]).toBe("no");
});

test("(6 / M6) a moved known adapter is quiesced then restored with its new port and credentials", async () => {
	profile()["match.path"] = "usb-old-port";
	await f.discover();
	expect(profile()?.["connection.autoconnect"]).toBe("no");
	await f.restore();
	expect(profile()?.["match.path"]).toBe(PORT);
	expect(profile()?.["802-11-wireless.ssid"]).toBe("Policy AP");
	expect(observedWifiAdapterMode(f.row())).toBe("hotspot");
});

test("(7) a confirmed hybrid start explicitly leaves autoconnect no", async () => {
	f.seed(true);
	expect(await f.start()).toEqual({ success: true });
	expect(profile()?.["connection.autoconnect"]).toBe("no");
	expect(
		f.effects.some((e) => e.fields["connection.autoconnect"] === "yes"),
	).toBe(false);
});

test("(8) startup leaves owned station and unowned AP profiles untouched", async () => {
	f.profiles.set("station-profile", {
		"802-11-wireless.mode": "infrastructure",
		"connection.autoconnect": "yes",
	});
	rememberHotspotCredentials("dc:a6:32:aa:bb:cc", {
		ssid: "Station",
		password: "station-password",
		conn: "station-profile",
	});
	f.profiles.set("foreign-ap", {
		"802-11-wireless.mode": "ap",
		"connection.autoconnect": "yes",
		"connection.interface-name": "clap-foreign",
	});
	const station = structuredClone(f.profiles.get("station-profile"));
	const foreign = structuredClone(f.profiles.get("foreign-ap"));
	await f.discover();
	expect(f.profiles.get("station-profile")).toEqual(station);
	expect(f.profiles.get("foreign-ap")).toEqual(foreign);
	expect(
		f.effects.filter(
			(e) => e.uuid === "station-profile" || e.uuid === "foreign-ap",
		),
	).toEqual([]);
});

test("(9) colon-bearing PCI paths keep exact bytes inside the ifindex bracket", async () => {
	await f.start();
	expect(profile()?.["match.path"]).toBe(PORT);
	const pathAt = f.reads.indexOf("path:wlan0");
	expect(pathAt).toBeGreaterThan(
		f.reads.indexOf("/sys/class/net/wlan0/ifindex"),
	);
	expect(f.reads.slice(pathAt + 1)).toContain("/sys/class/net/wlan0/ifindex");
});

test.each([
	"*",
	"?",
	"[",
	"!",
	"|",
	"&",
	"`",
	" ",
	"\t",
	"\n",
	"\r",
	"\0",
	"\x7f",
])("(10) unsafe path byte %j never arms autoconnect", async (byte) => {
	f.witnesses.set("wlan0", {
		ifindex: 3,
		phy: "/sys/devices/policy/phy0",
		mac: MAC,
		path: `usb${byte}port`,
	});
	await f.start();
	expect(profile()?.["connection.autoconnect"]).toBe("no");
	expect(profile()?.["match.path"] ?? "").toBe("");
});
