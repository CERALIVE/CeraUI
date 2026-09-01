/*
 * CPU-frequency collector — `/sys/devices/system/cpu/cpufreq/policy*` read
 * through the root-aware collector filesystem seam (`collectors/fs.ts`).
 *
 * Every leg runs against a REAL fixture tree on disk (an injected root), so the
 * directory enumeration, the per-policy path building, and genuine ENOENT are
 * all exercised — which is precisely where a sysfs collector breaks. The five
 * legs pin the contract:
 *
 *   rk3588       — 3 policies (0/4/6), exact kHz payload, no per-core expansion
 *   x86          — N policies, numeric order (policy10 after policy9, not after
 *                  policy1 — a lexicographic sort would fail here)
 *   partial      — ONE policy lacks cpuinfo_max_freq → that policy alone is
 *                  omitted; the others survive
 *   disappearing — a policy directory vanishes between enumeration and read →
 *                  omitted, no throw
 *   absent       — no cpufreq directory at all → the field is omitted entirely
 *
 * The metadata legs below (`related_cpus`, `scaling_governor`, /proc/cpuinfo)
 * add one more axis, and its whole point is what is NOT emitted: a part number
 * this build has not checked, a vendor that is not ARM, a policy whose CPUs
 * disagree, and a CPU /proc/cpuinfo never mentioned all yield NO label. The
 * metadata-absent leg additionally proves the emitted row is byte-identical to
 * the one that shipped before any of this existed.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	CPUFREQ_DIR,
	CPUINFO_PATH,
	collectCpuFreq,
	cpuFreqFromPolicyReads,
	cpuLabelsFromCpuinfo,
	formatCpuList,
	labelForCpus,
	parseGovernor,
	parseRelatedCpus,
	policyIdsFromEntries,
} from "../modules/system/collectors/cpufreq.ts";
import {
	type CollectorFs,
	createCollectorFs,
} from "../modules/system/collectors/fs.ts";

/** One policy's fixture content; `undefined` means the node is not written. */
type PolicyFixture = {
	id: string;
	cur?: string;
	max?: string;
	relatedCpus?: string;
	governor?: string;
};

/**
 * Build a fixture root carrying `sys/devices/system/cpu/cpufreq/<policy>/…`.
 * With `policies` undefined the cpufreq directory is never created — the
 * absent-source leg. `cpuinfo` is written to `/proc/cpuinfo` under the same
 * root, so an omitted one is a board whose part table could not be read.
 */
async function fixtureRoot(
	policies?: readonly PolicyFixture[],
	cpuinfo?: string,
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ceraui-cpufreq-"));
	if (cpuinfo !== undefined) {
		const path = join(root, CPUINFO_PATH);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, cpuinfo);
	}
	if (policies === undefined) return root;
	for (const policy of policies) {
		const dir = join(root, CPUFREQ_DIR, policy.id);
		await mkdir(dir, { recursive: true });
		if (policy.cur !== undefined) {
			await writeFile(join(dir, "scaling_cur_freq"), policy.cur);
		}
		if (policy.max !== undefined) {
			await writeFile(join(dir, "cpuinfo_max_freq"), policy.max);
		}
		if (policy.relatedCpus !== undefined) {
			await writeFile(join(dir, "related_cpus"), policy.relatedCpus);
		}
		if (policy.governor !== undefined) {
			await writeFile(join(dir, "scaling_governor"), policy.governor);
		}
	}
	return root;
}

/** A full policy: both nodes present, kernel-style trailing newline. */
function policy(id: string, curKhz: number, maxKhz: number): PolicyFixture {
	return { id, cur: `${curKhz}\n`, max: `${maxKhz}\n` };
}

/** An arm64 `/proc/cpuinfo`, one block per CPU, in the kernel's own layout. */
function armCpuinfo(
	cpus: ReadonlyArray<{ cpu: number; part: string; implementer?: string }>,
): string {
	return `${cpus
		.map(
			({ cpu, part, implementer = "0x41" }) =>
				`processor\t: ${cpu}\n` +
				"BogoMIPS\t: 24.00\n" +
				`CPU implementer\t: ${implementer}\n` +
				"CPU architecture: 8\n" +
				"CPU variant\t: 0x0\n" +
				`CPU part\t: ${part}\n` +
				"CPU revision\t: 0\n",
		)
		.join("\n")}\n`;
}

/** An x86 `/proc/cpuinfo`, where every CPU repeats the same `model name`. */
function x86Cpuinfo(cpus: readonly number[], modelName: string): string {
	return `${cpus
		.map(
			(cpu) =>
				`processor\t: ${cpu}\n` +
				"vendor_id\t: GenuineIntel\n" +
				"cpu family\t: 6\n" +
				"model\t\t: 190\n" +
				`model name\t: ${modelName}\n` +
				"cpu MHz\t\t: 800.000\n",
		)
		.join("\n")}\n`;
}

// The RK3588 shape: one policy per cluster boundary (cpu0 / cpu4 / cpu6). The
// collector does NOT know that — the ids are simply what the kernel printed.
const RK3588 = [
	policy("policy0", 1_008_000, 1_800_000),
	policy("policy4", 1_416_000, 2_400_000),
	policy("policy6", 2_016_000, 2_400_000),
];

// A 12-thread x86 box: one policy per CPU. policy10/policy11 exist precisely to
// prove the ordering is numeric, not lexicographic.
const X86 = Array.from({ length: 12 }, (_, i) =>
	policy(`policy${i}`, 800_000 + i * 1000, 4_800_000),
);

describe("cpufreq collector — sysfs policies through the injected root", () => {
	test("rk3588-shaped: three policies, exact kHz as the kernel reports them", async () => {
		const root = await fixtureRoot(RK3588);
		expect(await collectCpuFreq(createCollectorFs(root))).toEqual({
			cpuFreq: [
				{ id: "policy0", curKhz: 1_008_000, maxKhz: 1_800_000 },
				{ id: "policy4", curKhz: 1_416_000, maxKhz: 2_400_000 },
				{ id: "policy6", curKhz: 2_016_000, maxKhz: 2_400_000 },
			],
		});
	});

	test("x86-shaped: N policies, ordered NUMERICALLY (policy10 follows policy9)", async () => {
		const root = await fixtureRoot(X86);
		const stats = await collectCpuFreq(createCollectorFs(root));
		expect(stats.cpuFreq).toEqual(
			Array.from({ length: 12 }, (_, i) => ({
				id: `policy${i}`,
				curKhz: 800_000 + i * 1000,
				maxKhz: 4_800_000,
			})),
		);
	});

	test("partial: a policy missing cpuinfo_max_freq is omitted ALONE, not the array", async () => {
		const root = await fixtureRoot([
			policy("policy0", 1_008_000, 1_800_000),
			{ id: "policy4", cur: "1416000\n" }, // no cpuinfo_max_freq
			policy("policy6", 2_016_000, 2_400_000),
		]);
		expect(await collectCpuFreq(createCollectorFs(root))).toEqual({
			cpuFreq: [
				{ id: "policy0", curKhz: 1_008_000, maxKhz: 1_800_000 },
				{ id: "policy6", curKhz: 2_016_000, maxKhz: 2_400_000 },
			],
		});
	});

	test("disappearing: a policy dir removed between enumeration and read is omitted, no throw", async () => {
		const root = await fixtureRoot(RK3588);
		const real = createCollectorFs(root);
		// Enumerate, then delete policy4 BEFORE the caller reads it — the exact
		// CPU-hotplug race the collector has to survive on a real board.
		const racy: CollectorFs = {
			readText: real.readText,
			readDir: async (path) => {
				const entries = await real.readDir(path);
				await rm(join(root, CPUFREQ_DIR, "policy4"), {
					recursive: true,
					force: true,
				});
				return entries;
			},
		};
		expect(await collectCpuFreq(racy)).toEqual({
			cpuFreq: [
				{ id: "policy0", curKhz: 1_008_000, maxKhz: 1_800_000 },
				{ id: "policy6", curKhz: 2_016_000, maxKhz: 2_400_000 },
			],
		});
	});

	test("absent cpufreq directory: the field is omitted entirely, no throw", async () => {
		const root = await fixtureRoot();
		expect(await collectCpuFreq(createCollectorFs(root))).toEqual({});
	});

	test("a cpufreq dir whose every policy is unreadable omits the field (never [])", async () => {
		const root = await fixtureRoot([{ id: "policy0" }, { id: "policy1" }]);
		const stats = await collectCpuFreq(createCollectorFs(root));
		expect(stats).toEqual({});
		expect("cpuFreq" in stats).toBe(false);
	});
});

describe("policyIdsFromEntries — enumeration filter + ordering", () => {
	test("keeps only policyN entries and sorts them numerically", () => {
		expect(
			policyIdsFromEntries([
				"policy10",
				"boost",
				"policy2",
				"policy0",
				"policy",
				"policyX",
				"cpu0",
			]),
		).toEqual(["policy0", "policy2", "policy10"]);
	});
});

describe("cpuFreqFromPolicyReads — parse edge cases", () => {
	test("whitespace-padded integers parse; the value is kHz, untouched", () => {
		expect(
			cpuFreqFromPolicyReads([
				{ id: "policy0", cur: "  1008000  \n", max: "1800000\n" },
			]),
		).toEqual([{ id: "policy0", curKhz: 1_008_000, maxKhz: 1_800_000 }]);
	});

	test("an unparseable or empty node omits that policy — never NaN, never 0", () => {
		expect(
			cpuFreqFromPolicyReads([
				{ id: "policy0", cur: "banana\n", max: "1800000\n" },
				{ id: "policy1", cur: "1008000\n", max: "" },
				{ id: "policy2", cur: "1008000\n", max: undefined },
				{ id: "policy3", cur: "1008000\n", max: "1800000\n" },
			]),
		).toEqual([{ id: "policy3", curKhz: 1_008_000, maxKhz: 1_800_000 }]);
	});

	test("a genuinely-read 0 kHz survives — it is a measurement, not a gap", () => {
		expect(
			cpuFreqFromPolicyReads([{ id: "policy0", cur: "0\n", max: "1800000\n" }]),
		).toEqual([{ id: "policy0", curKhz: 0, maxKhz: 1_800_000 }]);
	});
});

// The board's three cpufreq policies, each with the CPUs it governs and the MIDR
// part those CPUs report: 4x Cortex-A55 then two 2x Cortex-A76 clusters.
const RK3588_CLUSTERS = [
	{
		id: "policy0",
		cur: 1_008_000,
		max: 1_800_000,
		cpus: [0, 1, 2, 3],
		part: "0xd05",
		label: "Cortex-A55",
		range: "0-3",
	},
	{
		id: "policy4",
		cur: 1_416_000,
		max: 2_400_000,
		cpus: [4, 5],
		part: "0xd0b",
		label: "Cortex-A76",
		range: "4-5",
	},
	{
		id: "policy6",
		cur: 2_016_000,
		max: 2_400_000,
		cpus: [6, 7],
		part: "0xd0b",
		label: "Cortex-A76",
		range: "6-7",
	},
] as const;

function rk3588Fixture(governor = "performance"): {
	policies: PolicyFixture[];
	cpuinfo: string;
} {
	return {
		policies: RK3588_CLUSTERS.map((cluster) => ({
			...policy(cluster.id, cluster.cur, cluster.max),
			relatedCpus: `${cluster.cpus.join(" ")}\n`,
			governor: `${governor}\n`,
		})),
		cpuinfo: armCpuinfo(
			RK3588_CLUSTERS.flatMap((cluster) =>
				cluster.cpus.map((cpu) => ({ cpu, part: cluster.part })),
			),
		),
	};
}

const X86_MODEL = "Intel(R) N100";
const X86_THREADS = 12;
const X86_MAX_KHZ = 4_800_000;

function x86Fixture(): { policies: PolicyFixture[]; cpuinfo: string } {
	const cpus = Array.from({ length: X86_THREADS }, (_, i) => i);
	return {
		policies: cpus.map((cpu) => ({
			...policy(`policy${cpu}`, 800_000 + cpu * 1000, X86_MAX_KHZ),
			relatedCpus: `${cpu}\n`,
			governor: "schedutil\n",
		})),
		cpuinfo: x86Cpuinfo(cpus, X86_MODEL),
	};
}

describe("cpufreq metadata — cpus, governor and a NAME that is never guessed", () => {
	test("rk3588 3-cluster: every policy carries its CPUs, count, governor and part", async () => {
		const { policies, cpuinfo } = rk3588Fixture();
		const root = await fixtureRoot(policies, cpuinfo);

		expect(await collectCpuFreq(createCollectorFs(root))).toEqual({
			cpuFreq: [
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
			],
		});
	});

	test("x86 12-thread: one policy per CPU, each spanning exactly one, one shared model name", async () => {
		const { policies, cpuinfo } = x86Fixture();
		const stats = await collectCpuFreq(
			createCollectorFs(await fixtureRoot(policies, cpuinfo)),
		);

		expect(stats.cpuFreq).toHaveLength(X86_THREADS);
		expect(stats.cpuFreq).toEqual(
			Array.from({ length: X86_THREADS }, (_, cpu) => ({
				id: `policy${cpu}`,
				curKhz: 800_000 + cpu * 1000,
				maxKhz: X86_MAX_KHZ,
				cpus: `${cpu}`,
				cpuCount: 1,
				governor: "schedutil",
				label: X86_MODEL,
			})),
		);
	});

	// The byte-compat leg: a device that publishes none of the new nodes emits
	// EXACTLY the three fields it always did. `toEqual` is what makes it a lock —
	// an accidentally-defaulted `cpuCount: 0` or `label: ""` fails here.
	test("metadata-absent: the row is byte-identical to the pre-metadata payload", async () => {
		const root = await fixtureRoot([
			policy("policy0", 1_008_000, 1_800_000),
			policy("policy4", 1_416_000, 2_400_000),
		]);
		const stats = await collectCpuFreq(createCollectorFs(root));

		expect(stats).toEqual({
			cpuFreq: [
				{ id: "policy0", curKhz: 1_008_000, maxKhz: 1_800_000 },
				{ id: "policy4", curKhz: 1_416_000, maxKhz: 2_400_000 },
			],
		});
		for (const row of stats.cpuFreq ?? []) {
			expect(Object.keys(row).sort()).toEqual(["curKhz", "id", "maxKhz"]);
		}
	});

	test("an unreadable /proc/cpuinfo drops only the label", async () => {
		const { policies } = rk3588Fixture();
		const stats = await collectCpuFreq(
			createCollectorFs(await fixtureRoot(policies)),
		);

		expect(stats.cpuFreq?.[0]).toEqual({
			id: "policy0",
			curKhz: 1_008_000,
			maxKhz: 1_800_000,
			cpus: "0-3",
			cpuCount: 4,
			governor: "performance",
		});
	});

	test("an UNKNOWN ARM part is never named, and takes nothing else with it", async () => {
		const stats = await collectCpuFreq(
			createCollectorFs(
				await fixtureRoot(
					[
						{
							...policy("policy0", 1_008_000, 1_800_000),
							relatedCpus: "0 1\n",
							governor: "schedutil\n",
						},
					],
					armCpuinfo([
						{ cpu: 0, part: "0xd4e" },
						{ cpu: 1, part: "0xd4e" },
					]),
				),
			),
		);

		expect(stats.cpuFreq?.[0]).toEqual({
			id: "policy0",
			curKhz: 1_008_000,
			maxKhz: 1_800_000,
			cpus: "0-1",
			cpuCount: 2,
			governor: "schedutil",
		});
	});

	// A part number belongs to whoever implemented the core. Naming somebody
	// else's silicon "Cortex-A55" because the number collides is the fabrication
	// the implementer gate exists to prevent.
	test("a NON-ARM implementer reusing a known part number is not named", async () => {
		const stats = await collectCpuFreq(
			createCollectorFs(
				await fixtureRoot(
					[{ ...policy("policy0", 1_008_000, 1_800_000), relatedCpus: "0\n" }],
					armCpuinfo([{ cpu: 0, part: "0xd05", implementer: "0x51" }]),
				),
			),
		);

		expect(stats.cpuFreq?.[0]?.label).toBeUndefined();
		expect(stats.cpuFreq?.[0]?.cpus).toBe("0");
	});

	test("a policy whose CPUs report DIFFERENT parts names neither", async () => {
		const stats = await collectCpuFreq(
			createCollectorFs(
				await fixtureRoot(
					[
						{
							...policy("policy0", 1_008_000, 1_800_000),
							relatedCpus: "0 1\n",
						},
					],
					armCpuinfo([
						{ cpu: 0, part: "0xd05" },
						{ cpu: 1, part: "0xd0b" },
					]),
				),
			),
		);

		expect(stats.cpuFreq?.[0]?.label).toBeUndefined();
	});

	test("a policy naming a CPU /proc/cpuinfo never mentioned is not labelled", async () => {
		const stats = await collectCpuFreq(
			createCollectorFs(
				await fixtureRoot(
					[
						{
							...policy("policy0", 1_008_000, 1_800_000),
							relatedCpus: "0 1\n",
						},
					],
					armCpuinfo([{ cpu: 0, part: "0xd05" }]),
				),
			),
		);

		expect(stats.cpuFreq?.[0]?.label).toBeUndefined();
	});

	test("an unparseable related_cpus drops cpus, count AND the label it feeds", async () => {
		const stats = await collectCpuFreq(
			createCollectorFs(
				await fixtureRoot(
					[
						{
							...policy("policy0", 1_008_000, 1_800_000),
							relatedCpus: "cpu0 cpu1\n",
							governor: "performance\n",
						},
					],
					armCpuinfo([{ cpu: 0, part: "0xd05" }]),
				),
			),
		);

		expect(stats.cpuFreq?.[0]).toEqual({
			id: "policy0",
			curKhz: 1_008_000,
			maxKhz: 1_800_000,
			governor: "performance",
		});
	});

	test("a governor node holding something that is not a name is omitted", async () => {
		const stats = await collectCpuFreq(
			createCollectorFs(
				await fixtureRoot([
					{
						...policy("policy0", 1_008_000, 1_800_000),
						relatedCpus: "0\n",
						governor: "\n",
					},
				]),
			),
		);

		expect(stats.cpuFreq?.[0]?.governor).toBeUndefined();
		expect(stats.cpuFreq?.[0]?.cpus).toBe("0");
	});
});

describe("cpufreq metadata parsers", () => {
	test("related_cpus is de-duplicated and sorted ascending", () => {
		expect(parseRelatedCpus(" 3 1 0 2 1 \n")).toEqual([0, 1, 2, 3]);
		expect(parseRelatedCpus("")).toBeUndefined();
		expect(parseRelatedCpus(undefined)).toBeUndefined();
		expect(parseRelatedCpus("0 x 2")).toBeUndefined();
	});

	test("CPU numbers compact into the kernel's own range notation", () => {
		expect(formatCpuList([0, 1, 2, 3])).toBe("0-3");
		expect(formatCpuList([4])).toBe("4");
		expect(formatCpuList([0, 2, 4])).toBe("0,2,4");
		expect(formatCpuList([0, 1, 2, 6, 7])).toBe("0-2,6-7");
		expect(formatCpuList([])).toBe("");
	});

	test("a governor is accepted as a name, never as arbitrary bytes", () => {
		expect(parseGovernor("performance\n")).toBe("performance");
		expect(parseGovernor(" schedutil ")).toBe("schedutil");
		expect(parseGovernor("")).toBeUndefined();
		expect(parseGovernor("perf ormance")).toBeUndefined();
		expect(parseGovernor(undefined)).toBeUndefined();
	});

	test("cpuinfo yields only the CPUs whose part this build has checked", () => {
		const labels = cpuLabelsFromCpuinfo(
			armCpuinfo([
				{ cpu: 0, part: "0xd05" },
				{ cpu: 4, part: "0xd0b" },
				{ cpu: 9, part: "0xd4e" },
			]),
		);

		expect(labels.get(0)).toBe("Cortex-A55");
		expect(labels.get(4)).toBe("Cortex-A76");
		expect(labels.has(9)).toBe(false);
		expect(cpuLabelsFromCpuinfo(undefined).size).toBe(0);
	});

	test("labelForCpus requires unanimity and full coverage", () => {
		const labels = new Map([
			[0, "Cortex-A55"],
			[1, "Cortex-A55"],
			[4, "Cortex-A76"],
		]);

		expect(labelForCpus([0, 1], labels)).toBe("Cortex-A55");
		expect(labelForCpus([0, 4], labels)).toBeUndefined();
		expect(labelForCpus([0, 2], labels)).toBeUndefined();
		expect(labelForCpus([], labels)).toBeUndefined();
	});
});
