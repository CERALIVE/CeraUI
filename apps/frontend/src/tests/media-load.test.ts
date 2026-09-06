import { type EncoderLoad, encoderLoadSchema } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";
import { deriveEncoderActivity } from "../lib/streaming/encoder-load";
import {
	mockEncoderLoadAt,
	parseEncoderLoadMockFlavor,
} from "../lib/streaming/encoder-load-mock";
import {
	isMediaLoadStale,
	mediaCoreHintLabel,
	mediaLoadCoreCount,
} from "../lib/streaming/media-load";

describe("island encoder activity", () => {
	const reading: EncoderLoad = {
		source: null,
		cores: [],
		updatedAt: 1234,
		simulated: false,
		blocks: [
			{
				source: "mpp-service",
				block: "rkvenc",
				cores: [
					{
						core: "fdbd0000.rkvenc-core",
						load: 145.53,
						utilization: 121.08,
						sessions: [],
					},
				],
			},
		],
	};

	it("reports encoding when raw queue accounting exceeds the legacy scale", () => {
		// Given a block whose legacy projection cannot express its magnitude.
		// When the encoder verdict is derived, then the block remains authoritative.
		expect(deriveEncoderActivity(reading)).toBe("encoding");
	});

	it("reports encoding when only hardware utilization is readable", () => {
		const value: EncoderLoad = {
			...reading,
			blocks: [
				{
					source: "mpp-service",
					block: "rkvenc",
					cores: [
						{ core: "encoder", load: null, utilization: 17, sessions: null },
					],
				},
			],
		};
		expect(deriveEncoderActivity(value)).toBe("encoding");
	});

	it("does not let a stale legacy percentage override an unknown encoder block", () => {
		const value: EncoderLoad = {
			...reading,
			source: "mpp-service",
			cores: [{ core: "rkvenc0", kind: "percent", percent: 40 }],
			blocks: [
				{
					source: "mpp-service",
					block: "rkvenc",
					cores: [
						{
							core: "encoder",
							load: null,
							utilization: null,
							sessions: [{ pid: 42, index: 0 }],
						},
					],
				},
			],
		};
		expect(deriveEncoderActivity(value)).toBe("unreported");
	});

	it("does not claim idle when one encoder metric is unknown", () => {
		const value: EncoderLoad = {
			...reading,
			blocks: [
				{
					source: "mpp-service",
					block: "rkvenc",
					cores: [
						{ core: "encoder", load: 0, utilization: null, sessions: [] },
					],
				},
			],
		};
		expect(deriveEncoderActivity(value)).toBe("unreported");
	});

	it("reports idle when both metrics on every reported encoder are zero", () => {
		const value: EncoderLoad = {
			...reading,
			blocks: [
				{
					source: "mpp-service",
					block: "rkvenc",
					cores: [
						{
							core: "encoder",
							load: 0,
							utilization: 0,
							sessions: [{ pid: 42, index: 0 }],
						},
					],
				},
			],
		};
		expect(deriveEncoderActivity(value)).toBe("idle");
	});

	it("keeps the clock fallback when only another media group is published", () => {
		const value: EncoderLoad = {
			...reading,
			source: "clk-enable-count",
			cores: [{ core: "rkvenc0", kind: "active", active: false }],
			blocks: [
				{
					source: "rkrga",
					block: "rga",
					cores: [
						{
							core: "scheduler[0]: rga3",
							load: 99,
							utilization: null,
							sessions: null,
						},
					],
				},
			],
		};
		expect(deriveEncoderActivity(value)).toBe("idle");
	});
});

describe("media presentation facts", () => {
	it.each([
		["fdbd0000.rkvenc-core", "fdbd0000"],
		["fdc38100.video-codec", "fdc38100"],
		["scheduler[0]: rga3", "rga3[0]"],
		["scheduler[1]: rga3", "rga3[1]"],
		["unfamiliar-core", "unfamiliar-core"],
	])("keeps compact identity distinct for %s", (core, label) => {
		expect(mediaCoreHintLabel(core)).toBe(label);
	});
	it("uses the real wire schema for the opt-in island fixture", () => {
		const flavor = parseEncoderLoadMockFlavor("island");
		const fixture = encoderLoadSchema.parse(
			mockEncoderLoadAt(flavor, 1234, false),
		);
		expect(fixture.simulated).toBe(true);
		expect(fixture.blocks?.map((group) => group.block)).toEqual([
			"rkvenc",
			"rkvdec",
			"jpgdec",
			"rga",
		]);
		expect(mediaLoadCoreCount(fixture.blocks ?? [])).toBe(9);
	});

	it.each([0, 1, 5])("counts %i reported cores without padding", (count) => {
		const cores = Array.from({ length: count }, (_, index) => ({
			core: `core-${index}`,
			load: null,
			utilization: null,
			sessions: null,
		}));
		expect(
			mediaLoadCoreCount([{ source: "mpp-service", block: "jpgdec", cores }]),
		).toBe(count);
	});

	it.each([
		[null, true],
		[3999, true],
		[4000, false],
		[4001, false],
		[10_001, false],
	] as const)(
		"ages a sample stamped %s without treating clock skew as old",
		(updatedAt, stale) => {
			const value: EncoderLoad = {
				source: null,
				cores: [],
				updatedAt,
				simulated: false,
			};
			expect(isMediaLoadStale(value, 10_000)).toBe(stale);
		},
	);
});
