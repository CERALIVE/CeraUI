import { expect, test } from "bun:test";
import { hotspotCredentialsStore } from "../modules/wifi/hotspot-credentials.ts";
import { wifiUpdateSavedConns } from "../modules/wifi/wifi.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
	withWifiAdapterPolicyLocks,
} from "../modules/wifi/wifi-adapter-lock.ts";
import { addWifiInterface } from "../modules/wifi/wifi-connections.ts";
import { startHotspotForInterface } from "../modules/wifi/wifi-hotspot-activation.ts";
import { handleHotspotConn } from "../modules/wifi/wifi-hotspot-discovery.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import type {
	HotspotActivationDeps,
	WifiInterfaceWithHotspot,
} from "../modules/wifi/wifi-hotspot-types.ts";
import { profileRefreshFixture } from "./helpers/wifi-profile-refresh-fixture.ts";

test("a pending discovery priority write excludes activation until normalization finishes", async () => {
	const f = await profileRefreshFixture("test-ap", {
		"connection.autoconnect-priority": "0",
		"802-11-wireless.mac-address": "dc:a6:32:aa:bb:c0",
	});
	f.own();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const effects: string[] = [];
	f.beforeWrite(async (fields) => {
		if (fields["connection.autoconnect-priority"]) {
			entered.resolve();
			await release.promise;
			effects.push("priority-complete");
		}
	});
	const deps: HotspotActivationDeps = {
		readProfileInstance: async () => undefined,
		releaseConcurrentInterface: async () => true,
		nmConnSetFields: async () => true,
		nmApConnAdd: async () => undefined,
		nmConnDelete: async () => true,
		nmDisconnect: async () => true,
		nmConnect: async () => {
			effects.push("up");
			return true;
		},
		wifiUpdateSavedConns: async () => undefined,
		broadcastState: () => undefined,
		setDupIpSuppression: () => undefined,
		credentials: hotspotCredentialsStore,
		findHotspotConn: async () => undefined,
		pruneHotspotConns: async () => undefined,
	};
	const discovery = handleHotspotConn("dc:a6:32:aa:bb:c0", "test-ap");
	try {
		await entered.promise;
		expect(
			await startHotspotForInterface("dc:a6:32:aa:bb:c0", f.row, deps),
		).toEqual({
			success: false,
			error: "DEVICE_BUSY",
		});
		expect(effects).toEqual([]);
		release.resolve();
		await discovery;
		expect(
			await startHotspotForInterface("dc:a6:32:aa:bb:c0", f.row, deps),
		).toEqual({ success: true });
		expect(effects).toEqual(["priority-complete", "up"]);
	} finally {
		release.resolve();
		await discovery;
		await settlePending("wlan0", false);
		await f.restore();
	}
});

test("normalization completes for the held parent while a policy alias is locked", async () => {
	const mac = "dc:a6:32:aa:bb:c0";
	const f = await profileRefreshFixture("test-ap", {
		"connection.autoconnect-priority": "0",
		"802-11-wireless.mac-address": mac,
	});
	f.own();
	const other: WifiInterfaceWithHotspot = {
		...f.row,
		id: 1,
		ifname: "wlan1",
		hotspot: { warnings: {}, availableChannels: ["auto"] },
	};
	addWifiInterface("dc:a6:32:aa:bb:c1", other);
	try {
		const key = wifiAdapterLockKey(mac);
		await withWifiAdapterLock(key, () =>
			withWifiAdapterPolicyLocks(key, new Set([f.row, other]), () =>
				handleHotspotConn(mac, "test-ap"),
			),
		);
		expect(f.fields["connection.autoconnect-priority"]).toBe("999");
		expect(f.row.hotspot.conn).toBe("test-ap");
	} finally {
		await f.restore();
	}
});

for (const operation of ["repin", "duplicate-policy"] as const) {
	test(`global saved-profile ${operation} waits for the adapter transaction`, async () => {
		const f = await profileRefreshFixture();
		f.own();
		if (operation === "duplicate-policy") f.own("test-ap");
		if (operation === "repin") delete f.row.hotspot.conn;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const holding = withWifiAdapterLock(wifiAdapterLockKey(f.mac), async () => {
			entered.resolve();
			await release.promise;
		});
		try {
			await entered.promise;
			await wifiUpdateSavedConns();
			expect(f.writes).toEqual([]);
			release.resolve();
			await holding;
			await wifiUpdateSavedConns();
			expect(f.writes).toEqual([
				{
					uuid: f.uuid,
					fields:
						operation === "repin"
							? {
									"connection.interface-name": "",
									"802-11-wireless.mac-address": f.mac,
								}
							: { "connection.autoconnect": "no" },
					ownsLock: true,
				},
			]);
		} finally {
			release.resolve();
			await holding;
			await f.restore();
		}
	});
}
