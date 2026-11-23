import { afterEach, expect, jest, spyOn, test } from "bun:test";
import * as time from "../helpers/time.ts";
import { getConfig } from "../modules/config.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../modules/wifi/wifi-adapter-lock.ts";
import {
	getWifiInterfacesByMacAddress,
	wifiCancelScanRefresh,
} from "../modules/wifi/wifi-connections.ts";
import { canHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";
import { advancePolicy, policyStop } from "./helpers/wifi-reconcile-fixture.ts";

const f = autoconnectFixture();
const limited = () => {
	const row = Object.values(getWifiInterfacesByMacAddress()).find(canHotspot);
	if (!row) throw new Error("Missing limited radio");
	return row;
};
async function discoverLimited(two = false): Promise<void> {
	f.persistMode(MAC, "hotspot");
	f.witnesses.set("wlan0", {
		ifindex: 3,
		phy: "/sys/devices/policy/phy0",
		path: PORT,
	});
	if (two) {
		f.witnesses.set("wlan1", {
			ifindex: 5,
			phy: "/sys/devices/policy/phy1",
			path: "usb-other",
		});
	}
	f.list([
		`wlan0:wifi:connected:${PROFILE}`,
		...(two ? ["wlan1:wifi:disconnected:"] : []),
	]);
	await f.discover();
	wifiCancelScanRefresh();
}

afterEach(() => {
	resetBootReadiness();
	jest.useRealTimers();
});

test("r4 code1 limited Stop refuses while its observed profile owner is locked", async () => {
	await discoverLimited();
	const release = Promise.withResolvers<void>();
	const held = withWifiAdapterLock(
		wifiAdapterLockKey(MAC),
		() => release.promise,
	);
	const disconnect = jest.fn(async () => true);
	try {
		expect(await policyStop(disconnect)).toEqual({
			success: false,
			error: "DEVICE_BUSY",
		});
		expect(disconnect).not.toHaveBeenCalled();
		expect(f.effects).toEqual([]);
		expect(getConfig().wifi_modes).toEqual({ [MAC]: "hotspot" });
	} finally {
		release.resolve();
		await held;
	}
});

test("r4 code1 identity transfer cannot overtake an admitted limited Stop", async () => {
	jest.useFakeTimers();
	jest.setSystemTime(10_000);
	spyOn(time, "getms").mockImplementation(() => Date.now());
	await discoverLimited();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<boolean>();
	const stopping = policyStop(async () => {
		entered.resolve();
		const disconnected = await release.promise;
		f.list(["wlan0:wifi:disconnected:"]);
		return disconnected;
	});
	await entered.promise;
	f.witnesses.set("wlan0", {
		ifindex: 3,
		phy: "/sys/devices/policy/phy0",
		path: PORT,
		mac: MAC,
	});
	try {
		await advancePolicy(250);
		expect(Object.keys(getWifiInterfacesByMacAddress())).toEqual([
			"limited:3:0",
		]);
		expect(getBootReadiness().degraded).toBe(false);
	} finally {
		release.resolve(true);
		await stopping;
	}
	await advancePolicy(3000);
	expect(Object.keys(getWifiInterfacesByMacAddress())).toEqual([MAC]);
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
});

test("r4 adversarial2 two unreadable radios Stop the observed profile's unique owner", async () => {
	await discoverLimited(true);
	const disconnect = jest.fn(async () => true);
	expect(await policyStop(disconnect)).toEqual({ success: true });
	expect(disconnect).toHaveBeenCalledTimes(1);
	expect(limited().conn).toBeNull();
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
	expect(f.profiles.get(PROFILE)?.["connection.autoconnect"]).toBe("no");
});
