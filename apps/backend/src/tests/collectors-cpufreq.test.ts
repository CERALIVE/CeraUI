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
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	CPUFREQ_DIR,
	collectCpuFreq,
	cpuFreqFromPolicyReads,
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
};

/**
 * Build a fixture root carrying `sys/devices/system/cpu/cpufreq/<policy>/…`.
 * With `policies` undefined the cpufreq directory is never created — the
 * absent-source leg.
 */
async function fixtureRoot(
	policies?: readonly PolicyFixture[],
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ceraui-cpufreq-"));
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
	}
	return root;
}

/** A full policy: both nodes present, kernel-style trailing newline. */
function policy(id: string, curKhz: number, maxKhz: number): PolicyFixture {
	return { id, cur: `${curKhz}\n`, max: `${maxKhz}\n` };
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
