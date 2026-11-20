import { afterEach, expect, jest, spyOn, test } from "bun:test";
import * as time from "../helpers/time.ts";
import { getConfig } from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	getBootReadiness,
	markBootDegraded,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import {
	getHotspotCredentials,
	rememberHotspotCredentials,
	resetHotspotCredentialsForTest,
} from "../modules/wifi/hotspot-credentials.ts";
import {
	defaultAdapterModeDeps,
	setWifiAdapterMode,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import { reconcileWifiAdapterLocked } from "../modules/wifi/wifi-adapter-reconciler.ts";
import { quiesceHotspotAutoconnect } from "../modules/wifi/wifi-autoconnect-policy.ts";
import {
	removeWifiInterface,
	wifiCancelScanRefresh,
} from "../modules/wifi/wifi-connections.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";
import { advancePolicy } from "./helpers/wifi-reconcile-fixture.ts";

const f = autoconnectFixture();

afterEach(() => {
	resetBootReadiness();
	jest.useRealTimers();
});

test("r4 an activation policy rejection enters the shared owner retry path", async () => {
	jest.useFakeTimers();
	f.persistMode(MAC, "hotspot");
	const write = nm.nmConnSetFields;
	spyOn(nm, "nmConnSetFields").mockImplementation((uuid, fields) =>
		fields["connection.autoconnect-priority"] === "999"
			? Promise.resolve(false)
			: write(uuid, fields),
	);
	expect(await f.start()).toEqual({ success: true });
	expect(getBootReadiness().degradedSubsystems).toEqual([
		`wifi-hotspot-autoconnect:${MAC}`,
	]);
	expect(jest.getTimerCount()).toBe(1);
});

test("r4 code2 discovery recovery clears the exact composite owner's health", async () => {
	const owner = `${MAC}@phy0`;
	resetHotspotCredentialsForTest();
	rememberHotspotCredentials(owner, {
		ssid: "Policy AP",
		password: "fixture-password",
		conn: PROFILE,
	});
	f.persistMode(owner, "station");
	markBootDegraded("engine");
	const write = spyOn(nm, "nmConnSetFields").mockResolvedValue(false);
	expect(await reconcileWifiAdapterLocked(owner)).toBe(false);
	expect(getBootReadiness().degradedSubsystems).toContain(
		`wifi-hotspot-autoconnect:${owner}`,
	);
	write.mockRestore();
	await f.discover();
	expect(getBootReadiness().degradedSubsystems).toEqual(["engine"]);
	expect(f.profiles.get(PROFILE)?.["connection.autoconnect"]).toBe("no");
});

test("r4 code3 refused station selection schedules policy recovery", async () => {
	jest.useFakeTimers();
	jest.setSystemTime(10_000);
	spyOn(time, "getms").mockImplementation(() => Date.now());
	f.persistMode(MAC, "hotspot");
	const profile = f.profiles.get(PROFILE);
	if (!profile) throw new Error("Missing profile");
	profile["match.path"] = PORT;
	await f.discover();
	wifiCancelScanRefresh();
	const read = spyOn(nm, "nmConnGetFields").mockResolvedValue(undefined);
	expect(
		await setWifiAdapterMode(0, "station", {
			...defaultAdapterModeDeps,
			publishOutcome: () => undefined,
		}),
	).toEqual({ success: false, error: "deactivation-failed" });
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "hotspot" });
	expect(jest.getTimerCount()).toBe(1);
	read.mockRestore();
	await advancePolicy(3000);
	expect(getBootReadiness().degraded).toBe(false);
});

test("r4 adversarial1 confirmed absent history is pruned and cannot block discovery", async () => {
	const profile = f.profiles.get(PROFILE);
	if (!profile) throw new Error("Missing profile");
	f.profiles.set("new-ap", { ...profile });
	rememberHotspotCredentials(MAC, {
		ssid: "Policy AP",
		password: "fixture-password",
		conn: "new-ap",
	});
	f.profiles.delete(PROFILE);
	removeWifiInterface(MAC);
	const read = nm.nmConnGetFields;
	spyOn(nm, "nmConnGetFields").mockImplementation((uuid, fields) =>
		uuid === PROFILE ? Promise.resolve(undefined) : read(uuid, fields),
	);
	await f.discover();
	expect(getHotspotCredentials(MAC)?.previousConns).toEqual([]);
	expect(f.publications).not.toEqual([]);
	expect(getBootReadiness().degraded).toBe(false);
});

test("r4 adversarial4 an unreadable owned station profile never grants AP teardown", async () => {
	f.persistMode(MAC, "station");
	const profile = f.profiles.get(PROFILE);
	if (!profile) throw new Error("Missing profile");
	profile["802-11-wireless.mode"] = "infrastructure";
	await f.sample();
	spyOn(nm, "nmConnGetFields").mockResolvedValue(undefined);
	const disconnect = spyOn(nm, "nmDisconnect").mockResolvedValue(true);
	expect(
		await quiesceHotspotAutoconnect(
			wifiRadioIdentity.state.rows,
			new Map([["wlan0", PROFILE]]),
		),
	).toBe(false);
	expect(disconnect).not.toHaveBeenCalled();
	expect(getBootReadiness().degraded).toBe(true);
	expect(getHotspotCredentials(MAC)?.conn).toBe(PROFILE);
});
