import { expect, spyOn, test } from "bun:test";
import * as nm from "../modules/network/network-manager.ts";
import { getPendingHotspotCreation } from "../modules/wifi/hotspot-credentials.ts";
import { getWifiState } from "../modules/wifi/state/wifi-state.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../modules/wifi/wifi-adapter-lock.ts";
import {
	cancelWifiAdapterReconciliation,
	reconcileWifiAdapterTeardownLocked,
} from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import { syncWifiStateCache } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { HOTSPOT_UP_TO } from "../modules/wifi/wifi-hotspot-types.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";

test("rollback leaves an activation running if Up timed out without an active-path receipt", async () => {
	const f = await firstAp();
	try {
		f.faults.upTimeout = true;
		const result = await f.start();
		const uuid = f.created();
		if (!uuid) throw new Error("Missing created profile");
		expect(f.active()).toBe(uuid);
		expect(f.profiles.has(uuid)).toBeTrue();
		expect(
			f.commands.filter((args) => ["down", "del"].includes(args[1] ?? "")),
		).toEqual([]);
		expect(result).toMatchObject({
			success: false,
			reason: "cleanup-pending",
		});
	} finally {
		cancelWifiAdapterReconciliation();
		await f.restore();
	}
});

test.each(["before Down", "after Down"] as const)(
	"first-profile rollback leaves a same-profile successor started %s running",
	async (when) => {
		const f = await firstAp("autoconnect");
		try {
			const down = f.deps.nmDisconnect;
			const connect = f.deps.nmConnect;
			f.deps.nmDisconnect = async (uuid, path) => {
				if (when === "before Down") await connect(uuid, HOTSPOT_UP_TO);
				const stopped = await down(uuid, path);
				if (when === "after Down") await connect(uuid, HOTSPOT_UP_TO);
				return stopped;
			};
			const result = await f.start();
			const uuid = f.created();
			if (!uuid) throw new Error("Missing created profile");
			expect(f.active()).toBe(uuid);
			expect(f.profiles.has(uuid)).toBeTrue();
			expect(result).toMatchObject({
				success: false,
				reason: "cleanup-pending",
			});
		} finally {
			cancelWifiAdapterReconciliation();
			await f.restore();
		}
	},
);

test("cleanup retires cache and creation provenance when the profile vanishes during activity readback", async () => {
	const f = await firstAp();
	try {
		f.faults.upTimeout = true;
		expect(await f.start()).toMatchObject({ reason: "cleanup-pending" });
		const uuid = f.created();
		if (!uuid) throw new Error("Missing created profile");
		expect(getPendingHotspotCreation(MAC)).toBe(uuid);
		f.row.conn = uuid;
		f.row.activeConn = uuid;
		f.row.activeMode = "ap";
		syncWifiStateCache(MAC, f.row);
		const list = nm.nmConnsGet;
		spyOn(nm, "nmConnsGet").mockImplementation(async (fields) => {
			if (fields === "uuid,active") {
				f.profiles.delete(uuid);
				f.observe(undefined, "ap");
			}
			return list(fields);
		});

		const retry = await withWifiAdapterLock(wifiAdapterLockKey(MAC), () =>
			reconcileWifiAdapterTeardownLocked(MAC),
		);

		expect(retry).toEqual({
			success: true,
			result: { complete: true, stopped: true },
		});
		expect(getPendingHotspotCreation(MAC)).toBeUndefined();
		expect(getWifiState()[MAC]?.conn).toBeNull();
		expect(getWifiState()[MAC]?.activeConn).toBeNull();
		expect(
			f.commands.filter((args) => ["down", "del"].includes(args[1] ?? "")),
		).toEqual([]);
	} finally {
		cancelWifiAdapterReconciliation();
		await f.restore();
	}
});
