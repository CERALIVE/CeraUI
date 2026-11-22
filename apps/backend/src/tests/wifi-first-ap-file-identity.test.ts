import { expect, spyOn, test } from "bun:test";
import { rmSync, statSync, writeFileSync } from "node:fs";
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
	hotspotCredentialsStore,
	initHotspotCredentials,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import { wifiAdapterModeRecorder } from "../modules/wifi/wifi-adapter-mode.ts";
import { cancelWifiAdapterReconciliation } from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import { wifiHotspotStop } from "../modules/wifi/wifi-hotspot-config.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";
import { replayFirstApState } from "./helpers/wifi-first-ap-instances.ts";

for (const attack of [
	"identical-replacement",
	"restored-in-place",
	"unreadable-file",
	"unreadable-run",
] as const) {
	test(`startup preserves ${attack} across NM runs and exposes authority loss`, async () => {
		const f = await firstAp();
		const modes = config.getConfig().wifi_modes;
		const dir = await mkdtemp(join(tmpdir(), "first-ap-file-"));
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
			if (!uuid) throw new Error("Missing failed first AP");
			await f.armRetainedProfile();
			const store: unknown = JSON.parse(await readFile(path, "utf8"));
			const filename = f.nm.files.filename(uuid);
			if (attack === "unreadable-file") rmSync(filename);
			if (attack === "restored-in-place") {
				const before = statSync(filename, { bigint: true });
				writeFileSync(filename, "operator restored copy");
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
					nmRestart: true,
					reportAuthority: true,
					unreadableRun: attack === "unreadable-run",
					...(attack === "identical-replacement"
						? { replacement: "same-settings" }
						: {}),
				}),
			).toEqual({
				result: attack !== "unreadable-run",
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

for (const phase of ["retained", "up-to-cleanup"] as const) {
	test(`${phase} cleanup never acts on an identical operator replacement after NM restart`, async () => {
		const f = await firstAp();
		const modes = config.getConfig().wifi_modes;
		config.getConfig().wifi_modes = {};
		resetBootReadiness();
		spyOn(config, "saveConfig").mockImplementation(() => undefined);
		const cleanupActions: string[] = [];
		let trace = false;
		const {
			nmConnSetFields: set,
			nmDisconnect: down,
			nmConnDelete: del,
		} = f.deps;
		f.deps.nmConnSetFields = async (uuid, fields) => {
			if (trace) cleanupActions.push("off");
			return set(uuid, fields);
		};
		f.deps.nmDisconnect = async (...args) => {
			if (trace) cleanupActions.push("down");
			return down(...args);
		};
		f.deps.nmConnDelete = async (uuid) => {
			if (trace) cleanupActions.push("delete");
			return del(uuid);
		};
		const replace = (uuid: string) => {
			f.nm.restart();
			f.replace(uuid, "First AP");
			const fields = f.settings.get(uuid);
			if (fields) fields["connection.id"] = "Operator restored AP";
			trace = true;
		};
		f.faults.upTimeout = true;
		if (phase === "retained") f.faults.downFails = f.faults.deleteFails = true;
		else {
			const connect = f.deps.nmConnect;
			f.deps.nmConnect = async (uuid, timeout, activated) => {
				const result = await connect(uuid, timeout, activated);
				replace(uuid);
				return result;
			};
		}
		try {
			expect((await f.start()).success).toBe(false);
			const uuid = f.created();
			if (!uuid) throw new Error("Missing first AP");
			if (phase === "retained") {
				resetBootReadiness();
				replace(uuid);
				f.faults.upTimeout = f.faults.downFails = f.faults.deleteFails = false;
				await wifiHotspotStop({ device: 0 });
			}
			expect(cleanupActions).toEqual([]);
			expect(f.profiles.has(uuid)).toBe(true);
			expect(getPendingHotspotCreation(MAC)).toBeUndefined();
			expect(getBootReadiness().degraded).toBe(true);
		} finally {
			cancelWifiAdapterReconciliation();
			config.getConfig().wifi_modes = modes;
			await f.restore();
			resetBootReadiness();
		}
	});
}

test("NM restart between our lost write and readback drops authority without cleanup", async () => {
	const f = await firstAp();
	const modes = config.getConfig().wifi_modes;
	config.getConfig().wifi_modes = {};
	spyOn(config, "saveConfig").mockImplementation(() => undefined);
	f.deps.recordIntent = wifiAdapterModeRecorder;
	const set = f.deps.nmConnSetFields;
	let committedAt = -1;
	f.deps.nmConnSetFields = async (uuid, fields) => {
		const result = await set(uuid, fields);
		if (fields["connection.autoconnect"] === "yes") {
			committedAt = f.commands.length;
			f.nm.restart();
		}
		return result;
	};
	f.faults.autoconnectTimeout = true;
	resetBootReadiness();
	try {
		expect((await f.start()).success).toBe(false);
		const uuid = f.created();
		if (!uuid || committedAt < 0) throw new Error("Missing committed write");
		expect(
			f.commands
				.slice(committedAt)
				.filter((args) => ["modify", "down", "del"].includes(args[1] ?? "")),
		).toEqual([]);
		expect(getPendingHotspotCreation(MAC)).toBeUndefined();
		expect(f.active()).toBe(uuid);
		expect(f.autoconnect.has(uuid)).toBe(true);
		expect(getBootReadiness().degraded).toBe(true);
	} finally {
		cancelWifiAdapterReconciliation();
		config.getConfig().wifi_modes = modes;
		await f.restore();
		resetBootReadiness();
	}
});
