import { describe, expect, test } from "bun:test";
import { encoderLoadSchema } from "@ceraui/rpc";
import {
	collectEncoderLoad,
	createEncoderLoadState,
	type EncoderLoadDeps,
} from "../modules/system/encoder-load.ts";

const LOAD = "/proc/mpp_service/load";
const INTERVAL = "/proc/mpp_service/load_interval";
const SESSIONS = "/proc/mpp_service/sessions-summary";
const RGA = "/proc/rkrga/load";
const NOW = 1_800_000_000_000;
const ENCODER = "fdbd0000.rkvenc-core";
const fixture = (name: string) =>
	Bun.file(
		new URL(`./fixtures/encoder-load/${name}.txt`, import.meta.url),
	).text();

async function harness() {
	const files: Record<string, string> = {
		[INTERVAL]: "1000",
		[LOAD]: await fixture("mpp-load"),
		[SESSIONS]: await fixture("sessions-summary"),
		"/sys/bus/platform/devices/fdc38100.video-codec/of_node/compatible":
			"rockchip,rkv-decoder-v2\0",
		"/sys/bus/platform/devices/fdc40100.video-codec/of_node/compatible":
			"rockchip,rkv-decoder-v2\0",
	};
	const writes: string[] = [];
	const reads: string[] = [];
	const deps: EncoderLoadDeps = {
		readText: async (path) => {
			reads.push(path);
			const value = files[path];
			if (value === undefined) throw new Error(`ENOENT: ${path}`);
			return value;
		},
		writeText: async (path, value) => {
			writes.push(path);
			files[path] = value;
		},
		now: () => NOW,
	};
	const state = createEncoderLoadState();
	return {
		files,
		writes,
		reads,
		collect: () => collectEncoderLoad(deps, state),
	};
}

describe("island encoder-load collection from source-derived files", () => {
	test("publishes real block groups and independent metrics without inventing RGA", async () => {
		const h = await harness(); // Given the five driver rows, in non-address order.
		const result = await h.collect(); // When the production collector reads them.
		expect(result).toMatchObject({
			// Then only published blocks exist.
			blocks: [
				{
					block: "rkvenc",
					source: "mpp-service",
					cores: [
						{
							core: ENCODER,
							load: 11.34,
							utilization: 11.08,
							sessions: [
								{ pid: 4242, index: 7 },
								{ pid: 4242, index: 8 },
							],
						},
						{
							core: "fdbe0000.rkvenc-core",
							load: 0,
							utilization: 0,
							sessions: [],
						},
					],
				},
				{
					block: "rkvdec",
					source: "mpp-service",
					cores: [
						{
							core: "fdc38100.video-codec",
							load: 23.1,
							utilization: 22.87,
							sessions: [],
						},
						{
							core: "fdc40100.video-codec",
							load: 6.75,
							utilization: 6.51,
							sessions: [{ pid: 4343, index: 9 }],
						},
					],
				},
				{
					block: "jpgdec",
					source: "mpp-service",
					cores: [
						{
							core: "fdb90000.jpegd",
							load: 2.5,
							utilization: 1.25,
							sessions: [],
						},
					],
				},
			],
		});
		expect(encoderLoadSchema.parse(result)).toEqual(result);
		expect(h.writes).toEqual([]);
		expect(JSON.stringify(result)).not.toContain("iova");
	});

	test.each([1, 3, 5])(
		"derives %i encoder cores instead of padding or truncating to two",
		async (count) => {
			const h = await harness();
			h.files[LOAD] = Array.from(
				{ length: count },
				(_, i) =>
					`${(0x1000 + i * 0x1000).toString(16)}.rkvenc-core load: ${i}.00% utilization: 0.00%`,
			)
				.reverse()
				.join("\n");
			const result = await h.collect();
			expect(result.cores).toEqual(
				Array.from({ length: count }, (_, i) => ({
					core: `rkvenc${i}`,
					kind: "percent",
					percent: i,
				})),
			);
		},
	);

	test("resolves generic decoder names by compatible, never by their address", async () => {
		const h = await harness();
		h.files[LOAD] = "abc000.video-codec load: 3.00% utilization: 2.00%\n";
		h.files["/sys/bus/platform/devices/abc000.video-codec/of_node/compatible"] =
			"rockchip,rkv-decoder-v2\0";
		const result = await h.collect();
		expect(result).toMatchObject({
			blocks: [
				{
					block: "rkvdec",
					cores: [{ core: "abc000.video-codec", load: 3, utilization: 2 }],
				},
			],
		});
		expect(result.cores).toEqual([]);
	});

	test("does not classify an unproven generic video-codec as an island decoder", async () => {
		const h = await harness();
		h.files[
			"/sys/bus/platform/devices/fdc38100.video-codec/of_node/compatible"
		] = "rockchip,rk3588-av1-vpu\0";
		delete h.files[
			"/sys/bus/platform/devices/fdc40100.video-codec/of_node/compatible"
		];
		const result = await h.collect();
		expect(result.blocks?.map((block) => block.block)).toEqual([
			"rkvenc",
			"jpgdec",
		]);
	});

	test("preserves multicore accounting above 100 without clamping the legacy percentage", async () => {
		const h = await harness();
		h.files[LOAD] = `${ENCODER} load: 150.25% utilization: 120.75%\n`;
		const result = await h.collect();
		expect(result.blocks?.[0]?.cores[0]).toMatchObject({
			load: 150.25,
			utilization: 120.75,
		});
		expect(result.cores).toEqual([]);
	});

	test.each(["NaN", "11.2.3", "-1", "Infinity", "3junk"])(
		"withholds malformed load %s independently of utilization",
		async (value) => {
			const h = await harness();
			h.files[LOAD] = `${ENCODER} load: ${value}% utilization: 12.50%\n`;
			const result = await h.collect();
			expect(result.blocks?.[0]?.cores[0]).toMatchObject({
				core: ENCODER,
				load: null,
				utilization: 12.5,
			});
		},
	);

	test("retains a malformed core without moving another core's ownership", async () => {
		const h = await harness();
		h.files[LOAD] = (h.files[LOAD] ?? "").replace(
			"11.34% utilization:  11.08%",
			"bad% utilization: bad%",
		);
		const result = await h.collect();
		expect(result.blocks?.[0]?.cores[0]).toMatchObject({
			core: ENCODER,
			load: null,
			utilization: null,
			sessions: [
				{ pid: 4242, index: 7 },
				{ pid: 4242, index: 8 },
			],
		});
		expect(result.cores[1]).toEqual({
			core: "rkvenc1",
			kind: "percent",
			percent: 0,
		});
	});

	test("keeps missing sessions unknown without losing load", async () => {
		const h = await harness();
		delete h.files[SESSIONS];
		const result = await h.collect();
		expect(result.blocks?.[0]?.cores[0]).toMatchObject({
			load: 11.34,
			sessions: null,
		});
	});

	test("an empty summary clears owners on the next tick", async () => {
		const h = await harness();
		await h.collect();
		h.files[SESSIONS] = "";
		const result = await h.collect();
		expect(result.blocks?.[0]?.cores[0]?.sessions).toEqual([]);
	});

	test("a truncated summary is unknown, never a partial or stale ownership claim", async () => {
		const h = await harness();
		h.files[SESSIONS] += "session: pid=5555 index=10\n";
		const result = await h.collect();
		expect(result.blocks?.[0]?.cores[0]?.sessions).toBeNull();
	});

	test("RGA uses published schedulers, with no invented utilization or per-core owners", async () => {
		const h = await harness();
		h.files[RGA] = await fixture("rga-load");
		const result = await h.collect();
		expect(result.blocks?.find((block) => block.block === "rga")).toEqual({
			block: "rga",
			source: "rkrga",
			cores: [
				{
					core: "scheduler[0]: rga3",
					load: 12,
					utilization: null,
					sessions: null,
				},
				{
					core: "scheduler[1]: rga3",
					load: 0,
					utilization: null,
					sessions: null,
				},
				{
					core: "scheduler[2]: rga2",
					load: 5,
					utilization: null,
					sessions: null,
				},
			],
		});
	});
});
