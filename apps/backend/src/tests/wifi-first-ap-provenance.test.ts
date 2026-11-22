import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../helpers/config-loader.ts";
import { getConfig } from "../modules/config.ts";
import {
	getPendingHotspotCreation,
	hotspotCredentialsStore,
	initHotspotCredentials,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import { wifiAdapterModeRecorder } from "../modules/wifi/wifi-adapter-mode.ts";
import { cancelWifiAdapterReconciliation } from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import { reconcileWifiAdapterPolicies } from "../modules/wifi/wifi-adapter-reconciler.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";
import { replayFirstApState as replay } from "./helpers/wifi-first-ap-instances.ts";

for (const completion of ["confirmation", "cleanup"] as const) {
	test(`creation UUID is durable before add and retired after ${completion}`, async () => {
		const f = await firstAp(completion === "cleanup" ? "up" : undefined);
		const dir = await mkdtemp(join(tmpdir(), "first-ap-write-"));
		const path = join(dir, "hotspot_credentials.json");
		await initHotspotCredentials(path);
		rememberHotspotCredentials(MAC, { ssid: "First AP", password: f.secret });
		f.deps.credentials = hotspotCredentialsStore;
		let observed = false;
		f.faults.beforeAdd = async () => {
			const saved: {
				version: number;
				adapters: Record<string, { pendingCreation?: string }>;
			} = JSON.parse(await readFile(path, "utf8"));
			expect(saved.version).toBe(2);
			expect(saved.adapters[MAC]?.pendingCreation).toBe(f.created());
			expect(f.profiles.has(f.created() ?? "")).toBe(false);
			observed = true;
		};
		try {
			expect((await f.start()).success).toBe(completion === "confirmation");
			expect(observed).toBe(true);
			if (completion === "confirmation") settlePending("wlan0", true);
			expect(getPendingHotspotCreation(MAC)).toBeUndefined();
			const saved: {
				version: number;
				adapters: Record<string, { pendingCreation?: string }>;
			} = JSON.parse(await readFile(path, "utf8"));
			expect(saved.version).toBe(2);
			expect(saved.adapters[MAC]?.pendingCreation).toBeUndefined();
		} finally {
			cancelWifiAdapterReconciliation();
			await f.restore();
			await rm(dir, { recursive: true, force: true });
		}
	});
}

test("a refused creation-record write dispatches no add or activation", async () => {
	const f = await firstAp();
	const dir = await mkdtemp(join(tmpdir(), "first-ap-write-failure-"));
	await initHotspotCredentials(join(dir, "hotspot_credentials.json"));
	rememberHotspotCredentials(MAC, { ssid: "First AP", password: f.secret });
	f.deps.credentials = hotspotCredentialsStore;
	spyOn(configLoader, "writeFileAtomicSync").mockImplementation(() => {
		throw new Error("Fixture disk full");
	});
	try {
		expect(await f.start()).toEqual({
			success: false,
			error: "activation-failed",
		});
		expect(f.commands).toEqual([]);
		expect(getPendingHotspotCreation(MAC)).toBeUndefined();
	} finally {
		cancelWifiAdapterReconciliation();
		await f.restore();
		await rm(dir, { recursive: true, force: true });
	}
});

test("observing an operator AP cannot create ownership or first-start provenance", async () => {
	const f = await firstAp();
	const uuid = "22222222-2222-4222-8222-222222222222";
	try {
		const fields = {
			"connection.id": "CeraLive Hotspot",
			"802-11-wireless.mode": "ap",
			"802-11-wireless.ssid": "Operator AP",
			"802-11-wireless-security.psk": "operator-fixture-password",
			"802-11-wireless.mac-address": MAC,
			"connection.interface-name": "",
			"connection.autoconnect": "yes",
			"connection.autoconnect-priority": "999",
			"match.path": wifiRadioIdentity.state.rows.get("wlan0")?.devicePath ?? "",
		};
		expect(
			await replay({
				uuid,
				settings: [[uuid, fields]],
				autoconnect: [uuid],
				operator: true,
			}),
		).toEqual({
			result: true,
			active: uuid,
			autoconnect: true,
			preserved: true,
			owned: false,
			intent: null,
			deleted: false,
		});
	} finally {
		await f.restore();
	}
});

test("a renamed failed first start retains creation evidence across restart", async () => {
	const f = await firstAp();
	const modes = getConfig().wifi_modes;
	const dir = await mkdtemp(join(tmpdir(), "first-ap-creation-"));
	const path = join(dir, "hotspot_credentials.json");
	getConfig().wifi_modes = {};
	spyOn(wifiAdapterModeRecorder, "persist").mockImplementation(
		(owner, mode) => {
			getConfig().wifi_modes = { ...getConfig().wifi_modes, [owner]: mode };
		},
	);
	spyOn(wifiAdapterModeRecorder, "restore").mockImplementation(
		(owner, mode) => {
			const next = { ...getConfig().wifi_modes };
			if (mode === undefined) delete next[owner];
			else next[owner] = mode;
			getConfig().wifi_modes = next;
		},
	);
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
		if (!uuid) throw new Error("Missing first-start UUID");
		const profile = f.settings.get(uuid);
		if (!profile) throw new Error("Missing first-start settings");
		profile["connection.id"] = "Weekend AP";
		await reconcileWifiAdapterPolicies({
			identities: wifiRadioIdentity.state.rows,
			active: new Map([["wlan0", uuid]]),
		});
		const store: unknown = JSON.parse(await readFile(path, "utf8"));
		expect(
			await replay({
				uuid,
				settings: [...f.settings],
				autoconnect: [...f.autoconnect],
				store,
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
		getConfig().wifi_modes = modes;
		await f.restore();
		await rm(dir, { recursive: true, force: true });
	}
});
