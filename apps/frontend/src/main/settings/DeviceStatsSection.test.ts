// @vitest-environment jsdom
/**
 * The CPU Load tile — a share of capacity, not a bare load average.
 *
 * Reported live on a Rock 5B+: one software encode pegging a single core of an
 * 8-core board rendered "CPU Load 1.00" with no reference point, which reads as
 * saturation. These cases pin the fix at the RENDERED DOM, because the pure
 * derivation being right is not the same as the tile showing it — and they pin
 * the honest degradation, which is the half a percentage-only test would miss.
 */
import type { CpuInfo, DeviceStats, FanReading } from "@ceraui/rpc/schemas";
import { render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DeviceStatsSection from "./DeviceStatsSection.svelte";

const subs = vi.hoisted(() => ({
	deviceStats: undefined as DeviceStats | undefined,
	fan: undefined as FanReading | undefined,
	cpu: undefined as CpuInfo | undefined,
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getDeviceStats: () => subs.deviceStats,
	getFanSnapshot: () => subs.fan,
	getCpuInfo: () => subs.cpu,
}));

vi.mock("$lib/stores/device-health-history.svelte", () => ({
	getEncoderLoad: () => ({
		source: null,
		cores: [],
		updatedAt: null,
		simulated: false,
	}),
}));

function statsWithLoad(cpuLoad1: number | null): DeviceStats {
	return {
		disk: null,
		cpuLoad1,
		socTemp: null,
		ifaceRxTx: null,
		raucSlot: "unavailable",
	};
}

const tile = () => screen.getByTestId("device-stat-cpuLoad");
const value = () => screen.getByTestId("device-stat-cpuLoad-value");
const barTone = () =>
	screen.getByTestId("device-stat-cpuLoad-bar").getAttribute("data-bar-tone");

beforeEach(() => {
	subs.deviceStats = statsWithLoad(1.0);
	subs.fan = undefined;
	subs.cpu = { cores: 8 };
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("CPU Load tile", () => {
	it("leads with the share of total capacity, not the load average", () => {
		render(DeviceStatsSection);

		expect(value().textContent?.trim()).toBe("13 %");
	});

	it("keeps the raw load average as secondary context", () => {
		render(DeviceStatsSection);

		expect(tile().textContent).toMatch(/Light\s*·\s*load 1\.00/);
	});

	it("draws a capacity bar, which the bare load average could not justify", () => {
		render(DeviceStatsSection);

		expect(barTone()).toBe("primary");
	});

	it.each([
		[1.0, "light", "primary"],
		[5.6, "moderate", "warning"],
		[7.6, "heavy", "critical"],
	])("a load of %s across 8 cores reads as %s", (load, band, tone) => {
		subs.deviceStats = statsWithLoad(load);
		render(DeviceStatsSection);

		expect(tile().getAttribute("data-cpu-band")).toBe(band);
		expect(barTone()).toBe(tone);
	});

	it("shows the true percentage above 100 while the bar stops at full", () => {
		subs.deviceStats = statsWithLoad(12);
		render(DeviceStatsSection);

		expect(value().textContent?.trim()).toBe("150 %");
		expect(
			screen
				.getByTestId("device-stat-cpuLoad-bar")
				.firstElementChild?.getAttribute("style"),
		).toContain("inline-size: 100%");
	});

	describe("without a core count", () => {
		it.each([
			["no broadcast has arrived", undefined],
			["the device reported no topology", { cores: null } as CpuInfo],
		])("falls back to the raw load average when %s", (_label, cpu) => {
			subs.cpu = cpu as CpuInfo | undefined;
			render(DeviceStatsSection);

			expect(value().textContent?.trim()).toBe("1.00");
			// No fabricated denominator ⇒ no bar and no band.
			expect(screen.queryByTestId("device-stat-cpuLoad-bar")).toBeNull();
			expect(tile().getAttribute("data-cpu-band")).toBeNull();
		});
	});

	it("renders the unavailable WORD when there is no load reading at all", () => {
		subs.deviceStats = statsWithLoad(null);
		render(DeviceStatsSection);

		expect(value().textContent?.trim()).toBe("Unavailable");
	});
});
