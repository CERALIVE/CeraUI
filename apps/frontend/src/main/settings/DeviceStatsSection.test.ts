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

// `extra` carries ONE optional signal at a time, so a case states the field it
// is about and nothing else. Omitting it yields a payload with the five
// always-present fields alone — which is the ABSENT leg of every optional
// signal, and is why the CPU Load cases double as proof that an unmeasured
// signal renders no element at all.
function statsWithLoad(
	cpuLoad1: number | null,
	extra: Partial<DeviceStats> = {},
): DeviceStats {
	return {
		disk: null,
		cpuLoad1,
		socTemp: null,
		ifaceRxTx: null,
		raucSlot: "unavailable",
		...extra,
	};
}

const GIB = 1024 ** 3;

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

/**
 * The four collector signals — memory, per-policy CPU frequency, DDR and GPU.
 *
 * Each is OPTIONAL on the wire and an absent key means the kernel published no
 * such interface, which is a different fact from "the figure is zero". So the
 * absent leg asserts the element is gone rather than blank: a dash, a zero or an
 * "Unavailable" word here would each be a reading the board never produced.
 *
 * The formatting legs exist because the payload carries THREE units — bytes,
 * kHz (cpufreq) and Hz (devfreq) — and mixing two of them is a silent 1000x
 * error that no type would catch.
 */
describe("memory", () => {
	const stat = () => screen.queryByTestId("device-stat-memory");

	it("is not rendered at all when /proc/meminfo published nothing", () => {
		render(DeviceStatsSection);

		expect(stat()).toBeNull();
		expect(screen.queryByTestId("device-stat-memory-value")).toBeNull();
	});

	it("leads with the used share and carries used-of-total in GiB", () => {
		subs.deviceStats = statsWithLoad(1.0, {
			memTotalBytes: 8 * GIB,
			memAvailableBytes: 6 * GIB,
			memUsedPercent: 25,
		});
		render(DeviceStatsSection);

		expect(
			screen.getByTestId("device-stat-memory-value").textContent?.trim(),
		).toBe("25 %");
		expect(stat()?.textContent).toContain("2.0 GiB / 8.0 GiB");
	});

	it("draws a bar, because a used percentage has a real denominator", () => {
		subs.deviceStats = statsWithLoad(1.0, {
			memTotalBytes: 8 * GIB,
			memAvailableBytes: 6 * GIB,
			memUsedPercent: 25,
		});
		render(DeviceStatsSection);

		expect(
			screen
				.getByTestId("device-stat-memory-bar")
				.firstElementChild?.getAttribute("style"),
		).toContain("inline-size: 25%");
	});

	it("rounds the percentage to a whole number", () => {
		subs.deviceStats = statsWithLoad(1.0, { memUsedPercent: 62.6 });
		render(DeviceStatsSection);

		expect(
			screen.getByTestId("device-stat-memory-value").textContent?.trim(),
		).toBe("63 %");
	});
});

describe("swap", () => {
	const stat = () => screen.queryByTestId("device-stat-swap");

	it("is not rendered at all when swap was never measured", () => {
		render(DeviceStatsSection);

		expect(stat()).toBeNull();
	});

	it("states used-of-total in GiB", () => {
		subs.deviceStats = statsWithLoad(1.0, {
			swapTotalBytes: 2 * GIB,
			swapFreeBytes: 1.5 * GIB,
		});
		render(DeviceStatsSection);

		expect(
			screen.getByTestId("device-stat-swap-value").textContent?.trim(),
		).toBe("0.5 GiB / 2.0 GiB");
	});

	// A measured zero is a REAL answer — the board was asked and said "no swap".
	// It is not the absent case above and must not render as one.
	it("says None on a swapless board, which is a measurement", () => {
		subs.deviceStats = statsWithLoad(1.0, {
			swapTotalBytes: 0,
			swapFreeBytes: 0,
		});
		render(DeviceStatsSection);

		expect(
			screen.getByTestId("device-stat-swap-value").textContent?.trim(),
		).toBe("None");
	});
});

describe("CPU frequency", () => {
	const policies = [
		{ id: "policy0", curKhz: 1_008_000, maxKhz: 1_800_000 },
		{ id: "policy4", curKhz: 1_416_000, maxKhz: 2_400_000 },
	];

	it("is not rendered at all when no cpufreq policy answered", () => {
		render(DeviceStatsSection);

		expect(screen.queryByTestId("device-stat-cpuFreq")).toBeNull();
	});

	it("renders one row per policy, current against the hardware ceiling", () => {
		subs.deviceStats = statsWithLoad(1.0, { cpuFreq: policies });
		render(DeviceStatsSection);

		expect(
			screen.getByTestId("cpufreq-policy-value-policy0").textContent?.trim(),
		).toBe("1.01 GHz / 1.80 GHz");
		expect(
			screen.getByTestId("cpufreq-policy-value-policy4").textContent?.trim(),
		).toBe("1.42 GHz / 2.40 GHz");
	});

	// The id is a sysfs directory name. `policy0` is RK3588's little cluster and
	// `policy4`/`policy6` its big ones, but that is BOARD knowledge — this array
	// does not carry it, and inventing the label would be wrong on x86.
	it("labels a policy by its sysfs id and never by a cluster name", () => {
		subs.deviceStats = statsWithLoad(1.0, { cpuFreq: policies });
		render(DeviceStatsSection);

		const text = screen.getByTestId("device-stat-cpuFreq").textContent ?? "";
		expect(text).toContain("policy0");
		expect(text).toContain("policy4");
		expect(text).not.toMatch(/little|big/i);
	});

	it("draws each policy against its own ceiling", () => {
		subs.deviceStats = statsWithLoad(1.0, { cpuFreq: policies });
		render(DeviceStatsSection);

		expect(
			screen
				.getByTestId("cpufreq-policy-bar-policy0")
				.firstElementChild?.getAttribute("style"),
		).toContain("inline-size: 56%");
	});

	// A device that sent no metadata is the pre-metadata payload, and it must
	// still render exactly as it did: sysfs ids, no count, no governor chip.
	it("renders the raw shape with no invented name, count or governor", () => {
		subs.deviceStats = statsWithLoad(1.0, { cpuFreq: policies });
		render(DeviceStatsSection);

		expect(
			screen.getByTestId("cpufreq-policies").getAttribute("data-cpufreq-shape"),
		).toBe("raw");
		expect(screen.queryByTestId("cpufreq-policy-governor-policy0")).toBeNull();
		expect(screen.queryByTestId("cpufreq-policy-detail-policy0")).toBeNull();
		expect(
			screen.getByTestId("cpufreq-policy-policy0").textContent,
		).not.toMatch(/\u00d7/);
	});
});

/**
 * The metadata the collector now reads: which CPUs a policy governs, which
 * governor drives it, and the microarchitecture those CPUs report.
 *
 * Two shapes, and the discriminator is whether a policy governs more than ONE
 * CPU. A cluster keeps its row and gains a name; a per-core board's dozen
 * near-identical policies fold into one row carrying the count and the range of
 * clocks they occupy — because twelve bars against one ceiling is noise, and
 * picking one of them to draw would be a claim about a core nobody chose.
 */
describe("CPU frequency — labelled clusters and per-core aggregation", () => {
	const RK3588 = [
		{
			id: "policy0",
			curKhz: 1_008_000,
			maxKhz: 1_800_000,
			cpus: "0-3",
			cpuCount: 4,
			governor: "performance",
			label: "Cortex-A55",
		},
		{
			id: "policy4",
			curKhz: 1_416_000,
			maxKhz: 2_400_000,
			cpus: "4-5",
			cpuCount: 2,
			governor: "performance",
			label: "Cortex-A76",
		},
		{
			id: "policy6",
			curKhz: 2_016_000,
			maxKhz: 2_400_000,
			cpus: "6-7",
			cpuCount: 2,
			governor: "performance",
			label: "Cortex-A76",
		},
	];

	const X86 = Array.from({ length: 12 }, (_, cpu) => ({
		id: `policy${cpu}`,
		curKhz: 800_000 + cpu * 1000,
		maxKhz: 4_800_000,
		cpus: `${cpu}`,
		cpuCount: 1,
		governor: "schedutil",
		label: "Intel(R) N100",
	}));

	it("names an ARM cluster and states how many cores it covers", () => {
		subs.deviceStats = statsWithLoad(1.0, { cpuFreq: RK3588 });
		render(DeviceStatsSection);

		expect(
			screen.getByTestId("cpufreq-policies").getAttribute("data-cpufreq-shape"),
		).toBe("cluster");
		expect(screen.getByTestId("cpufreq-policy-policy0").textContent).toContain(
			"Cortex-A55\u00a0\u00d74",
		);
		expect(screen.getByTestId("cpufreq-policy-policy4").textContent).toContain(
			"Cortex-A76\u00a0\u00d72",
		);
	});

	it("renders the governor as its own chip beside the cluster", () => {
		subs.deviceStats = statsWithLoad(1.0, { cpuFreq: RK3588 });
		render(DeviceStatsSection);

		expect(
			screen.getByTestId("cpufreq-policy-governor-policy0").textContent?.trim(),
		).toBe("performance");
	});

	// The two A76 policies are genuinely alike, so the row that tells them apart
	// is the one naming the sysfs policy and the CPUs behind it.
	it("keeps the sysfs id and the CPU range visible for a single policy", () => {
		subs.deviceStats = statsWithLoad(1.0, { cpuFreq: RK3588 });
		render(DeviceStatsSection);

		expect(
			screen.getByTestId("cpufreq-policy-detail-policy4").textContent?.trim(),
		).toBe("policy4 \u00b7 cpu4-5");
		expect(
			screen.getByTestId("cpufreq-policy-detail-policy6").textContent?.trim(),
		).toBe("policy6 \u00b7 cpu6-7");
	});

	it("keeps the cluster reading and its fill bar unchanged", () => {
		subs.deviceStats = statsWithLoad(1.0, { cpuFreq: RK3588 });
		render(DeviceStatsSection);

		expect(
			screen.getByTestId("cpufreq-policy-value-policy0").textContent?.trim(),
		).toBe("1.01 GHz / 1.80 GHz");
		expect(
			screen
				.getByTestId("cpufreq-policy-bar-policy0")
				.getAttribute("data-bar-kind"),
		).toBe("fill");
	});

	it("folds a 12-thread x86 board into ONE row, not twelve near-identical bars", () => {
		subs.deviceStats = statsWithLoad(1.0, { cpuFreq: X86 });
		render(DeviceStatsSection);

		const container = screen.getByTestId("cpufreq-policies");
		expect(container.getAttribute("data-cpufreq-shape")).toBe("per-core");
		expect(container.querySelectorAll("[data-policy-count]")).toHaveLength(1);
		expect(screen.getByTestId("cpufreq-policy-policy0").textContent).toContain(
			"Intel(R) N100\u00a0\u00d712",
		);
		expect(
			screen
				.getByTestId("cpufreq-policy-policy0")
				.getAttribute("data-policy-count"),
		).toBe("12");
	});

	// One figure for twelve cores would have to pick a core to be about, so the
	// folded row reports the range they actually occupy.
	it("reports the folded cores' clock RANGE and draws it as a span", () => {
		subs.deviceStats = statsWithLoad(1.0, { cpuFreq: X86 });
		render(DeviceStatsSection);

		expect(
			screen.getByTestId("cpufreq-policy-value-policy0").textContent?.trim(),
		).toBe("0.80\u20130.81 GHz / 4.80 GHz");
		expect(
			screen
				.getByTestId("cpufreq-policy-bar-policy0")
				.getAttribute("data-bar-kind"),
		).toBe("span");
		expect(
			screen.getByTestId("cpufreq-policy-detail-policy0").textContent?.trim(),
		).toBe("cpu0-11");
	});

	// A folded group has no single sysfs policy, so naming its first one would be
	// a wrong label rather than the diagnostic it is for a one-policy row.
	it("does not attribute a folded group to one policy id", () => {
		subs.deviceStats = statsWithLoad(1.0, { cpuFreq: X86 });
		render(DeviceStatsSection);

		expect(
			screen.getByTestId("cpufreq-policy-detail-policy0").textContent,
		).not.toContain("policy0");
	});

	it("never invents a cluster name from a policy id or a core count", () => {
		subs.deviceStats = statsWithLoad(1.0, { cpuFreq: RK3588 });
		render(DeviceStatsSection);

		expect(
			screen.getByTestId("cpufreq-policies").textContent ?? "",
		).not.toMatch(/big|little/i);
	});
});

describe("DDR bus", () => {
	it("is not rendered at all when no memory-controller device answered", () => {
		render(DeviceStatsSection);

		expect(screen.queryByTestId("device-stat-ddr")).toBeNull();
	});

	// devfreq reports Hz where cpufreq reports kHz, so this row is the one that
	// would show a 1000x error if the two ever shared a formatter.
	it("reads as an integer percentage over its devfreq clock in MHz", () => {
		subs.deviceStats = statsWithLoad(1.0, {
			ddr: {
				loadPercent: 37.4,
				curFreqHz: 528_000_000,
				maxFreqHz: 1_560_000_000,
			},
		});
		render(DeviceStatsSection);

		expect(
			screen.getByTestId("device-stat-ddr-value").textContent?.trim(),
		).toBe("37 %");
		expect(screen.getByTestId("device-stat-ddr").textContent).toContain(
			"528 MHz / 1560 MHz",
		);
	});
});

describe("GPU", () => {
	it("is not rendered at all when no GPU load interface answered", () => {
		render(DeviceStatsSection);

		expect(screen.queryByTestId("device-stat-gpu")).toBeNull();
	});

	it("reads as an integer percentage over its devfreq clock in MHz", () => {
		subs.deviceStats = statsWithLoad(1.0, {
			gpu: {
				loadPercent: 61,
				curFreqHz: 300_000_000,
				maxFreqHz: 1_000_000_000,
			},
		});
		render(DeviceStatsSection);

		expect(
			screen.getByTestId("device-stat-gpu-value").textContent?.trim(),
		).toBe("61 %");
		expect(screen.getByTestId("device-stat-gpu").textContent).toContain(
			"300 MHz / 1000 MHz",
		);
	});

	// The Mali kbase node publishes a load and structurally no frequency. That is
	// an ordinary reading, not a half one — the load still shows, and no
	// fabricated "0 MHz" appears beside it.
	it("shows a load with no frequency when the kbase node answered", () => {
		subs.deviceStats = statsWithLoad(1.0, { gpu: { loadPercent: 61 } });
		render(DeviceStatsSection);

		expect(
			screen.getByTestId("device-stat-gpu-value").textContent?.trim(),
		).toBe("61 %");
		expect(screen.getByTestId("device-stat-gpu").textContent).not.toMatch(/Hz/);
	});
});
