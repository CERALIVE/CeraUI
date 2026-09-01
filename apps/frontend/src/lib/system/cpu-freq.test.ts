import type { CpuFreqPolicy } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	cpuFreqBar,
	deriveCpuFreqRows,
	formatCpuSpec,
	parseCpuSpec,
} from "./cpu-freq";

/** The board's three policies, exactly as the collector emits them. */
const RK3588: CpuFreqPolicy[] = [
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

const X86_MODEL = "Intel(R) N100";

function x86(threads: number, overrides: Partial<CpuFreqPolicy> = {}) {
	return Array.from({ length: threads }, (_, cpu) => ({
		id: `policy${cpu}`,
		curKhz: 800_000 + cpu * 1000,
		maxKhz: 4_800_000,
		cpus: `${cpu}`,
		cpuCount: 1,
		governor: "schedutil",
		label: X86_MODEL,
		...overrides,
	})) satisfies CpuFreqPolicy[];
}

/** The pre-metadata payload — the only thing an older device sends. */
const RAW: CpuFreqPolicy[] = [
	{ id: "policy0", curKhz: 1_008_000, maxKhz: 1_800_000 },
	{ id: "policy4", curKhz: 1_416_000, maxKhz: 2_400_000 },
];

describe("cluster shape — a policy that governs several CPUs keeps its row", () => {
	it("names each policy by the label the device derived", () => {
		const { shape, rows } = deriveCpuFreqRows(RK3588);

		expect(shape).toBe("cluster");
		expect(rows.map((row) => [row.name, row.cpuCount, row.cpus])).toEqual([
			["Cortex-A55", 4, "0-3"],
			["Cortex-A76", 2, "4-5"],
			["Cortex-A76", 2, "6-7"],
		]);
	});

	it("carries the governor and the sysfs id each row still names exactly", () => {
		const rows = deriveCpuFreqRows(RK3588).rows;

		expect(rows.map((row) => row.governor)).toEqual([
			"performance",
			"performance",
			"performance",
		]);
		expect(rows.map((row) => row.policyIds)).toEqual([
			["policy0"],
			["policy4"],
			["policy6"],
		]);
	});

	// Two Cortex-A76 policies read alike by design — they ARE alike. What tells
	// them apart is the CPUs each governs, which is why the range is carried.
	it("keeps the two identically-labelled A76 policies apart by their CPUs", () => {
		const rows = deriveCpuFreqRows(RK3588).rows;

		expect(rows[1]?.cpus).not.toBe(rows[2]?.cpus);
		expect(rows[1]?.key).not.toBe(rows[2]?.key);
	});

	it("draws each policy as a fill against its OWN ceiling", () => {
		const rows = deriveCpuFreqRows(RK3588).rows;

		expect(cpuFreqBar(rows[0] as never)).toEqual({
			kind: "fill",
			startPercent: 0,
			sizePercent: 56,
		});
		expect(cpuFreqBar(rows[2] as never)).toEqual({
			kind: "fill",
			startPercent: 0,
			sizePercent: 84,
		});
	});
});

describe("per-core shape — a policy per CPU is not a unit worth a row", () => {
	it("folds identical policies into one row carrying the count", () => {
		const { shape, rows } = deriveCpuFreqRows(x86(12));

		expect(shape).toBe("per-core");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe(X86_MODEL);
		expect(rows[0]?.cpuCount).toBe(12);
		expect(rows[0]?.cpus).toBe("0-11");
		expect(rows[0]?.policyIds).toHaveLength(12);
	});

	it("reports the RANGE the folded cores occupy, never one core's clock", () => {
		const rows = deriveCpuFreqRows(x86(12)).rows;

		expect(rows[0]?.curMinKhz).toBe(800_000);
		expect(rows[0]?.curMaxKhz).toBe(811_000);
		expect(cpuFreqBar(rows[0] as never)?.kind).toBe("span");
	});

	// A hybrid box runs two different ceilings, and folding those together would
	// draw one bar against a denominator half the cores never had.
	it("splits a group per distinct label AND ceiling", () => {
		const hybrid: CpuFreqPolicy[] = [
			...x86(4),
			...Array.from({ length: 4 }, (_, i) => ({
				id: `policy${4 + i}`,
				curKhz: 700_000,
				maxKhz: 3_400_000,
				cpus: `${4 + i}`,
				cpuCount: 1,
				governor: "schedutil",
				label: "Intel(R) N100 E-core",
			})),
		];
		const { rows } = deriveCpuFreqRows(hybrid);

		expect(rows).toHaveLength(2);
		expect(rows.map((row) => [row.name, row.cpuCount, row.maxKhz])).toEqual([
			[X86_MODEL, 4, 4_800_000],
			["Intel(R) N100 E-core", 4, 3_400_000],
		]);
	});

	it("withholds the governor when the folded policies disagree about it", () => {
		const mixed = x86(4);
		const last = mixed[3];
		if (last !== undefined) last.governor = "powersave";

		expect(deriveCpuFreqRows(mixed).rows[0]?.governor).toBeUndefined();
		expect(deriveCpuFreqRows(x86(4)).rows[0]?.governor).toBe("schedutil");
	});

	// Folding needs a name for the group. Without one the only candidate is the
	// first policy's directory name, which is not a name for the eleven behind it.
	it("does NOT fold when the device could not name the part", () => {
		const unlabelled = x86(12).map(({ label: _label, ...rest }) => rest);
		const { shape, rows } = deriveCpuFreqRows(unlabelled);

		expect(shape).toBe("cluster");
		expect(rows).toHaveLength(12);
		expect(rows[0]?.name).toBe("policy0");
		expect(rows[0]?.named).toBe(false);
	});
});

describe("raw shape — a device that sent no metadata renders as it always did", () => {
	it("names every row by its sysfs id and carries nothing else", () => {
		const { shape, rows } = deriveCpuFreqRows(RAW);

		expect(shape).toBe("raw");
		expect(rows).toEqual([
			{
				key: "policy0",
				name: "policy0",
				named: false,
				policyIds: ["policy0"],
				curMinKhz: 1_008_000,
				curMaxKhz: 1_008_000,
				maxKhz: 1_800_000,
			},
			{
				key: "policy4",
				name: "policy4",
				named: false,
				policyIds: ["policy4"],
				curMinKhz: 1_416_000,
				curMaxKhz: 1_416_000,
				maxKhz: 2_400_000,
			},
		]);
	});

	it("draws the same fill bar the pre-metadata panel drew", () => {
		expect(cpuFreqBar(deriveCpuFreqRows(RAW).rows[0] as never)).toEqual({
			kind: "fill",
			startPercent: 0,
			sizePercent: 56,
		});
	});

	it("has no rows at all for an absent or empty signal", () => {
		expect(deriveCpuFreqRows(undefined)).toEqual({ shape: "raw", rows: [] });
		expect(deriveCpuFreqRows([])).toEqual({ shape: "raw", rows: [] });
	});
});

describe("bar geometry", () => {
	it("gives a flat group a visible span rather than nothing", () => {
		const flat = deriveCpuFreqRows(
			x86(4).map((policy) => ({ ...policy, curKhz: 800_000 })),
		).rows[0];

		expect(cpuFreqBar(flat as never)).toEqual({
			kind: "span",
			startPercent: 17,
			sizePercent: 2,
		});
	});

	it("draws nothing when the device reported no ceiling to draw against", () => {
		expect(
			cpuFreqBar({
				key: "policy0",
				name: "policy0",
				named: false,
				policyIds: ["policy0"],
				curMinKhz: 0,
				curMaxKhz: 0,
				maxKhz: 0,
			}),
		).toBeNull();
	});
});

describe("CPU range notation", () => {
	it("round-trips the kernel's own compaction", () => {
		expect(parseCpuSpec("0-3")).toEqual([0, 1, 2, 3]);
		expect(parseCpuSpec("4")).toEqual([4]);
		expect(parseCpuSpec("0,2,4")).toEqual([0, 2, 4]);
		expect(parseCpuSpec(undefined)).toEqual([]);
		expect(formatCpuSpec([0, 1, 2, 6, 7])).toBe("0-2,6-7");
		expect(formatCpuSpec([])).toBe("");
	});
});
