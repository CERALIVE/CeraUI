import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../modules/config.ts";
import {
	hotspotCredentialsStore,
	initHotspotCredentials,
	recordHotspotProfileCreation,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import { wifiAdapterModeRecorder } from "../modules/wifi/wifi-adapter-mode.ts";
import { cancelWifiAdapterReconciliation } from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";
import { replayFirstApState } from "./helpers/wifi-first-ap-instances.ts";

test("an unpersisted creation-instance binding cannot reach activation", async () => {
	const f = await firstAp();
	rememberHotspotCredentials(MAC, { ssid: "First AP", password: f.secret });
	f.deps.credentials = {
		...hotspotCredentialsStore,
		recordCreation: (owner, uuid, instance) =>
			instance ? false : recordHotspotProfileCreation(owner, uuid),
	};
	try {
		expect(await f.start()).toEqual({
			success: false,
			error: "activation-failed",
		});
		expect(f.commands.some((args) => args.includes("up"))).toBe(false);
		expect(f.profiles.has(f.created() ?? "")).toBe(false);
	} finally {
		cancelWifiAdapterReconciliation();
		await f.restore();
	}
});

for (const replacement of ["settings-path", "settings-fingerprint"] as const) {
	test(`persisted first-start authority drops a replacement with changed ${replacement}`, async () => {
		const f = await firstAp();
		const modes = config.getConfig().wifi_modes;
		const dir = await mkdtemp(join(tmpdir(), "first-ap-instance-"));
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
			if (!uuid) throw new Error("Missing failed first-start UUID");
			await f.armRetainedProfile();
			const store: unknown = JSON.parse(await readFile(path, "utf8"));
			expect(
				await replayFirstApState({
					uuid,
					settings: [...f.settings],
					autoconnect: [...f.autoconnect],
					store,
					replacement,
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
