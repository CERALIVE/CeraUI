import { expect, spyOn, test } from "bun:test";
import * as nm from "../modules/network/network-manager.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../modules/wifi/wifi-adapter-lock.ts";
import {
	cancelWifiAdapterReconciliation,
	reconcileWifiAdapterTeardownLocked,
} from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import { firstAp, MAC, OTHER_UUID } from "./helpers/wifi-first-ap-fixture.ts";

// Model a new daemon's object table separately from the usual fixture, whose
// restart intentionally advances its path counter.
function renumberingDaemon(f: Awaited<ReturnType<typeof firstAp>>) {
	const connect = f.deps.nmConnect;
	const disconnect = f.deps.nmDisconnect;
	const reusedPath = "/org/freedesktop/NetworkManager/ActiveConnection/1";
	let renumbered = false;
	f.deps.nmConnect = (uuid, timeout, capture) =>
		connect(uuid, timeout, () => capture?.(reusedPath));
	f.deps.nmDisconnect = async (uuid, path) => {
		if (renumbered && path === reusedPath) {
			// apath identifies the new daemon's object regardless of the UUID.
			f.observe(undefined, "ap");
			return true;
		}
		return disconnect(uuid, path);
	};
	return () => {
		f.nm.restart();
		f.observe(OTHER_UUID, "ap");
		renumbered = true;
	};
}

test("retained rollback retires its inactive profile without downing a reused path after NM restarts", async () => {
	const f = await firstAp("autoconnect");
	const restart = renumberingDaemon(f);
	try {
		f.faults.downFails = true;
		expect(await f.start()).toMatchObject({ reason: "cleanup-pending" });
		const uuid = f.created();
		if (!uuid) throw new Error("Missing created profile");

		restart();
		f.faults.downFails = false;
		await withWifiAdapterLock(wifiAdapterLockKey(MAC), () =>
			reconcileWifiAdapterTeardownLocked(MAC),
		);

		expect(f.active()).toBe(OTHER_UUID);
		expect(f.profiles.has(uuid)).toBeFalse();
	} finally {
		cancelWifiAdapterReconciliation();
		await f.restore();
	}
});

test("a hybrid channel refusal after NM restarts does not down an unrelated activation on the reused path", async () => {
	const f = await firstAp(undefined, true);
	const restart = renumberingDaemon(f);
	try {
		f.deps.confirmHybridActivation = async () => {
			restart();
			return false;
		};

		expect((await f.start()).success).toBeFalse();
		expect(f.active()).toBe(OTHER_UUID);
	} finally {
		cancelWifiAdapterReconciliation();
		await f.restore();
	}
});

test.each(["active", "unknown"] as const)(
	"retained cleanup preserves both profiles after a daemon restart when old profile activity is %s",
	async (activity) => {
		const f = await firstAp("autoconnect");
		const restart = renumberingDaemon(f);
		try {
			f.faults.downFails = true;
			expect(await f.start()).toMatchObject({ reason: "cleanup-pending" });
			const uuid = f.created();
			if (!uuid) throw new Error("Missing created profile");
			restart();
			f.faults.downFails = false;

			const inventory = nm.nmConnsGet;
			spyOn(nm, "nmConnsGet").mockImplementation(async (fields) => {
				const rows = await inventory(fields);
				return fields === "uuid,active"
					? activity === "unknown"
						? undefined
						: rows?.map((line) =>
								line.startsWith(`${uuid}:`) ? `${uuid}:yes` : line,
							)
					: rows;
			});
			await withWifiAdapterLock(wifiAdapterLockKey(MAC), () =>
				reconcileWifiAdapterTeardownLocked(MAC),
			);

			expect(f.active()).toBe(OTHER_UUID);
			expect(f.profiles.has(uuid)).toBeTrue();
		} finally {
			cancelWifiAdapterReconciliation();
			await f.restore();
		}
	},
);

test("retained cleanup retries autoconnect suppression even while a pathless activation stays active", async () => {
	const f = await firstAp();
	try {
		f.faults.upTimeout = true;
		f.faults.offFails = true;
		const refresh = f.deps.wifiUpdateSavedConns;
		f.deps.wifiUpdateSavedConns = async () => {
			await refresh();
			await f.armRetainedProfile();
		};
		expect(await f.start()).toMatchObject({ reason: "cleanup-pending" });
		const uuid = f.created();
		if (!uuid) throw new Error("Missing created profile");
		expect(f.autoconnect.has(uuid)).toBeTrue();

		f.faults.offFails = false;
		await withWifiAdapterLock(wifiAdapterLockKey(MAC), () =>
			reconcileWifiAdapterTeardownLocked(MAC),
		);

		expect(f.autoconnect.has(uuid)).toBeFalse();
		expect(f.active()).toBe(uuid);
		expect(f.profiles.has(uuid)).toBeTrue();
	} finally {
		cancelWifiAdapterReconciliation();
		await f.restore();
	}
});
