import { expect, spyOn, test } from "bun:test";
import { call } from "@orpc/server";
import * as mocks from "../mocks/mock-service.ts";
import * as wifi from "../mocks/providers/wifi.ts";
import * as incarnations from "../mocks/providers/wifi-incarnation.ts";
import {
	admitWifiRequest,
	withWifiRequestBinding,
} from "../modules/wifi/wifi-binding.ts";
import { wifiHotspotStart } from "../modules/wifi/wifi-hotspot-activation.ts";
import { defaultHotspotConfigDeps } from "../modules/wifi/wifi-hotspot-config.ts";
import {
	hotspotConfigureProcedure,
	hotspotStartProcedure,
} from "../rpc/procedures/wifi.procedure.ts";
import { fixture, request } from "./helpers/wifi-entry-fixture.ts";

for (const limited of [false, true]) {
	test(`request-bound mock transaction follows the current mock producer, limited=${limited}`, async () => {
		const state = await fixture();
		state.mocked(true);
		mocks.initMockService(limited ? "wifi-limited" : "multi-modem-wifi");
		try {
			const expected = incarnations.getMockWifiIncarnation("wlan0");
			expect(
				await withWifiRequestBinding(
					{ device: "0", expected, kind: "config" },
					() => wifiHotspotStart({ device: 0 }),
				),
			).toEqual(
				limited
					? { success: false, error: "radio-unverified" }
					: { success: true },
			);
		} finally {
			await state.restore();
		}
	});
}

test("mock Start admission and its effect share a token before a queued rebind", async () => {
	const state = await fixture();
	state.mocked(true);
	mocks.initMockService("multi-modem-wifi");
	const read = incarnations.getMockWifiIncarnation;
	const token = read("wlan0");
	let queued = false;
	spyOn(incarnations, "getMockWifiIncarnation").mockImplementation((device) => {
		const current = read(device);
		if (!queued) {
			queued = true;
			queueMicrotask(() => incarnations.rebindMockWifi(device));
		}
		return current;
	});
	const write = mocks.setMockWifiConnection;
	const writtenUnder: string[] = [];
	spyOn(mocks, "setMockWifiConnection").mockImplementation((device, update) => {
		writtenUnder.push(read(device));
		return write(device, update);
	});
	try {
		expect(
			await call(
				hotspotStartProcedure,
				{
					device: "0",
					incarnation: token,
				},
				{ context: state.context },
			),
		).toEqual({ success: true, accepted: true });
		expect(writtenUnder).toEqual([token]);
		expect(read("wlan0")).not.toBe(token);
	} finally {
		await state.restore();
	}
});

test("a current mock Configure token reaches the existing writer failure", async () => {
	const state = await fixture();
	state.mocked(true);
	mocks.initMockService("multi-modem-wifi");
	const token = incarnations.getMockWifiIncarnation("wlan0");
	const writer = spyOn(
		defaultHotspotConfigDeps,
		"nmConnSetFields",
	).mockResolvedValue(false);
	try {
		expect(
			await call(
				hotspotConfigureProcedure,
				{
					device: "0",
					incarnation: token,
					name: "Admission AP",
					password: "admission-password",
					channel: "auto",
				},
				{ context: state.context },
			),
		).toEqual({ success: true });
		await state.configReceived;
		expect(writer).toHaveBeenCalledTimes(1);
		expect(JSON.parse(state.frames.at(-1) ?? "{}").wifi.hotspot.config).toEqual(
			{
				device: 0,
				error: "saving",
				incarnation: token,
			},
		);
	} finally {
		await state.restore();
	}
});

for (const kind of ["prepare-save", "start", "hotspot"] as const) {
	test(`mock ${kind} consumes admission before changing provider state`, async () => {
		const state = await fixture();
		state.mocked(true);
		mocks.initMockService("multi-modem-wifi");
		const seen: Promise<boolean>[] = [];
		const probe = () =>
			seen.push(
				admitWifiRequest(
					{ ...state.row },
					async () => false,
					() => true,
				),
			);
		const writeConnection = mocks.setMockWifiConnection;
		spyOn(mocks, "setMockWifiConnection").mockImplementation(
			(device, update) => {
				probe();
				return writeConnection(device, update);
			},
		);
		const writeConfig = wifi.setMockHotspotConfig;
		spyOn(wifi, "setMockHotspotConfig").mockImplementation((device, update) => {
			probe();
			return writeConfig(device, update);
		});
		try {
			expect(
				(
					await request(
						kind,
						state.context,
						incarnations.getMockWifiIncarnation("wlan0"),
					)
				).success,
			).toBe(true);
			expect(await Promise.all(seen)).toEqual([false]);
		} finally {
			await state.restore();
		}
	});
}
