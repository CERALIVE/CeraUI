import { expect, spyOn, test } from "bun:test";
import { call } from "@orpc/server";
import { initMockService } from "../mocks/mock-service.ts";
import { setMockWifiFaults } from "../mocks/providers/wifi.ts";
import { getMockWifiIncarnation } from "../mocks/providers/wifi-incarnation.ts";
import * as streaming from "../modules/streaming/streaming.ts";
import * as locks from "../modules/wifi/wifi-adapter-lock.ts";
import { defaultAdapterModeDeps } from "../modules/wifi/wifi-adapter-mode-transition.ts";
import { setWifiAdapterModeProcedure } from "../rpc/procedures/wifi.procedure.ts";
import { wifiModeSockets } from "./helpers/wifi-mode-sockets.ts";

for (const [scenario, target, error] of [
	["probe-busy", "hotspot", "DEVICE_BUSY"],
	["lock-busy", "hotspot", "DEVICE_BUSY"],
	["lock-binding", "hotspot", "radio-changed"],
	["limited", "hotspot", "radio-unverified"],
	["capability", "hybrid", "capability-unproven"],
	["unsupported", "hotspot", "unsupported"],
	["streaming", "hotspot", "DEVICE_BUSY"],
	["missing", "station", "no-device"],
	["mock-station-busy", "station", "DEVICE_BUSY"],
	["mock-missing", "station", "no-device"],
	["mock-capability", "hybrid", "capability-unproven"],
] as const) {
	test(`${scenario} mode refusal before pending reaches only its requester`, async () => {
		const state = await wifiModeSockets();
		const release = Promise.withResolvers<void>();
		const key = locks.wifiAdapterLockKeyForDeviceId("0");
		if (key === undefined) throw new Error("missing adapter lock");
		let held: ReturnType<typeof locks.withWifiAdapterLock> | undefined;
		let token = state.before;
		switch (scenario) {
			case "probe-busy":
				spyOn(defaultAdapterModeDeps, "isAdapterBusy").mockResolvedValue(true);
				break;
			case "lock-busy":
				spyOn(defaultAdapterModeDeps, "isAdapterBusy").mockImplementation(
					async () => {
						held = locks.withWifiAdapterLock(key, () => release.promise);
						return false;
					},
				);
				break;
			case "lock-binding": {
				const original = locks.withWifiAdapterLock;
				let calls = 0;
				spyOn(locks, "withWifiAdapterLock").mockImplementation(
					async (lock, operation) => {
						if (++calls === 3) await state.rotate();
						return original(lock, operation);
					},
				);
				break;
			}
			case "limited":
				spyOn(defaultAdapterModeDeps, "isAdapterBusy").mockImplementation(
					async () => {
						state.row.degradedReason = "permanent-mac-unresolved";
						return false;
					},
				);
				break;
			case "capability":
			case "missing":
				break;
			case "unsupported":
				Reflect.deleteProperty(state.row, "hotspot");
				break;
			case "streaming":
				state.row.conn = "station-uuid";
				state.row.activeMode = "infrastructure";
				spyOn(streaming, "getIsStreaming").mockReturnValue(true);
				break;
			case "mock-station-busy":
			case "mock-missing":
			case "mock-capability":
				state.mocked(true);
				initMockService("multi-modem-wifi");
				token = getMockWifiIncarnation("wlan0");
				if (scenario === "mock-station-busy")
					setMockWifiFaults({ deviceBusy: true });
				break;
			default: {
				const unexpected: never = scenario;
				throw new Error(`unknown fixture ${unexpected}`);
			}
		}
		const device =
			scenario === "missing" || scenario === "mock-missing" ? "99" : "0";
		try {
			expect(
				await call(
					setWifiAdapterModeProcedure,
					{
						device,
						mode: target,
						...(target === "station" ? {} : { incarnation: token }),
					},
					{ context: state.b },
				),
			).toEqual({ success: false, error });
			expect(state.modes(state.receivedA)).toEqual([]);
			expect(state.modes(state.receivedObserver)).toEqual([]);
			expect(state.modes(state.receivedB)).toMatchObject([{ error }]);
			expect(state.receivedB).toHaveLength(1);
			expect(JSON.parse(state.receivedB[0] ?? "{}")).not.toHaveProperty("seq");
			expect(state.effects).toEqual([]);
		} finally {
			release.resolve();
			await held;
			await state.restore();
		}
	});
}
