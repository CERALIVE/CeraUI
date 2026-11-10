import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { call } from "@orpc/server";
import * as mocks from "../mocks/mock-service.ts";
import { getMockHotspotConfig } from "../mocks/providers/wifi.ts";
import * as wifi from "../modules/wifi/wifi.ts";
import * as mode from "../modules/wifi/wifi-adapter-mode-transition.ts";
import * as activation from "../modules/wifi/wifi-hotspot-activation.ts";
import * as config from "../modules/wifi/wifi-hotspot-config.ts";
import {
	hotspotConfigureProcedure,
	hotspotPrepareProcedure,
	hotspotStartProcedure,
	hotspotStopProcedure,
	setWifiAdapterModeProcedure,
} from "../rpc/procedures/wifi.procedure.ts";
import { wifiProtocolContext } from "./helpers/wifi-protocol-context.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const context = wifiProtocolContext();
const options = { context };
const chosen = { name: "Protocol AP", password: "protocol-password" };
const originalMockMode = process.env.MOCK_MODE;

afterEach(() => {
	mock.restore();
	mocks.resetMockState();
	mocks.stopMockService();
	if (originalMockMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = originalMockMode;
});

for (const incarnation of [undefined, "stale-unrelated-token"]) {
	const expected = incarnation === undefined ? {} : { incarnation };
	test(`real requests ignore optional expected binding ${incarnation}`, async () => {
		const registry = isolateWifiRegistry();
		spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
		const prepare = spyOn(activation, "wifiHotspotPrepare").mockResolvedValue({
			success: true,
			...chosen,
		});
		const start = spyOn(activation, "wifiHotspotStart").mockResolvedValue({
			success: true,
		});
		const stop = spyOn(config, "wifiHotspotStop").mockResolvedValue({
			success: true,
		});
		const dispatch = spyOn(wifi, "handleWifi").mockImplementation(
			() => undefined,
		);
		const setMode = spyOn(mode, "setWifiAdapterMode").mockResolvedValue({
			success: true,
			applied: "station",
		});
		try {
			expect(
				await call(
					hotspotPrepareProcedure,
					{ device: "0", ...expected },
					options,
				),
			).toEqual({ success: true, ...chosen });
			expect(prepare).toHaveBeenLastCalledWith({ device: 0 });
			expect(
				await call(
					hotspotPrepareProcedure,
					{ device: "0", ...chosen, ...expected },
					options,
				),
			).toEqual({ success: true, ...chosen });
			expect(prepare).toHaveBeenLastCalledWith({ device: 0, ...chosen });
			expect(
				await call(
					hotspotStartProcedure,
					{ device: "0", ...expected },
					options,
				),
			).toEqual({ success: true, accepted: true });
			expect(start).toHaveBeenCalledWith({ device: 0 });
			expect(
				await call(hotspotStopProcedure, { device: "0", ...expected }, options),
			).toEqual({ success: true });
			expect(stop).toHaveBeenCalledWith({ device: 0 });
			expect(
				await call(
					hotspotConfigureProcedure,
					{
						device: "0",
						...chosen,
						channel: "auto",
						...expected,
					},
					options,
				),
			).toEqual({ success: true });
			expect(dispatch).toHaveBeenCalledWith(context.ws, {
				hotspot: { config: { device: 0, ...chosen, channel: "auto" } },
			});
			for (const target of ["station", "hotspot", "hybrid"] as const) {
				expect(
					await call(
						setWifiAdapterModeProcedure,
						{
							device: "0",
							mode: target,
							...expected,
						},
						options,
					),
				).toEqual({ success: true, applied: "station" });
				expect(setMode).toHaveBeenLastCalledWith("0", target);
			}
		} finally {
			restoreWifiRegistry(registry);
		}
	});

	test(`mock requests preserve legacy effects with expected binding ${incarnation}`, async () => {
		process.env.MOCK_MODE = "true";
		mocks.initMockService("multi-modem-wifi");
		const device = "0";
		const before = getMockHotspotConfig("wlan0");
		expect(
			await call(hotspotPrepareProcedure, { device, ...expected }, options),
		).toEqual({ success: true, name: before.name, password: before.password });
		expect(
			await call(
				hotspotPrepareProcedure,
				{ device, ...chosen, ...expected },
				options,
			),
		).toEqual({ success: true, ...chosen });
		expect(
			await call(hotspotStartProcedure, { device, ...expected }, options),
		).toEqual({ success: true, accepted: true });
		expect(mocks.getMockState().wifiModes.wlan0).toBe("hotspot");
		expect(
			await call(
				hotspotConfigureProcedure,
				{
					device,
					...chosen,
					channel: "auto",
					...expected,
				},
				options,
			),
		).toEqual({ success: true });
		expect(getMockHotspotConfig("wlan0")).toEqual({
			uuid: before.uuid,
			...chosen,
			channel: "auto",
		});
		expect(
			await call(hotspotStopProcedure, { device, ...expected }, options),
		).toEqual({ success: true });
		expect(mocks.getMockState().wifiModes.wlan0).toBe("station");
		for (const target of ["hotspot", "station"] as const) {
			expect(
				await call(
					setWifiAdapterModeProcedure,
					{
						device,
						mode: target,
						...expected,
					},
					options,
				),
			).toEqual({ success: true, applied: target });
			expect(mocks.getMockState().wifiModes.wlan0).toBe(target);
		}
		expect(
			await call(
				setWifiAdapterModeProcedure,
				{
					device,
					mode: "hybrid",
					...expected,
				},
				options,
			),
		).toEqual({ success: false, error: "capability-unproven" });
	});
}
