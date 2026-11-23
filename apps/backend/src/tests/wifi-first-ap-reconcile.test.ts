import { expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import * as clock from "../helpers/time.ts";
import { getConfig } from "../modules/config.ts";
import {
	nmConnsGet,
	nmcliParseSep,
} from "../modules/network/network-manager.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import {
	getHotspotCredentials,
	getPendingHotspotCreation,
	getPendingHotspotCreationInstance,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../modules/wifi/wifi-adapter-lock.ts";
import {
	getPersistedWifiAdapterMode,
	wifiAdapterModeRecorder,
} from "../modules/wifi/wifi-adapter-mode.ts";
import { cancelWifiAdapterReconciliation } from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import { reconcileWifiAdapterPolicies } from "../modules/wifi/wifi-adapter-reconciler.ts";
import {
	defaultHotspotStopDeps,
	wifiHotspotStop,
} from "../modules/wifi/wifi-hotspot-config.ts";
import * as interfaces from "../modules/wifi/wifi-interfaces.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { firstAp, MAC, OTHER_UUID } from "./helpers/wifi-first-ap-fixture.ts";

for (const remaining of ["none", "delete", "down"] as const) {
	test(`Stop consumes first-start cleanup with ${remaining} still unavailable`, async () => {
		const f = await firstAp();
		const modes = getConfig().wifi_modes;
		getConfig().wifi_modes = {};
		spyOn(wifiAdapterModeRecorder, "persist").mockImplementation(
			(owner, mode) => {
				getConfig().wifi_modes = { ...getConfig().wifi_modes, [owner]: mode };
			},
		);
		resetBootReadiness();
		f.faults.upTimeout = f.faults.downFails = f.faults.deleteFails = true;
		try {
			expect(await f.start()).toEqual({
				success: false,
				error: "activation-failed",
				reason: "cleanup-pending",
			});
			const uuid = f.created();
			if (!uuid) throw new Error("Missing first-start UUID");
			expect(f.active()).toBe(uuid);
			expect(f.row.conn).toBeNull();
			f.faults.downFails = remaining === "down";
			f.faults.deleteFails = remaining !== "none";
			const result = await wifiHotspotStop(
				{ device: 0 },
				{
					...defaultHotspotStopDeps,
					broadcastState: () => undefined,
					setDupIpSuppression: () => undefined,
					releaseConcurrentInterface: async () => true,
					rescan: async () => undefined,
				},
			);
			expect(result).toEqual(
				remaining === "down"
					? { success: false, error: "deactivation-failed" }
					: { success: true },
			);
			expect(f.active() ?? null).toBe(remaining === "down" ? uuid : null);
			expect(getPersistedWifiAdapterMode(MAC) ?? null).toBe(
				remaining === "down" ? null : "station",
			);
			expect(f.profiles.has(OTHER_UUID)).toBe(true);
			expect(getBootReadiness().degraded).toBe(remaining !== "none");
		} finally {
			f.faults.downFails = f.faults.deleteFails = false;
			await wifiHotspotStop({ device: 0 });
			cancelWifiAdapterReconciliation();
			getConfig().wifi_modes = modes;
			resetBootReadiness();
			await f.restore();
		}
	});
}

test("retained cleanup shares Stop's owner lock and five-minute discovery retry budget", async () => {
	const f = await firstAp();
	let now = 0;
	let retries = 0;
	spyOn(clock, "getms").mockImplementation(() => now);
	spyOn(interfaces, "scheduleWifiDiscoveryRetry").mockImplementation(() => {
		retries++;
	});
	cancelWifiAdapterReconciliation();
	f.faults.upTimeout = f.faults.downFails = f.faults.deleteFails = true;
	try {
		expect((await f.start()).success).toBe(false);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing retained UUID");
		rememberHotspotCredentials(MAC, {
			ssid: "First AP",
			password: f.secret,
			conn: uuid,
		});
		const before = f.commands.length;
		await withWifiAdapterLock(wifiAdapterLockKey(MAC), async () => {
			expect(await wifiHotspotStop({ device: 0 })).toEqual({
				success: false,
				error: "DEVICE_BUSY",
			});
		});
		expect(f.commands).toHaveLength(before);
		const observation = {
			identities: wifiRadioIdentity.state.rows,
			active: new Map([["wlan0", uuid]]),
		};
		expect(await reconcileWifiAdapterPolicies(observation)).toBe(false);
		const scheduled = retries;
		now = 5 * 60 * 1000;
		expect(await reconcileWifiAdapterPolicies(observation)).toBe(false);
		expect(retries).toBe(scheduled);
		f.faults.downFails = f.faults.deleteFails = false;
		expect(await reconcileWifiAdapterPolicies(observation)).toBe(false);
		expect(f.active()).toBe(uuid);
		expect(f.profiles.has(uuid)).toBe(true);
		expect(f.commands.filter((args) => args[1] === "add")).toHaveLength(1);
	} finally {
		cancelWifiAdapterReconciliation();
		resetBootReadiness();
		await f.restore();
	}
});

test("startup disarms failed first-start provenance while preserving legacy missing intent", async () => {
	const f = await firstAp();
	const modes = getConfig().wifi_modes;
	getConfig().wifi_modes = {};
	spyOn(wifiAdapterModeRecorder, "persist").mockImplementation(
		(owner, mode) => {
			getConfig().wifi_modes = { ...getConfig().wifi_modes, [owner]: mode };
		},
	);
	spyOn(wifiAdapterModeRecorder, "restore").mockImplementation(
		(owner, previous) => {
			const next = { ...getConfig().wifi_modes };
			if (previous === undefined) delete next[owner];
			else next[owner] = previous;
			getConfig().wifi_modes = next;
		},
	);
	f.deps.recordIntent = wifiAdapterModeRecorder;
	f.faults.upTimeout = true;
	f.faults.offFails = f.faults.downFails = f.faults.deleteFails = true;
	try {
		expect(await f.start()).toEqual({
			success: false,
			error: "activation-failed",
			reason: "cleanup-pending",
		});
		const uuid = f.created();
		if (!uuid) throw new Error("Missing persisted first-start UUID");
		await f.armRetainedProfile();
		expect(f.active()).toBe(uuid);
		expect(f.autoconnect.has(uuid)).toBe(true);
		expect(getPersistedWifiAdapterMode(MAC)).toBeUndefined();
		const profilePaths = (await nmConnsGet("uuid,dbus-path"))
			?.filter(Boolean)
			.map(nmcliParseSep);
		const profileFiles = (await nmConnsGet("uuid,filename"))
			?.filter(Boolean)
			.map(nmcliParseSep);
		for (const legacy of [false, true]) {
			const child = Bun.spawn(
				[
					process.execPath,
					"test",
					"--timeout",
					"15000",
					"./apps/backend/src/tests/helpers/wifi-first-ap-restart.ts",
				],
				{
					cwd: resolve(import.meta.dir, "../../../.."),
					env: process.env,
					stdin: new Response(
						JSON.stringify({
							uuid,
							settings: [...f.settings],
							autoconnect: [...f.autoconnect],
							legacy,
							profilePaths,
							profileFiles,
							store: {
								version: 2,
								adapters: {
									[MAC]: {
										...getHotspotCredentials(MAC),
										...(!legacy
											? {
													pendingCreation: getPendingHotspotCreation(MAC),
													pendingCreationInstance:
														getPendingHotspotCreationInstance(MAC),
												}
											: {}),
									},
								},
							},
						}),
					),
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const stdout = await new Response(child.stdout).text();
			const diagnostic = await new Response(child.stderr).text();
			if ((await child.exited) !== 0)
				throw new Error(diagnostic.replaceAll(f.secret, "<redacted>"));
			const result: unknown = JSON.parse(
				stdout.trim().split("\n").at(-1) ?? "",
			);
			expect(await child.exited).toBe(0);
			expect(result).toEqual({
				result: true,
				active: legacy ? uuid : null,
				autoconnect: legacy,
				preserved: true,
				owned: !legacy,
				intent: null,
				deleted: false,
			});
		}
	} finally {
		f.faults.offFails = f.faults.downFails = f.faults.deleteFails = false;
		await wifiHotspotStop({ device: 0 });
		cancelWifiAdapterReconciliation();
		getConfig().wifi_modes = modes;
		resetBootReadiness();
		await f.restore();
	}
});
