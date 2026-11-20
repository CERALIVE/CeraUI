import { expect, spyOn, test } from "bun:test";
import type { WifiAdapterModeResult } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import * as streaming from "../modules/streaming/streaming.ts";
import {
	wifiAdapterLockKeyForDeviceId,
	withWifiAdapterLock,
} from "../modules/wifi/wifi-adapter-lock.ts";
import * as mode from "../modules/wifi/wifi-adapter-mode-transition.ts";
import type { HotspotOutcomePublisher } from "../modules/wifi/wifi-hotspot-outcome.ts";
import { setWifiAdapterModeProcedure } from "../rpc/procedures/wifi.procedure.ts";
import { wifiModeSockets } from "./helpers/wifi-mode-sockets.ts";

for (const [target, token] of [
	["station", undefined],
	["station", "stale-station-token"],
	["hotspot", "current"],
] as const) {
	test(`post-echo ${target} contention with token ${token} stays private to the loser`, async () => {
		const state = await wifiModeSockets();
		state.row.conn = "station-uuid";
		state.row.activeMode = "infrastructure";
		spyOn(streaming, "getIsStreaming").mockReturnValue(false);
		let complete: HotspotOutcomePublisher | undefined;
		spyOn(mode.defaultAdapterModeDeps, "startHotspot").mockImplementation(
			async (_device, publish) => {
				complete = publish;
				return { success: true };
			},
		);
		spyOn(mode.defaultAdapterModeDeps, "armTerminalTimeout").mockImplementation(
			() => () => undefined,
		);
		const release = Promise.withResolvers<void>();
		const key = wifiAdapterLockKeyForDeviceId("0");
		if (key === undefined) throw new Error("missing adapter lock");
		let held: ReturnType<typeof withWifiAdapterLock> | undefined;
		try {
			expect(
				await call(
					setWifiAdapterModeProcedure,
					{ device: "0", mode: "hotspot", incarnation: state.before },
					{ context: state.a },
				),
			).toEqual({ success: true, accepted: true, applied: "hotspot" });
			const pending = {
				device: 0,
				mode: "hotspot",
				pending: true,
				incarnation: state.before,
			} satisfies WifiAdapterModeResult;
			expect(state.modes(state.receivedA)).toEqual([pending]);
			held = withWifiAdapterLock(key, () => release.promise);
			expect(
				await call(
					setWifiAdapterModeProcedure,
					{
						device: "0",
						mode: target,
						...(token === undefined
							? {}
							: { incarnation: token === "current" ? state.before : token }),
					},
					{ context: state.b },
				),
			).toEqual({ success: false, error: "DEVICE_BUSY" });
			if (complete === undefined) throw new Error("missing mode completion");
			complete("start", 0, { success: true });
			const success = {
				device: 0,
				mode: "hotspot",
				success: true,
				incarnation: state.before,
			} satisfies WifiAdapterModeResult;
			expect(state.modes(state.receivedA)).toEqual([pending, success]);
			expect(state.modes(state.receivedObserver)).toEqual([pending, success]);
			expect(state.modes(state.receivedB)).toEqual([
				pending,
				{
					device: target === "station" ? 0 : "0",
					error: "DEVICE_BUSY",
					incarnation:
						token === "current" ? state.before : (token ?? state.before),
				},
				success,
			]);
			expect(JSON.parse(state.receivedB[1] ?? "{}")).not.toHaveProperty("seq");
			expect(JSON.parse(state.receivedA[1] ?? "{}")).toHaveProperty("seq");
		} finally {
			release.resolve();
			await held;
			await state.restore();
		}
	});
}

for (const exit of ["return", "throw"] as const) {
	test(`a bypassed mode consumer retires requester publication on ${exit}`, async () => {
		const state = await wifiModeSockets();
		const release = Promise.withResolvers<void>();
		const internal = mode.setWifiAdapterMode;
		let later: Promise<unknown> | undefined;
		const failure = new Error("synthetic bypass");
		spyOn(mode, "setWifiAdapterMode").mockImplementation(async () => {
			later = release.promise.then(() => internal("99", "station"));
			if (exit === "throw") throw failure;
			return { success: true, applied: "station" };
		});
		try {
			const result = await call(
				setWifiAdapterModeProcedure,
				{ device: "0", mode: "station" },
				{ context: state.b },
			).catch((error: unknown) => error);
			if (exit === "throw") expect(result).toBe(failure);
			else expect(result).toEqual({ success: true, applied: "station" });
			release.resolve();
			await later;
			expect(state.modes(state.receivedA)).toEqual([
				{ device: "99", error: "no-device", incarnation: state.before },
			]);
			expect(state.modes(state.receivedB)).toEqual(
				state.modes(state.receivedA),
			);
		} finally {
			release.resolve();
			await later;
			await state.restore();
		}
	});
}
