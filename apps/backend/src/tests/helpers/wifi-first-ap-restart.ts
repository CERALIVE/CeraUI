import { spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../../modules/config.ts";
import { getBootReadiness } from "../../modules/system/readiness.ts";
import {
	getHotspotCredentials,
	getPendingHotspotCreation,
	initHotspotCredentials,
	rememberHotspotCredentials,
} from "../../modules/wifi/hotspot-credentials.ts";
import { wifiUpdateSavedConns } from "../../modules/wifi/wifi.ts";
import {
	getPersistedWifiAdapterMode,
	wifiAdapterModeRecorder,
} from "../../modules/wifi/wifi-adapter-mode.ts";
import { cancelWifiAdapterReconciliation } from "../../modules/wifi/wifi-adapter-reconcile-retry.ts";
import { reconcileWifiAdapterPolicies } from "../../modules/wifi/wifi-adapter-reconciler.ts";
import { wifiRadioIdentity } from "../../modules/wifi/wifi-radio-identity.ts";
import { firstAp, MAC } from "./wifi-first-ap-fixture.ts";

test("replay persisted first-start NM state", async () => {
	const persistent: {
		uuid: string;
		settings: Array<[string, Record<string, string>]>;
		autoconnect: string[];
		legacy?: boolean;
		operator?: boolean;
		store?: unknown;
		profilePaths?: string[][];
		profileFiles?: string[][];
		replacement?: "settings-path" | "settings-fingerprint" | "same-settings";
		nmRun?: { bus: number; owner: number };
		nmRestart?: boolean;
		busRestart?: boolean;
		reanchorThenReplace?: boolean;
		reportAuthority?: boolean;
		unreadableRun?: boolean;
	} = JSON.parse(await Bun.stdin.text());
	const f = await firstAp();
	const dir = await mkdtemp(join(tmpdir(), "first-ap-restart-"));
	try {
		getConfig().wifi_modes = {};
		spyOn(wifiAdapterModeRecorder, "persist").mockImplementation(
			(owner, mode) => {
				getConfig().wifi_modes = { ...getConfig().wifi_modes, [owner]: mode };
			},
		);
		for (const [uuid, fields] of persistent.settings) {
			f.profiles.add(uuid);
			f.settings.set(uuid, fields);
		}
		if (persistent.profilePaths) f.restoreProfilePaths(persistent.profilePaths);
		if (persistent.profileFiles) f.nm.files.restore(persistent.profileFiles);
		if (persistent.nmRun) f.nm.restoreRun(persistent.nmRun);
		if (persistent.nmRestart) f.nm.restart(persistent.busRestart);
		const profile = f.settings.get(persistent.uuid);
		if (persistent.legacy && profile) profile["connection.id"] = "Hotspot";
		for (const uuid of persistent.autoconnect) f.autoconnect.add(uuid);
		f.observe(persistent.uuid, "ap");
		if (persistent.store) {
			const path = join(dir, "hotspot_credentials.json");
			await Bun.write(path, JSON.stringify(persistent.store));
			await initHotspotCredentials(path);
		} else if (!persistent.operator) {
			rememberHotspotCredentials(MAC, {
				ssid: "First AP",
				password: "restart-fixture-password",
				conn: persistent.uuid,
			});
		}
		if (persistent.replacement && !persistent.reanchorThenReplace)
			f.replace(
				persistent.uuid,
				persistent.replacement === "same-settings" ? "First AP" : "Operator AP",
				persistent.replacement !== "settings-fingerprint",
			);
		if (
			persistent.reportAuthority &&
			persistent.replacement === "same-settings" &&
			profile
		)
			profile["connection.id"] = "Operator restored AP";
		await wifiUpdateSavedConns();
		if (persistent.unreadableRun)
			spyOn(f.nm, "busReply").mockReturnValue("unreadable");
		if (persistent.reanchorThenReplace) {
			getConfig().wifi_modes = { [MAC]: "hotspot" };
			await reconcileWifiAdapterPolicies({
				identities: wifiRadioIdentity.state.rows,
				active: new Map([["wlan0", persistent.uuid]]),
			});
			getConfig().wifi_modes = {};
			f.replace(persistent.uuid, "First AP");
			await wifiUpdateSavedConns();
		}
		const result = await reconcileWifiAdapterPolicies({
			identities: wifiRadioIdentity.state.rows,
			active: new Map([["wlan0", persistent.uuid]]),
		});
		if (persistent.reportAuthority)
			await reconcileWifiAdapterPolicies({
				identities: wifiRadioIdentity.state.rows,
				active: new Map([["wlan0", f.active() ?? null]]),
			});
		process.stdout.write(
			`${JSON.stringify({
				result,
				active: f.active() ?? null,
				autoconnect: f.autoconnect.has(persistent.uuid),
				preserved: f.profiles.has(persistent.uuid),
				owned: getHotspotCredentials(MAC)?.conn === persistent.uuid,
				intent: getPersistedWifiAdapterMode(MAC) ?? null,
				deleted: f.commands.some((args) => args[1] === "del"),
				...(persistent.reportAuthority
					? { degraded: getBootReadiness().degraded }
					: {}),
				...(persistent.replacement || persistent.reportAuthority
					? {
							pending: getPendingHotspotCreation(MAC) ?? null,
							mutations: f.commands
								.filter((args) =>
									["modify", "down", "del"].includes(args[1] ?? ""),
								)
								.map((args) => args.slice(0, 3)),
						}
					: {}),
			})}\n`,
		);
	} finally {
		cancelWifiAdapterReconciliation();
		await f.restore();
		await rm(dir, { recursive: true, force: true });
	}
});
