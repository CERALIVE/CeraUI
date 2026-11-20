import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	getBootReadiness,
	markBootDegraded,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import { rememberHotspotCredentials } from "../modules/wifi/hotspot-credentials.ts";
import {
	defaultAdapterModeDeps,
	setWifiAdapterMode,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import { quiesceHotspotAutoconnect } from "../modules/wifi/wifi-autoconnect-policy.ts";
import { getWifiInterfacesByMacAddress } from "../modules/wifi/wifi-connections.ts";
import { canHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

import { policyStop as stop } from "./helpers/wifi-reconcile-fixture.ts";

const f = autoconnectFixture();
const OTHER = "dc:a6:32:aa:bb:cc";
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
	"round3 R1 any unreadable possible owner preserves recovery, reversed=%s",
	async (reversed) => {
		f.persistMode(MAC, "hotspot");
		f.witnesses.set("wlan1", {
			ifindex: 5,
			phy: "/sys/devices/policy/phy1",
			path: "usb-unreadable",
		});
		await f.sample();
		const entries = [...wifiRadioIdentity.state.rows];

		expect(
			await quiesceHotspotAutoconnect(
				new Map(reversed ? entries.reverse() : entries),
				new Map(),
			),
		).toBe(true);
		expect(profile()["connection.autoconnect"]).toBe("yes");
		expect(f.effects).toEqual([]);
	},
);

test.each([false, true])(
	"round3 R2 direct Stop disarms current and historical APs, active=%s",
	async (active) => {
		profile()["match.path"] = PORT;
		f.persistMode(MAC, "hotspot");
		await f.discover();
		f.profiles.set("current-ap", { ...profile() });
		rememberHotspotCredentials(MAC, {
			ssid: "Policy AP",
			password: "fixture-password",
			conn: "current-ap",
		});
		if (active) {
			f.row().conn = PROFILE;
			f.row().activeConn = PROFILE;
			f.row().activeMode = "ap";
		}
		const disconnect = jest.fn(async () => true);

		expect(await stop(disconnect)).toEqual({ success: true });
		expect(profile()["connection.autoconnect"]).toBe("no");
		expect(f.profiles.get("current-ap")?.["connection.autoconnect"]).toBe("no");
		expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
		expect(disconnect).toHaveBeenCalledTimes(active ? 1 : 0);
	},
);

test.each([false, true])(
	"round3 R2 rejected Stop policy still reports stopped and saves station, active=%s",
	async (active) => {
		profile()["match.path"] = PORT;
		f.persistMode(MAC, "hotspot");
		await f.discover();
		if (active) {
			f.row().conn = PROFILE;
			f.row().activeConn = PROFILE;
			f.row().activeMode = "ap";
		}
		spyOn(nm, "nmConnSetFields").mockResolvedValue(false);
		const disconnect = jest.fn(async () => true);

		expect(await stop(disconnect)).toEqual({ success: true });
		expect(disconnect).toHaveBeenCalledTimes(active ? 1 : 0);
		expect(f.row().conn).toBeNull();
		expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
	},
);

test.each([false, true])(
	"round3 R2 limited Stop checks its logical owner's current and historical APs, active=%s",
	async (active) => {
		f.persistMode(MAC, "hotspot");
		f.witnesses.set("wlan0", {
			ifindex: 3,
			phy: "/sys/devices/policy/phy0",
			path: PORT,
		});
		await f.discover();
		f.profiles.set("current-ap", { ...profile() });
		rememberHotspotCredentials(MAC, {
			ssid: "Policy AP",
			password: "fixture-password",
			conn: "current-ap",
		});
		const row = Object.values(getWifiInterfacesByMacAddress()).find(canHotspot);
		if (!row) throw new Error("Missing limited fixture radio");
		if (active) {
			row.hotspot.conn = PROFILE;
			row.conn = PROFILE;
			row.activeConn = PROFILE;
			row.activeMode = "ap";
		}
		const disconnect = jest.fn(async () => true);

		expect(await stop(disconnect)).toEqual({ success: true });
		expect(profile()["connection.autoconnect"]).toBe("no");
		expect(f.profiles.get("current-ap")?.["connection.autoconnect"]).toBe("no");
		expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
		expect(disconnect).toHaveBeenCalledTimes(active ? 1 : 0);
	},
);

test.each(["quiesce", "station", "Stop"] as const)(
	"round3 R3 unreadable owned profile degrades %s without inventing disarm success",
	async (action) => {
		profile()["match.path"] = PORT;
		f.persistMode(MAC, "hotspot");
		await f.discover();
		spyOn(nm, "nmConnGetFields").mockResolvedValue(undefined);
		const disconnect = jest.fn(async () => true);
		if (action === "Stop") {
			f.row().conn = PROFILE;
			f.row().activeConn = PROFILE;
			f.row().activeMode = "ap";
		}

		if (action === "quiesce") {
			expect(
				await quiesceHotspotAutoconnect(
					wifiRadioIdentity.state.rows,
					new Map(),
				),
			).toBe(false);
		} else {
			const result =
				action === "Stop"
					? await stop(disconnect)
					: await setWifiAdapterMode(0, "station", {
							...defaultAdapterModeDeps,
							publishOutcome: () => undefined,
						});
			expect(result).toEqual(
				action === "Stop"
					? { success: true }
					: { success: false, error: "deactivation-failed" },
			);
		}
		expect(disconnect).toHaveBeenCalledTimes(action === "Stop" ? 1 : 0);
		expect(getConfig().wifi_modes).toEqual({
			[MAC]: action === "Stop" ? "station" : "hotspot",
		});
		expect(getBootReadiness().degradedSubsystems).toContain(
			`wifi-hotspot-autoconnect:${MAC}`,
		);
	},
);

test("round3 R4 health clears only after all owner profiles succeed and retains unrelated failures", async () => {
	f.persistMode(MAC, "station");
	const current = { ...profile() };
	f.profiles.set("current-ap", current);
	rememberHotspotCredentials(MAC, {
		ssid: "Policy AP",
		password: "fixture-password",
		conn: "current-ap",
	});
	markBootDegraded("engine");
	markBootDegraded(`wifi-hotspot-autoconnect:${OTHER}`);
	const write = nm.nmConnSetFields;
	let rejected: string | undefined = PROFILE;
	spyOn(nm, "nmConnSetFields").mockImplementation((uuid, fields) =>
		uuid === rejected ? Promise.resolve(false) : write(uuid, fields),
	);
	await f.sample();

	expect(
		await quiesceHotspotAutoconnect(wifiRadioIdentity.state.rows, new Map()),
	).toBe(false);
	expect(getBootReadiness().degradedSubsystems).toContain(
		`wifi-hotspot-autoconnect:${MAC}`,
	);
	rejected = "current-ap";
	current["connection.autoconnect"] = "yes";
	profile()["connection.autoconnect"] = "yes";
	expect(
		await quiesceHotspotAutoconnect(wifiRadioIdentity.state.rows, new Map()),
	).toBe(false);
	expect(getBootReadiness().degradedSubsystems).toContain(
		`wifi-hotspot-autoconnect:${MAC}`,
	);
	rejected = undefined;

	expect(
		await quiesceHotspotAutoconnect(wifiRadioIdentity.state.rows, new Map()),
	).toBe(true);
	expect(getBootReadiness()).toEqual({
		degraded: true,
		degradedSubsystems: ["engine", `wifi-hotspot-autoconnect:${OTHER}`],
	});
});
