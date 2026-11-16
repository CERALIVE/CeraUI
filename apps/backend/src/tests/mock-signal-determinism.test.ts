import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import {
	getMockState,
	getModemSignal,
	initMockService,
	stopMockService,
} from "../mocks/mock-service.ts";
import { getMockDbusModemViews } from "../mocks/providers/cellular.ts";

const SCENARIO = "multi-modem-wifi";

// bun shares one global across files, so restore MOCK_MODE after flipping it on.
const savedMockMode = process.env.MOCK_MODE;

function signals(): { modems: [number, number][]; wifi: [string, number][] } {
	const state = getMockState();
	return { modems: [...state.modemSignals], wifi: [...state.wifiSignals] };
}

describe("mock signals are fixed seeds, so screenshots of them are byte-stable", () => {
	beforeAll(() => {
		process.env.MOCK_MODE = "true";
		initMockService(SCENARIO);
	});

	afterAll(() => {
		stopMockService();
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
	});

	test("every boot seeds the same modem and wifi signals", () => {
		const first = signals();
		initMockService(SCENARIO);
		expect(signals()).toEqual(first);
	});

	test("the periodic tick moves traffic but never a signal", () => {
		const timerSpy = spyOn(globalThis, "setInterval");
		try {
			initMockService(SCENARIO);
			const tick = timerSpy.mock.calls.find((call) => call[1] === 1000)?.[0];
			if (typeof tick !== "function") {
				throw new Error("mock periodic update timer was not registered");
			}
			const before = signals();
			const trafficBefore = [...getMockState().networkTraffic];

			tick();
			tick();

			expect(signals()).toEqual(before);
			expect([...getMockState().networkTraffic]).not.toEqual(trafficBefore);
		} finally {
			timerSpy.mockRestore();
		}
	});

	test("the D-Bus view reports the mmcli seed, at the excellent three-bar level", () => {
		const views = getMockDbusModemViews();
		expect(views).toHaveLength(3);
		for (const view of views) {
			expect(view.signal).toBe(Math.round(getModemSignal(view.runtimeId)));
			// Frontend signal.ts: >= 75 is "excellent", which also draws three bars.
			expect(view.signal).toBeGreaterThanOrEqual(75);
		}
	});
});
