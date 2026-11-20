import { expect, spyOn, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import * as config from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import { getPendingHotspotCreation } from "../modules/wifi/hotspot-credentials.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../modules/wifi/wifi-adapter-lock.ts";
import { wifiAdapterModeRecorder } from "../modules/wifi/wifi-adapter-mode.ts";
import {
	cancelWifiAdapterReconciliation,
	reconcileWifiAdapterTeardownLocked,
} from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import { reconcileWifiAdapterPolicies } from "../modules/wifi/wifi-adapter-reconciler.ts";
import { handleWifiMonitorEvent } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { runHotspotProfileOperation } from "../modules/wifi/wifi-hotspot-profile-operation.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";

function restoreInPlace(filename: string): void {
	const before = statSync(filename, { bigint: true });
	writeFileSync(filename, readFileSync(filename));
	const after = statSync(filename, { bigint: true });
	expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
	expect(after.ctimeNs === before.ctimeNs).toBe(false);
}

test("saved-profile Start confirms after its own autoconnect policy write", async () => {
	const f = await firstAp();
	const outcomes: unknown[] = [];
	f.deps.publishOutcome = (_kind, _device, outcome) => outcomes.push(outcome);
	const event = {
		type: "device-state",
		device: "wlan0",
		state: "connected",
	} as const;
	try {
		expect(await f.start()).toEqual({ success: true });
		await handleWifiMonitorEvent(event);
		expect(outcomes).toEqual([{ success: true }]);
		outcomes.length = 0;
		f.observe(undefined, "ap");
		f.row.conn = null;
		f.row.activeConn = null;
		expect(await f.start()).toEqual({ success: true });
		await handleWifiMonitorEvent(event);
		expect(outcomes).toEqual([{ success: true }]);
	} finally {
		await f.restore();
	}
});

test("an owned policy modify keeps a pending confirmation receipt current", async () => {
	const f = await firstAp();
	const outcomes: unknown[] = [];
	f.deps.publishOutcome = (_kind, _device, outcome) => outcomes.push(outcome);
	try {
		expect(await f.start()).toEqual({ success: true });
		const uuid = f.created();
		if (!uuid) throw new Error("Missing pending profile");
		expect(
			(
				await runHotspotProfileOperation({
					uuid,
					kind: "modify",
					fields: { "connection.autoconnect-priority": "999" },
					run: (fields) => f.deps.nmConnSetFields(uuid, fields),
				})
			).success,
		).toBe(true);
		await handleWifiMonitorEvent({
			type: "device-state",
			device: "wlan0",
			state: "connected",
		});
		expect(outcomes).toEqual([{ success: true }]);
	} finally {
		await f.restore();
	}
});

test("an owned modify keeps retained cleanup on the existing canonical receipt", async () => {
	const f = await firstAp();
	f.faults.upTimeout = f.faults.downFails = f.faults.deleteFails = true;
	resetBootReadiness();
	try {
		expect((await f.start()).success).toBe(false);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing retained profile");
		f.faults.upTimeout = f.faults.downFails = f.faults.deleteFails = false;
		expect(
			(
				await runHotspotProfileOperation({
					uuid,
					kind: "modify",
					fields: { "connection.autoconnect-priority": "999" },
					run: (fields) => f.deps.nmConnSetFields(uuid, fields),
				})
			).success,
		).toBe(true);
		f.observe(undefined, "ap");
		await withWifiAdapterLock(wifiAdapterLockKey(MAC), () =>
			reconcileWifiAdapterTeardownLocked(MAC),
		);
		expect(f.profiles.has(uuid)).toBe(false);
		expect(getPendingHotspotCreation(MAC)).toBeUndefined();
		expect(getBootReadiness().degraded).toBe(false);
	} finally {
		cancelWifiAdapterReconciliation();
		await f.restore();
		resetBootReadiness();
	}
});

for (const window of [
	"first-up",
	"retained-down",
	"policy-down",
	"retained-delete",
] as const) {
	test(`runtime ${window} never adopts an operator file restore`, async () => {
		const f = await firstAp();
		const modes = config.getConfig().wifi_modes;
		config.getConfig().wifi_modes = {};
		spyOn(config, "saveConfig").mockImplementation(() => undefined);
		f.deps.recordIntent = wifiAdapterModeRecorder;
		let restoredAt = -1;
		const restore = (uuid: string) => {
			restoreInPlace(f.nm.files.filename(uuid));
			restoredAt = f.commands.length;
		};
		if (window === "first-up") {
			f.faults.upTimeout = true;
			const up = f.deps.nmConnect;
			f.deps.nmConnect = async (uuid, timeout, activated) => {
				const result = await up(uuid, timeout, activated);
				restore(uuid);
				return result;
			};
		} else if (window === "retained-down" || window === "retained-delete") {
			f.faults.downFails = f.faults.deleteFails = true;
			const up = f.deps.nmConnect;
			f.deps.nmConnect = async (...args) => {
				await up(...args);
				return false;
			};
		} else {
			f.faults.upTimeout =
				f.faults.offFails =
				f.faults.downFails =
				f.faults.deleteFails =
					true;
		}
		resetBootReadiness();
		try {
			expect((await f.start()).success).toBe(false);
			const uuid = f.created();
			if (!uuid) throw new Error("Missing first AP");
			if (window === "retained-down") {
				resetBootReadiness();
				f.faults.deleteFails = false;
				const down = f.deps.nmDisconnect;
				f.deps.nmDisconnect = async (target, path) => {
					const result = await down(target, path);
					restore(target);
					return result;
				};
				await withWifiAdapterLock(wifiAdapterLockKey(MAC), () =>
					reconcileWifiAdapterTeardownLocked(MAC),
				);
			} else if (window === "retained-delete") {
				resetBootReadiness();
				f.faults.downFails = false;
				const remove = f.deps.nmConnDelete;
				f.deps.nmConnDelete = async (target) => {
					const result = await remove(target);
					restore(target);
					return result;
				};
				await withWifiAdapterLock(wifiAdapterLockKey(MAC), () =>
					reconcileWifiAdapterTeardownLocked(MAC),
				);
				f.faults.deleteFails = false;
				f.deps.nmConnDelete = remove;
				await withWifiAdapterLock(wifiAdapterLockKey(MAC), () =>
					reconcileWifiAdapterTeardownLocked(MAC),
				);
			} else if (window === "policy-down") {
				cancelWifiAdapterReconciliation();
				resetBootReadiness();
				f.faults.offFails = f.faults.downFails = f.faults.deleteFails = false;
				await f.armRetainedProfile();
				const down = nm.nmDisconnect;
				spyOn(nm, "nmDisconnect").mockImplementation(async (target) => {
					const result = await down(target);
					restore(target);
					return result;
				});
				await reconcileWifiAdapterPolicies({
					identities: wifiRadioIdentity.state.rows,
					active: new Map([["wlan0", uuid]]),
				});
			}
			if (restoredAt < 0) throw new Error("Restore window was not reached");
			expect(
				f.commands
					.slice(restoredAt)
					.filter((args) => ["modify", "down", "del"].includes(args[1] ?? "")),
			).toEqual([]);
			expect(f.profiles.has(uuid)).toBe(true);
			expect(getPendingHotspotCreation(MAC)).toBeUndefined();
			expect(getBootReadiness().degraded).toBe(true);
			if (window === "policy-down") expect(f.autoconnect.has(uuid)).toBe(true);
		} finally {
			cancelWifiAdapterReconciliation();
			config.getConfig().wifi_modes = modes;
			await f.restore();
			resetBootReadiness();
		}
	});
}
