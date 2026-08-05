/*
 * Per-core VEPU580 encoder load — the privileged two-kernel collector.
 *
 * The load-bearing assertion in this file is a NEGATIVE one, and it mirrors the
 * frontend contract test: NOTHING here turns a `clk_enable_count` into a
 * percentage. On mainline that count is a reference count, not a magnitude, so
 * publishing it as a number would fabricate a denominator the driver never
 * produced — exactly the class of lie the Device Health panel exists to prevent.
 *
 * The rest is detection + degradation: which of the two kernel interfaces is
 * live is PROBED, and a device where neither answers reports the honest
 * unavailable floor rather than a shaped guess.
 */
import { describe, expect, test } from "bun:test";
import { withDeviceType } from "../modules/system/device-detection.ts";
import {
	collectEncoderLoad,
	createEncoderLoadState,
	ENCODER_LOAD_UNAVAILABLE,
	type EncoderLoadDeps,
	type EncoderLoadState,
	hasUsableCore,
	initEncoderLoad,
	parseEnableCount,
	parseLoadPercent,
	parseMppLoad,
} from "../modules/system/encoder-load.ts";

// ─── deps stub ───────────────────────────────────────────────────────────────

const MPP_LOAD = "/proc/mpp_service/load";
const MPP_INTERVAL = "/proc/mpp_service/load_interval";
const CLK0 = "/sys/kernel/debug/clk/clk_rkvenc0_core/clk_enable_count";
const CLK1 = "/sys/kernel/debug/clk/clk_rkvenc1_core/clk_enable_count";

const NOW = 1_800_000_000_000;

type Harness = {
	deps: EncoderLoadDeps;
	state: EncoderLoadState;
	reads: string[];
	writes: Array<{ path: string; contents: string }>;
};

function makeHarness(files: Record<string, string>): Harness {
	const reads: string[] = [];
	const writes: Array<{ path: string; contents: string }> = [];
	return {
		reads,
		writes,
		state: createEncoderLoadState(),
		deps: {
			readText: async (path) => {
				reads.push(path);
				const value = files[path];
				if (value === undefined) throw new Error(`ENOENT: ${path}`);
				return value;
			},
			writeText: async (path, contents) => {
				writes.push({ path, contents });
				files[path] = contents;
			},
			now: () => NOW,
		},
	};
}

/**
 * The vendor driver's real output shape. Decoder/RGA blocks share the file and
 * must be ignored; only `rkvenc-core` rows are encoder cores.
 */
const VENDOR_LOAD_ONE_SESSION = [
	"fdbd0000.rkvenc-core      load:  11.34% utilization:  11.08%",
	"fdbe0000.rkvenc-core      load:   0.00% utilization:   0.00%",
	"fdb50400.vdpu-core        load:   0.00% utilization:   0.00%",
	"",
].join("\n");

// ─── pure parsers ────────────────────────────────────────────────────────────

describe("parseLoadPercent", () => {
	test("accepts the measured vendor-kernel figures", () => {
		expect(parseLoadPercent("0.00")).toBe(0);
		expect(parseLoadPercent("11.34")).toBe(11.34);
		expect(parseLoadPercent("45.53")).toBe(45.53);
	});

	test("REFUSES an out-of-range figure rather than clamping it", () => {
		// A clamped wrong figure still reads as a measurement.
		expect(parseLoadPercent("101")).toBeNull();
		expect(parseLoadPercent("-1")).toBeNull();
		expect(parseLoadPercent("n/a")).toBeNull();
	});
});

describe("parseEnableCount", () => {
	test("reads the count, and refuses a malformed or negative one", () => {
		expect(parseEnableCount("0\n")).toBe(0);
		expect(parseEnableCount("2\n")).toBe(2);
		expect(parseEnableCount("")).toBeNull();
		expect(parseEnableCount("-1")).toBeNull();
	});
});

describe("parseMppLoad", () => {
	test("picks out ONLY the encoder-core rows", () => {
		expect(parseMppLoad(VENDOR_LOAD_ONE_SESSION)).toEqual([11.34, 0]);
	});

	test("orders cores by base ADDRESS, not by print order", () => {
		const reversed = [
			"fdbe0000.rkvenc-core      load:   0.00% utilization:   0.00%",
			"fdbd0000.rkvenc-core      load:  45.53% utilization:  45.10%",
		].join("\n");
		// fdbd0000 is core 0 — the file's print order must not decide that.
		expect(parseMppLoad(reversed)).toEqual([45.53, 0]);
	});

	test("degrades an out-of-range row to null without dropping its slot", () => {
		const bogus = [
			"fdbd0000.rkvenc-core      load: 900.00% utilization:  11.08%",
			"fdbe0000.rkvenc-core      load:   7.00% utilization:   0.00%",
		].join("\n");
		expect(parseMppLoad(bogus)).toEqual([null, 7]);
	});

	test("a file with no encoder rows yields nothing", () => {
		expect(parseMppLoad("please set load_interval first!!!\n")).toEqual([]);
	});
});

// ─── vendor 6.1 reality ──────────────────────────────────────────────────────

describe("vendor kernel — /proc/mpp_service", () => {
	test("reports REAL per-core percentages", async () => {
		const h = makeHarness({
			[MPP_INTERVAL]: "1000",
			[MPP_LOAD]: VENDOR_LOAD_ONE_SESSION,
		});
		const reading = await collectEncoderLoad(h.deps, h.state);
		expect(reading).toEqual({
			source: "mpp-service",
			cores: [
				{ core: "rkvenc0", kind: "percent", percent: 11.34 },
				{ core: "rkvenc1", kind: "percent", percent: 0 },
			],
			updatedAt: NOW,
			simulated: false,
		});
	});

	test("arms load_interval when accounting is OFF, exactly once", async () => {
		const h = makeHarness({
			[MPP_INTERVAL]: "0",
			[MPP_LOAD]: VENDOR_LOAD_ONE_SESSION,
		});
		await collectEncoderLoad(h.deps, h.state);
		await collectEncoderLoad(h.deps, h.state);
		await collectEncoderLoad(h.deps, h.state);
		expect(h.writes).toEqual([{ path: MPP_INTERVAL, contents: "1000" }]);
	});

	test("NEVER writes when the device already has accounting armed", async () => {
		const h = makeHarness({
			[MPP_INTERVAL]: "500",
			[MPP_LOAD]: VENDOR_LOAD_ONE_SESSION,
		});
		await collectEncoderLoad(h.deps, h.state);
		expect(h.writes).toEqual([]);
	});

	test("a refused write never breaks the read", async () => {
		const h = makeHarness({
			[MPP_INTERVAL]: "0",
			[MPP_LOAD]: VENDOR_LOAD_ONE_SESSION,
		});
		h.deps.writeText = async () => {
			throw new Error("EACCES");
		};
		const reading = await collectEncoderLoad(h.deps, h.state);
		expect(reading.source).toBe("mpp-service");
	});

	test("simulated is FALSE on every real read", async () => {
		const h = makeHarness({
			[MPP_INTERVAL]: "1000",
			[MPP_LOAD]: VENDOR_LOAD_ONE_SESSION,
		});
		expect((await collectEncoderLoad(h.deps, h.state)).simulated).toBe(false);
	});
});

// ─── mainline / edge 7.1 reality ─────────────────────────────────────────────

describe("mainline kernel — clk_enable_count", () => {
	test("reports busy/idle ONLY, with no percentage anywhere", async () => {
		const h = makeHarness({ [CLK0]: "2\n", [CLK1]: "1\n" });
		const reading = await collectEncoderLoad(h.deps, h.state);
		expect(reading).toEqual({
			source: "clk-enable-count",
			cores: [
				{ core: "rkvenc0", kind: "active", active: true },
				{ core: "rkvenc1", kind: "active", active: true },
			],
			updatedAt: NOW,
			simulated: false,
		});
		for (const core of reading.cores) {
			expect(core).not.toHaveProperty("percent");
		}
	});

	test("treats the measured 2-vs-1 as a REFERENCE COUNT, not a magnitude", async () => {
		// Four concurrent sessions produced core0=2, core1=1 on mainline. That is
		// not "core 0 is twice as busy" — both are simply enabled.
		const h = makeHarness({ [CLK0]: "2\n", [CLK1]: "1\n" });
		const { cores } = await collectEncoderLoad(h.deps, h.state);
		expect(cores[0]).toEqual({ ...cores[1], core: "rkvenc0" } as never);
	});

	test("a zero count is idle — the board's measured idle state", async () => {
		const h = makeHarness({ [CLK0]: "0\n", [CLK1]: "0\n" });
		const { cores } = await collectEncoderLoad(h.deps, h.state);
		expect(cores).toEqual([
			{ core: "rkvenc0", kind: "active", active: false },
			{ core: "rkvenc1", kind: "active", active: false },
		]);
	});

	test("one unreadable core degrades only that core", async () => {
		const h = makeHarness({ [CLK0]: "1\n" });
		const { cores, source } = await collectEncoderLoad(h.deps, h.state);
		expect(source).toBe("clk-enable-count");
		expect(cores).toEqual([
			{ core: "rkvenc0", kind: "active", active: true },
			{ core: "rkvenc1", kind: "unavailable" },
		]);
	});
});

// ─── detection + degradation ─────────────────────────────────────────────────

describe("runtime detection", () => {
	test("neither interface readable ⇒ the honest unavailable floor", async () => {
		const h = makeHarness({});
		expect(await collectEncoderLoad(h.deps, h.state)).toEqual(
			ENCODER_LOAD_UNAVAILABLE,
		);
	});

	test("prefers the richer interface when BOTH are present", async () => {
		const h = makeHarness({
			[MPP_INTERVAL]: "1000",
			[MPP_LOAD]: VENDOR_LOAD_ONE_SESSION,
			[CLK0]: "1\n",
			[CLK1]: "0\n",
		});
		expect((await collectEncoderLoad(h.deps, h.state)).source).toBe(
			"mpp-service",
		);
	});

	test("an mpp file that answers NOTHING falls through to busy/idle", async () => {
		// The vendor driver prints this until load_interval is armed. A reality
		// only wins when it produced a usable core reading.
		const h = makeHarness({
			[MPP_INTERVAL]: "1000",
			[MPP_LOAD]: "please set load_interval first!!!\n",
			[CLK0]: "1\n",
			[CLK1]: "0\n",
		});
		const reading = await collectEncoderLoad(h.deps, h.state);
		expect(reading.source).toBe("clk-enable-count");
		expect(reading.cores).toEqual([
			{ core: "rkvenc0", kind: "active", active: true },
			{ core: "rkvenc1", kind: "active", active: false },
		]);
	});

	test("a throwing clock read never crashes the tick", async () => {
		const h = makeHarness({});
		h.deps.readText = async () => {
			throw new Error("EIO");
		};
		expect(await collectEncoderLoad(h.deps, h.state)).toEqual(
			ENCODER_LOAD_UNAVAILABLE,
		);
	});

	test("hasUsableCore is what decides an instrumented reality", () => {
		expect(hasUsableCore([{ core: "rkvenc0", kind: "unavailable" }])).toBe(
			false,
		);
		expect(
			hasUsableCore([{ core: "rkvenc0", kind: "active", active: false }]),
		).toBe(true);
	});
});

describe("the emulated-host gate", () => {
	test("an emulated host reads NOTHING — no collector, no synthetic reading", async () => {
		const h = makeHarness({ [CLK0]: "1\n", [CLK1]: "1\n" });
		await withDeviceType("emulated", async () => {
			await initEncoderLoad(h.deps);
		});
		expect(h.reads).toEqual([]);
	});
});

describe("no path converts an enable count into a number", () => {
	test("the module exports no enable-count-to-percent helper", async () => {
		const module = await import("../modules/system/encoder-load.ts");
		for (const [name, value] of Object.entries(module)) {
			if (typeof value !== "function") continue;
			expect(name).not.toMatch(/percentFrom|toPercent|asPercent/i);
		}
	});

	test("the module source never derives a number from an enable count", async () => {
		const source = await Bun.file(
			new URL("../modules/system/encoder-load.ts", import.meta.url).pathname,
		).text();
		expect(source).not.toMatch(/active\s*\?\s*\d/);
		expect(source).not.toMatch(/kind:\s*"percent"[\s\S]{0,120}enableCount/i);
	});

	test("a mainline reading can never satisfy a percent consumer", async () => {
		const h = makeHarness({ [CLK0]: "9\n", [CLK1]: "9\n" });
		const { cores } = await collectEncoderLoad(h.deps, h.state);
		for (const core of cores) {
			expect(core.kind).toBe("active");
			expect(JSON.stringify(core)).not.toMatch(/percent/);
		}
	});
});
