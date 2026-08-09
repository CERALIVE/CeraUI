/*
 * DDR / memory-controller collector — `/sys/class/devfreq/*` read through the
 * root-aware collector filesystem seam (`collectors/fs.ts`).
 *
 * THE NODE NAME IS PROBED, NOT KNOWN. Which devfreq device (if any) exposes the
 * DDR controller, and in which of the two `load` formats, is a HARDWARE-OPEN
 * question pending a capture on a real board (T16's runbook). These legs pin the
 * behaviour of the probe rather than a confirmed vendor path:
 *
 *   dmc / "N@FkHz"  — the documented vendor form, load percent before the `@`
 *   dmc / bare      — the same node as a plain integer percentage
 *   pattern match   — no device literally called `dmc`; a dfi/dmc-shaped name wins
 *   probe order     — a tree carrying BOTH: `dmc` is chosen, deterministically
 *   absent          — no devfreq tree (mainline's expected shape) → field omitted
 *
 * Every leg runs against a REAL fixture tree on disk, so the enumeration, the
 * per-node path building, and genuine ENOENT are exercised — the three places a
 * sysfs collector actually breaks.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	collectDdr,
	DEVFREQ_DIR,
	ddrCandidatesFromEntries,
	ddrFromNodes,
	parseDevfreqLoad,
} from "../modules/system/collectors/ddr.ts";
import { createCollectorFs } from "../modules/system/collectors/fs.ts";

/** One devfreq device's fixture content; `undefined` means the node is absent. */
type DevfreqFixture = {
	name: string;
	load?: string;
	cur?: string;
	max?: string;
};

/**
 * Build a fixture root carrying `sys/class/devfreq/<device>/…`. With `devices`
 * undefined the devfreq directory is never created — the absent-source leg,
 * which is what a mainline kernel with no DMC driver actually looks like.
 */
async function fixtureRoot(
	devices?: readonly DevfreqFixture[],
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ceraui-ddr-"));
	if (devices === undefined) return root;
	for (const device of devices) {
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

/** A complete device: all three nodes, kernel-style trailing newline. */
function device(
	name: string,
	load: string,
	curHz: number,
	maxHz: number,
): DevfreqFixture {
	return { name, load, cur: `${curHz}\n`, max: `${maxHz}\n` };
}

// Frequencies are Hz — devfreq's own unit for cur_freq/max_freq (528 MHz
// current against a 1.56 GHz ceiling is an ordinary RK3588-class DDR pair).
const CUR_HZ = 528_000_000;
const MAX_HZ = 1_560_000_000;

describe("ddr collector — devfreq probe through the injected root", () => {
	test('a "dmc" device whose load reads "N@FkHz" emits the exact payload', async () => {
		const root = await fixtureRoot([
			device("dmc", "23@528000000Hz\n", CUR_HZ, MAX_HZ),
		]);
		expect(await collectDdr(createCollectorFs(root))).toEqual({
			ddr: { loadPercent: 23, curFreqHz: CUR_HZ, maxFreqHz: MAX_HZ },
		});
	});

	test('a "dmc" device whose load is a BARE integer emits the same shape', async () => {
		const root = await fixtureRoot([device("dmc", "47\n", CUR_HZ, MAX_HZ)]);
		expect(await collectDdr(createCollectorFs(root))).toEqual({
			ddr: { loadPercent: 47, curFreqHz: CUR_HZ, maxFreqHz: MAX_HZ },
		});
	});

	test("no device is called dmc: a dfi/dmc-PATTERNED name is probed instead", async () => {
		const root = await fixtureRoot([
			// A GPU devfreq device is a normal sibling here and must not match.
			device("fb000000.gpu", "88\n", 300_000_000, 1_000_000_000),
			device("ff630000.dfi", "12@528000kHz\n", CUR_HZ, MAX_HZ),
		]);
		expect(await collectDdr(createCollectorFs(root))).toEqual({
			ddr: { loadPercent: 12, curFreqHz: CUR_HZ, maxFreqHz: MAX_HZ },
		});
	});

	test("PROBE ORDER: with both present, the dmc-named device wins over the pattern match", async () => {
		const root = await fixtureRoot([
			device("ff630000.dfi", "12\n", 100_000_000, 200_000_000),
			device("dmc", "23\n", CUR_HZ, MAX_HZ),
		]);
		expect(await collectDdr(createCollectorFs(root))).toEqual({
			ddr: { loadPercent: 23, curFreqHz: CUR_HZ, maxFreqHz: MAX_HZ },
		});
	});

	test("absent devfreq directory: the field is omitted entirely, no throw", async () => {
		const root = await fixtureRoot();
		const stats = await collectDdr(createCollectorFs(root));
		expect(stats).toEqual({});
		expect("ddr" in stats).toBe(false);
	});

	test("a devfreq tree with no memory-controller candidate omits the field", async () => {
		const root = await fixtureRoot([
			device("fb000000.gpu", "88\n", 300_000_000, 1_000_000_000),
			device("fdab0000.npu", "5\n", 300_000_000, 1_000_000_000),
		]);
		expect(await collectDdr(createCollectorFs(root))).toEqual({});
	});

	test("a candidate missing its load node falls through to the NEXT candidate", async () => {
		// A devfreq device with no vendor `load` extension is exactly the
		// mainline shape — it must not shadow a sibling that does have one.
		const root = await fixtureRoot([
			{ name: "dmc", cur: `${CUR_HZ}\n`, max: `${MAX_HZ}\n` },
			device("ff630000.dfi", "34\n", CUR_HZ, MAX_HZ),
		]);
		expect(await collectDdr(createCollectorFs(root))).toEqual({
			ddr: { loadPercent: 34, curFreqHz: CUR_HZ, maxFreqHz: MAX_HZ },
		});
	});

	test("a dmc device with no readable node at all omits the field (never a zero-fill)", async () => {
		const root = await fixtureRoot([{ name: "dmc" }]);
		const stats = await collectDdr(createCollectorFs(root));
		expect(stats).toEqual({});
		expect("ddr" in stats).toBe(false);
	});

	test("a genuinely-read 0% load survives — it is a measurement, not a gap", async () => {
		const root = await fixtureRoot([
			device("dmc", "0@528000000Hz\n", CUR_HZ, MAX_HZ),
		]);
		expect(await collectDdr(createCollectorFs(root))).toEqual({
			ddr: { loadPercent: 0, curFreqHz: CUR_HZ, maxFreqHz: MAX_HZ },
		});
	});
});

describe("ddrCandidatesFromEntries — the hardware-open probe list", () => {
	test("dmc first, then dfi/dmc-patterned names in a deterministic order", () => {
		expect(
			ddrCandidatesFromEntries([
				"ff630000.dfi",
				"fb000000.gpu",
				"dmc",
				"ff620000.dmc",
				"fdab0000.npu",
			]),
		).toEqual(["dmc", "ff620000.dmc", "ff630000.dfi"]);
	});

	test("matching is case-insensitive and substring-based (the names are DT node ids)", () => {
		expect(ddrCandidatesFromEntries(["FF620000.DMC", "Dfi0"])).toEqual([
			"Dfi0",
			"FF620000.DMC",
		]);
	});

	test("a devfreq listing with no memory-controller device yields no candidate", () => {
		expect(ddrCandidatesFromEntries(["fb000000.gpu", "fdab0000.npu"])).toEqual(
			[],
		);
	});

	test("ordering does not depend on readdir order", () => {
		const entries = ["ff630000.dfi", "ff620000.dmc", "dmc"];
		expect(ddrCandidatesFromEntries(entries)).toEqual(
			ddrCandidatesFromEntries([...entries].reverse()),
		);
	});
});

describe("parseDevfreqLoad — BOTH documented load formats", () => {
	test('the "N@FkHz" form yields N; the frequency echo is ignored', () => {
		expect(parseDevfreqLoad("23@528000000Hz\n")).toBe(23);
		expect(parseDevfreqLoad("7@528000kHz")).toBe(7);
		expect(parseDevfreqLoad("  100@1560000000Hz  \n")).toBe(100);
	});

	test("the bare-integer form yields the integer", () => {
		expect(parseDevfreqLoad("47\n")).toBe(47);
		expect(parseDevfreqLoad("  0  ")).toBe(0);
	});

	test("anything else is unparseable — never NaN, never a coerced 0", () => {
		expect(parseDevfreqLoad(undefined)).toBeUndefined();
		expect(parseDevfreqLoad("")).toBeUndefined();
		expect(parseDevfreqLoad("banana\n")).toBeUndefined();
		expect(parseDevfreqLoad("23@\n")).toBeUndefined();
		expect(parseDevfreqLoad("@528000000Hz\n")).toBeUndefined();
		expect(parseDevfreqLoad("12.5\n")).toBeUndefined();
		// Out of the percentage range: whatever that node meant, it is not a
		// percent, and reporting it as one would put a bogus bar on the panel.
		expect(parseDevfreqLoad("101\n")).toBeUndefined();
		expect(parseDevfreqLoad("255@528000000Hz\n")).toBeUndefined();
	});
});

describe("ddrFromNodes — the all-three-or-nothing reduction", () => {
	test("all three nodes parse → a reading", () => {
		expect(
			ddrFromNodes({ load: "23\n", cur: "528000000\n", max: "1560000000\n" }),
		).toEqual({ loadPercent: 23, curFreqHz: CUR_HZ, maxFreqHz: MAX_HZ });
	});

	test("any missing or unparseable node → undefined, never a half-filled reading", () => {
		expect(
			ddrFromNodes({
				load: undefined,
				cur: "528000000\n",
				max: "1560000000\n",
			}),
		).toBeUndefined();
		expect(
			ddrFromNodes({ load: "23\n", cur: undefined, max: "1560000000\n" }),
		).toBeUndefined();
		expect(
			ddrFromNodes({ load: "23\n", cur: "528000000\n", max: "" }),
		).toBeUndefined();
		expect(
			ddrFromNodes({ load: "23\n", cur: "banana\n", max: "1560000000\n" }),
		).toBeUndefined();
	});

	test("a genuinely-read 0 in any field is kept", () => {
		expect(
			ddrFromNodes({ load: "0\n", cur: "0\n", max: "1560000000\n" }),
		).toEqual({
			loadPercent: 0,
			curFreqHz: 0,
			maxFreqHz: MAX_HZ,
		});
	});
});
