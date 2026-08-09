/*
 * GPU-load collector — the DUAL-PATH probe, read through the root-aware
 * collector filesystem seam (`collectors/fs.ts`).
 *
 * NEITHER PATH IS CONFIRMED ON HARDWARE. Which node a board publishes — a Mali
 * kbase `utilisation` file, a devfreq `*.gpu/load`, or nothing at all — is a
 * HARDWARE-OPEN question pending a capture on a real board (T16's runbook).
 * These legs pin the behaviour of the PROBE rather than a confirmed vendor path:
 *
 *   kbase shape   — a Mali kbase utilisation node answers → load only, no freq
 *   sibling spell — the first candidate is absent; a sibling spelling answers
 *   devfreq shape — a `*.gpu` devfreq device answers → load + cur/max frequency
 *   devfreq load  — the same device with only `load` → load alone, no freq keys
 *   probe order   — a tree carrying BOTH: kbase wins, deterministically
 *   absent        — neither path present → the field is omitted entirely
 *
 * Every leg runs against a REAL fixture tree on disk, so the enumeration, the
 * per-node path building, and genuine ENOENT are exercised — the three places a
 * sysfs collector actually breaks.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEVFREQ_DIR } from "../modules/system/collectors/ddr.ts";
import { createCollectorFs } from "../modules/system/collectors/fs.ts";
import {
	collectGpu,
	gpuCandidatesFromEntries,
	gpuFromDevfreqNodes,
	KBASE_UTILISATION_CANDIDATES,
	parseKbaseUtilisation,
} from "../modules/system/collectors/gpu.ts";

/** One devfreq GPU device's fixture content; `undefined` means the node is absent. */
type DevfreqFixture = {
	name: string;
	load?: string;
	cur?: string;
	max?: string;
};

type Fixture = {
	/** Absolute kernel paths → contents, for the kbase leg (candidate files). */
	kbase?: Record<string, string>;
	/** devfreq devices; `undefined` leaves `/sys/class/devfreq` uncreated. */
	devfreq?: readonly DevfreqFixture[];
};

/**
 * Build a fixture root. With BOTH keys omitted neither probe path exists — the
 * absent leg, which is what a board publishing no GPU load actually looks like.
 */
async function fixtureRoot(fixture: Fixture = {}): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ceraui-gpu-"));
	for (const [path, body] of Object.entries(fixture.kbase ?? {})) {
		const file = join(root, path);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, body);
	}
	for (const device of fixture.devfreq ?? []) {
		const dir = join(root, DEVFREQ_DIR, device.name);
		await mkdir(dir, { recursive: true });
		if (device.load !== undefined)
			await writeFile(join(dir, "load"), device.load);
		if (device.cur !== undefined)
			await writeFile(join(dir, "cur_freq"), device.cur);
		if (device.max !== undefined)
			await writeFile(join(dir, "max_freq"), device.max);
	}
	return root;
}

/** A complete devfreq GPU device: all three nodes, kernel-style trailing newline. */
function device(
	name: string,
	load: string,
	curHz: number,
	maxHz: number,
): DevfreqFixture {
	return { name, load, cur: `${curHz}\n`, max: `${maxHz}\n` };
}

/** The candidate the collector probes FIRST — the British vendor spelling. */
const KBASE_PRIMARY = "/sys/class/misc/mali0/device/utilisation";

// Frequencies are Hz — devfreq's own unit (300 MHz current against a 1 GHz
// ceiling is an ordinary RK3588-class Mali pair).
const CUR_HZ = 300_000_000;
const MAX_HZ = 1_000_000_000;

describe("gpu collector — the dual-path probe through the injected root", () => {
	test("KBASE SHAPE: a Mali utilisation node emits load ONLY — no invented frequency", async () => {
		const root = await fixtureRoot({ kbase: { [KBASE_PRIMARY]: "42\n" } });
		const stats = await collectGpu(createCollectorFs(root));
		// Exact payload: the kbase node publishes a percentage and nothing else,
		// so the frequency keys are ABSENT rather than zero- or null-filled.
		expect(stats).toEqual({ gpu: { loadPercent: 42 } });
		expect("curFreqHz" in (stats.gpu ?? {})).toBe(false);
		expect("maxFreqHz" in (stats.gpu ?? {})).toBe(false);
	});

	test("a SIBLING SPELLING answers when the first candidate is absent", async () => {
		const root = await fixtureRoot({
			kbase: { "/sys/class/misc/mali0/device/utilization": "17\n" },
		});
		expect(await collectGpu(createCollectorFs(root))).toEqual({
			gpu: { loadPercent: 17 },
		});
	});

	test("DEVFREQ SHAPE: a `*.gpu` device emits load PLUS both frequencies", async () => {
		const root = await fixtureRoot({
			devfreq: [device("fb000000.gpu", "63\n", CUR_HZ, MAX_HZ)],
		});
		expect(await collectGpu(createCollectorFs(root))).toEqual({
			gpu: { loadPercent: 63, curFreqHz: CUR_HZ, maxFreqHz: MAX_HZ },
		});
	});

	test('the devfreq vendor load form "N@FHz" parses, and the frequency echo is ignored', async () => {
		const root = await fixtureRoot({
			devfreq: [device("fb000000.gpu", "88@300000000Hz\n", CUR_HZ, MAX_HZ)],
		});
		expect(await collectGpu(createCollectorFs(root))).toEqual({
			gpu: { loadPercent: 88, curFreqHz: CUR_HZ, maxFreqHz: MAX_HZ },
		});
	});

	test("a devfreq device with load but NO frequency nodes emits load alone", async () => {
		const root = await fixtureRoot({
			devfreq: [{ name: "fb000000.gpu", load: "51\n" }],
		});
		// Load is the reading; the frequencies are independently optional, so a
		// partial node set is reported partially rather than dropped whole.
		expect(await collectGpu(createCollectorFs(root))).toEqual({
			gpu: { loadPercent: 51 },
		});
	});

	test("ABSENT: neither probe path exists → the field is omitted entirely, no throw", async () => {
		const root = await fixtureRoot();
		const stats = await collectGpu(createCollectorFs(root));
		expect(stats).toEqual({});
		expect("gpu" in stats).toBe(false);
	});

	test("PROBE ORDER: with BOTH paths present the kbase node wins", async () => {
		const root = await fixtureRoot({
			kbase: { [KBASE_PRIMARY]: "42\n" },
			devfreq: [device("fb000000.gpu", "63\n", CUR_HZ, MAX_HZ)],
		});
		// kbase is checked first and answers, so the devfreq frequencies are
		// never read — the ordering is observable precisely because the two
		// paths carry different fields.
		expect(await collectGpu(createCollectorFs(root))).toEqual({
			gpu: { loadPercent: 42 },
		});
	});

	test("an UNPARSEABLE kbase node falls through to the devfreq path", async () => {
		const root = await fixtureRoot({
			kbase: { [KBASE_PRIMARY]: "banana\n" },
			devfreq: [device("fb000000.gpu", "63\n", CUR_HZ, MAX_HZ)],
		});
		expect(await collectGpu(createCollectorFs(root))).toEqual({
			gpu: { loadPercent: 63, curFreqHz: CUR_HZ, maxFreqHz: MAX_HZ },
		});
	});

	test("a devfreq tree with no `*.gpu` device omits the field (dmc is not a GPU)", async () => {
		const root = await fixtureRoot({
			devfreq: [device("dmc", "37\n", 528_000_000, 1_560_000_000)],
		});
		const stats = await collectGpu(createCollectorFs(root));
		expect(stats).toEqual({});
		expect("gpu" in stats).toBe(false);
	});

	test("a `*.gpu` device with no load node omits the field — never a fabricated 0%", async () => {
		const root = await fixtureRoot({
			devfreq: [
				{ name: "fb000000.gpu", cur: `${CUR_HZ}\n`, max: `${MAX_HZ}\n` },
			],
		});
		const stats = await collectGpu(createCollectorFs(root));
		expect(stats).toEqual({});
		expect("gpu" in stats).toBe(false);
	});

	test("a candidate with no load falls through to the NEXT `*.gpu` candidate", async () => {
		const root = await fixtureRoot({
			devfreq: [
				{ name: "fb000000.gpu", cur: `${CUR_HZ}\n`, max: `${MAX_HZ}\n` },
				device("fb001000.gpu", "29\n", CUR_HZ, MAX_HZ),
			],
		});
		expect(await collectGpu(createCollectorFs(root))).toEqual({
			gpu: { loadPercent: 29, curFreqHz: CUR_HZ, maxFreqHz: MAX_HZ },
		});
	});

	test("a genuinely-read 0% load survives — it is a measurement, not a gap", async () => {
		const kbaseRoot = await fixtureRoot({ kbase: { [KBASE_PRIMARY]: "0\n" } });
		expect(await collectGpu(createCollectorFs(kbaseRoot))).toEqual({
			gpu: { loadPercent: 0 },
		});
		const devfreqRoot = await fixtureRoot({
			devfreq: [device("fb000000.gpu", "0\n", CUR_HZ, MAX_HZ)],
		});
		expect(await collectGpu(createCollectorFs(devfreqRoot))).toEqual({
			gpu: { loadPercent: 0, curFreqHz: CUR_HZ, maxFreqHz: MAX_HZ },
		});
	});
});

describe("KBASE_UTILISATION_CANDIDATES — the hardware-open candidate list", () => {
	test("the British vendor spelling is probed FIRST", () => {
		expect(KBASE_UTILISATION_CANDIDATES[0]).toBe(KBASE_PRIMARY);
	});

	test("every candidate is an absolute kernel path under the mali misc device", () => {
		for (const candidate of KBASE_UTILISATION_CANDIDATES) {
			expect(candidate.startsWith("/sys/")).toBe(true);
			// The seam refuses a relative path or a `..` segment; a candidate that
			// needed either would throw at read time instead of being skipped.
			expect(candidate.includes("..")).toBe(false);
		}
	});
});

describe("gpuCandidatesFromEntries — the `*.gpu` devfreq filter", () => {
	test("only `.gpu`-suffixed names match, in a deterministic order", () => {
		expect(
			gpuCandidatesFromEntries([
				"fb001000.gpu",
				"dmc",
				"fb000000.gpu",
				"fdab0000.npu",
				"ff630000.dfi",
			]),
		).toEqual(["fb000000.gpu", "fb001000.gpu"]);
	});

	test("matching is case-insensitive (the names are DT node ids)", () => {
		expect(gpuCandidatesFromEntries(["FB000000.GPU"])).toEqual([
			"FB000000.GPU",
		]);
	});

	test("a name merely CONTAINING gpu is not a `*.gpu` device", () => {
		expect(gpuCandidatesFromEntries(["gpu-thermal", "mali-gpu0"])).toEqual([]);
	});

	test("ordering does not depend on readdir order", () => {
		const entries = ["fb001000.gpu", "dmc", "fb000000.gpu"];
		expect(gpuCandidatesFromEntries(entries)).toEqual(
			gpuCandidatesFromEntries([...entries].reverse()),
		);
	});
});

describe("parseKbaseUtilisation — the kbase percentage node", () => {
	test("a bare integer yields the percentage", () => {
		expect(parseKbaseUtilisation("42\n")).toBe(42);
		expect(parseKbaseUtilisation("  0  ")).toBe(0);
		expect(parseKbaseUtilisation("100")).toBe(100);
	});

	test("anything else is unparseable — never NaN, never a coerced 0", () => {
		expect(parseKbaseUtilisation(undefined)).toBeUndefined();
		expect(parseKbaseUtilisation("")).toBeUndefined();
		expect(parseKbaseUtilisation("banana\n")).toBeUndefined();
		expect(parseKbaseUtilisation("42.5\n")).toBeUndefined();
		// Out of the percentage range: whatever that node meant, it is not a
		// percent, and drawing it as one would put a bogus bar on the panel.
		expect(parseKbaseUtilisation("101\n")).toBeUndefined();
		expect(parseKbaseUtilisation("255\n")).toBeUndefined();
	});
});

describe("gpuFromDevfreqNodes — load required, frequencies independently optional", () => {
	test("all three nodes parse → the full reading", () => {
		expect(
			gpuFromDevfreqNodes({
				load: "63\n",
				cur: "300000000\n",
				max: "1000000000\n",
			}),
		).toEqual({ loadPercent: 63, curFreqHz: CUR_HZ, maxFreqHz: MAX_HZ });
	});

	test("an unparseable load → undefined, so the candidate is skipped entirely", () => {
		expect(
			gpuFromDevfreqNodes({
				load: undefined,
				cur: "300000000\n",
				max: "1000000000\n",
			}),
		).toBeUndefined();
		expect(
			gpuFromDevfreqNodes({ load: "banana\n", cur: undefined, max: undefined }),
		).toBeUndefined();
	});

	test("an unparseable frequency drops THAT key only — the load still reports", () => {
		expect(
			gpuFromDevfreqNodes({ load: "63\n", cur: "banana\n", max: undefined }),
		).toEqual({ loadPercent: 63 });
		expect(
			gpuFromDevfreqNodes({ load: "63\n", cur: "300000000\n", max: "" }),
		).toEqual({ loadPercent: 63, curFreqHz: CUR_HZ });
	});

	test("a genuinely-read 0 in any field is kept", () => {
		expect(
			gpuFromDevfreqNodes({ load: "0\n", cur: "0\n", max: "1000000000\n" }),
		).toEqual({ loadPercent: 0, curFreqHz: 0, maxFreqHz: MAX_HZ });
	});
});
