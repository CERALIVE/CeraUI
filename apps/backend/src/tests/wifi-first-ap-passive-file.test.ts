import { expect, spyOn, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../modules/config.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import {
	getPendingHotspotCreation,
	getPendingHotspotCreationInstance,
	hotspotCredentialsStore,
	initHotspotCredentials,
	recordHotspotProfileCreation,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../modules/wifi/wifi-adapter-lock.ts";
import { wifiAdapterModeRecorder } from "../modules/wifi/wifi-adapter-mode.ts";
import {
	cancelWifiAdapterReconciliation,
	reconcileWifiAdapterTeardownLocked,
} from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";
import { replayFirstApState } from "./helpers/wifi-first-ap-instances.ts";

for (const attack of ["stale-receipt", "inplace-restore"] as const) {
	test(`startup preserves passive same-run ${attack} without an owned write`, async () => {
		const f = await firstAp();
		const modes = config.getConfig().wifi_modes;
		const dir = await mkdtemp(join(tmpdir(), "first-ap-passive-"));
		const path = join(dir, "hotspot_credentials.json");
		config.getConfig().wifi_modes = {};
		spyOn(config, "saveConfig").mockImplementation(() => undefined);
		await initHotspotCredentials(path);
		rememberHotspotCredentials(MAC, { ssid: "First AP", password: f.secret });
		f.deps.credentials = hotspotCredentialsStore;
		f.deps.recordIntent = wifiAdapterModeRecorder;
		f.faults.upTimeout =
			f.faults.offFails =
			f.faults.downFails =
			f.faults.deleteFails =
				true;
		try {
			expect(await f.start()).toEqual({
				success: false,
				error: "activation-failed",
				reason: "cleanup-pending",
			});
			const uuid = f.created();
			await f.armRetainedProfile();
			const receipt = getPendingHotspotCreationInstance(MAC);
			if (!uuid || !receipt?.file)
				throw new Error("Missing persisted creation receipt");
			if (attack === "stale-receipt") {
				if (
					!recordHotspotProfileCreation(MAC, uuid, {
						...receipt,
						file: {
							filename: `${receipt.file.filename}.prior`,
							device: String(BigInt(receipt.file.device) - 1n),
							inode: String(BigInt(receipt.file.inode) - 1n),
							ctime: String(BigInt(receipt.file.ctime) - 1n),
						},
					})
				)
					throw new Error("Could not seed stale reviewer receipt");
			}
			const store: unknown = JSON.parse(await readFile(path, "utf8"));
			if (attack === "inplace-restore") {
				const filename = f.nm.files.filename(uuid);
				const before = statSync(filename, { bigint: true });
				writeFileSync(filename, readFileSync(filename));
				const after = statSync(filename, { bigint: true });
				expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
				expect(after.ctimeNs === before.ctimeNs).toBe(false);
			}
			expect(
				await replayFirstApState({
					uuid,
					settings: [...f.settings],
					autoconnect: [...f.autoconnect],
					store,
					nmRun: f.nm.run(),
					reportAuthority: true,
				}),
			).toEqual({
				result: true,
				active: uuid,
				autoconnect: true,
				preserved: true,
				owned: true,
				intent: null,
				deleted: false,
				pending: null,
				mutations: [],
				degraded: true,
			});
		} finally {
			cancelWifiAdapterReconciliation();
			config.getConfig().wifi_modes = modes;
			await f.restore();
			await rm(dir, { recursive: true, force: true });
		}
	});
}

for (const attack of ["file-replacement", "inplace-restore"] as const) {
	test(`retained pre-action check preserves a passive same-run ${attack}`, async () => {
		const f = await firstAp();
		f.faults.upTimeout = f.faults.downFails = f.faults.deleteFails = true;
		f.faults.offFails = attack === "file-replacement";
		try {
			expect((await f.start()).success).toBe(false);
			const uuid = f.created();
			if (!uuid) throw new Error("Missing retained first AP");
			if (attack === "file-replacement") f.nm.files.write(uuid);
			else {
				const filename = f.nm.files.filename(uuid);
				const before = statSync(filename, { bigint: true });
				writeFileSync(filename, readFileSync(filename));
				const after = statSync(filename, { bigint: true });
				expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
				expect(after.ctimeNs === before.ctimeNs).toBe(false);
			}
			f.faults.upTimeout =
				f.faults.offFails =
				f.faults.downFails =
				f.faults.deleteFails =
					false;
			resetBootReadiness();
			const checkpoint = f.commands.length;
			await withWifiAdapterLock(wifiAdapterLockKey(MAC), () =>
				reconcileWifiAdapterTeardownLocked(MAC),
			);
			expect(
				f.commands
					.slice(checkpoint)
					.filter((args) => ["modify", "down", "del"].includes(args[1] ?? "")),
			).toEqual([]);
			expect(f.profiles.has(uuid)).toBe(true);
			expect(f.active()).toBe(uuid);
			expect(getPendingHotspotCreation(MAC)).toBeUndefined();
			expect(getBootReadiness().degraded).toBe(true);
		} finally {
			cancelWifiAdapterReconciliation();
			await f.restore();
			resetBootReadiness();
		}
	});
}
