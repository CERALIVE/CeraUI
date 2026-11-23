import { afterEach, expect, jest, spyOn, test } from "bun:test";
import * as time from "../helpers/time.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../modules/wifi/wifi-adapter-lock.ts";
import { wifiAdapterModeRestoreSource } from "../modules/wifi/wifi-adapter-mode-events.ts";
import { wifiCancelScanRefresh } from "../modules/wifi/wifi-connections.ts";
import * as compat from "../rpc/compat.ts";
import {
	autoconnectFixture,
	MAC,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

import { advancePolicy as advance } from "./helpers/wifi-reconcile-fixture.ts";

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

test.each(["write", "read", "busy"] as const)(
	"round3 R5 discovery retries %s failure and restores without another event",
	async (fault) => {
		jest.useFakeTimers();
		jest.setSystemTime(10_000);
		spyOn(time, "getms").mockImplementation(() => Date.now());
		f.persistMode(MAC, "hotspot");
		const publishLocal = compat.broadcastMsgLocal;
		spyOn(compat, "broadcastMsgLocal").mockImplementation((...args) => {
			f.publications.push(profile()["connection.autoconnect"] ?? "");
			return publishLocal(...args);
		});
		const write = nm.nmConnSetFields;
		const read = nm.nmConnGetFields;
		let failed = true;
		if (fault === "write")
			spyOn(nm, "nmConnSetFields").mockImplementation((uuid, fields) =>
				failed ? Promise.resolve(false) : write(uuid, fields),
			);
		if (fault === "read")
			spyOn(nm, "nmConnGetFields").mockImplementation((uuid, fields) =>
				failed ? Promise.resolve(undefined) : read(uuid, fields),
			);
		const release = Promise.withResolvers<void>();
		const held =
			fault === "busy"
				? withWifiAdapterLock(wifiAdapterLockKey(MAC), () => release.promise)
				: undefined;
		const notifications: string[] = [];
		const restores: Promise<void>[] = [];
		const unsubscribe = wifiAdapterModeRestoreSource.subscribe(async () => {
			notifications.push(profile()["connection.autoconnect"] ?? "");
			const restore = f.restore();
			restores.push(restore);
			await restore;
		});
		try {
			await f.discover();
			expect(f.publications).toEqual([]);
			expect(notifications).toEqual([]);
			expect(jest.getTimerCount()).toBe(1);
			expect(getBootReadiness().degraded).toBe(fault !== "busy");
			failed = false;
			release.resolve();
			await held;

			await advance(3000);
			await Promise.all(restores);

			expect(notifications).toEqual(["no"]);
			expect(f.activations).toEqual([PROFILE]);
			expect(f.publications[0]).toBe("no");
			expect(getBootReadiness()).toEqual({
				degraded: false,
				degradedSubsystems: [],
			});
		} finally {
			release.resolve();
			await held;
			unsubscribe();
			wifiCancelScanRefresh();
		}
	},
);

test("round3 R5 permanent policy failure exhausts the existing five-minute discovery budget", async () => {
	jest.useFakeTimers();
	jest.setSystemTime(10_000);
	spyOn(time, "getms").mockImplementation(() => Date.now());
	f.persistMode(MAC, "station");
	spyOn(nm, "nmConnSetFields").mockResolvedValue(false);
	const devices = spyOn(nm, "nmDevices");

	await f.discover();
	for (let attempt = 0; attempt < 100; attempt++) await advance(3000);

	expect(devices).toHaveBeenCalledTimes(101);
	expect(jest.getTimerCount()).toBe(0);
	await advance(300_000);
	expect(devices).toHaveBeenCalledTimes(101);
	expect(f.publications).toEqual([]);
});
