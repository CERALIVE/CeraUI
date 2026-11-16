import { expect, spyOn, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import { rememberHotspotCredentials } from "../modules/wifi/hotspot-credentials.ts";
import { observedWifiAdapterMode } from "../modules/wifi/wifi-adapter-mode.ts";
import {
	defaultAdapterModeDeps,
	setWifiAdapterMode,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import * as apSta from "../modules/wifi/wifi-ap-sta-capability.ts";
import { hotspotAutoconnectFields } from "../modules/wifi/wifi-autoconnect-policy.ts";
import * as concurrent from "../modules/wifi/wifi-concurrent-interface.ts";
import {
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
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

test.each(["selection", "startup"] as const)(
	"review R3 station intent at %s disarms pinned current and historical APs across reboot",
	async (source) => {
		profile()["match.path"] = PORT;
		f.profiles.set("current-ap", { ...profile() });
		rememberHotspotCredentials(MAC, {
			ssid: "Policy AP",
			password: "fixture-password",
			conn: "current-ap",
		});
		if (source === "selection") {
			f.persistMode(MAC, "hotspot");
			expect(
				await setWifiAdapterMode(0, "station", {
					...defaultAdapterModeDeps,
					publishOutcome: () => undefined,
				}),
			).toEqual({ success: true, applied: "station" });
			expect(profile()["connection.autoconnect"]).toBe("no");
		} else f.persistMode(MAC, "station");

		await f.discover();
		await f.restore();

		expect(profile()["connection.autoconnect"]).toBe("no");
		expect(f.profiles.get("current-ap")?.["connection.autoconnect"]).toBe("no");
		expect(f.activations).toEqual([]);
		expect(observedWifiAdapterMode(f.row())).toBe("station");
		expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
	},
);

test("review R3 a rejected station policy write refuses success and restores prior intent", async () => {
	f.persistMode(MAC, "hotspot");
	spyOn(nm, "nmConnSetFields").mockResolvedValue(false);

	expect(
		await setWifiAdapterMode(0, "station", {
			...defaultAdapterModeDeps,
			publishOutcome: () => undefined,
		}),
	).toEqual({ success: false, error: "deactivation-failed" });
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "hotspot" });
});

test.each([undefined, "station", "hotspot", "hybrid"] as const)(
	"review R3 autoconnect arms only with AP intent, given %s",
	async (intent) => {
		if (intent !== undefined) f.persistMode(MAC, intent);
		await f.sample();
		expect(
			hotspotAutoconnectFields(MAC, {
				"802-11-wireless.mac-address": MAC,
				"match.path": PORT,
			})["connection.autoconnect"],
		).toBe(intent === "hotspot" || intent === "hybrid" ? "yes" : "no");
	},
);

test("review R3 pinned hotspot intent keeps its reboot recovery", async () => {
	profile()["match.path"] = PORT;
	f.persistMode(MAC, "hotspot");

	await f.discover();
	await f.restore();

	expect(profile()["connection.autoconnect"]).toBe("yes");
	expect(f.activations).toEqual([PROFILE]);
	expect(observedWifiAdapterMode(f.row())).toBe("hotspot");
});

test.each(["hotspot", "station"] as const)(
	"review R4 rejected quiesce with %s intent withholds creation and publication until next pass",
	async (intent) => {
		f.persistMode(MAC, intent);
		removeWifiInterface(MAC);
		resetBootReadiness();
		spyOn(apSta, "supportsApStaConcurrency").mockResolvedValue(true);
		const allocate = spyOn(
			concurrent,
			"ensureConcurrentApInterface",
		).mockResolvedValue({
			ifname: "clap-wlan0",
			created: false,
			type: "managed",
		});
		const write = nm.nmConnSetFields;
		let rejected = true;
		spyOn(nm, "nmConnSetFields").mockImplementation((uuid, fields) =>
			rejected && fields["connection.autoconnect"] === "no"
				? Promise.resolve(false)
				: write(uuid, fields),
		);
		try {
			await f.discover();

			expect(allocate).not.toHaveBeenCalled();
			expect(f.publications).toEqual([]);
			expect(getWifiInterfacesByMacAddress()).toEqual({});
			expect(getBootReadiness()).toEqual({
				degraded: true,
				degradedSubsystems: [`wifi-hotspot-autoconnect:${MAC}`],
			});

			rejected = false;
			await f.discover();

			expect(profile()["connection.autoconnect"]).toBe("no");
			expect(allocate).not.toHaveBeenCalled();
			expect(f.publications).toContain("no");
			expect(f.publications).not.toContain("yes");
		} finally {
			resetBootReadiness();
		}
	},
);

test("a duplicate path on distinct phys is unreadable for autoconnect", async () => {
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		mac: "dc:a6:32:aa:bb:cc",
		path: PORT,
	});
	await f.start();
	expect(profile()?.["connection.autoconnect"]).toBe("no");
});

test("a failed exclusive pin write refuses activation and never arms autoconnect", async () => {
	f.refusePin();
	expect(await f.start()).toEqual({
		success: false,
		error: "activation-failed",
	});
	expect(f.activations).toEqual([]);
	expect(
		f.effects.some((e) => e.fields["connection.autoconnect"] === "yes"),
	).toBe(false);
});

test("a first profile gets both pins before its explicit reconnect is allowed to arm autoconnect", async () => {
	delete f.row().hotspot.conn;
	expect(await f.start()).toEqual({ success: true });
	expect(profile()["match.path"]).toBe(PORT);
	expect(profile()["802-11-wireless.mac-address"]).toBe(MAC);
	expect(profile()["connection.autoconnect"]).toBe("yes");
});

test("a port read across replacement cannot publish the predecessor path", async () => {
	spyOn(nm, "nmDeviceProp").mockImplementation(async (_ifname, fields) => {
		if (fields !== "GENERAL.PATH") return undefined;
		f.witnesses.set("wlan0", {
			ifindex: 99,
			phy: "/sys/devices/policy/phy0",
			mac: MAC,
			path: "usb-successor",
		});
		return [PORT];
	});
	await f.sample();
	expect(wifiRadioIdentity.state.rows.get("wlan0")?.lifetime).toBeUndefined();
});
