import { expect, spyOn, test } from "bun:test";
import type { WifiMessage } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { rememberHotspotCredentials } from "../modules/wifi/hotspot-credentials.ts";
import { broadcastWifiState, wifiBuildMsg } from "../modules/wifi/wifi.ts";
import { defaultAdapterModeDeps } from "../modules/wifi/wifi-adapter-mode-deps.ts";
import {
	cancelWifiAdapterReconciliation,
	registerWifiAdapterTeardownLocked,
} from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import { defaultHotspotStopDeps } from "../modules/wifi/wifi-hotspot-config.ts";
import { handleHotspotConn } from "../modules/wifi/wifi-hotspot-discovery.ts";
import {
	beginHotspotTransition,
	settlePending,
} from "../modules/wifi/wifi-hotspot-monitor.ts";
import { holdWifiModeWitness } from "../modules/wifi/wifi-mode-witness.ts";
import { suspendWifiRadioRow } from "../modules/wifi/wifi-radio-publication.ts";
import * as compat from "../rpc/compat.ts";
import { setWifiAdapterModeProcedure } from "../rpc/procedures/wifi.procedure.ts";
import { MAC, OTHER_UUID } from "./helpers/wifi-first-ap-fixture.ts";
import { isolateTransition } from "./helpers/wifi-transition-fixture.ts";

test.each([false, true])(
	"Hybrid to Hotspot keeps the original prior across renewal, publication withheld=%s",
	async (withheld) => {
		const f = await isolateTransition(true);
		const defaults = { ...defaultHotspotDeps };
		let restorePublication: (() => void) | undefined;
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<{ complete: true; stopped: true }>();
		try {
			const uuid = await f.startAccepted();
			settlePending(f.row.ifname, true);
			expect(wifiBuildMsg()[0]?.observed_mode).toBe("hybrid");
			Object.assign(defaultHotspotDeps, f.deps, {
				preferConcurrentAp: () => false,
				broadcastState: broadcastWifiState,
			});
			delete defaultHotspotDeps.pollHotspotActive;
			spyOn(
				defaultHotspotStopDeps,
				"releaseConcurrentInterface",
			).mockResolvedValue(true);
			spyOn(defaultHotspotStopDeps, "rescan").mockResolvedValue(undefined);
			spyOn(defaultAdapterModeDeps, "persistMode").mockImplementation(() => {});
			spyOn(defaultAdapterModeDeps, "readPersistedMode").mockReturnValue(
				undefined,
			);
			spyOn(compat, "broadcastMsg").mockImplementation((type, payload) => {
				f.collect("normal", type, payload);
				if (type === "wifi") {
					const { adapter_mode: mode }: WifiMessage = JSON.parse(
						JSON.stringify(payload),
					);
					if (mode) {
						f.peer.push(["mode", mode, wifiBuildMsg()[0]?.leaving]);
						if (withheld && "pending" in mode) {
							restorePublication = suspendWifiRadioRow(f.row);
							expect(wifiBuildMsg()[0]?.incarnation).toBeUndefined();
						}
					}
				}
			});
			f.peer.length = 0;
			registerWifiAdapterTeardownLocked(MAC, () => {
				entered.resolve();
				return resume.promise;
			});
			const change = call(
				setWifiAdapterModeProcedure,
				{ device: String(f.row.id), mode: "hotspot", incarnation: f.before },
				{ context: f.context },
			);
			try {
				expect(
					await Promise.race([
						entered.promise.then(() => "between legs"),
						change,
					]),
				).toBe("between legs");
				expect(f.active()).toBeUndefined();
				if (withheld) {
					expect(wifiBuildMsg()[0]?.leaving).toBeUndefined();
					restorePublication?.();
					expect(wifiBuildMsg()[0]?.incarnation).toBe(f.before);
				}
				expect(wifiBuildMsg()[0]?.leaving).toBe("hybrid");
				const before = f.row.hotspot;
				const fields = f.settings.get(uuid);
				if (!fields) throw new Error("Missing old Hybrid profile");
				const foreign = "dc:a6:32:aa:bb:ff";
				rememberHotspotCredentials(foreign, {
					ssid: "Foreign AP",
					password: "foreign-password",
				});
				fields["802-11-wireless.mac-address"] = foreign;
				await handleHotspotConn(MAC, uuid);
				expect(f.row.hotspot).not.toBe(before);
				expect(wifiBuildMsg()[0]?.incarnation).toBe(f.before);
				broadcastWifiState(); // Any peer joining between legs sees the held mode.
				resume.resolve({ complete: true, stopped: true });
				expect(await change).toEqual({
					success: true,
					accepted: true,
					applied: "hotspot",
				});
				settlePending(f.row.ifname, true);
				const mode = {
					device: f.row.id,
					mode: "hotspot",
					incarnation: f.before,
				};
				expect(f.peer).toEqual([
					["mode", { ...mode, pending: true }, undefined],
					[
						"normal",
						withheld ? undefined : f.before,
						"deactivating",
						withheld ? undefined : "hybrid",
					],
					[
						"normal",
						withheld ? undefined : f.before,
						undefined,
						withheld ? undefined : "hybrid",
					],
					["normal", f.before, undefined, "hybrid"],
					["normal", f.before, "activating", "hybrid"],
					["normal", f.before, "activating", "hybrid"],
					["normal", f.before, undefined, "hybrid"],
					["mode", { ...mode, success: true }, "hybrid"],
					["local", f.before, undefined, undefined],
				]);
			} finally {
				resume.resolve({ complete: true, stopped: true });
				await change;
			}
		} finally {
			restorePublication?.();
			Object.assign(defaultHotspotDeps, defaults);
			cancelWifiAdapterReconciliation();
			await f.restore();
		}
	},
);

test.each([false, true])(
	"public mode Start rebinds only an unsettled outer witness, expired=%s",
	async (expired) => {
		const f = await isolateTransition();
		const defaults = { ...defaultHotspotDeps };
		Object.assign(defaultHotspotDeps, f.deps, {
			broadcastState: broadcastWifiState,
		});
		delete defaultHotspotDeps.pollHotspotActive;
		spyOn(defaultAdapterModeDeps, "persistMode").mockImplementation(() => {});
		spyOn(defaultAdapterModeDeps, "readPersistedMode").mockReturnValue(
			undefined,
		);
		let expire: (() => void) | undefined;
		spyOn(defaultAdapterModeDeps, "armTerminalTimeout").mockImplementation(
			(action) => {
				expire = action;
				return () => {};
			},
		);
		spyOn(compat, "broadcastMsg").mockImplementation((type, payload) => {
			f.collect("normal", type, payload);
			if (type !== "wifi") return;
			const frame: WifiMessage = JSON.parse(JSON.stringify(payload));
			if (frame.adapter_mode) {
				f.peer.push(["mode", frame.adapter_mode, wifiBuildMsg()[0]?.leaving]);
			}
			if (frame.hotspot?.start) f.peer.push(["start", frame.hotspot.start]);
		});
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<{ complete: true; stopped: true }>();
		f.row.hotspot.conn = OTHER_UUID;
		rememberHotspotCredentials("dc:a6:32:aa:bb:ff", {
			ssid: "Foreign AP",
			password: "foreign-password",
		});
		registerWifiAdapterTeardownLocked(MAC, () => {
			entered.resolve();
			return resume.promise;
		});
		const pending = call(
			setWifiAdapterModeProcedure,
			{ device: String(f.row.id), mode: "hotspot", incarnation: f.before },
			{ context: f.context },
		);
		try {
			expect(
				await Promise.race([entered.promise.then(() => "cleanup"), pending]),
			).toBe("cleanup");
			const original = f.row.hotspot;
			await handleHotspotConn(MAC, OTHER_UUID);
			expect(f.row.hotspot).not.toBe(original);
			expect(wifiBuildMsg()[0]?.incarnation).toBe(f.before);
			if (expired) {
				if (!expire) throw new Error("Missing real mode terminal timer");
				expire();
			}
			resume.resolve({ complete: true, stopped: true });
			expect(await pending).toEqual({
				success: true,
				accepted: true,
				applied: "hotspot",
			});
			settlePending(f.row.ifname, true);
			const witness = expired ? undefined : "station";
			const mode = { device: f.row.id, mode: "hotspot", incarnation: f.before };
			expect(f.peer).toEqual([
				["mode", { ...mode, pending: true }, undefined],
				...(expired
					? [
							[
								"mode",
								{
									device: f.row.id,
									error: "not-confirmed",
									incarnation: f.before,
								},
								undefined,
							],
						]
					: []),
				["normal", f.before, "activating", witness],
				["normal", f.before, "activating", witness],
				["normal", f.before, undefined, witness],
				["start", { device: f.row.id, success: true }],
				...(expired
					? []
					: [
							["mode", { ...mode, success: true }, "station"],
							["local", f.before, undefined, undefined],
						]),
			]);
		} finally {
			resume.resolve({ complete: true, stopped: true });
			await pending;
			cancelWifiAdapterReconciliation();
			Object.assign(defaultHotspotDeps, defaults);
			await f.restore();
		}
	},
);

test("a transition cannot capture for an uncaptured holder from another hotspot owner", async () => {
	const f = await isolateTransition();
	const release = holdWifiModeWitness(f.row);
	try {
		f.row.hotspot = { ...f.row.hotspot };
		beginHotspotTransition(f.row, "activating");
		expect(wifiBuildMsg()[f.row.id]?.leaving).toBeUndefined();
	} finally {
		release();
		await f.restore();
	}
});

test("a successor's prior is captured before the old Start holder is released", async () => {
	const f = await isolateTransition();
	try {
		await f.startAccepted();
		expect(wifiBuildMsg()[f.row.id]?.leaving).toBe("station");
		f.row.hotspot = { ...f.row.hotspot };
		delete f.row.hotspot.transition;
		delete f.row.activeMode;
		const release = holdWifiModeWitness(f.row);
		try {
			beginHotspotTransition(f.row, "activating");
			expect(wifiBuildMsg()[f.row.id]?.leaving).toBeNull();
		} finally {
			release();
		}
	} finally {
		await f.restore();
	}
});
