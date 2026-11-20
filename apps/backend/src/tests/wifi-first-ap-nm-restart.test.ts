import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../modules/config.ts";
import {
	hotspotCredentialsStore,
	initHotspotCredentials,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import { wifiAdapterModeRecorder } from "../modules/wifi/wifi-adapter-mode.ts";
import { cancelWifiAdapterReconciliation } from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import { wifiHotspotStop } from "../modules/wifi/wifi-hotspot-config.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";
import { replayFirstApState } from "./helpers/wifi-first-ap-instances.ts";

for (const busRestart of [false, true]) {
	test(`startup recovers our failed AP after NM renumbering, bus restart=${busRestart}`, async () => {
		const f = await firstAp();
		const modes = config.getConfig().wifi_modes;
		const dir = await mkdtemp(join(tmpdir(), "first-ap-nm-run-"));
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
			expect(
				await replayFirstApState({
					uuid,
					settings: [...f.settings],
					autoconnect: [...f.autoconnect],
					store,
					nmRun: f.nm.run(),
					nmRestart: true,
					busRestart,
				}),
			).toEqual({
				result: true,
				active: null,
				autoconnect: false,
				preserved: true,
				owned: true,
				intent: null,
				deleted: false,
			});
		} finally {
			cancelWifiAdapterReconciliation();
			config.getConfig().wifi_modes = modes;
			await f.restore();
			await rm(dir, { recursive: true, force: true });
		}
	});
}

test("pending cleanup Stop disconnects our AP after an in-process NM restart", async () => {
	const f = await firstAp();
	const modes = config.getConfig().wifi_modes;
	config.getConfig().wifi_modes = {};
	spyOn(config, "saveConfig").mockImplementation(() => undefined);
	f.faults.upTimeout = f.faults.downFails = f.faults.deleteFails = true;
	try {
		expect((await f.start()).success).toBe(false);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing failed first AP");
		f.nm.restart();
		f.faults.upTimeout = f.faults.downFails = f.faults.deleteFails = false;
		expect(await wifiHotspotStop({ device: 0 })).toEqual({ success: true });
		expect(f.active()).toBeUndefined();
		expect(f.profiles.has(uuid)).toBe(false);
		expect(f.commands.filter((args) => args[1] === "down")).toHaveLength(2);
	} finally {
		cancelWifiAdapterReconciliation();
		config.getConfig().wifi_modes = modes;
		await f.restore();
	}
});

for (const attack of [
	"same-run-clone",
	"next-run-replacement",
	"reanchored-clone",
] as const) {
	test(`NM run comparison preserves the operator's ${attack}`, async () => {
		const f = await firstAp();
		const modes = config.getConfig().wifi_modes;
		const dir = await mkdtemp(join(tmpdir(), "first-ap-nm-replacement-"));
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
			expect((await f.start()).success).toBe(false);
			const uuid = f.created();
			if (!uuid) throw new Error("Missing first AP");
			await f.armRetainedProfile();
			const store: unknown = JSON.parse(await readFile(path, "utf8"));
			expect(
				await replayFirstApState({
					uuid,
					settings: [...f.settings],
					autoconnect: [...f.autoconnect],
					store,
					nmRun: f.nm.run(),
					nmRestart: attack !== "same-run-clone",
					replacement:
						attack === "next-run-replacement"
							? "settings-path"
							: "same-settings",
					reanchorThenReplace: attack === "reanchored-clone",
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
			});
		} finally {
			cancelWifiAdapterReconciliation();
			config.getConfig().wifi_modes = modes;
			await f.restore();
			await rm(dir, { recursive: true, force: true });
		}
	});
}
